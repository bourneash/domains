---
name: domains-audit-ai-inventory
description: Audit which AI every site/service in the domains fleet uses — one row per cron service, with local-vs-remote, model, and enabled/disabled status. Use when asked "what AI do we use / where", "which model does X run", "what's local vs Claude", "what's disabled", or to refresh the AI-usage table after wiring/pausing roles.
---

# Audit fleet AI usage

One command produces the authoritative table (one row per service):

```bash
python3 tools/ai-inventory/audit-ai.py            # markdown table (ID | Domain | Service | Local/Remote | Model | Status)
python3 tools/ai-inventory/audit-ai.py --json     # same data as JSON
```

Run from the domains repo root (`/home/jesse/projects/domains`). No deps (stdlib only).

## What it reads (and how to trust it)

For every site with `ops/scripts/run-worker.sh` (a runner site), it walks `ops/docker/crontab*`
for `run-worker.sh <role>` / `run-role.sh <role>` invocations (skipping commented lines — a
commented cron line = that service is OFF and is intentionally excluded), then resolves:

- **Status** — `DISABLED` iff `sites/<domain>/ops/.<role>-disabled` exists (the kill-switch).
- **Model** — in priority order: (1) `<role>) … MODEL="x"` in `run-role.sh`; (2) content-backend
  env in `docker-compose.yml` (`BSG_LLM_BACKEND`, `WRITER_MODEL`, `LOCAL_LLM_MODEL`); (3) a
  role-specific `run-<role>.sh` that calls Ollama → Local, else the generic `claude -p` path.
- **Local/Remote** — Ollama model ⇒ **Local** (host Ollama); `claude -p` ⇒ **Remote** (Claude Code
  SUBSCRIPTION, not the per-token API — no `ANTHROPIC_API_KEY` on the workers); scraper/smoke ⇒ **no-AI**.

`MODEL=""` resolves to claude -p's **default (currently Sonnet)**. Rows noted
`verify if pinned` are claude -p roles whose script wasn't opened — open `run-<role>.sh` to confirm
an explicit `--model` if exactness matters.

## Toggling a service (what the audit's Status reflects)

Kill-switch (instant, no rebuild — honored by both `run-worker.sh` and `run-role.sh`):

```bash
touch sites/<domain>/ops/.<role>-disabled    # disable
rm    sites/<domain>/ops/.<role>-disabled    # re-enable
```

⚠️ Some `ops/` dirs are **root-owned** (container writes) → `touch` gives Permission denied.
Create the flag via a root container instead:
`docker run --rm -v $PWD/sites:/s alpine touch /s/<domain>/ops/.<role>-disabled`.
These flags are gitignored (host-local). For a *permanent* removal, comment the crontab line +
rebuild that site's cron image.

## Switching local↔Claude / model (the 3 content sites)

- **broadwayshowgirls**: `BSG_LLM_BACKEND` in docker-compose = `local` | `claude-sonnet` | `claude-haiku`.
- **saveusfarms / americastrikes**: Claude path = `update` role (`WRITER_MODEL` = `sonnet`|`haiku`);
  Local path = `news-writer-local` role (paused via kill-switch). See [[reference_local_llm_writer_pattern]].

After any change, re-run the audit to confirm the table.
