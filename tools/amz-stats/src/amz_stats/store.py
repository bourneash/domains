"""Snapshot persistence for amz-stats.

write_snapshot appends the snapshot to a daily JSONL file and overwrites
the ``latest.json`` convenience pointer — both in ``out_dir``.
"""
from __future__ import annotations

import json
from pathlib import Path


def write_snapshot(snap: dict, out_dir: Path) -> None:
    """Persist ``snap`` to ``out_dir``.

    - Appends a compact JSON line to ``out_dir/amz-stats-<YYYY-MM-DD>.jsonl``
      (day derived from ``snap["timestamp"][:10]``).
    - Overwrites ``out_dir/latest.json`` with a pretty-printed copy.

    ``out_dir`` is created (including parents) if it does not exist.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = snap.get("timestamp")
    if not ts:
        raise ValueError("snap must contain 'timestamp'")
    day = ts[:10]
    jsonl_path = out_dir / f"amz-stats-{day}.jsonl"
    with jsonl_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(snap, separators=(",", ":")) + "\n")
    (out_dir / "latest.json").write_text(
        json.dumps(snap, indent=2) + "\n", encoding="utf-8"
    )
