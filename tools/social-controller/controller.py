#!/usr/bin/env python3
"""Deterministic queue boundary for the AI social-controller role.

This module deliberately contains no model imports. ``prepare`` is the cron
preflight: when it prints 0 the shell exits before Claude is invoked. The AI
may only mutate queue state through ``approve`` and ``reject``, both of which
re-check that the requested row is still a public draft.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(os.environ.get("FLEET_DOMAINS_ROOT", "/home/jesse/projects/domains"))
os.environ.setdefault("DOMAINS_ROOT", str(ROOT))
HUB_SRC = ROOT / "tools" / "social-hub" / "src"
if str(HUB_SRC) not in sys.path:
    sys.path.insert(0, str(HUB_SRC))

from social_hub import db, oversight, quality, queue  # noqa: E402
from social_hub.config import load_site_config, site_config_path  # noqa: E402

PUBLIC_EXCLUSIONS = ("console",)
ROLE_HINTS = (
    "social",
    "promoter",
    "content",
    "writer",
    "editor",
    "scout",
)


def _public_drafts(limit: int) -> list[dict]:
    marks = ",".join("?" for _ in PUBLIC_EXCLUSIONS)
    rows = db.query(
        f"""
        SELECT p.*,
               s.title AS source_title, s.summary AS source_summary,
               s.url AS source_url, s.tags AS source_tags,
               m.author_handle AS mention_author,
               m.text AS mention_text, m.url AS mention_url
          FROM posts p
          LEFT JOIN sources s
            ON s.site = p.site
           AND s.source_type = p.source_type
           AND s.source_id = p.source_id
          LEFT JOIN mentions m ON m.id = p.mention_id
         WHERE p.status = 'draft'
           AND p.platform NOT IN ({marks})
         ORDER BY p.created_at ASC, p.id ASC
         LIMIT ?
        """,
        (*PUBLIC_EXCLUSIONS, limit),
    )
    return db.rows_to_dicts(rows)


def _role_paths(site: str) -> list[str]:
    role_dir = ROOT / "sites" / site / "ops" / "roles"
    if not role_dir.is_dir():
        return []
    paths = []
    for path in sorted(role_dir.glob("*.md")):
        if any(hint in path.stem.lower() for hint in ROLE_HINTS):
            paths.append(str(path.relative_to(ROOT)))
    return paths


def _site_context(site: str) -> dict:
    cfg = load_site_config(site)
    path = site_config_path(site)
    data = cfg.data if cfg else {}
    return {
        "site": site,
        "config_path": str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
        "voice": data.get("voice", ""),
        "guardrails": (data.get("ai") or {}).get("guardrails", ""),
        "content_direction": data.get("content_direction", ""),
        "approval": data.get("approval", "manual"),
        "writer_role_paths": _role_paths(site),
    }


def _prior_feedback(site: str, limit: int = 12) -> list[dict]:
    rows = db.query(
        "SELECT id, post_id, category, severity, reason, actor, created_at "
        "FROM feedback WHERE site = ? ORDER BY id DESC LIMIT ?",
        (site, limit),
    )
    return db.rows_to_dicts(rows)


def build_packet(limit: int) -> dict:
    quarantined = 0
    for post in _public_drafts(200):
        cfg = load_site_config(post["site"])
        source = {
            "title": post.get("source_title") or "",
            "summary": post.get("source_summary") or "",
            "url": post.get("source_url") or "",
        }
        problems = quality.findings(post, source, cfg)
        if problems:
            first = problems[0]
            queue.quarantine(
                post["id"], by="quality-gate", category=first["category"], reason=first["reason"]
            )
            quarantined += 1

    posts = _public_drafts(limit)
    sites = sorted({post["site"] for post in posts})
    run_id = db.insert(
        "runs",
        {
            "kind": "social-controller",
            "started_at": db.utcnow(),
            "finished_at": db.utcnow() if not posts else None,
            "ok": 1 if not posts else None,
            "stats": json.dumps(
                {"pending": len(posts), "quality_quarantined": quarantined, "ai_invoked": False}
            ),
        },
    )
    return {
        "generated_at": db.utcnow(),
        "run_id": run_id,
        "count": len(posts),
        "quality_quarantined": quarantined,
        "posts": posts,
        "sites": [
            {**_site_context(site), "prior_controller_feedback": _prior_feedback(site)}
            for site in sites
        ],
        "commands": {
            "approve": "python3 tools/social-controller/controller.py approve POST_ID",
            "reject": "python3 tools/social-controller/controller.py reject POST_ID --category CATEGORY --reason 'actionable reason'",
            "propose": "python3 tools/social-controller/controller.py propose --site SITE --scope site --target TARGET --evidence FEEDBACK_ID FEEDBACK_ID --instruction 'specific durable guidance'",
            "apply_proposal": "python3 tools/social-controller/controller.py apply-proposal PROPOSAL_ID",
            "remaining": "python3 tools/social-controller/controller.py remaining --packet PACKET_PATH",
        },
    }


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    tmp.replace(path)


def _mutable_public_draft(post_id: int) -> dict:
    post = queue.get(post_id)
    if not post:
        raise SystemExit(f"post {post_id} not found")
    if post["status"] != "draft":
        raise SystemExit(f"post {post_id} is {post['status']}, not draft")
    if post["platform"] in PUBLIC_EXCLUSIONS:
        raise SystemExit(f"post {post_id} is a non-public {post['platform']} preview")
    return post


def _packet_ids(path: Path) -> list[int]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [int(post["id"]) for post in payload.get("posts", [])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    prep = sub.add_parser("prepare", help="write the review packet and print its draft count")
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--limit", type=int, default=60)

    approve = sub.add_parser("approve", help="approve one still-pending public draft")
    approve.add_argument("post_id", type=int)

    reject = sub.add_parser("reject", help="reject one still-pending public draft")
    reject.add_argument("post_id", type=int)
    reject.add_argument("--category", choices=sorted(quality.FEEDBACK_CATEGORIES), default="other")
    reject.add_argument("--reason", required=True)

    remaining = sub.add_parser("remaining", help="print packet IDs that are still drafts")
    remaining.add_argument("--packet", type=Path, required=True)

    finish = sub.add_parser("finish", help="close a controller run and record its outcomes")
    finish.add_argument("--packet", type=Path, required=True)
    finish.add_argument("--exit-code", type=int, default=0)

    sub.add_parser("status", help="print controller health and learning state")

    proposal = sub.add_parser("propose", help="file an evidence-backed writer-guidance proposal")
    proposal.add_argument("--site")
    proposal.add_argument("--scope", choices=("site", "fleet"), required=True)
    proposal.add_argument("--target", required=True)
    proposal.add_argument("--instruction", required=True)
    proposal.add_argument("--evidence", type=int, nargs="+", required=True)

    apply_proposal = sub.add_parser("apply-proposal", help="mark a proposal applied after its file change")
    apply_proposal.add_argument("proposal_id", type=int)

    args = parser.parse_args(argv)
    if args.command == "prepare":
        packet = build_packet(max(1, min(args.limit, 200)))
        _atomic_json(args.output, packet)
        print(packet["count"])
        return 0

    if args.command == "approve":
        _mutable_public_draft(args.post_id)
        db.update("posts", args.post_id, {"quality_status": "passed"})
        post = queue.approve(args.post_id, by="social-controller")
        print(json.dumps({"id": args.post_id, "status": post["status"], "scheduled_at": post["scheduled_at"]}))
        return 0

    if args.command == "reject":
        reason = " ".join(args.reason.split()).strip()
        if len(reason) < 8:
            raise SystemExit("rejection reason must be actionable (at least 8 characters)")
        _mutable_public_draft(args.post_id)
        post = queue.quarantine(
            args.post_id,
            by="social-controller",
            category=args.category,
            reason=reason[:300],
        )
        print(json.dumps({"id": args.post_id, "status": post["status"], "reason": post["error"]}))
        return 0

    if args.command == "status":
        print(json.dumps(oversight.status(), indent=2, default=str))
        return 0

    if args.command == "propose":
        try:
            row = oversight.propose(
                site=args.site,
                scope=args.scope,
                target_path=args.target,
                instruction=args.instruction,
                evidence=args.evidence,
                actor="social-controller",
            )
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        print(json.dumps(row, default=str))
        return 0

    if args.command == "apply-proposal":
        try:
            row = oversight.apply_proposal(args.proposal_id, actor="social-controller")
        except (KeyError, ValueError) as exc:
            raise SystemExit(str(exc)) from exc
        print(json.dumps(row, default=str))
        return 0

    if args.command == "finish":
        payload = json.loads(args.packet.read_text(encoding="utf-8"))
        counts: Counter[str] = Counter()
        for post_id in _packet_ids(args.packet):
            post = queue.get(post_id)
            counts[(post or {}).get("status", "missing")] += 1
        unresolved = counts.get("draft", 0)
        ok = args.exit_code == 0 and unresolved == 0
        db.update(
            "runs",
            int(payload["run_id"]),
            {
                "finished_at": db.utcnow(),
                "ok": 1 if ok else 0,
                "stats": json.dumps(
                    {
                        "pending": payload.get("count", 0),
                        "quality_quarantined": payload.get("quality_quarantined", 0),
                        "ai_invoked": True,
                        "outcomes": dict(counts),
                    }
                ),
                "error": None if ok else f"exit={args.exit_code}; unresolved={unresolved}",
            },
        )
        print(json.dumps({"ok": ok, "outcomes": dict(counts)}))
        return 0 if ok else 1

    unresolved = []
    for post_id in _packet_ids(args.packet):
        post = queue.get(post_id)
        if post and post["status"] == "draft" and post["platform"] not in PUBLIC_EXCLUSIONS:
            unresolved.append(post_id)
    print(json.dumps(unresolved))
    return 1 if unresolved else 0


if __name__ == "__main__":
    raise SystemExit(main())
