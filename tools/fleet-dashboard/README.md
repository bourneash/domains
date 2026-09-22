# Domain Fleet Manager

Portfolio control plane for the domain fleet (http://127.0.0.1:4754 locally;
LAN access uses the host's LAN name or IP on port 4754).

## Change Queue

The **Change Queue** view is the operator entry point for site work that would otherwise be
started manually from a CLI session. Requests are stored durably in the dashboard event database
and can be categorized as errors, design, navigation, content, marketing, sales, SEO, engineering,
or other work. Each request records priority, role, provider (`claude`, `chatgpt`/Codex, or `local`),
model, and a bounded max-turn budget.

Automatic pickup is off by default. When enabled, the queue honors its configured cadence and
concurrency, creates an isolated improvement worktree/sandbox, and can automatically hand a
completed implementation to a separate reviewer. Automatic review is enabled by default, but can
be disabled globally in Queue controls or per request. The reviewer must explicitly return a PASS
marker; only then does the dashboard run the quality gates, commit the worktree, and push/deploy it.
Requests that are already in `review` have an **Auto-review & deliver** action in both the queue
row and the request detail panel. A reviewer rejection or failed gate leaves the request in review
with the error and preserves the worktree for human inspection.

Executive report work uses `delivery_mode=report_only`. It runs in the same isolated worktree and
automatic-review path, but writes a durable report artifact and ends as `verified`; it never
deploys, pushes, or creates a deployment record. The request keeps `requested_by` and
`source_proposal_id` for auditability, and the artifact is available at
`GET /api/change-requests/:id/report`. CEO/CTO/CFO/CRO requestors receive a durable executive
follow-up message when their request starts, blocks, fails, or completes.

Read-only executive telemetry is available without queue approval. Scheduled intelligence snapshots
are the first source; `POST /api/executive/data-requests` falls back to the existing first-party
adapters when a fresh snapshot is unavailable, stores a permissioned artifact, and records the
request/fulfillment events. These requests never grant implementation, deployment, credential, or
spending authority.

Queue execution uses persistent leases with heartbeats. The lease duration is configurable in Queue
controls (5 minutes to 24 hours). After a dashboard restart, expired clean work is safely reset and
requeued; expired worktrees containing changes are marked failed and preserved for manual recovery,
so the system never silently duplicates or overwrites unfinished work.

Provider command defaults can be overridden for the dashboard container with
`FD_CHANGE_QUEUE_CHATGPT_COMMAND` and `FD_CHANGE_QUEUE_LOCAL_COMMAND`. Local voice transcription
is optional and uses `FD_LOCAL_STT_COMMAND` (default: `whisper-cli`), which must accept an audio
file path and print a transcript to stdout. No cloud STT call is made by the dashboard.

Before a queued request starts, the dashboard checks that the selected provider executable is
installed in the isolated developer container. A missing CLI fails early with an actionable error,
cleans up the sandbox/worktree, and leaves the request retryable instead of producing a dangling
building run. Retrying an older failed request also cleans up any clean leftover run resources first;
dirty worktrees are preserved and require operator recovery.

Key views include:

- **Executive Workbench** — one assistive case queue for decisions, evidence
  gaps, incidents, Legal/Security reviews, education, and implementation
  follow-through. Roles can create and update cases from autonomous plans;
  owner interaction is reserved for decisions and approvals.

- **Priorities** — a cross-fleet decision queue that joins canonical lifecycle
  policy, analytics coverage, task ownership, and SEO evidence. Recommendations
  expose confidence and proxy value while expected profit remains deliberately
  blank until revenue is attributable by site/content.
- **Improvements** — the closed-loop delivery workbench. Starting a priority
  creates one correlated improvement run and task, captures the current
  analytics baseline, and tracks it through proposed, building, review,
  deployment, measurement, and a proven/regressed/inconclusive outcome. Preview,
  validation, branch, deployment, and outcome evidence remain attached to the
  same durable run rather than being split across unrelated views.
  Each build gets a real `git worktree` and its own `dd-imp-*` developer
  container; the live site checkout never changes branches. The workbench can
  run the assigned Claude implementation, show its log and full diff, commit
  only that worktree, start a browser preview, and enforce diff/test/build plus
  HTML, metadata, accessibility-structure, image-alt, analytics, and internal-
  link gates. Review includes side-by-side production/preview frames. A typed
  approval rebases and fast-forwards the validated commit onto the clean
  production branch, pushes it, waits for deploy-health confirmation, and only
  then starts a fresh 28-day measurement window. Rollback creates and pushes a
  real Git revert. One delivery/measurement run per site prevents overlapping
  changes from contaminating attribution; stale runs and task-state drift are
  visible instead of silently repaired.
- **Data Quality** — explicit source contracts for expected versus observed
  coverage, freshness, upstream errors, and revenue attribution completeness.

- **Engineers** — the live engineer audit: tier (aligned/partial/legacy/none),
  feature flags (work-lock / liveness-pulse / daily-summary), cron schedule,
  latest pulse status + age (stale flag at >35m), render pass/fail, Cloudflare
  health, queued-task count, kill-switch flags, plus a 3-day coverage % and a
  pulse sparkline. This panel **delegates to `engineer-status.py --json`** so the
  tier/pulse/queue logic stays single-sourced in the Python CLI.
- **Git** — per-site working-tree status (each site is its own submodule repo):
  branch, uncommitted-file count, ahead/behind. Expand a row to see the exact
  changed files with their porcelain status codes.
- **Build Usage** — automatically cached Cloudflare Workers Builds history with
  build minutes, monthly allowance/overage projection, repository rollups,
  linked commits and messages, failures, and the live production/preview trigger
  inventory. It also audits every trigger against the fleet path-filter and
  build-cache policy without exposing build tokens or environment variables.
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
  Exact query-page relationships add conservative click-upside estimates and
  multi-URL keyword-cannibalization detection without guessing the ranking URL.
  Operators can filter by site, priority, or opportunity type and file a
  deduplicated backlog task with an execution plan directly from an action.

Operational discovery remains dynamic: any site under `sites/*/ops/` appears
automatically. Lifecycle and capability policy come from the canonical
`registry/fleet.yaml`; the dashboard does not maintain a second registry.

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

### Commit workflow

This repository uses `tools/git-hooks/pre-commit`. When the live Vaultwarden
database is mounted, the hook refreshes and stages
`tools/credential-vault-backup/data/db.sqlite3` plus `last-backup.txt` on every
commit. That SQLite snapshot contains Bitwarden client-side-encrypted item
blobs; plaintext admin, automation-login, and master-password files are never
committed. Expect those two backup files to appear in the commit and leave
them staged. For a dashboard-only change, stage only `tools/fleet-dashboard/`
and let the hook add the encrypted snapshot automatically; do not use
`git add -A` in the monorepo because site submodules and other sessions may
have unrelated changes.

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

- LAN-wide publish (`0.0.0.0:4754`). Keep the host firewall restricted to the
  trusted LAN and keep `FD_TOKEN` enabled.
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
- **Causal event graph:** task creation, recommendation filing, lifecycle moves,
  completion, edits, and trashing are stored in `data/fleet-events.sqlite` with
  stable entity and correlation IDs. Query with `GET /api/events`; source-owned
  telemetry remains in its original service.
- **Improvement deployment guardrails:** quality evidence is bound to the exact
  worktree commit; any later edit invalidates deployment. The canonical checkout
  must be clean and on `main`/`master`, concurrent active improvements on the
  same site are rejected, failed rebases are aborted, and deploy/rollback both
  require typing the exact improvement title. Cancellation will not discard a
  dirty worktree. Implementation agents time out after 45 minutes and cannot
  deploy or modify the linked task themselves.
- **Worker boundary:** queue and developer workers run with a read-only root
  filesystem, no Linux capabilities, no privilege escalation, resource limits,
  and a dedicated per-worker bridge network. They receive only the requested
  site/worktree, worker state, and (when configured) one Codex auth file; host
  SSH directories, Claude directories, fleet `.env` files, and unrelated Codex
  state are not mounted. The Fleet Manager itself remains a trusted control
  plane because its authenticated API drives the Docker socket and repository.
- Amazon earnings retain report-level tracking IDs and map a tag to a site only
  when the tag is uniquely discoverable in that site's source. Ambiguous and
  missing tags remain visibly unattributed.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `FD_PORT` | `4754` | listen port |
| `FD_HOST` | `127.0.0.1` | bind address |
| `FD_TOKEN` | _(from the vault, via `rendered/tool-fleet-dashboard.env`)_ | require this token on `/api/*`; **required** on a non-loopback bind unless `FD_AUTH=0`. Rotate with `bin/fleet-dashboard rotate-token` (writes the vault, then re-renders) |
| `FD_VIEWER_TOKENS` | _(unset)_ | optional comma-separated header-only credentials allowed to read `GET` endpoints but forbidden from every mutation; alternatively append `viewer:<token>` to the vault-backed `FD_TOKEN` list |
| `FD_AUTH` | `1` | set `0` to disable the token gate while keeping `FD_TOKEN` parked (explicit opt-out) |
| `FD_ALLOW_INSECURE` | _(unset)_ | set `1` to allow a non-loopback bind with no token (accepts the risk) |
| `FD_ALLOWED_HOSTS` | loopback + compose names + configured LAN host | extra allowed `Host` values (or `*`) |
| `FD_DOMAINS_ROOT` | repo root | path to the domains monorepo |
| `FD_DATA_DIR` | `./data` | where the action audit log (`actions.jsonl`) is written |
| `DATAHUB_API` | `http://host.docker.internal:4760` | first-party GSC/GA4 source used by SEO Intelligence |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | root `.env` fallback | read-only source for the Build Usage background cache; credentials are never returned by the API or written to its cache |
| `FD_QUIET` | _(unset)_ | set `1` to silence the request log |

## Test

    npm test
