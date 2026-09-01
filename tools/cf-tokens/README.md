# cf-tokens

Per-site Cloudflare API tokens, one zone each.

    mint.py --audit                 # who is scoped, who is still on the fleet token
    mint.py --site xxxtea.com       # mint (or rotate) one site
    mint.py --all                   # every site the policy grants a CF token
    mint.py --revoke xxxtea.com     # delete the token and the vault field
    mint.py --all --dry-run

## Why

Every site cron container held the **fleet** Cloudflare token: one credential
that could rewrite DNS across all 66 zones and deploy all 57 Workers. Those
containers run `claude -p` over scraped feeds, product pages and social replies,
some with `--dangerously-skip-permissions`. One prompt injection reached the
whole Cloudflare account (B1).

## What this actually buys — measured, not assumed

Probed on 2026-09-01 against all 395 Cloudflare permission groups, with a real
scoped token minted, tested and deleted:

| | scope | result |
|---|---|---|
| `Zone Read`, `DNS Write`, `Workers Routes Write` | `…api.account.zone` | zone-scopeable — another site's DNS returns **403** ✅ |
| `Workers Scripts Write`, `Workers CI Read` | `…api.account` **only** | no per-script resource exists — a site token still lists all 57 Workers and can deploy any of them ❌ |

So a compromised container can no longer hijack another site's **domain**, but
can still deploy code to another site's **Worker**.

**This is a blast-radius reduction, not isolation. Do not write it up as closing
B1.** The fix for the Workers half is to stop containers holding a Cloudflare
credential at all — a host-side deploy broker, the same shape as
`tools/env-broker`: the host holds the one credential and performs the deploy for
the requesting site; the container holds nothing.

Two zone-scoped observations worth knowing: zone *metadata* (`GET /zones/<id>`)
reads 200 across zones regardless of scoping — only the record-level calls are
enforced. And `Workers CI Read` is what the 36 `/builds` call sites in the site
ops scripts need; without it deploy-status polling 403s.

## Storage

A minted token's value is returned by Cloudflare **exactly once**, at creation.
It goes straight into that site's own vault item (`fleet — site-<domain>`) and is
held nowhere else — never in the shared `.env`, never on disk outside the render.
`write_site_value` reads it back and aborts the run if it does not match, because
a token that exists at Cloudflare but was not stored is unrecoverable: that
site's deploys simply stop.

`tools/env-broker` picks these up automatically — `per_site_vault` in
`policy.yaml` declares `CLOUDFLARE_API_TOKEN` as per-site, and a site's own value
wins over the fleet-wide one at render time. Sites still on the shared token show
up in `env_broker.py --check` as `FLEETWIDE`, so the migration has a visible
countdown rather than being something you have to remember.

Tools are deliberately excluded: `cf-stats` and `site-tracker` aggregate *across*
the fleet, so an account-scoped token is what they legitimately need.

## The minting credential

`CLOUDFLARE_PROVISION_TOKEN` (CF token name `fleet-provisioner`) carries
`User → API Tokens → Edit` **plus** every permission it hands out, since
Cloudflare will not let a token grant what it does not itself hold. That makes it
strictly more powerful than the fleet token this tool exists to retire, so it is
both `never_grant` and `vault_only` in the env-broker policy: it lives in
Vaultwarden, never in the shared `.env`, and is rendered into **no** container.
It expires 2028-06-30.

## After minting

    tools/env-broker/env_broker.py render --all
    # then RESTART the affected containers

Re-rendering alone is not enough: compose bind-mounts these as individual
**files**, and the renderer writes via `os.replace`, which swaps the inode. A
running container keeps reading the old one until it is restarted.

## Test

    python3 -m pytest tests/ -q
