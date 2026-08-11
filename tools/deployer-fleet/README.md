# deployer-fleet

Dynamic, **read-only, zero-token** drift audit of the Deployer cron role across
every site under `sites/`. Answers: *which sites are on the
`tools/cron-roles/archetypes/deployer/` template, and how far behind the
current version is each one?*

## Usage

```bash
python3 tools/deployer-fleet/deployer-status.py            # table — every site with a deploy.sh
python3 tools/deployer-fleet/deployer-status.py --drift     # only archetype-family sites that aren't aligned
python3 tools/deployer-fleet/deployer-status.py --json      # machine-readable (all sites, including "none")
```

## What it reads (writes nothing)

| Column | Meaning |
|---|---|
| TIER | `aligned` (every current feature marker present) · `PARTIAL` (archetype-family, missing markers) · `custom` (has a deployer, never migrated to this archetype — e.g. amputeenews.com, rodhat.com) · `none` (no `ops/scripts/deploy.sh`) |
| FEATURES `[BADITCW]` | one letter per marker, `·` = missing — see script docstring for what each guards against and which incident introduced it |
| MISSING | which markers this site's `deploy.sh` lacks |

`wrangler_direct` sites (`0xroulette.com`, `rc-9.com` per `meta.yml
known_variants`) are excluded from the `C` (CF Workers Build poll) requirement
— they `wrangler deploy` synchronously and have no async build gap to poll.

## Model: stamp-once, detect-don't-fix

Same as `tools/engineer-fleet/`. The archetype is the source of truth;
installed copies are hand-tuned per site and are **never auto-synced** —
`tools/cron-roles/README.md`: *"Improving an archetype here does NOT
propagate to already-installed sites."* This script only surfaces drift.

Rolling a fix out:

1. Patch `tools/cron-roles/archetypes/deployer/scripts/deploy.sh.tmpl` so
   every *future* install gets it.
2. Patch already-stamped sites **deliberately, one at a time** — canary one,
   verify a real deploy cycle, then work through the rest of the `--drift`
   list. Never a blind fan-out — see `feedback_no_auto_rollout_tool`: a
   one-shot sync across live sites risks clobbering legitimate per-site
   tuning (e.g. `known_variants`).
3. Re-run `--drift` to confirm convergence.
