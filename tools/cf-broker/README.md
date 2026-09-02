# cf-broker

Host-side Cloudflare read broker. Site containers hold **no** Cloudflare credential.

    docker compose up -d --build
    ./broker.py --check                 # config sanity, no listen
    ./issue-tokens.py --all             # per-site tokens + tokens.json map

## Why this exists

`tools/cf-tokens` gave every site a zone-scoped Cloudflare token, which stopped
one compromised container rewriting another site's DNS. It could not stop the
worse thing: Cloudflare's `Workers Scripts Write` exists **only** at account
scope, so any site's token can still deploy any of the 57 workers. Verified
against all 395 permission groups — there is no per-script resource to ask for.

The only remaining move is to take the credential out of the containers, which
run `claude -p` over scraped feeds and product pages.

That turned out to be cheap, because of what the credential was actually used
for. Measured across every site's `ops/scripts` before designing anything:

- **All direct Cloudflare calls from containers are reads** — `curl -s`, no
  write verbs. Worker/service status, the builds list, build logs.
- **Only 6 sites run `wrangler deploy` in-container.** The other ~24 deploy by
  pushing to git and letting Cloudflare Workers Builds do it; their token exists
  purely to *watch* that build.

So for most of the fleet the credential buys four GETs, and a read-only broker
removes it outright.

## The two rules that do the work

1. **The site comes from the caller's token, never from the request.** There is
   no `?site=` to tamper with, so a container cannot phrase a question about
   another site, let alone get an answer. `CF_BROKER_TOKEN` is an identity, not
   just a password — which is why it is per-site and issued, never shared.
2. **The upstream path is built here from an allowlisted template.** Nothing the
   caller sends is interpolated into the Cloudflare URL, so the broker cannot be
   turned into an open proxy for the account-scoped token it holds.

Two consequences worth spelling out:

- Cloudflare keys builds by **script tag**, not worker name. The broker resolves
  that itself. Letting the caller pass a tag would be letting it pick a worker —
  precisely the cross-site read this service prevents.
- A build id looks guessable, so `/v1/builds/<id>/logs` is an **authorization**
  check, not a format check: the id must appear in this site's own builds list.
  If that list cannot be fetched, the answer is 403, never "sure, here you go".

## Exposure

**No `ports:`.** The broker holds the account-scoped token that site containers
are losing, so it is not reachable from the host or the LAN at all — only by
service name on the private `cf-broker_net` Docker network that sites join. An
earlier revision bound `0.0.0.0` on the host; that was wrong and is why the
compose file says so out loud.

It mounts two read-only files and nothing else: `tokens.json` (a token → site map
and *only* that) and `registry/fleet.yaml`. The obvious shortcut — mounting
env-broker's `rendered/` — would hand a process that answers four GETs every
site's Slack and Cloudflare credentials.

## Endpoints

| route | upstream | notes |
|---|---|---|
| `GET /healthz` | — | no token |
| `GET /v1/worker` | `workers/services/<worker>` | |
| `GET /v1/script` | `workers/scripts/<worker>` | |
| `GET /v1/builds` | `builds/workers/<tag>/builds` | tag resolved server-side |
| `GET /v1/builds/<id>/logs` | `builds/builds/<id>/logs` | id must be this site's |

An absent, unknown or revoked token all return an identical 401, so a caller
learns nothing about which tokens exist.

## Migrating a site

1. `./issue-tokens.py --site <domain>` (also rewrites `tokens.json`)
2. Point its `deploy.sh` at `${CF_BROKER_URL:-http://cf-broker:4788}` with
   `CF_BROKER_TOKEN`; delete every `api.cloudflare.com` call.
3. Add `cf_broker` to the **cron** service's networks (that is the service that
   runs the roles) and to the top-level `networks:` as external `cf-broker_net`.
4. Add `deny_keys: [CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID]` for it in
   `tools/env-broker/policy.yaml`.
5. `env_broker.py render --site <domain>` and recreate the container.

`xxxtea.com` is the canary and is fully migrated: 0 Cloudflare env vars in the
container, build verification still working through the broker.

**Not yet covered:** the 6 sites that run `wrangler deploy` in-container
(amputeenews, eastcoastrappers, rodhat, shoppinkflamingo, arttogogh, girlpain).
They need a deploy endpoint, not just reads, and are a separate step.

## Test

    python3 -m pytest tests/ -q
