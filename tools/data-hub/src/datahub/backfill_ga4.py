"""One-shot GA4 backfill: ~16 months, chunked ~3 months per call (date as a
dimension gets one row per day per call — this is 6 calls, not 487). GSC has
no equivalent: its data does not exist for us until the day the domain was
verified, so there is nothing to backfill (see the pipeline design spec)."""
from __future__ import annotations

from datetime import date, timedelta

from .metrics.ga4 import _rows_to_records, METRIC_MAP


def _chunk_ranges(months: int, chunk_months: int, today: date) -> list[tuple[str, str]]:
    chunk_end = today - timedelta(days=1)
    chunks = []
    remaining = months
    while remaining > 0:
        span = min(chunk_months, remaining)
        chunk_start = chunk_end.replace(day=1)
        for _ in range(span - 1):
            prev_month_end = chunk_start - timedelta(days=1)
            chunk_start = prev_month_end.replace(day=1)
        chunks.append((chunk_start.isoformat(), chunk_end.isoformat()))
        chunk_end = chunk_start - timedelta(days=1)
        remaining -= span
    return list(reversed(chunks))


def backfill_site(client, property_id: str, *, months: int = 16, chunk_months: int = 3,
                  today: date | None = None) -> list[dict]:
    all_records: list[dict] = []
    for start, end in _chunk_ranges(months, chunk_months, today or date.today()):
        body = {
            "dateRanges": [{"startDate": start, "endDate": end}],
            "dimensions": [{"name": "date"}],
            "metrics": [{"name": n} for n, _ in METRIC_MAP],
            "returnPropertyQuota": True,
        }
        response = client.properties().runReport(property=f"properties/{property_id}", body=body).execute()
        all_records.extend(_rows_to_records(response, grain="site", has_dim_key=False))
    return all_records
