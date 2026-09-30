#!/usr/bin/env python3
"""Append one provider-neutral AI usage event to a site's daily ledger."""
from __future__ import annotations

import argparse
import fcntl
import json
import math
import time
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--repo-root", type=Path, required=True)
    p.add_argument("--site", required=True)
    p.add_argument("--role", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--provider", required=True)
    p.add_argument("--input-tokens", type=int, default=0)
    p.add_argument("--output-tokens", type=int, default=0)
    p.add_argument("--cost-usd", type=float, default=0.0)
    args = p.parse_args()
    if any(value < 0 for value in (args.input_tokens, args.output_tokens, args.cost_usd)):
        p.error("token counts and cost must be non-negative")
    if not math.isfinite(args.cost_usd):
        p.error("cost must be finite")
    ledger = args.repo_root / "ops" / "logs" / f"token-usage-{time.strftime('%Y-%m-%d', time.gmtime())}.jsonl"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schema_version": 1,
        "recorded_at_unix": int(time.time()), "site": args.site, "role": args.role,
        "model": args.model, "provider": args.provider, "subtype": "success",
        "is_error": False, "exit_status": 0, "num_turns": 1, "duration_ms": None,
        "total_cost_usd": args.cost_usd, "input_tokens": args.input_tokens,
        "output_tokens": args.output_tokens, "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0, "session_id": None,
    }
    with ledger.open("a", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


if __name__ == "__main__":
    main()
