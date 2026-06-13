---
name: domains-agent-cron-role-engineer
description: This skill should be used when the user asks to "install the engineer agent", "set up the engineer role", "add the engineer cron role", "install the cron engineer", "add an engineer agent to this project", "update the engineer role", "maintain the engineer agent", or "wire up the engineer for this site". Installs or updates the autonomous engineer cron role into any domain project under /home/jesse/projects/domains/sites/, adds it to the crontab, and updates all other agent roles to know about the engineer's presence and escalation path.
---

# domains-agent-cron-role-engineer

Install or maintain the autonomous engineer cron role for a domain project. The engineer runs every 4 hours, health-checks the live site, picks up `type: engineering` tasks from the backlog, reports to Slack, and commits logs to the repo.

## Two modes

**Install** — `ops/roles/engineer.md` does not yet exist in the target project.
**Maintain** — `ops/roles/engineer.md` already exists; bring it up to date and scan for missing escalation sections in other roles.

Detect mode automatically: if `ops/roles/engineer.md` exists, run maintain. Otherwise run install.

---

## Step 1: Detect project context

Gather these values before writing anything. They are used as substitutions throughout the templates.

```bash
# From the target project root:
TARGET=<project-root>   # e.g. /home/jesse/projects/domains/sites/americastrikes.com

# Site name — try package.json, then CLAUDE.md, then directory name
SITE_NAME=$(grep -m1 '"name"' $TARGET/site/package.json 2>/dev/null | sed 's/.*": *"//;s/".*//')
[ -z "$SITE_NAME" ] && SITE_NAME=$(basename $TARGET)

# Live URL — try CLAUDE.md, wrangler.jsonc, or construct from dir name
SITE_URL=$(grep -m1 'https://' $TARGET/CLAUDE.md 2>/dev/null | grep -oP 'https://[^ ]+' | head -1)

# Slack channel + env var — read from existing crontab or run-role.sh
SLACK_CHANNEL=$(grep -oP 'SLACK_CHANNEL_\w+:-\K[^}]+' $TARGET/ops/scripts/run-role.sh 2>/dev/null | head -1)
SLACK_ENV_VAR=$(grep -oP 'SLACK_CHANNEL_\w+' $TARGET/ops/scripts/run-role.sh 2>/dev/null | head -1)

# Existing roles
ls $TARGET/ops/roles/
```

If `notify-slack.sh` does **not** exist at `$TARGET/ops/scripts/notify-slack.sh`, copy it from the sinderella reference project (`/home/jesse/projects/domains/sites/sinderella.org/ops/scripts/notify-slack.sh`) before proceeding.

---

## Step 2: Install or update `ops/roles/engineer.md`

Read the template from `references/engineer-role-template.md`. Replace all `{{PLACEHOLDER}}` values with the detected project context:

| Placeholder | Source |
|---|---|
| `{{SITE_NAME}}` | Detected site name |
| `{{SITE_URL}}` | Detected live URL |
| `{{SLACK_CHANNEL}}` | Detected Slack channel name |
| `{{SLACK_CHANNEL_ENV_VAR}}` | Detected env var name |

Write the result to `$TARGET/ops/roles/engineer.md`.

**For maintain mode:** compare the existing file's section headings against the template. Add any sections that are missing. Do not overwrite customisations the operator has made inside existing sections unless they conflict with the template's required structure (health check list, Slack call format, build gates).

---

## Step 3: Add engineer to `ops/docker/crontab.docker`

Check whether an `engineer` entry already exists:

```bash
grep -q "engineer" $TARGET/ops/docker/crontab.docker
```

If missing, add this block immediately before the `# SEO + Planner` or `# LOG PRUNE` section (whichever comes first):

```
# ────────────────────────────────────────────────────────────────────────
# ENGINEER — every 4 hours
# Health-checks the live site, picks up type:engineering tasks from backlog
# (max 3 per run), commits log, pings Slack.
# ────────────────────────────────────────────────────────────────────────
0 */4 * * *   bash ops/scripts/run-worker.sh engineer
```

If an entry already exists, leave it as-is.

---

## Step 4: Update other agent roles

For each `*.md` in `$TARGET/ops/roles/` **except** `engineer.md`, `brief-builder.md`, `reading-generator.md`, and `signal-writer.md` (Python pipeline roles — they can't self-escalate):

1. Check whether the file already contains `## Escalating engineering issues`.
2. If missing, read `references/escalation-snippet.md` and append the correct variant based on the role's purpose:

| Role file contains… | Variant to use |
|---|---|
| `voice`, `audit`, `score` | **quality-auditor** variant |
| `seo`, `keyword`, `search` | **seo-analyst** variant |
| `plan`, `board`, `status` | **planner** variant |
| `content`, `writer`, `generator` | **content-writer** variant |
| anything else | **generic** variant |

Substitute `{{ROLE_NAME}}` with the role's filename (without `.md`) in the appended text.

---

## Step 5: Ensure infrastructure

```bash
mkdir -p $TARGET/ops/logs
mkdir -p $TARGET/ops/tasks/{backlog,in-progress,done}
```

These directories must exist for the engineer to function. Create them silently if missing.

---

## Step 6: Commit and report

```bash
cd $TARGET
git add ops/roles/ ops/docker/crontab.docker ops/logs/ ops/tasks/ ops/scripts/notify-slack.sh
git commit -m "engineer: install cron role + wire escalation paths in agent roles"
```

Report to the user:
- What was installed vs. already present
- Which roles received the escalation section
- Whether notify-slack.sh was copied
- Any `{{PLACEHOLDER}}` values that could not be auto-detected (so the user can fill them in manually)

---

## Maintain mode specifics

When the engineer role already exists, run a lighter pass:

1. **Template drift** — check that all section headings from `references/engineer-role-template.md` exist in the current `engineer.md`. Add any that are missing.
2. **Missing escalation sections** — scan all role files and add escalation section to any that are missing it (same logic as Step 4).
3. **Cron entry** — verify the `0 */4 * * *` entry exists. Add if missing.
4. **No destructive changes** — never delete or rewrite content in existing role files. Append only.

---

## Additional resources

- **`references/engineer-role-template.md`** — Full canonical `engineer.md` with `{{PLACEHOLDER}}` substitution tokens
- **`references/escalation-snippet.md`** — Role-specific boilerplate variants for the "Escalating engineering issues" section
