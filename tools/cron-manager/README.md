# cron-manager

Portfolio cron control panel. Discovers every cron system across the domains
repo — each `sites/*/ops/docker/crontab.docker` and `tools/*/crontab.docker` —
and lets you see what runs, pause/resume jobs, edit schedules, and remove jobs.

Dynamic: any new site that follows the standard `ops/` layout appears
automatically. No registry to maintain.

## Run

Local (host Node):

    npm install
    npm start            # http://127.0.0.1:4753

Containerized:

    docker compose up -d --build
    # panel at http://127.0.0.1:4753

## How actions apply

- **Pause / Resume a role** (lines that call `run-worker.sh <role>`):
  toggles `ops/.<role>-disabled`. **Instant** — the next scheduled fire is
  skipped by `run-worker.sh`. No rebuild, no container bounce. This is the
  everyday "pause the content writer" path.
- **Edit schedule / Remove / Pause a non-role line** (tool commands, pruning,
  `run-deployer.sh`, etc.): rewrites `crontab.docker`. Because that file is
  baked into the cron image (`COPY` in `Dockerfile.cron`), the change is **not
  live** until you click **Rebuild & restart cron** for that system.

## New roles

This tool manages existing jobs. To add a *new* autonomous role to a site, use
the `domains-agent-cron-role-engineer` skill, which scaffolds the role file,
crontab line, and supporting scripts.

## Test

    npm test
