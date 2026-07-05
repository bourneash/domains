# fleet-smoke

Centralized, deterministic health checks for every domain in the portfolio.
One daily cron tick, staggered per-site, config-driven, Slack-notified.

Full architecture + how-to: see the `skill-domains-dev-smoke-tester-checks`
Claude skill (`~/.claude/skills/skill-domains-dev-smoke-tester-checks/SKILL.md`).

## Quick start

```bash
# run everything once, right now, on the host (no Docker needed)
cd tools/fleet-smoke
python3 -m pip install -r requirements.txt
python3 run_fleet_smoke.py

# just one site, no stagger delay
python3 run_fleet_smoke.py --only xxxtea.com --stagger-seconds 0

# tests
python3 -m pytest -v

# bring up the real cron container (daily 07:00 ET)
docker compose build fleet-smoke-cron
docker compose up -d fleet-smoke-cron
```

Add a site: create `sites/<domain>/ops/smoke.yaml` (schema in the skill doc
above) and commit it in that site's own repo. No fleet-smoke code change,
no rebuild — the next cron tick picks it up.
