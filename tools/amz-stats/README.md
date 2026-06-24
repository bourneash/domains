# amz-stats

Daily Amazon affiliate catalog snapshot collector. Scans every `sites/<domain>/site/src/lib/affiliate.ts` in the domains project for ASINs, calls the Amazon Creators API to check availability and pricing, and writes a JSONL snapshot + `latest.json` to `out/`.

## What it does

1. Harvests ASINs from `affiliate.ts` files across the fleet
2. Calls Amazon Creators API (`/catalog/v1/getItems`) in batches of 10
3. Records availability (IN_STOCK / OOS / UNKNOWN), price, rating, and image URL per ASIN
4. Writes `out/amz-stats-<YYYY-MM-DD>.jsonl` (appended) and `out/latest.json` (overwritten)
5. Appends a one-line summary to `out/cron.log`

## Setup

Credentials are read from the shared fleet `.env` (mounted at `/work/.env.shared`):

```
AMAZON_CREATORS_KEY_ID=...
AMAZON_CREATORS_KEY_SECRET=...
AMAZON_ASSOCIATES_STORE_ID=...
```

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
docker compose exec collector amz-stats collect --out-dir /work/out --domains-root /work/domains
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
