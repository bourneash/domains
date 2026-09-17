#!/usr/bin/env python3
"""Write a clean affiliate-funnel baseline from data-hub and Amazon exports.

This deliberately keeps Amazon attribution separate from first-party traffic:
Amazon's tracking-ID report is account-level, while GA4/GSC are site-level.
"""
from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from datetime import date, timedelta, datetime, timezone
from pathlib import Path


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--api', default='http://127.0.0.1:4760')
    ap.add_argument('--earnings', default='tools/amz-stats/out/earnings-latest.json')
    ap.add_argument('--out', default='tools/affiliate-funnel/out/baseline-latest.json')
    args = ap.parse_args()
    end = date.today()
    start = end - timedelta(days=args.days - 1)
    q = urllib.parse.urlencode({'window': args.days})
    result = {
        'created_at': datetime.now(timezone.utc).isoformat(),
        'window': {'days': args.days, 'start': start.isoformat(), 'end': end.isoformat()},
        'first_party': None,
        'amazon': None,
        'errors': [],
    }
    try:
        health = get_json(f'{args.api.rstrip("/")}/metrics/health')
        # Summary is intentionally fleet-wide only when site is omitted.
        summary = get_json(f'{args.api.rstrip("/")}/metrics/summary?{q}')
        result['first_party'] = {'health': health, 'summary': summary}
    except Exception as exc:
        result['errors'].append(f'data-hub: {exc}')
    earnings = Path(args.earnings)
    if earnings.exists():
        try:
            raw = json.loads(earnings.read_text())
            rows = raw.get('rows', raw) if isinstance(raw, dict) else raw
            result['amazon'] = {
                'pulled_at': raw.get('pulled_at') if isinstance(raw, dict) else None,
                'days': raw.get('days') if isinstance(raw, dict) else None,
                'rows': rows,
                'note': 'Tracking-ID reports have no daily dimension; do not join these rows to individual dates.',
            }
        except Exception as exc:
            result['errors'].append(f'earnings: {exc}')
    else:
        result['errors'].append(f'earnings file missing: {earnings}')
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not result['errors'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
