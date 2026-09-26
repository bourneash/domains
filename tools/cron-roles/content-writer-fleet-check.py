#!/usr/bin/env python3
"""Audit content-writer runners for shared hardening hooks."""
from __future__ import annotations
import argparse, json
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2]); ap.add_argument('--json', action='store_true'); ap.add_argument('--strict', action='store_true'); args = ap.parse_args()
    shared_preflight = (args.root / 'tools/fleet-images/worker/entrypoint.sh').read_text(errors='replace')
    shared_runtime_preflight = 'content-writer-runtime-preflight.sh' in shared_preflight
    rows = []
    for script in sorted((args.root / 'sites').glob('*/ops/scripts/run-role.sh')):
        text = script.read_text(errors='replace')
        if 'content-writer' not in text: continue
        rows.append({'site': script.parts[-4], 'script': str(script.relative_to(args.root)), 'policy': 'content-writer-policy.sh' in text, 'sandbox': 'writer_sandbox_exec' in text or 'bwrap' in text, 'quality_gate': 'content-writer-quality.py' in text, 'observed_mode': 'CONTENT_WRITER_OBSERVED' in text, 'shared_runtime_preflight': shared_runtime_preflight})
    if args.json: print(json.dumps({'shared_runtime_preflight': shared_runtime_preflight, 'sites': rows, 'transaction_hardened': sum(all(r[k] for k in ('policy','sandbox','quality_gate')) for r in rows), 'total': len(rows)}, indent=2))
    else:
        for row in rows:
            missing = [k for k in ('policy','sandbox','quality_gate') if not row[k]]; print(f"{row['site']}: {'OK' if not missing else 'MISSING ' + ','.join(missing)}")
        print(f"content-writer fleet: {sum(not any(not r[k] for k in ('policy','sandbox','quality_gate')) for r in rows)}/{len(rows)} transaction-hardened; shared runtime preflight={'yes' if shared_runtime_preflight else 'no'}")
    return 1 if args.strict and any(not all(r[k] for k in ('policy','sandbox','quality_gate')) for r in rows) else 0

if __name__ == '__main__': raise SystemExit(main())
