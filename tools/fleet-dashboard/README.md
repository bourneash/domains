# fleet-dashboard

Portfolio control plane for the domain fleet (http://127.0.0.1:4754).

Key views include:

- **Engineers** — the live engineer audit: tier (aligned/partial/legacy/none),
  feature flags (work-lock / liveness-pulse / daily-summary), cron schedule,
  latest pulse status + age (stale flag at >35m), render pass/fail, Cloudflare
  health, queued-task count, kill-switch flags, plus a 3-day coverage % and a
  pulse sparkline. This panel **delegates to `engineer-status.py --json`** so the
  tier/pulse/queue logic stays single-sourced in the Python CLI.
- **Git** — per-site working-tree status (each site is its own submodule repo):
  branch, uncommitted-file count, ahead/behind. Expand a row to see the exact
  changed files with their porcelain status codes.
- **Tasks** — full CRUD over each site's `ops/tasks/{backlog,in-progress,done,hold}`
  board: create, edit (frontmatter + markdown body), move between columns, and
  delete. Edits write the markdown files directly; the site's
  engineer/committer picks them up on its next pass (this tool never commits).
- **AI Inventory** — dispatch-aware provider/model/status inventory for every
  scheduled service. It delegates to `tools/ai-inventory/audit-ai.py --json`,
  follows dedicated engineer/writer/deployer dispatches, distinguishes local
  Ollama/vLLM from remote Claude, and keeps deterministic rows visible.
- **SEO Intelligence** — joins first-party GSC demand with GA4 readiness,
  Lighthouse/Web Vitals, link-rot, and crawlability evidence to rank actionable
  opportunities across the fleet. Page-level GSC and GA4 data expose content
  decay, organic page opportunities, and engagement risks; conversions,
  sessions, engagement, and demand provide an explicit non-revenue value score.
  Operators can filter by site, priority, or opportunity type and file a
  deduplicated backlog task with an execution plan directly from an action.

Dynamic: any site under `sites/*/ops/` appears automatically. No registry.

## Run

Local (host Node — needs `python3`, `git`, and `docker` on PATH):

    npm install
    npm start            # http://127.0.0.1:4754

Containerized:

    tools/fleet-dashboard/bin/fleet-dashboard up
    # panel at http://127.0.0.1:4754

The operator command loads the panel's scoped credential file
(`tools/env-broker/rendered/tool-fleet-dashboard.env` — see **Safety** below,
*not* the shared root `.env`), supplies the host Docker group, and waits for the
health endpoint. It also supports `restart`, `status`, and `token`.
`rotate-token` writes a new `FD_TOKEN` to **Vaultwarden**, re-renders, and
recreates the panel — a vault failure aborts with the old token still in effect,
because a panel recreated against a token the vault never accepted would lock you
out with no way back. Routine rotation is neither required nor recommended;
rotate after suspected disclosure.

## Why it shells out to Python

The engineer liveness audit (tiers, pulse parsing, queue counting, cron-line
detection) already lives in `tools/engineer-fleet/engineer-status.py` and is the
documented source of truth (`reference_engineer_pulse_monitoring`). The web
layer calls `--json` / `--history N --json` rather than re-implementing it, so
the CLI and the dashboard can never disagree.

The AI Inventory and Task Budget views use the same pattern: their Python CLIs
remain the canonical classifiers, while the dashboard adds summaries, filtering,
and presentation.

## Safety

- Loopback-only publish (`127.0.0.1:4754`).
- **Host allowlist (always on):** every request's `Host` must resolve to an
  allowed name (defaults: `127.0.0.1`, `localhost`, `fleet-dashboard`, `panel`).
  This defeats DNS-rebinding. Extend with `FD_ALLOWED_HOSTS=a,b,c`, or set it to
  `*` to disable.
- **Token gate:** set `FD_TOKEN=<secret>` to require a token on every `/api/*`
  request. Browsers unlock via a login form (an HttpOnly cookie holding an HMAC
  of the token, not the token itself). The cookie has a rolling 30-day idle
  lifetime, so normal use keeps that browser signed in without weakening the
  gate for abandoned sessions. Programmatic clients send `x-fd-token: <secret>`.
- **Where the token lives (B2):** **not** in the shared fleet `.env`. That file
  is the fleet's bootstrap credential blob, and parking the panel's own gate in
  it meant the secret guarding the docker socket travelled with 60 unrelated
  keys — the gate documented right here was, as wired, decorative. FD_TOKEN's
  home is **Vaultwarden**; `tools/env-broker` renders it into
  `tools/env-broker/rendered/tool-fleet-dashboard.env` (mode 0400, three keys),
  which compose loads via `env_file:`. Regenerate with
  `tools/env-broker/env_broker.py render --all` — the broker pulls `FD_TOKEN`
  from the vault whatever `--source` says, and a vault outage leaves the last
  good file untouched rather than blanking the credential.
- **Off switch — `FD_AUTH=0`:** turns the token gate off entirely while leaving
  `FD_TOKEN` parked in the rendered file, so turning it back on is a
  one-character edit rather than re-issuing a secret. What you give up: the panel
  mounts the docker socket and joins `vpn_proxy`, so with the gate off **any
  container on that network can drive the whole fleet and the host**, not just
  people on your LAN. Flip it back with `env_broker.py set-secret
  --group dashboard --key FD_AUTH` + `tools/fleet-dashboard/bin/fleet-dashboard up`.
- **Refuses to start unsafe (B2):** on a non-loopback bind (`FD_HOST` not
  `127.0.0.1`/`localhost`/`::1`) with no `FD_TOKEN`, the server exits with an
  error instead of coming up unauthenticated. The compose deploy binds `0.0.0.0`
  and joins `vpn_proxy`, so `FD_TOKEN` is **required** there (`bin/fleet-dashboard`
  refuses to start without a rendered file carrying one). Override only with `FD_ALLOW_INSECURE=1` if you
  accept the risk. Note: on `vpn_proxy` the token is the *only* real gate — a
  peer container reaches the panel's container IP regardless of the bind address.
- **Host allowlist (always on)** defeats DNS-rebinding (see above).
- Every `:slug` route is gated through site discovery; columns and filenames
  are validated against an allowlist / regex (no path traversal).
- **Audit trail (B4):** every mutating `/api/*` request (push, container
  lifecycle, crontab edit, rebuild, task delete, role run — including rejected
  401/403 attempts) is appended to `data/actions.jsonl` with a non-secret actor
  fingerprint, path, status, and duration. Read it back at `GET /api/actions`.
- **Per-repo git lock (B3):** dashboard commit/ignore/push on a site are
  serialized per slug so they can't interleave with each other (the site's own
  engineer/committer cron still pushes independently).
- Task deletes are a **soft delete** into `ops/tasks/.trash/` (recoverable), not
  an unlink.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `FD_PORT` | `4754` | listen port |
| `FD_HOST` | `127.0.0.1` | bind address |
| `FD_TOKEN` | _(from the vault, via `rendered/tool-fleet-dashboard.env`)_ | require this token on `/api/*`; **required** on a non-loopback bind unless `FD_AUTH=0`. Rotate with `bin/fleet-dashboard rotate-token` (writes the vault, then re-renders) |
| `FD_AUTH` | `1` | set `0` to disable the token gate while keeping `FD_TOKEN` parked (explicit opt-out) |
| `FD_ALLOW_INSECURE` | _(unset)_ | set `1` to allow a non-loopback bind with no token (accepts the risk) |
| `FD_ALLOWED_HOSTS` | loopback + compose names | extra allowed `Host` values (or `*`) |
| `FD_DOMAINS_ROOT` | repo root | path to the domains monorepo |
| `FD_DATA_DIR` | `./data` | where the action audit log (`actions.jsonl`) is written |
| `DATAHUB_API` | `http://host.docker.internal:4760` | first-party GSC/GA4 source used by SEO Intelligence |
| `FD_QUIET` | _(unset)_ | set `1` to silence the request log |

## Test

    npm test
