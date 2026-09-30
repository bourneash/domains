#!/usr/bin/env python3
"""Fleet AI token-usage aggregator.

Reads the per-site ledgers written by `tools/scripts/claude-tracked.sh`
(`ops/logs/token-usage-<UTC date>.jsonl`, one JSON object per `claude -p`
call) and rolls them up into a fleet-wide report: totals by site, by
(site, role), by day, plus a cache-hit ratio and an honest list of which
sites have no ledger data yet (most of the fleet, until each site's
`run-role.sh` is migrated per tools/cron-roles/WIRING.md Step 6.5).

Usage:
    python3 tools/ai-usage/aggregate.py
    python3 tools/ai-usage/aggregate.py --json
    python3 tools/ai-usage/aggregate.py --root /path/to/domains --json
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import date, datetime, timezone
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[2]

NUMERIC_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)
LEDGER_SCHEMA_VERSION = 1
TRANSIENT_FAILURE_CLASSES = frozenset({
    "zero_cost_failure", "parse_error", "network_preflight_failed",
})
KNOWN_SUBTYPES = frozenset({
    "success", "error_max_turns", "error_during_execution", "parse_error",
    "network_preflight_failed", "account_usage_exhausted", "authentication_failed",
})

DIRECT_CLAUDE_CALL = re.compile(r"\btimeout\b.*\bclaude\s+-p\b")
PYTHON_CLAUDE_CALL = re.compile(r"[\[\(]\s*['\"]claude['\"]\s*,\s*['\"]-p['\"]")
LOCAL_MODEL_CALL = re.compile(r"(?:chat\.completions\.create|/api/chat|/v1/chat/completions)")


# failure_class values claude-tracked.sh already retries once, in-run, for free
# (see its "Single same-run retry" comment) — the CLI hiccupped before any
# billable work started and the wrapper's own retry usually clears it. A record
# still tagged with one of these after that retry cost nothing and self-heals
# on the site's next scheduled tick, so counting it alongside a real failure
# (a stuck deploy, a bad diagnosis, a genuine account/auth problem) makes a
# healthy fleet look like it has a reliability problem when it doesn't
# (2026-08-27 audit: weirdgirlstore/amputeenews "errors" were entirely this).
def _empty_totals() -> dict:
    return {
        "calls": 0,
        "errors": 0,
        "transient_errors": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "total_cost_usd": 0.0,
    }


def _add(totals: dict, record: dict) -> None:
    totals["calls"] += 1
    if record.get("is_error"):
        if record.get("failure_class") in TRANSIENT_FAILURE_CLASSES:
            totals["transient_errors"] += 1
        else:
            totals["errors"] += 1
    for field in NUMERIC_FIELDS:
        totals[field] += record.get(field) or 0
    totals["total_cost_usd"] += record.get("total_cost_usd") or 0.0


def _cache_hit_ratio(totals: dict) -> float | None:
    denom = totals["input_tokens"] + totals["cache_read_input_tokens"]
    if denom == 0:
        return None
    return round(totals["cache_read_input_tokens"] / denom, 4)


def _utc_hour(record: dict) -> str | None:
    """Return the record's UTC hour bucket, if its event timestamp is valid.

    Ledger filenames are only day-granular.  Hourly reporting must use the
    timestamp captured with the call, so old/imported rows without one remain
    in the daily totals but are intentionally absent from hourly totals.
    """
    value = record.get("recorded_at_unix")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    except (OverflowError, OSError, ValueError):
        return None


def wiring_status(site_dir: Path) -> str:
    """Classify all executable AI call sites, not only run-role.sh.

    Bash-driven roles commonly call Claude from an engineer, watchdog, or
    writer helper.  Checking only the dispatcher made the old dashboard claim
    that a site was wired while its actual AI calls were invisible.
    """
    ops_dir = site_dir / "ops"
    scripts_dir = ops_dir / "scripts"
    llm_dir = ops_dir / "llm"
    if not scripts_dir.is_dir() and not llm_dir.is_dir():
        return "no_ai_role"

    tracked = 0
    untracked = 0
    for script in scripts_dir.rglob("*.sh"):
        for line in script.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.lstrip()
            if not stripped or stripped.startswith("#"):
                continue
            if DIRECT_CLAUDE_CALL.search(line) or PYTHON_CLAUDE_CALL.search(line):
                untracked += 1
            if '"$CLAUDE_TRACKED"' in line or "${CLAUDE_TRACKED}" in line:
                tracked += 1

    # Local OpenAI-compatible/Ollama clients cannot use the Claude wrapper;
    # they are wired when they emit provider-neutral records through record.py.
    for client in llm_dir.rglob("*.py") if llm_dir.is_dir() else ():
        if "tests" in client.relative_to(llm_dir).parts:
            continue
        text = client.read_text(encoding="utf-8", errors="ignore")
        if LOCAL_MODEL_CALL.search(text):
            if "record.py" in text:
                tracked += 1
            else:
                untracked += 1

    if untracked:
        return "not_wired"
    if tracked:
        return "wired_awaiting_first_run"
    return "no_ai_role"


def coverage_row(site_dir: Path, has_ledger: bool) -> dict:
    status = wiring_status(site_dir)
    return {
        "site": site_dir.name,
        "status": "reporting" if has_ledger else status,
        "has_ledger": has_ledger,
    }


def read_ledger_records(ledger: Path, diagnostics: dict | None = None) -> list[dict]:
    records = []
    for line in ledger.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            if diagnostics is not None:
                diagnostics["malformed_json"] = diagnostics.get("malformed_json", 0) + 1
            continue
    return records


def _validate_record(record: object) -> tuple[dict | None, str | None]:
    """Validate the producer contract without rejecting legacy v1 rows."""
    if not isinstance(record, dict):
        return None, "not_object"
    version = record.get("schema_version", LEDGER_SCHEMA_VERSION)
    if version != LEDGER_SCHEMA_VERSION:
        return None, f"unsupported_schema_version:{version}"
    for field in ("site", "role"):
        if not isinstance(record.get(field), str) or not record[field].strip():
            return None, f"missing_{field}"
    # Rows written before subtype was added are ordinary successful calls.
    if "subtype" not in record:
        record = {**record, "subtype": "success"}
    if "is_error" in record and not isinstance(record["is_error"], bool):
        return None, "is_error_not_bool"
    if "exit_status" in record and (
        isinstance(record["exit_status"], bool)
        or not isinstance(record["exit_status"], int)
    ):
        return None, "exit_status_not_int"
    for field in ("requested_max_turns", "recorded_at_unix"):
        value = record.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            return None, f"{field}_not_int"
    if "model_drift" in record and not isinstance(record["model_drift"], bool):
        return None, "model_drift_not_bool"
    for field in (*NUMERIC_FIELDS, "total_cost_usd", "duration_ms", "num_turns"):
        value = record.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            return None, f"{field}_not_numeric"
        if isinstance(value, (int, float)):
            if isinstance(value, float) and not math.isfinite(value):
                return None, f"{field}_not_finite"
            if value < 0:
                return None, f"{field}_negative"
    return record, None


def classify_alert(record: dict) -> dict:
    """Return stable alert semantics for one validated ledger record."""
    subtype = record.get("subtype") or "unknown"
    failure_class = record.get("failure_class") or subtype
    requested_turns = record.get("requested_max_turns")
    hit_max_turns = bool(
        isinstance(requested_turns, int) and not isinstance(requested_turns, bool)
        and requested_turns > 1 and subtype == "error_max_turns"
    )
    inconsistent_failure = record.get("exit_status", 0) != 0 and not record.get("is_error", False)
    is_error = bool(record.get("is_error")) or inconsistent_failure
    transient = failure_class in TRANSIENT_FAILURE_CLASSES
    model_drift = bool(record.get("model_drift"))
    if hit_max_turns:
        kind, severity = "max_turns", 2
    elif model_drift:
        kind, severity = "model_drift", 2
    elif is_error:
        kind, severity = "transient_failure" if transient else "failure", 1 if transient else 3
    else:
        kind, severity = None, 0
    return {
        "alert_kind": kind,
        "severity": severity,
        "actionable": bool(kind and not transient),
        "hit_max_turns": hit_max_turns,
        "is_error": is_error,
        "inconsistent_failure": inconsistent_failure,
        "model_drift": model_drift,
        "failure_class": failure_class,
    }


def collect(root: Path = DEFAULT_ROOT, start_day: str | None = None,
            end_day: str | None = None) -> dict:
    """Build a report, optionally limited to inclusive UTC ledger dates."""
    if start_day and end_day and start_day > end_day:
        raise ValueError("start_day must not be after end_day")
    sites_dir = root / "sites"
    by_site: dict[str, dict] = {}
    by_site_role: dict[tuple[str, str], dict] = {}
    by_day: dict[str, dict] = {}
    by_day_site_role: dict[tuple[str, str, str], dict] = {}
    by_hour: dict[str, dict] = {}
    by_hour_site_role: dict[tuple[str, str, str], dict] = {}
    by_model: dict[tuple[str, str], dict] = {}
    by_requested_model: dict[str, dict] = {}
    by_site_role_drift: dict[tuple[str, str], dict] = {}
    by_site_role_mixed_compaction: dict[tuple[str, str], dict] = {}
    alerts: list[dict] = []
    incidents: dict[tuple[str, str, str], dict] = {}
    diagnostics = {"malformed_json": 0, "invalid_records": 0, "invalid_record_reasons": {},
                   "unknown_subtypes": {}}
    instrumented_sites: set[str] = set()
    all_sites: list[str] = []

    if sites_dir.is_dir():
        all_sites = sorted(p.name for p in sites_dir.iterdir() if p.is_dir())

    # Fleet-level roles (tools/ai-optimizer's analyst + implementer) write to
    # <root>/ops/logs with CRON_SITE="_fleet" — they belong to no single site.
    # Without this they were invisible here, which meant the AI-cost optimizer
    # was the one AI spend the AI-cost dashboard could not see.
    ledger_dirs = [(name, sites_dir / name / "ops" / "logs") for name in all_sites]
    if (root / "ops" / "logs").is_dir():
        ledger_dirs.append(("_fleet", root / "ops" / "logs"))

    for site_name, log_dir in ledger_dirs:
        if not log_dir.is_dir():
            continue
        for ledger in sorted(log_dir.glob("token-usage-*.jsonl")):
            day = ledger.stem.removeprefix("token-usage-")
            if start_day and day < start_day:
                continue
            if end_day and day > end_day:
                continue
            for raw_record in read_ledger_records(ledger, diagnostics):
                record, invalid_reason = _validate_record(raw_record)
                if invalid_reason:
                    diagnostics["invalid_records"] += 1
                    reasons = diagnostics["invalid_record_reasons"]
                    reasons[invalid_reason] = reasons.get(invalid_reason, 0) + 1
                    continue
                assert record is not None
                site = record.get("site") or site_name
                role = record.get("role") or "unknown"
                instrumented_sites.add(site)

                _add(by_site.setdefault(site, _empty_totals()), record)
                _add(by_site_role.setdefault((site, role), _empty_totals()), record)
                _add(by_day.setdefault(day, _empty_totals()), record)
                _add(by_day_site_role.setdefault((day, site, role), _empty_totals()), record)
                hour = _utc_hour(record)
                if hour:
                    _add(by_hour.setdefault(hour, _empty_totals()), record)
                    _add(by_hour_site_role.setdefault((hour, site, role), _empty_totals()), record)
                provider = record.get("provider") or "Anthropic / Claude Code CLI"
                model = record.get("model") or "unresolved"
                _add(by_model.setdefault((provider, model), _empty_totals()), record)
                requested_model = record.get("requested_model")
                if requested_model:
                    _add(by_requested_model.setdefault(requested_model, _empty_totals()), record)
                requested_turns = record.get("requested_max_turns")
                turns = record.get("num_turns") or 0
                alert = classify_alert(record)
                subtype = record.get("subtype")
                if subtype not in KNOWN_SUBTYPES:
                    diagnostics["unknown_subtypes"][subtype] = diagnostics["unknown_subtypes"].get(subtype, 0) + 1
                is_error = alert["is_error"]
                hit_max_turns = alert["hit_max_turns"]
                is_model_drift = alert["model_drift"]
                if is_model_drift:
                    _add(by_site_role_drift.setdefault((site, role), _empty_totals()), record)
                if record.get("model_drift_kind") == "mixed_compaction":
                    _add(by_site_role_mixed_compaction.setdefault((site, role), _empty_totals()), record)
                if alert["alert_kind"]:
                    alert_row = {
                        "day": day, "site": site, "role": role, "provider": provider,
                        "model": model, "requested_model": requested_model,
                        "num_turns": turns, "requested_max_turns": requested_turns,
                        "recorded_at_unix": record.get("recorded_at_unix"),
                        "is_error": is_error, "exit_status": record.get("exit_status", 0),
                        "hit_max_turns": hit_max_turns, "model_drift": is_model_drift,
                        "model_drift_kind": record.get("model_drift_kind") or (
                            "family_drift" if is_model_drift else None
                        ),
                        "subtype": subtype, "failure_class": alert["failure_class"],
                        "alert_kind": alert["alert_kind"], "severity": alert["severity"],
                        "actionable": alert["actionable"],
                        "inconsistent_failure": alert["inconsistent_failure"],
                        "total_cost_usd": record.get("total_cost_usd") or 0.0,
                    }
                    alerts.append(alert_row)
                    incident_key = (alert_row["alert_kind"], alert_row["failure_class"],
                                    alert_row["model"] if alert_row["alert_kind"] == "model_drift" else "")
                    incident = incidents.setdefault(incident_key, {
                        "alert_kind": alert_row["alert_kind"], "failure_class": alert_row["failure_class"],
                        "model": incident_key[2] or None, "severity": alert_row["severity"],
                        "calls": 0, "sites": set(), "roles": set(), "total_cost_usd": 0.0,
                        "first_day": day, "last_day": day,
                    })
                    incident["calls"] += 1
                    incident["sites"].add(site)
                    incident["roles"].add(role)
                    incident["total_cost_usd"] += alert_row["total_cost_usd"]
                    incident["first_day"] = min(incident["first_day"], day)
                    incident["last_day"] = max(incident["last_day"], day)

    site_rows = []
    for site, totals in sorted(by_site.items()):
        row = {"site": site, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)}
        site_rows.append(row)

    role_rows = []
    for (site, role), totals in sorted(by_site_role.items()):
        row = {"site": site, "role": role, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)}
        role_rows.append(row)

    day_rows = []
    for day, totals in sorted(by_day.items()):
        row = {"day": day, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)}
        day_rows.append(row)

    day_site_role_rows = []
    for (day, site, role), totals in sorted(by_day_site_role.items()):
        day_site_role_rows.append({
            "day": day, "site": site, "role": role, **totals,
            "cache_hit_ratio": _cache_hit_ratio(totals),
        })

    hour_rows = []
    for hour, totals in sorted(by_hour.items()):
        hour_rows.append({"hour": hour, **totals, "cache_hit_ratio": _cache_hit_ratio(totals)})

    hour_site_role_rows = []
    for (hour, site, role), totals in sorted(by_hour_site_role.items()):
        hour_site_role_rows.append({
            "hour": hour, "site": site, "role": role, **totals,
            "cache_hit_ratio": _cache_hit_ratio(totals),
        })

    model_rows = []
    for (provider, model), totals in sorted(by_model.items()):
        model_rows.append({"provider": provider, "model": model, **totals,
                           "cache_hit_ratio": _cache_hit_ratio(totals)})
    requested_model_rows = []
    for model, totals in sorted(by_requested_model.items()):
        requested_model_rows.append({"requested_model": model, **totals,
                                     "cache_hit_ratio": _cache_hit_ratio(totals)})

    model_drift_rows = []
    for (site, role), totals in sorted(by_site_role_drift.items()):
        model_drift_rows.append({"site": site, "role": role, **totals})
    model_drift_calls = sum(row["calls"] for row in model_drift_rows)
    model_drift_cost_usd = sum(row["total_cost_usd"] for row in model_drift_rows)
    mixed_compaction_rows = [
        {"site": site, "role": role, **totals}
        for (site, role), totals in sorted(by_site_role_mixed_compaction.items())
    ]
    mixed_compaction_calls = sum(row["calls"] for row in mixed_compaction_rows)
    mixed_compaction_cost_usd = sum(row["total_cost_usd"] for row in mixed_compaction_rows)

    fleet_totals = _empty_totals()
    for totals in by_site.values():
        for field in (*NUMERIC_FIELDS, "calls", "errors", "transient_errors"):
            fleet_totals[field] += totals[field]
        fleet_totals["total_cost_usd"] += totals["total_cost_usd"]

    uninstrumented_sites = sorted(set(all_sites) - instrumented_sites)
    wired_awaiting_first_run = []
    not_wired = []
    no_ai_role = []
    for site_name in uninstrumented_sites:
        status = wiring_status(sites_dir / site_name)
        if status == "wired_awaiting_first_run":
            wired_awaiting_first_run.append(site_name)
        elif status == "not_wired":
            not_wired.append(site_name)
        else:
            no_ai_role.append(site_name)

    coverage = [coverage_row(sites_dir / site_name, site_name in instrumented_sites)
                for site_name in all_sites]

    return {
        "summary": {
            **fleet_totals,
            "cache_hit_ratio": _cache_hit_ratio(fleet_totals),
            "sites_total": len(all_sites),
            "sites_instrumented": len(instrumented_sites),
            "sites_uninstrumented": uninstrumented_sites,
            "sites_wired_awaiting_first_run": wired_awaiting_first_run,
            "sites_not_wired": not_wired,
            "sites_no_ai_role": no_ai_role,
            "coverage_complete": not not_wired,
            "model_drift_calls": model_drift_calls,
            "model_drift_cost_usd": model_drift_cost_usd,
            "mixed_compaction_calls": mixed_compaction_calls,
            "mixed_compaction_cost_usd": mixed_compaction_cost_usd,
            "ledger_malformed_json": diagnostics["malformed_json"],
            "ledger_invalid_records": diagnostics["invalid_records"],
            "ledger_unknown_subtypes": diagnostics["unknown_subtypes"],
        },
        "by_site": site_rows,
        "by_site_role": role_rows,
        "by_day": day_rows,
        "by_day_site_role": day_site_role_rows,
        "by_hour": hour_rows,
        "by_hour_site_role": hour_site_role_rows,
        "by_model": model_rows,
        "by_requested_model": requested_model_rows,
        "by_site_role_model_drift": model_drift_rows,
        "by_site_role_mixed_compaction": mixed_compaction_rows,
        # Hard failures rank above cost. Ranking purely by spend buried the
        # 2026-09-01 outage: 24 roles across 10 sites died on "401 OAuth access
        # token has been revoked", and because a call that never authenticates
        # bills $0.00 they sorted to the BOTTOM of this list -- below ordinary
        # expensive-but-healthy calls -- and fell off the Fleet Dashboard's
        # top-10 (public/app.js takes alerts.slice(0, 10)). A whole-fleet auth
        # outage was invisible for exactly the reason it was severe. A failed
        # call is the cheapest and the worst thing in this list, so is_error
        # leads the sort and cost only breaks ties within each group.
        "alerts": sorted(alerts, key=lambda row: (
            -row["severity"], -row["total_cost_usd"], row["day"], row["site"], row["role"]
        )),
        "incidents": sorted(({
            **row, "sites": sorted(row["sites"]), "roles": sorted(row["roles"]),
        } for row in incidents.values()), key=lambda row: (
            -row["severity"], -row["calls"], row["first_day"], row["failure_class"]
        )),
        "diagnostics": diagnostics,
        "filters": {"from": start_day, "to": end_day},
        "coverage": coverage,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--from", dest="start_day", type=date.fromisoformat,
                        help="inclusive UTC ledger date (YYYY-MM-DD)")
    parser.add_argument("--to", dest="end_day", type=date.fromisoformat,
                        help="inclusive UTC ledger date (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    start_day = args.start_day.isoformat() if args.start_day else None
    end_day = args.end_day.isoformat() if args.end_day else None
    if start_day and end_day and start_day > end_day:
        parser.error("--from must not be after --to")
    report = collect(args.root.resolve(), start_day, end_day)

    if args.json:
        print(json.dumps(report, indent=2))
        return

    summary = report["summary"]
    print(f"Sites instrumented: {summary['sites_instrumented']}/{summary['sites_total']}")
    transient_note = (f", {summary['transient_errors']} self-healed (zero-cost, ignore)"
                       if summary["transient_errors"] else "")
    print(f"Total calls: {summary['calls']} ({summary['errors']} errors{transient_note})")
    print(f"Total cost (USD): {summary['total_cost_usd']:.2f}")
    print(f"Input tokens: {summary['input_tokens']:,}  Output tokens: {summary['output_tokens']:,}")
    print(f"Cache read: {summary['cache_read_input_tokens']:,}  "
          f"Cache write: {summary['cache_creation_input_tokens']:,}  "
          f"Cache hit ratio: {summary['cache_hit_ratio']}")
    if summary["sites_wired_awaiting_first_run"]:
        print(f"\nWired, awaiting first cron fire ({len(summary['sites_wired_awaiting_first_run'])}): "
              + ", ".join(summary["sites_wired_awaiting_first_run"]))
    if summary["sites_not_wired"]:
        print(f"\nHas AI calls but NOT wired to claude-tracked.sh yet ({len(summary['sites_not_wired'])}): "
              + ", ".join(summary["sites_not_wired"]))
    if summary["sites_no_ai_role"]:
        print(f"\nNo AI cron role at all ({len(summary['sites_no_ai_role'])}): "
              + ", ".join(summary["sites_no_ai_role"]))
    if summary["model_drift_calls"]:
        print(f"\nModel drift (requested != actual model family): "
              f"{summary['model_drift_calls']} calls, "
              f"${summary['model_drift_cost_usd']:.2f}")
    print("\n| Site | Role | Calls | Errors | In | Out | Cache R | Cache W | Cost USD | Cache hit |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in report["by_site_role"]:
        print(f"| {row['site']} | {row['role']} | {row['calls']} | {row['errors']} | "
              f"{row['input_tokens']:,} | {row['output_tokens']:,} | "
              f"{row['cache_read_input_tokens']:,} | {row['cache_creation_input_tokens']:,} | "
              f"{row['total_cost_usd']:.4f} | {row['cache_hit_ratio']} |")


if __name__ == "__main__":
    main()
