# gh-stats

Hourly per-repo GitHub snapshot collector for the **Developer** Grafana
dashboard. Sibling to `tools/cf-stats`. Reads the domain→repo map from
`tools/site-tracker/sites.yml` (single source of truth) and the `GITHUB_TOKEN`
from `/home/jesse/projects/domains/.env`.

## What it collects (per active repo)

| Field | Source |
|---|---|
| default branch, visibility | `GET /repos/{slug}` |
| branch list + count | `GET /repos/{slug}/branches` |
| last commit to main (sha, date, subject) | `GET /repos/{slug}/commits?sha=main` |
| open PRs (number, title, head branch) | `GET /repos/{slug}/pulls?state=open` |

Each repo degrades to `{"ok": false, "error": ...}` on failure instead of
aborting the snapshot.

## Output

`out/` (gitignored): `gh-stats-YYYY-MM-DD.jsonl` (one snapshot/run) and
`latest.json` (most recent, pretty). `cf-grafana/ingest.py` reads these.

## Run (container)

```bash
cd /home/jesse/projects/domains/tools/gh-stats
docker compose up -d
docker compose logs -f
docker compose exec collector gh-stats collect --out-dir /work/out --sites-file /work/tools/site-tracker/sites.yml
docker compose down
```

## Run manually

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/gh-stats verify --env-file /home/jesse/projects/domains/.env
.venv/bin/gh-stats collect --out-dir out --env-file /home/jesse/projects/domains/.env
```

## Schedule

`crontab.docker` — hourly at `:37 UTC`, offset from cf-stats' `:23`.
