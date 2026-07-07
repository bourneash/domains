#!/usr/bin/env bash
# scaffold-update-skill.sh — stamp a per-site `<domain>-update` editorial-cycle skill from the
# proven americastrikes.com-update / aliencouncil.com-update skeleton.
#
# This does NOT produce a finished skill — it produces a faithful structural skeleton (gap-aware
# mode table, the full publish cycle, build/smoke gates, failure modes, cron wiring) with `FILL:`
# markers for everything site-specific. You then fill the markers from the site's brief + config.
# The point is to never hand-rebuild the 12-step skeleton again.
#
# Usage:
#   scaffold-update-skill.sh <domain.tld> [output-dir] [--force]
#
# Examples:
#   scaffold-update-skill.sh broadwayshowgirls.com
#   scaffold-update-skill.sh broadwayshowgirls.com /home/jesse/.claude/skills --force
#
# Default output dir is the domains repo's .claude/skills/ so the skill commits with the repo and
# is visible to the cron container (which mounts the repo). Pass ~/.claude/skills as arg 2 to match
# the older americastrikes/aliencouncil placement instead.

set -euo pipefail

DOMAIN="${1:-}"
OUTBASE="${2:-/home/jesse/projects/domains/.claude/skills}"
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; done
# if arg 2 was --force, reset OUTBASE to default
[ "${OUTBASE}" = "--force" ] && OUTBASE="/home/jesse/projects/domains/.claude/skills"

if [ -z "$DOMAIN" ] || [[ "$DOMAIN" == --* ]]; then
  echo "usage: scaffold-update-skill.sh <domain.tld> [output-dir] [--force]" >&2
  exit 2
fi

OUTDIR="${OUTBASE%/}/${DOMAIN}-update"
TARGET="${OUTDIR}/SKILL.md"

if [ -f "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  echo "refusing to overwrite existing $TARGET (pass --force to replace)" >&2
  exit 1
fi

mkdir -p "$OUTDIR"
TMP="$(mktemp)"

cat > "$TMP" <<'TEMPLATE'
---
name: @@DOMAIN@@-update
description: Run the editorial update cycle for @@DOMAIN@@ — FILL: one sentence on what it inventories, scans, and ships. Container/cron-safe headless skill — no interactive prompts. Invoke as `/@@DOMAIN@@-update`. Safe to run hourly, every few hours, or daily — backfills the gap automatically.
---

# @@DOMAIN@@ — editorial update cycle

You are running the canonical update cycle for **@@DOMAIN@@**. Read every section before acting. This
skill is **gap-aware** and **container-safe**: no `AskUserQuestion`, no `EnterPlanMode`, no clarifying
prompts — when invoked headless via `claude -p` inside the worker container there is no human at the
keyboard. **Do not skip steps.**

> Modeled on `americastrikes.com-update`. Keep what fits; delete steps this site doesn't have (e.g. no
> markets block, no IndexNow, no social queue). Sister skills: `americastrikes.com-update`,
> `aliencouncil.com-update`.

## Project facts (do not look these up)

- Project root: `/home/jesse/projects/domains/sites/@@DOMAIN@@/` (in container: `/work`)
- Live URL: https://@@DOMAIN@@/
- Repo: github.com/bourneash/FILL-REPO (private), branch `main`, auto-deploys via CF Workers Builds on push
- Content schema(s): `site/src/content.config.ts` — FILL: list the collections this cycle writes (e.g. `articles`, `briefings`)
- FILL: topic/beat slugs, persona slugs + their beats, edition counter (if any)
- Voice rules: `CLAUDE.md` + FILL: `ops/roles/<writer>.md`. FILL: the one-line voice law (e.g. "restraint is the joke", "serious newsroom, no exclamation").
- Smoke-test script: FILL: `ops/scripts/run-smoke-tests.sh https://@@DOMAIN@@` — exit 0 = pass
- Build: `cd site && npm run build` from repo root. Container installs `node_modules` on first run.
- Date: use the actual date from the system reminder, not hardcoded values from old files
- Affiliate: FILL: tag `@@BASE@@-20`, bundles/shelves per piece (delete if no affiliates)

## Gap awareness — read this first

When the skill fires, inventory freshness and pick a mode. FILL the table for this site's content
types (single-edition sites collapse to fresh / stale / catch-up):

| Latest content age | Mode | Behavior |
|---|---|---|
| < FILL h | **NO-OP** | Fresh. Surface "no-op, last piece <Xh ago" and stop. Bump nothing. |
| ≥ FILL h | **PUBLISH** | Ship one piece covering the window since the last one. |
| ≥ 48h | **CATCH-UP** | One honest catch-up edition covering the whole gap. Never fabricate per-day backfill. |

Rules common to all modes:
- News/scan window = `last_published` → `now`.
- Filenames/edition slugs use **today's** date — never backdate.
- All claims sourced. **No fabrication.** Thin window → ship a short honest piece, never an invented one.

## The cycle (in order — delete steps this site lacks)

### Step 1 — State + freshness inventory (do not skip)
```bash
cd /home/jesse/projects/domains/sites/@@DOMAIN@@ 2>/dev/null || cd /work
git status --short
git fetch origin --quiet && git log --oneline origin/main..HEAD HEAD..origin/main
ls site/src/content/FILL-COLLECTION/ | sort | tail -3
date -u
```
Dirty tree → surface, don't bulldoze. Diverged from origin → STOP. Read the latest piece's
`published:`, compute the gap, pick the mode. NO-OP → record one line in `ops/board/last-run.json` and stop.

### Step 2 — Source scan (cache first, then subagent)
FILL: if this site aggregates news, mirror americastrikes Step 2 — check `ops/cache/<feed>.json`
freshness, and only on miss dispatch a WebSearch subagent scoped to this site's beats + preferred
sources, returning scored JSON. Persona/review sites with no news feed: skip to Step 3 and pick the
topic from the content plan / brief instead.

### Step 3 — Decide what to publish
Combine the scan with the mode. If the scan is thin (FILL: < N stories scoring ≥5) degrade to the
shortest honest artifact — never invent to fill a quiet window.

### Step 4 — Writer subagent
Dispatch a `general-purpose` Agent to write one piece matching the schema in `site/src/content.config.ts`.
Pass: the lede/topic, the window, today's date, and the absolute voice rules. Set the byline/persona
per the beat map in Project facts. Return only the file path written.

> **Persona sites — the daily random co-authored piece.** On the cadence the brief defines (e.g. once
> a day), pick TWO personas at random (randomness in the script/selection, never hardcoded), write the
> piece in both voices, set `bylines: [a, b]` and `kind: coauthored`, and attach one writer's affiliate
> shelf. See the persona reference in `skills-domains-build-new-site`.

### Step 4b — Editor pass (optional, cheap)
If the site wants a proofreading gate, dispatch a Haiku `general-purpose` Agent to correct style in
place (no rewrite); frontmatter is read-only. Output `no changes needed` or the corrected file.

### Step 5 — Image (only if the piece needs a cover)
FILL: run the site's image pipeline (e.g. `node site/scripts/find-image.mjs <slug>`), or generate via
the `domains-media-generator-nanobanana` skill, or Pexels (keys in `.env`). Always write `imageCredit`.
Never ship a piece with a broken/placeholder hero.

### Step 6 — Build (gate)
```bash
cd /work/site 2>/dev/null || cd /home/jesse/projects/domains/sites/@@DOMAIN@@/site
PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:$PATH" npm run build 2>&1 | tail -15
```
Build fails → **STOP**, diagnose (usually: unquoted ISO date, missing required field, bad slug), fix,
re-run. Never push a broken build. Confirm `dist/client/wrangler.json` exists.

### Step 7 — Commit + push
```bash
git add site/src/content/
git -c commit.gpgsign=false commit -m "@@DOMAIN@@ update — <DATE> <MODE>: <one-line summary>"
git push origin main
```
CF Workers Builds deploys on push (~60–120s).

### Step 8 — Wait + smoke-test live (gate)
```bash
sleep 90
bash FILL-SMOKE-SCRIPT https://@@DOMAIN@@ 2>&1 | tail -25; echo "exit=$?"
curl -sS -o /dev/null -w "%{http_code} %{url_effective}\n" https://@@DOMAIN@@/FILL-new-url/
```
200 expected. Still 4xx after a 60s retry → surface to `ops/board/from-jesse/URGENT-<TODAY>.md`, and
worst case `git revert HEAD && git push`.

### Step 9 — (optional) IndexNow + social queue
FILL: if the site uses them, ping IndexNow for the new URLs and append social posts to
`ops/social/queue.jsonl`. Both are best-effort, non-fatal. Delete if unused.

### Step 10 — Update last-run + report, then stop
Merge (don't overwrite) `ops/board/last-run.json` with `{at, mode, shipped, smoke, exit}`, append a
dated entry to `ops/board/update-<TODAY>.md`, surface a final one-line summary, and **stop**. Do not
`/loop` or `/schedule` from inside this skill.

## Failure modes (handle explicitly)
| Failure | Action |
|---|---|
| Subagent returns no/malformed JSON | Retry once with "valid JSON only". Then degrade to shortest honest artifact. |
| Build fails | Show error tail; one targeted fix (usually date quoting / missing field); else STOP. |
| Smoke fails after 1 retry | `git revert HEAD && git push`; log to `ops/board/from-jesse/URGENT-<TODAY>.md`. |
| Content fresh (NO-OP) | Skip past Step 1; `mode: "no-op"`; exit 0. |
| Scan returns 0 usable items | Shortest honest standing piece; never invent. |
| Working tree dirty / diverged | Surface; do not stash or auto-resolve. |

## Don't do
- Don't invent sources, quotes, or events. Quiet window → short honest piece or no-op.
- Don't push without a green build. Don't bump anything without shipping content.
- Don't ask the user questions — this runs headless. Don't `/loop` or `/schedule` from here.
- Don't `--no-verify` or amend pushed commits. Don't backdate filenames. Don't fabricate per-day backfill.

## Container/cron invocation
The wrapper role `ops/roles/update.md` invokes this via `run-role.sh`:
```bash
docker compose run --rm worker update
```
which runs `claude -p "<contents of ops/roles/update.md>"`, and that file reads:
> Invoke the `/@@DOMAIN@@-update` skill and follow it through to completion.

Cron in `ops/docker/crontab.docker` (FILL the cadence the brief wants):
```cron
# Editorial update cycle
0 FILL * * *  docker compose run --rm worker update
```
Gap-aware design means a missed run recovers on the next fire, and fresh-content fires no-op cheaply.
TEMPLATE

BASE="${DOMAIN%.*}"
sed -e "s/@@DOMAIN@@/${DOMAIN}/g" -e "s/@@BASE@@/${BASE}/g" "$TMP" > "$TARGET"
rm -f "$TMP"

echo "Stamped: $TARGET"
echo
echo "Next:"
echo "  1. Open it and resolve every 'FILL:' / 'FILL-' marker from the site's brief + content.config.ts."
echo "  2. Delete steps this site doesn't have (news scan, image, IndexNow, social queue)."
echo "  3. Create the wrapper role: ops/roles/update.md → 'Invoke the /${DOMAIN}-update skill ...'."
echo "  4. Add the cron line to ops/docker/crontab.docker and register the role via the cron-role skills."
echo "  5. Dry-run: docker compose run --rm worker update   (or invoke /${DOMAIN}-update interactively)."
