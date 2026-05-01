# cf-stats

Hourly snapshot collector for the shared Cloudflare account. Hits the CF API
with the token in `/home/jesse/projects/domains/.env`, dumps a JSON record per
run, and writes a human-readable summary line to `out/cron.log`.

Use it to catch token expiry, watch worker request volumes, see DNS/zone
counts drift, and notice when a new resource appears that we forgot about.

## What it collects

| Field | Source | Token scope needed |
|---|---|---|
| token health + expiry | `GET /user/tokens/verify` | (always works) |
| zones (count, status, plan, names) | `GET /zones` | Zone:Read ✅ |
| DNS records (per-zone count + by-type) | `GET /zones/{id}/dns_records` | Zone:DNS:Read ✅ |
| worker scripts (count, modified_on, etag) | `GET /accounts/{id}/workers/scripts` | Workers Scripts ✅ |
| custom domains (per-zone, per-service) | `GET /accounts/{id}/workers/domains` | Workers Domains ✅ |
| workers.dev subdomain | `GET /accounts/{id}/workers/subdomain` | ✅ |
| email routing (enabled zones) | `GET /zones/{id}/email/routing` | Email Routing ✅ |
| KV namespaces | `GET /accounts/{id}/storage/kv/namespaces` | Workers KV (gracefully skipped if absent) |
| R2 buckets | `GET /accounts/{id}/r2/buckets` | R2 (gracefully skipped) |
| D1 databases | `GET /accounts/{id}/d1/database` | D1 (gracefully skipped) |
| Queues | `GET /accounts/{id}/queues` | Queues (gracefully skipped) |
| Workers analytics 24h (requests, errors, subrequests, per-script) | GraphQL `workersInvocationsAdaptive` | Account Analytics:Read ✅ |
| Per-zone HTTP analytics 7d (requests, pageviews, uniques, bytes, threats, cached split, daily series) | GraphQL `httpRequests1dGroups` (batched in groups of 10) | Zone Analytics:Read ✅ |
| Per-zone HTTP analytics 24h drilldown (top countries, top paths, status mix, blocked 403/429 by country+path) | GraphQL `httpRequestsAdaptiveGroups` | Zone Analytics:Read ✅ |

Every collector returns `{"ok": false, "error": "..."}` on auth failure
instead of aborting the run, so missing scopes don't kill the snapshot.

## Output

Two artifacts in `out/` (gitignored):

- `cf-stats-YYYY-MM-DD.jsonl` — one snapshot appended per run, dense JSON, per-day rotation.
- `latest.json` — pretty-printed most recent snapshot (overwritten each run).
- `cron.log` — stdout/stderr from the cron-driven runs (one summary line per run).

## Install / run manually

```bash
cd /home/jesse/projects/domains/tools/cf-stats
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/cf-stats verify          # check token works
.venv/bin/cf-stats collect         # one shot
```

Reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from
`/home/jesse/projects/domains/.env` automatically.

## Cron schedule

Installed in Jesse's user crontab (`crontab -l`):

```
# --- cf-stats-start ---
23 * * * * /home/jesse/projects/domains/tools/cf-stats/.venv/bin/cf-stats collect --out-dir /home/jesse/projects/domains/tools/cf-stats/out >> /home/jesse/projects/domains/tools/cf-stats/out/cron.log 2>&1
# --- cf-stats-end ---
```

Hourly at `:23` (offset from other ops jobs in the crontab).

## Sample summary line

```
[2026-05-01T03:55:23Z] cf-stats zones=34 workers=7 domains=12 dns=192 email_on=7 r2=- kv=0 d1=- queues=0 req24h=4073 err24h=0 pv7d=21071 uniq7d=4676 thr7d=1265 50.56s
```

`-` means the collector returned `ok=false` for that resource (typically
token doesn't have that scope). `analytics=NO` would mean the Workers GraphQL
call failed; `zoneana=NO` would mean the per-zone GraphQL call failed.
Otherwise you get `req24h` / `err24h` (Worker invocations) plus
`pv{N}d` / `uniq{N}d` / `thr{N}d` (zone-level pageviews, uniques, threats
across the lookback window — default 7d, tunable via `--zone-lookback-days`).

## Querying the snapshot

Per-site traffic for the active 7 sites:

```bash
python3 -c "
import json
d = json.load(open('out/latest.json'))['zone_analytics']['per_zone']
for n in ['aliencouncil.com','americastrikes.com','rc-9.com','reviewtattoo.com','sinderella.org','ultrarough.com','weapontester.com']:
    t = d.get(n, {}).get('totals') or {}
    print(f'{n:22s} pv={t.get(\"pageViews\",0):>5} uniq={t.get(\"uniques\",0):>4} thr={t.get(\"threats\",0):>4}')
"
```

Each `per_zone[name]` entry contains:
- `totals` — sums over lookback window (requests, pageViews, uniques, bytes, threats, cachedRequests, cachedBytes)
- `daily` — sorted day-by-day series (each item: date, requests, pageViews, uniques, bytes, threats)
- `recent` — last-24h drilldown (`by_country`, `by_path`, `by_status`, `blocked`)
