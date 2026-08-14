# content-guardrails

Fleet-wide identity/content protection. Two tiers:

- **Blocked** — hard-fails any commit containing the term. No override, ever.
  For things that must NEVER appear in fleet content (e.g. a real surname).
- **Warn** — only fails if an AI context-classifier judges the surrounding
  line actually refers to the protected identity. Clears "Jesse Owens" (a
  named public figure); flags "our founder Jesse" (a vague, unattributed,
  personally-identifying claim). A human (never the committing agent) can
  override a warn-flag with `HUMAN_ALLOW_WARN=1 git commit ...`.

Config lives in `config.json` (global lists + additive per-repo overrides —
a repo can add a term, never remove a global one). Edit it via the Fleet
Dashboard's **Guardrails** tab, or directly in this file.

## How it's wired in

`check.js` runs from the shared pre-commit hook (`tools/git-hooks/pre-commit`),
against whatever's currently staged, on **every commit fleet-wide** — the
domains superproject and every `sites/*` submodule.

Enforcement has two independent legs, because host and container commits
resolve `core.hooksPath` differently:

1. **Host-side**: `tools/scripts/install-git-hooks.sh` sets each repo's
   `core.hooksPath` to the absolute host path `tools/git-hooks`. Works for
   any commit made on the host (Jesse directly, the Fleet Dashboard's git
   module, a Claude Code session working in `sites/*` on the host — like the
   one that built this tool).

2. **Container-side (the actual leak vector — AI-authored content)**: worker
   containers only bind-mount `.:/work` (the single site repo) plus
   `tools/ -> /work/.monorepo-tools:ro`. The absolute host hooksPath from (1)
   **does not exist inside the container**, and git silently skips a
   hooksPath dir that doesn't exist — so relying on (1) alone leaves every
   AI-role commit made inside a worker container completely unchecked. Fix:
   `tools/scripts/install-guardrail-container-hooks.sh` inserts
   `git config --global core.hooksPath /work/.monorepo-tools/git-hooks` into
   each site's `ops/docker/entrypoint-worker.sh` (a container-local
   `--global` config in the container's own `~/.gitconfig`, so it never
   touches the repo's shared, host-relevant `.git/config`). No image rebuild
   needed — entrypoint scripts are bind-mounted, not baked, so this is
   live on the container's next run.
   Covers every site with a worker/cron Docker pipeline (23 as of 2026-08-14;
   sites without one are static/coming-soon placeholders with no AI content
   pipeline, so no leak vector to cover).

Both installers are idempotent — safe to re-run any time (e.g. after adding
a new site). `full-bootstrap.sh` calls both for new domains automatically.

## Why classification uses the `claude` CLI, not a raw API call

Every worker container already has an authenticated `claude` CLI (same OAuth
session every AI role uses) — no `ANTHROPIC_API_KEY` is configured
fleet-wide (see memory `project_fleet_outage_2026-08_oauth_expiry`). Shelling
out to `claude -p` reuses that existing auth instead of plumbing a new
credential. **Fails closed**: if the classifier can't run (auth expired,
container has no `claude`, garbage output), the hit is treated as flagged —
a guardrail whose failure mode is "silently let everything through" is worse
than no guardrail.

## Alerting + audit trail

Every blocked hit and every warn-flag posts to Slack `#domain-ops` (fleet
infra channel, not a per-site one — this is a compliance event, same
convention as `data-hub-images`' monitor) and appends a record to
`logs/hits.jsonl` (gitignored; read by the Fleet Dashboard's Guardrails tab
and, for container-side hits, visible in `docker logs`/the Errors tab too,
since `check.js` also prints to stderr).

## Files

- `config.json` — the lists. Not mounted read-write into any container, so
  an agent can never edit its own blocklist.
- `lib.js` — matching, classification, Slack alert, log read/write. Shared
  by `check.js` and the Fleet Dashboard's `server/guardrails.js`.
- `check.js` — the CLI entry point the pre-commit hook calls.
- `logs/hits.jsonl` — audit trail (gitignored).

## Manual test

```
node tools/content-guardrails/check.js --repo-root <any git repo>
```
Scans that repo's currently staged diff; exit 0 = clean, exit 1 = blocked.
