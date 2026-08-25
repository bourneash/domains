# env-broker

Renders each site container a **minimal** `.env` instead of the fleet's.

    env_broker.py --check                    # policy vs. what ops/ really uses
    env_broker.py render --all               # rendered/<domain>.env, mode 0400
    env_broker.py --source vault render --all
    env_broker.py import-to-vault            # push .env into the Fleet Env items

## Why

Every site cron container mounted the shared fleet `.env` — **60 keys**,
including `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, the Amazon
Creators secret, the PIA password, and **`FD_TOKEN`** — the Fleet Dashboard
operator token, i.e. the credential that gates the thing that can push to 48
repos and restart the fleet. Those containers run `claude -p` over
attacker-influenced input (scraped feeds, product pages, social replies). One
prompt injection in any one site meant the whole fleet.

Measured against what the ops trees actually reference:

| | keys |
|---|---|
| shared fleet `.env` | 60 |
| average site needs | **3.9** |
| referenced by no site at all | 25 (incl. `GITHUB_TOKEN`, `FD_TOKEN`, all `AMAZON_*`, all `VPN_*`) |

## Render, don't fetch

Containers never talk to the vault. A host-side broker holds the one vault
credential, renders a per-site file, and compose mounts that.

The alternative — `bw` inside every container — is worse on both axes.
Bitwarden's model has no per-item machine token: `bw` authenticates as a *user*,
so every container would hold a credential that unlocks the **whole** vault,
including all 68 social items. That trades 60 keys for one key that opens more
than the 60 did. It also makes Vaultwarden a hard runtime dependency of every
cron role on every site — a vault outage becomes a fleet outage, where today a
file mount cannot be "down".

Vaultwarden is the source of truth; the shared `.env` stays as bootstrap and
offline fallback. A vault-sourced render is byte-identical to a file-sourced
one (that equivalence is the migration's acceptance test).

## Policy

`policy.yaml` holds **no secrets** — it is the allowlist; values live in the
vault. A site's key set is:

    defaults.keys
      + its own SLACK_CHANNEL_* (from registry/fleet.yaml, since the names are
        irregular: SLACK_CHANNEL_RC9, SLACK_CHANNEL_AMERICA_STRIKES, …)
      + sites.<domain>.extra_keys
      - sites.<domain>.deny_keys
      - never_grant          # fleet-wide credentials no site may ever hold

`--check` re-derives what each site's `ops/` actually references and fails on
drift **in both directions**: a key a site needs but is not granted (its role
will break), and a key granted but never referenced (needless exposure). Run it
after touching any ops script; it is also fleet-cron Job 14.

Recipients are read off the filesystem — sites whose `docker-compose.yml`
mounts a fleet env — not off the registry, because 21 of the 49 registry
entries are unbuilt scaffolds with an `ops/` dir and no container.

## Vault layout

Org **Domain Fleet**, collection **Fleet Env** (separate from *Social Media* so
the two can later be granted to different accounts), 8 items grouped by
provider — `fleet — env-cloudflare`, `— env-slack`, `— env-amazon`,
`— env-media-apis`, `— env-vpn`, `— env-github`, `— env-dashboard`,
`— env-email`. Grouped rather than one 60-field blob so a provider can be
rotated without touching the rest.

## Operating

- Rendered files live in `rendered/` (gitignored, `0400`, written via a private
  temp file + rename so there is no 0644 window).
- **After changing a secret**: update the vault item, then
  `--source vault render --all`, then restart the affected cron containers.
- **After changing `policy.yaml` or an ops script**: `--check`, then re-render.
- Renders are not automatic. Job 14 only *detects* drift — deliberate rollouts,
  per `feedback_no_auto_rollout_tool`.

## Who consumes the rendered files

- **Site cron + worker containers** — `sites/*/docker-compose.yml` (all 27).
- **domain-developer dev containers** — `tools/domain-developer` (`bin/domain-developer`
  and `server/server.js`). These run Claude with `--dangerously-skip-permissions`,
  so they were the same exposure through a second door. Both spawn paths now
  **fail closed**: no rendered file means no credentials mounted, never a
  fallback to the fleet `.env`. The panel needs `rendered/` bind-mounted at the
  same host path, because it resolves `docker run -v` paths for the host but
  runs `existsSync` inside its own container.

Tool containers (`amz-stats`, `cf-stats`, `gh-stats`) still mount the shared
`.env`: they legitimately need the Amazon / Cloudflare / GitHub credentials and
are not per-site. Narrowing those is separate work.

## What this does not fix

`CLOUDFLARE_API_TOKEN` is still fleet-wide: site ops call
`/accounts/<id>/workers/...` for deploy verification, which a per-zone token
cannot reach. Narrowing it to a Workers:read token is the largest remaining
exposure here and is tracked separately.
