# fleet-registry — one list of domains

`registry/fleet.yaml` is the canonical list of every site in the fleet. Before it
existed, a new site had to be hand-added to ~14 independent rosters; each drifted
on its own, and nothing checked. At seeding time (2026-08-15) six live sites —
including totaljerks, shoptopless, wetpages and saveusfarms — were missing from
`site-tracker/sites.yml`, which `gh-stats` calls "the single source of truth".

## The truth model

- **The filesystem owns *existence*.** A directory under `sites/` with an `ops/`
  or `site/` dir is a site, full stop. No list can silently omit one.
- **The registry owns *policy*.** Status, ids, which fleet systems apply.
- **Tools own their own *settings*, keyed by domain** — as an overlay on the
  registry, never as a second roster.

Anything that violates this is drift, and drift is checked in both directions.

## Files

| Path | What it is |
|---|---|
| `registry/fleet.yaml` | the registry (repo root) |
| `build_registry.py` | merges disk + every legacy roster into the registry |
| `fleet_registry.py` / `fleet-registry.js` | read-only loaders (Python / Node) |
| `check_drift.py` | registry vs. world, both directions |
| `sync_rosters.py` | pushes the registry outward into rosters not yet migrated |
| `precommit_check.sh` | blocks a commit that adds a site the registry doesn't know |
| `MERGE_REPORT.md` | last merge's coverage + staleness report |
| `../scripts/onboard-site.sh` | register + reconcile one site (or `--all`) |
| `../scripts/registry-drift-cron.sh` | daily check; silent when healthy |

## Everyday use

```bash
# after bootstrapping a new site
bash tools/scripts/onboard-site.sh <domain.tld>

# reconcile the whole fleet / see what's unwired
bash tools/scripts/onboard-site.sh --all

# just the check (exit 1 on structural drift, --strict to fail on warnings too)
python3 tools/fleet-registry/check_drift.py

# rebuild derived fields after sites change on disk
python3 tools/fleet-registry/build_registry.py --write
```

`build_registry.py --write` is safe to re-run: `status`, `tags`, `notes` and
`capabilities_override` are human-owned and survive a rebuild. Everything else
is derived from disk and refreshed.

## Reading the registry from a tool

```python
import sys; sys.path.insert(0, "tools/fleet-registry")
import fleet_registry as R

for domain in R.sites(status="live"):
    ...
for domain in R.with_capability("analytics"):
    ...
```

```js
const reg = require('../fleet-registry/fleet-registry');
reg.sites(ROOT, { status: 'live' });
reg.withCapability(ROOT, 'cron');
```

Containers: set `FLEET_REGISTRY=/work/registry/fleet.yaml`, or mount the repo at
`/work` (both loaders check there).

## Fields

| Field | Owner | Meaning |
|---|---|---|
| `status` | human | `live` · `scaffold` · `parked` · `redirect`. Seeded from disk evidence, not `DOMAINS_INDEX.md` (that file was months stale — it filed totaljerks, rodhat and shoptopless as "parked"). |
| `repo` | derived | `owner/name` from `.gitmodules` |
| `worker` | derived | name from the site's `wrangler.jsonc` — the deployed truth |
| `cf_zone` | derived | Cloudflare zone |
| `slack_channel_env` | derived | the `SLACK_CHANNEL_*` key in `.env` |
| `capabilities` | derived | which fleet systems apply: `site` `ops` `cron` `smoke` `tasks` `affiliate` `analytics` `social` `data-hub` `product-feed` |
| `capabilities_override` | human | replaces detection entirely when set |
| `analytics` | derived | GA4 property / measurement id / GSC property |
| `registered_in` | derived | provenance — which legacy rosters knew about this site |

## Migration status

Consumers still keep their own lists; the registry is the seed and the referee,
not yet the read path. Migration is per-consumer and deliberate (canary first),
in this order — most drift-prone first:

1. `gh-stats` — already reads `site-tracker/sites.yml`; swap for the loader.
2. `site-tracker` — `sites.yml` becomes an overlay (checks/manual only).
3. `fleet-dashboard` — keep the `sites/` scan for existence, use the registry
   for status/capabilities so parked domains stop rendering as live sites.
4. `data-hub` / `product-feed` — subscriptions stay opt-in, but validate their
   keys against the registry so a typo'd domain fails loudly.

Until then, `sync_rosters.py --apply` keeps `site-tracker/sites.yml` populated
from the registry (additive only — it never edits or removes an existing entry).
