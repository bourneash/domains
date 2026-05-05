# Domains Tooling — Quickstart

All commands run from the repo root: `/home/jesse/projects/domains/`

---

## CLI Status Dashboard

One-shot view of traffic + ops health across all sites:

```bash
python3 tools/status           # full report (traffic + ops board)
python3 tools/status --traffic # traffic only (7d totals, 24h req)
python3 tools/status --ops     # ops board only (last run per role, exit codes)
```

**What it shows:**
- Per-site: requests/24h, pageviews/7d, uniques/7d, threats/7d, cache hit %, MB transferred
- Portfolio totals
- Workers invocations/errors (24h)
- Per-site ops roles: last run timestamp + exit code (green/yellow/red by age)

---

## Grafana — Visual Dashboards

Data is in SQLite at `tools/cf-grafana/data/cf-stats.db`. An `ingest` sidecar container
keeps it fresh automatically — re-runs every 5 minutes without any manual steps.

### Start

```bash
cd tools/cf-grafana
docker compose up -d
open http://localhost:4741
```

Dashboards auto-provision on startup — no import needed. Two are available:
- **CF Stats — Portfolio**: total pageviews/uniques/requests/threats over time, RUM
- **CF Stats — Zone Detail**: per-site breakdown, latest snapshot table

Data refreshes every 5 minutes. The `ingest` sidecar reads the cf-stats JSONL files
that the hourly cron writes, so nothing else is needed.

### Stop / restart

```bash
cd tools/cf-grafana
docker compose down       # stop both containers
docker compose up -d      # start (DB and dashboards persist)
docker compose restart    # restart without recreating
```

### Check logs

```bash
docker logs cf-grafana-grafana-1 --tail 50   # Grafana
docker logs cf-grafana-ingest-1  --tail 20   # ingest sidecar (shows snapshot counts)
```

### Manual ingest (if needed)

```bash
cd tools/cf-grafana && python3 ingest.py
```

---

## cf-stats — Cloudflare Data Collector

Hourly cron at `:23` collects from the CF API and appends to JSONL per day.

```bash
# Manual one-shot collect (useful after a long gap or to force a snapshot)
cd tools/cf-stats
.venv/bin/cf-stats collect --out-dir out

# Verify token is valid
.venv/bin/cf-stats verify

# Tail the cron log (shows summary lines + any errors)
tail -f tools/cf-stats/out/cron.log

# View latest snapshot (pretty JSON)
cat tools/cf-stats/out/latest.json | python3 -m json.tool | less

# Check portfolio 7d summary
python3 -c "
import json
d = json.load(open('tools/cf-stats/out/latest.json'))
per = d['zone_analytics']['per_zone']
for site, z in sorted(per.items()):
    t = z.get('totals') or {}
    print(f'{site:25s}  pv={t.get(\"pageViews\",0):>5}  uniq={t.get(\"uniques\",0):>4}')
"
```

**Output files** (`tools/cf-stats/out/`, gitignored):
| File | Contents |
|------|----------|
| `cf-stats-YYYY-MM-DD.jsonl` | One snapshot per cron run, daily rotation |
| `latest.json` | Most recent snapshot, pretty-printed |
| `cron.log` | One summary line per run + any errors |

**Cron schedule** (installed in `crontab -e`):
```
23 * * * *  cf-stats collect  # hourly at :23
```

---

## Ops Schedule Health

Each site writes a `ops/board/last-run.json` after every role execution.
`tools/status --ops` reads these to show what ran, when, and whether it succeeded.

**Log files** per site: `<site>/ops/logs/<role>-YYYY-MM-DD-HHMM.log`

```bash
# Tail the most recent aliencouncil brief-writer log
ls -t aliencouncil.com/ops/logs/brief-writer-*.log | head -1 | xargs tail -50

# Check last-run board for a specific site
cat americastrikes.com/ops/board/last-run.json | python3 -m json.tool

# Watch a cron log in real time
tail -f reviewtattoo.com/ops/logs/cron.log
```

**Roles by site** (from crontab):
| Site | Roles |
|------|-------|
| aliencouncil.com | planner (Mon), news-desk (daily), brief-writer (daily), content-writer (T/Th/Sa), seo-analyst (Wed), social-ops (daily), affiliate-ops (1st) |
| americastrikes.com | planner (Mon), update (daily), seo-analyst (Wed), newsletter-editor, social-media, deployer (flag-triggered) |
| reviewtattoo.com | planner (Mon), content-writer (T/Th/Sa), seo-analyst (Wed), affiliate-ops (1st), deployer (flag-triggered) |
| sinderella.org | content-writer (daily 3am), tarot-reader (daily 3:30am), notebook-writer (3x daily), mailbag-writer (M/W/F), seo-analyst (Mon), planner (Mon) |
| weapontester.com | planner (Mon), content-writer (T/Th/Sa), seo-analyst (Wed), deployer (flag-triggered) |
| ultrarough.com | (check `ultrarough.com/ops/`) |

---

## Known Issues / Notes

- **reviewtattoo.com 404s**: ~1,600/day from WordPress scanner bots probing `/wlwmanifest.xml`, `/xmlrpc.php`, etc. Site isn't WP so they all 404 harmlessly. Cosmetic only.
- **ultrarough.com transfer**: ~260MB/7d due to image-heavy pages (77% cache hit, so CF is absorbing most of it).
- **sinderella + ultrarough ops boards**: No `last-run.json` yet — either board dir not created or deployer hasn't fired.
- **aliencouncil brief-writer/content-writer**: Check logs if `tools/status --ops` shows `exit=1` — these can fail due to API rate limits or content guardrails.
