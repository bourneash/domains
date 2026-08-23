# amz-stats

Daily Amazon affiliate catalog snapshot collector. Scans every `sites/<domain>/site/src/lib/affiliate.ts` in the domains project for ASINs, calls the Amazon Creators API to check availability and pricing, and writes a JSONL snapshot + `latest.json` to `out/`.

## What it does

1. Harvests ASINs from `affiliate.ts` files across the fleet
2. Calls Amazon Creators API (`/catalog/v1/getItems`) in batches of 10
3. Records availability (IN_STOCK / OOS / UNKNOWN), price, rating, and image URL per ASIN
4. Writes `out/amz-stats-<YYYY-MM-DD>.jsonl` (appended) and `out/latest.json` (overwritten)
5. Appends a one-line summary to `out/cron.log`
6. **Auto-files backlog tasks** (`src/amz_stats/taskfiler.py`) for ASINs confirmed dead:
   an ASIN missing from `getItems` on 2 consecutive daily runs is independently
   verified with a direct HTTP fetch of `/dp/<ASIN>` before anything is filed —
   PA-API has been observed to persistently omit some live ASINs (likely a
   category/resource restriction, not delisting), so its "missing" signal
   alone is never trusted enough to act on. On a confirmed dead ASIN it
   writes `sites/<site>/ops/tasks/backlog/<date>-broken-affiliate-<id>.md`,
   commits, and pushes. It never edits `affiliate.ts` or picks a replacement
   — that's still a human/news-writer call. State lives in
   `out/asin_state.json` (gitignored).

## Setup

Credentials are read from the shared fleet `.env` (mounted at `/work/.env.shared`):

```
AMAZON_CREATORS_KEY_ID=...
AMAZON_CREATORS_KEY_SECRET=...
AMAZON_ASSOCIATES_STORE_ID=...
```

The domains root is mounted **read-write** at the same absolute host path
(`$HOME/projects/domains`, not `/work/domains`) — required for taskfiler's
git commits — along with `~/.ssh` and `~/.gitconfig` (both read-only) so it
can push using the host's `github-bourneash` deploy key and git identity.

## Bring up

```sh
docker compose up -d
```

## Watch logs

```sh
docker compose logs -f
```

## Force run

```sh
docker compose exec collector amz-stats collect --out-dir /work/out --domains-root "$HOME/projects/domains"
```

## Verify credentials

```sh
docker compose exec collector amz-stats verify
```

## Schedule

Runs daily at **06:17 UTC** (supercronic, `crontab.docker`).

## Output format

`out/latest.json` contains:

```json
{
  "timestamp": "2026-06-23T06:17:00Z",
  "store_id": "...",
  "version": "0.1.0",
  "catalog": {
    "ok": true,
    "asins": { "<ASIN>": { "title": "...", "price": "$9.99", "availability": "IN_STOCK", ... } },
    "errors": [],
    "batch_count": 3
  },
  "summary": {
    "per_site": { "<domain>": { "asin_count": 5, "oos_count": 0, ... } },
    "totals": { "site_count": 8, "unique_asin_count": 24, "oos_count": 1, ... }
  },
  "duration_seconds": 4.23
}
```
