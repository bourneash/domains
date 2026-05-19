# site-tracker

Portfolio maintenance dashboard — per-site verification/wiring state across
the domains portfolio. Five-layer architecture (registry, collectors, store,
API, frontend) running in a single Docker container at `localhost:4742`.

Design: [docs/superpowers/specs/2026-05-19-site-tracker-design.md](../../docs/superpowers/specs/2026-05-19-site-tracker-design.md)

## Quickstart

```bash
cd tools/site-tracker
docker compose up -d
open http://localhost:4742
```

See `docker compose logs -f` for collector cron output.
