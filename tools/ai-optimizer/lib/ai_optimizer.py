#!/usr/bin/env python3
"""ai-optimizer — fleet AI-cost finding queue.

The daily analyst files FINDINGS here as frontmatter markdown tickets; a human
approves/denies them in the Fleet Dashboard; an implementer picks up the
approved ones. Same file-kanban contract as tools/guide-queue (and the per-site
ops/tasks/ boards) so the Node dashboard side can read it with the same parser.

    queue/proposed/  → filed by the analyst, awaiting a human decision
    queue/approved/  → human said do it; implementer may pick it up
    queue/applied/   → implemented (records the commit)
    queue/rejected/  → human said no. NEVER re-file a matching finding.
    queue/deferred/  → "let it sit" — not now, but don't suppress forever

WHY THE VALIDATION RULES BELOW EXIST
------------------------------------
This queue is fed by an agent reading token-usage telemetry, and telemetry
alone is a proven liar about what is *currently* broken. In the 2026-08-25
audit session that motivated this tool, the analyst (Claude) twice reported a
role as an active cost bug based on a 14-day aggregate, when in both cases the
fix had already landed *inside that window*:

  - 0daynews.com page-designer — replaced by a deterministic script 2026-08-19;
    every AI call in the window predated the cutover.
  - newmomshop.com engineer — gated behind bash pre-checks 2026-08-19
    (862 calls before, 7 after). The aggregate showed 391 calls / $36 and
    looked like a live unconditional-invocation bug.

Both would have become tickets. An implementer acting on them would have
"fixed" already-fixed code. So a ticket is only well-formed if the analyst
went and looked at the CURRENT code and git history, not just the ledger:
`evidence_files` + `verified_current_code` + `verified_git_check` are
mandatory, and `validate()` rejects the ticket without them.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import date
from pathlib import Path

STATUSES = ("proposed", "approved", "applied", "rejected", "deferred")

# Terminal decisions. A finding whose dedupe key matches a ticket in one of
# these is NOT re-filed — rejected means "we considered this and said no", and
# re-proposing it every morning is exactly the noise this queue exists to avoid.
SUPPRESSING_STATUSES = ("proposed", "approved", "applied", "rejected", "deferred")

QUEUE_ROOT = Path(__file__).resolve().parents[1] / "queue"

RISK_LEVELS = ("low", "medium", "high")
SCOPES = ("site", "fleet")

# Fields the analyst must supply. See module docstring for why the evidence
# fields are non-negotiable.
REQUIRED_FIELDS = (
    "title",
    "finding_class",
    "scope",
    "window_from",
    "window_to",
    "measured_cost_usd",
    "evidence_files",
    "verified_current_code",
    "verified_git_check",
    "risk",
)


class ValidationError(ValueError):
    """A ticket that does not meet the evidence bar."""


# --- frontmatter (same flat contract as tasks.js / guideQueue.js) ----------

def _parse_scalar(val: str):
    v = val.strip()
    # A `>-` / `|` block scalar means someone wrote real multi-line YAML that
    # this flat parser cannot represent. Fail loudly rather than silently
    # returning ">-" as the value — during bring-up an unconstrained js-yaml
    # dump did exactly that and quietly ate two fields off a live ticket.
    if v in (">", ">-", "|", "|-", ">+", "|+"):
        raise ValidationError(
            "block scalars are not supported in this queue's frontmatter — "
            "writers must emit one line per key (see aioptimizer.js's dump options)"
        )
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        inner = v[1:-1]
        # js-yaml escapes embedded quotes/backslashes; undo that.
        return inner.replace('\\"', '"').replace("\\\\", "\\") if v[0] == '"' else inner
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(p) for p in _split_list(inner)]
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "~", ""):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v


def _split_list(inner: str):
    """Split a flow-list body on commas that aren't inside quotes."""
    parts, buf, quote = [], [], None
    for ch in inner:
        if quote:
            if ch == quote:
                quote = None
            buf.append(ch)
        elif ch in "\"'":
            quote = ch
            buf.append(ch)
        elif ch == ",":
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return [p for p in (p.strip() for p in parts) if p]


def parse(text: str):
    """Split a ticket file into (meta, body). Tolerant of a missing header."""
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        km = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not km:
            continue
        meta[km.group(1)] = _parse_scalar(km.group(2))
    return meta, m.group(2)


def _dump_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_dump_scalar(x) for x in v) + "]"
    s = str(v)
    if s == "" or re.search(r'[:#\[\]{}",]|^\s|\s$', s):
        return '"' + s.replace('"', '\\"') + '"'
    return s


FIELD_ORDER = (
    "ticket_id", "status", "title", "created", "decided", "finding_class",
    "dedupe_key", "scope", "sites", "role", "window_from", "window_to",
    "measured_cost_usd", "estimated_savings_usd_per_day", "risk",
    "verified_current_code", "verified_git_check", "evidence_files",
    "applied_commit", "decided_by", "decision_note",
)


def serialize(meta: dict, body: str) -> str:
    clean = {k: v for k, v in meta.items() if v is not None and v != "" and v != []}
    ordered = {k: clean.pop(k) for k in FIELD_ORDER if k in clean}
    ordered.update(clean)
    fm = "\n".join(f"{k}: {_dump_scalar(v)}" for k, v in ordered.items())
    return f"---\n{fm}\n---\n\n{(body or '').strip()}\n"


# --- identity + dedup ------------------------------------------------------

def slugify(s: str, limit: int = 60) -> str:
    s = unicodedata.normalize("NFKD", str(s or "finding"))
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return (s[:limit].strip("-")) or "finding"


def dedupe_key(finding_class: str, scope: str, sites, role) -> str:
    """Stable identity for 'the same finding'.

    Deliberately NOT the title (an agent rewords it every run) and not the
    dollar figure (drifts daily). Class + the thing it's about is what makes
    two findings the same finding.
    """
    site_part = ",".join(sorted(sites or [])) if scope == "site" else "*fleet*"
    raw = f"{slugify(finding_class)}|{scope}|{site_part}|{role or '*'}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# --- validation ------------------------------------------------------------

def validate(meta: dict) -> dict:
    """Raise ValidationError unless the ticket meets the evidence bar."""
    missing = [f for f in REQUIRED_FIELDS if meta.get(f) in (None, "", [])]
    if missing:
        raise ValidationError(f"missing required field(s): {', '.join(missing)}")

    if meta["scope"] not in SCOPES:
        raise ValidationError(f"scope must be one of {SCOPES}")
    if meta["scope"] == "site" and not meta.get("sites"):
        raise ValidationError("scope=site requires a non-empty `sites` list")
    if meta["risk"] not in RISK_LEVELS:
        raise ValidationError(f"risk must be one of {RISK_LEVELS}")

    # THE core rule — see module docstring. A finding read off the ledger with
    # no confirmation that the live code still has the problem is exactly the
    # false positive this queue exists to stop.
    if meta.get("verified_current_code") is not True:
        raise ValidationError(
            "verified_current_code must be true — read the CURRENT role/script "
            "and confirm the issue is still live before filing. Telemetry alone "
            "cannot tell you whether a fix already landed inside your window."
        )
    if not str(meta.get("verified_git_check") or "").strip():
        raise ValidationError(
            "verified_git_check must record the git evidence you checked "
            "(e.g. 'git log -3 ops/scripts/run-role.sh — last touched 2026-07-02, "
            "no gating commit in window')"
        )
    ev = meta.get("evidence_files")
    if not isinstance(ev, list) or not ev:
        raise ValidationError("evidence_files must be a non-empty list of file[:line] refs")

    for f in ("window_from", "window_to"):
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(meta[f])):
            raise ValidationError(f"{f} must be YYYY-MM-DD")
    if str(meta["window_from"]) > str(meta["window_to"]):
        raise ValidationError("window_from must not be after window_to")

    try:
        cost = float(meta["measured_cost_usd"])
    except (TypeError, ValueError):
        raise ValidationError("measured_cost_usd must be a number")
    if cost <= 0:
        raise ValidationError("measured_cost_usd must be > 0 — no ticket without measured spend")
    return meta


# --- queue ops -------------------------------------------------------------

def status_dir(status: str, root: Path | None = None) -> Path:
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r}")
    return (root or QUEUE_ROOT) / status


def _iter_files(root: Path | None = None):
    for status in STATUSES:
        d = status_dir(status, root)
        if not d.is_dir():
            continue
        for fp in sorted(d.glob("*.md")):
            yield status, fp


def load(fp: Path):
    meta, body = parse(fp.read_text(encoding="utf-8"))
    return meta, body


def list_tickets(root: Path | None = None, status: str | None = None):
    out = []
    for st, fp in _iter_files(root):
        if status and st != status:
            continue
        meta, body = load(fp)
        excerpt = re.sub(r"^#.*$", "", body, flags=re.M)
        excerpt = re.sub(r"\s+", " ", excerpt).strip()[:200]
        out.append({
            "file": fp.name,
            "status": st,
            "ticket_id": meta.get("ticket_id") or fp.stem,
            "title": meta.get("title") or fp.stem,
            "finding_class": meta.get("finding_class"),
            "dedupe_key": meta.get("dedupe_key"),
            "scope": meta.get("scope"),
            "sites": meta.get("sites") or [],
            "role": meta.get("role"),
            "measured_cost_usd": meta.get("measured_cost_usd"),
            "estimated_savings_usd_per_day": meta.get("estimated_savings_usd_per_day"),
            "risk": meta.get("risk"),
            "created": str(meta.get("created") or ""),
            "window_from": str(meta.get("window_from") or ""),
            "window_to": str(meta.get("window_to") or ""),
            "evidence_files": meta.get("evidence_files") or [],
            "verified_git_check": meta.get("verified_git_check"),
            "applied_commit": meta.get("applied_commit"),
            "decision_note": meta.get("decision_note"),
            "excerpt": excerpt,
        })
    return out


def find_by_dedupe_key(key: str, root: Path | None = None):
    """Return (status, file) of any existing ticket with this key, else None."""
    for st, fp in _iter_files(root):
        meta, _ = load(fp)
        if meta.get("dedupe_key") == key:
            return st, fp
    return None


def file_ticket(meta: dict, body: str, root: Path | None = None, force: bool = False):
    """Validate + write a new ticket into proposed/. Returns (path, 'created'|'suppressed')."""
    meta = dict(meta)
    meta.setdefault("created", date.today().isoformat())
    meta.setdefault("status", "proposed")
    validate(meta)

    key = dedupe_key(meta["finding_class"], meta["scope"], meta.get("sites"), meta.get("role"))
    meta["dedupe_key"] = key

    existing = find_by_dedupe_key(key, root)
    if existing and not force:
        return existing[1], f"suppressed (duplicate of {existing[0]}/{existing[1].name})"

    tid = meta.get("ticket_id") or f"{meta['created']}-{slugify(meta['title'])}"
    meta["ticket_id"] = tid
    d = status_dir("proposed", root)
    d.mkdir(parents=True, exist_ok=True)
    fp, n = d / f"{tid}.md", 2
    while fp.exists():
        fp = d / f"{tid}-{n}.md"
        n += 1
    fp.write_text(serialize(meta, body), encoding="utf-8")
    return fp, "created"


def move(file: str, to_status: str, root: Path | None = None, note: str | None = None,
         by: str | None = None, commit: str | None = None):
    """Move a ticket between columns, keeping frontmatter in sync."""
    if to_status not in STATUSES:
        raise ValueError(f"unknown status {to_status!r}")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.md$", file) or ".." in file:
        raise ValueError("bad filename")
    src = None
    for st, fp in _iter_files(root):
        if fp.name == file:
            src = (st, fp)
            break
    if not src:
        raise FileNotFoundError(f"ticket {file} not found")
    from_status, fp = src
    meta, body = load(fp)
    meta["status"] = to_status
    meta["decided"] = date.today().isoformat()
    if note:
        meta["decision_note"] = note
    if by:
        meta["decided_by"] = by
    if commit:
        meta["applied_commit"] = commit
    dest_dir = status_dir(to_status, root)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / fp.name
    dest.write_text(serialize(meta, body), encoding="utf-8")
    if dest != fp:
        fp.unlink()
    return {"from": from_status, "to": to_status, "file": dest.name}
