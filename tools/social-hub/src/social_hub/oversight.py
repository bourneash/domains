"""Operational status, feedback taxonomy, and governed learning proposals."""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from social_hub import db
from social_hub.config import domains_root, load_all

CONTROLLER_DIR = domains_root() / "tools" / "social-controller"
DISABLED_FILE = CONTROLLER_DIR / ".controller-disabled"


def _next_controller_run(now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    candidates = []
    for offset in range(0, 61):
        candidate = (moment + timedelta(minutes=offset)).replace(second=0, microsecond=0)
        if candidate.minute in {8, 23, 38, 53} and candidate > moment:
            candidates.append(candidate)
    return min(candidates).isoformat(timespec="seconds")


def _usage(days: int = 30) -> dict:
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    totals = {"runs": 0, "errors": 0, "tokens": 0, "cost_usd": 0.0}
    log_dir = CONTROLLER_DIR / "ops" / "logs"
    for path in sorted(log_dir.glob("token-usage-*.jsonl")) if log_dir.exists() else []:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if float(row.get("recorded_at_unix") or 0) < cutoff or row.get("role") != "social-controller":
                continue
            totals["runs"] += 1
            totals["errors"] += int(bool(row.get("is_error")))
            totals["tokens"] += int(row.get("input_tokens") or 0) + int(row.get("output_tokens") or 0)
            totals["cost_usd"] += float(row.get("total_cost_usd") or 0)
    totals["cost_usd"] = round(totals["cost_usd"], 4)
    return totals


def config_health() -> list[dict]:
    from social_hub.accounts import list_channels, read_registry

    registry_accounts: dict[str, list[dict]] = {}
    for account in read_registry().get("accounts", []):
        if account.get("status") == "active" and account.get("site"):
            registry_accounts.setdefault(account["site"], []).append(account)
    mirrored_channels: dict[str, list[dict]] = {}
    for channel in list_channels():
        mirrored_channels.setdefault(channel["site"], []).append(channel)

    rows = []
    for site, cfg in load_all().items():
        warnings = []
        if not cfg.voice.strip():
            warnings.append("missing voice")
        if not cfg.get("brand.audience"):
            warnings.append("missing brand audience")
        if not cfg.get("brand.purpose"):
            warnings.append("missing brand purpose")
        if not cfg.get("content_pillars"):
            warnings.append("missing content pillars")
        configured = set(cfg.platforms)
        for account in registry_accounts.get(site, []):
            platform = account.get("platform") or "unknown"
            if platform not in configured:
                warnings.append(f"active {platform} account is not configured")
            if not account.get("handle"):
                warnings.append(f"active {platform} account is missing a handle")
            if not account.get("credsInVault"):
                warnings.append(f"active {platform} account has no registered credentials")
        blocked = sorted(
            {
                channel["platform"]
                for channel in mirrored_channels.get(site, [])
                if channel.get("enabled") and channel.get("readiness") not in {"ready"}
            }
        )
        if blocked:
            warnings.append(f"channels need verification: {', '.join(blocked)}")
        warnings = list(dict.fromkeys(warnings))
        rows.append(
            {
                "site": site,
                "warnings": warnings,
                "ready": not warnings,
                "configured_platforms": sorted(configured),
                "active_accounts": len(registry_accounts.get(site, [])),
            }
        )
    return rows


def status() -> dict:
    now = db.utcnow()
    pending = db.one(
        "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM posts WHERE status = 'draft' AND platform != 'console'"
    )
    rewrite = db.one("SELECT COUNT(*) AS n FROM posts WHERE status = 'needs_rewrite'")
    fallback = db.one(
        "SELECT COUNT(*) AS all_n, SUM(CASE WHEN ai_model = 'fallback' THEN 1 ELSE 0 END) AS fallback_n "
        "FROM posts WHERE julianday(created_at) >= julianday('now', '-30 days') AND origin = 'ai'"
    )
    categories = {
        row["category"]: int(row["n"])
        for row in db.query(
            "SELECT category, COUNT(*) AS n FROM feedback WHERE state = 'open' GROUP BY category ORDER BY n DESC"
        )
    }
    last = db.row_to_dict(
        db.one("SELECT * FROM runs WHERE kind = 'social-controller' ORDER BY id DESC LIMIT 1")
    )
    proposals = db.rows_to_dicts(
        db.query("SELECT * FROM learning_proposals ORDER BY id DESC LIMIT 50")
    )
    health = config_health()
    all_generated = int((fallback or {})["all_n"] or 0)
    fallback_n = int((fallback or {})["fallback_n"] or 0)
    return {
        "generated_at": now,
        "enabled": not DISABLED_FILE.exists(),
        "next_run": _next_controller_run(),
        "pending": int((pending or {})["n"] or 0),
        "oldest_pending": (pending or {})["oldest"],
        "needs_rewrite": int((rewrite or {})["n"] or 0),
        "fallback": {"count": fallback_n, "total_ai": all_generated, "percent": round(100 * fallback_n / (all_generated or 1), 1)},
        "feedback_categories": categories,
        "last_run": last,
        "usage_30d": _usage(),
        "learning_proposals": proposals,
        "config_health": health,
        "config_ready": sum(1 for row in health if row["ready"]),
    }


def set_enabled(enabled: bool) -> dict:
    if enabled:
        DISABLED_FILE.unlink(missing_ok=True)
    else:
        DISABLED_FILE.parent.mkdir(parents=True, exist_ok=True)
        DISABLED_FILE.touch()
    db.log_event("controller.enabled" if enabled else "controller.disabled", message="changed from Social Hub")
    return {"enabled": enabled}


def propose(*, site: str | None, scope: str, target_path: str, instruction: str, evidence: list[int], actor: str) -> dict:
    if scope not in {"site", "fleet"}:
        raise ValueError("scope must be site or fleet")
    target = Path(target_path)
    if target.is_absolute() or ".." in target.parts:
        raise ValueError("target_path must be repo-relative")
    expected = Path("sites") / str(site) / "ops" if scope == "site" else Path("tools")
    if not target.is_relative_to(expected):
        raise ValueError(f"target_path is outside the allowed {scope} scope")
    evidence = sorted({int(item) for item in evidence})
    if len(evidence) < 2:
        raise ValueError("at least two feedback IDs are required")
    placeholders = ",".join("?" for _ in evidence)
    rows = db.query(f"SELECT id, site FROM feedback WHERE id IN ({placeholders})", tuple(evidence))
    if len(rows) != len(evidence) or (site and any(row["site"] != site for row in rows)):
        raise ValueError("evidence must reference existing feedback for the selected site")
    proposal_id = db.insert(
        "learning_proposals",
        {
            "site": site,
            "scope": scope,
            "target_path": str(target),
            "instruction": " ".join(instruction.split())[:1000],
            "evidence": json.dumps(evidence),
            "proposed_by": actor,
            "created_at": db.utcnow(),
        },
    )
    db.log_event("learning.proposed", site=site, ref_type="learning_proposal", ref_id=proposal_id, message=str(target))
    return db.row_to_dict(db.one("SELECT * FROM learning_proposals WHERE id = ?", (proposal_id,))) or {}


def review_proposal(proposal_id: int, *, state: str, actor: str) -> dict:
    if state not in {"approved", "rejected"}:
        raise ValueError("review state must be approved or rejected")
    row = db.one("SELECT * FROM learning_proposals WHERE id = ?", (proposal_id,))
    if not row:
        raise KeyError("proposal not found")
    db.update(
        "learning_proposals",
        proposal_id,
        {"state": state, "reviewed_by": actor, "reviewed_at": db.utcnow()},
    )
    db.log_event(f"learning.{state}", site=row["site"], ref_type="learning_proposal", ref_id=proposal_id, message=row["target_path"])
    return db.row_to_dict(db.one("SELECT * FROM learning_proposals WHERE id = ?", (proposal_id,))) or {}


def apply_proposal(proposal_id: int, *, actor: str) -> dict:
    """Mark guidance applied after the corresponding file change is complete.

    Site guidance can be applied directly by the controller. Fleet guidance is
    a higher-trust boundary and must already carry an operator approval.
    """
    row = db.one("SELECT * FROM learning_proposals WHERE id = ?", (proposal_id,))
    if not row:
        raise KeyError("proposal not found")
    if row["state"] in {"rejected", "applied"}:
        raise ValueError(f"proposal is already {row['state']}")
    if row["scope"] == "fleet" and row["state"] != "approved":
        raise ValueError("fleet proposals require operator approval before application")
    db.update(
        "learning_proposals",
        proposal_id,
        {"state": "applied", "reviewed_by": actor, "reviewed_at": db.utcnow()},
    )
    db.log_event("learning.applied", site=row["site"], ref_type="learning_proposal", ref_id=proposal_id, message=row["target_path"])
    return db.row_to_dict(db.one("SELECT * FROM learning_proposals WHERE id = ?", (proposal_id,))) or {}
