---
name: ultrarough.com-update
description: Run the operations cycle for ultrarough.com — verify all `/go/<id>` affiliate redirects resolve, audit the SKU registry for gaps, suggest SKU expansions across under-represented form factors and grit ranges, build, push, and live-smoke-test. Safe to run weekly. Auto-detects whether the catalog is stale (no SKU additions in N days) and proposes additions. Updates BOARD_REPORT with the cycle's findings.
---

# ultrarough.com — operations update cycle

You are running the canonical operations cycle for **ultrarough.com**. Read every section before acting.

> Naming convention: per-domain skills are named `<domain>-<purpose>` (e.g., `aliencouncil.com-update`, `ultrarough.com-update`).

## Project facts (do not look these up)

- Project root: `/home/jesse/projects/domains/ultrarough.com/`
- Live URL: https://ultrarough.com (after the `ultrarough.com-bind-domains` skill has been run)
- Repo: github.com/bourneash/ultrarough.com (private), branch `main`, auto-deploys via CF Workers Builds (Git integration) on push
- SKU registry: `site/src/lib/affiliate.ts`
- Affiliate cloak map: `site/public/_redirects`
- CF Zone ID: `980e286d87a8179086452f0b7c22fdc8`
- Voice rules: `CLAUDE.md` + `DESIGN_SYSTEM.md`. **Restraint is the joke. Never crude.**
- Node 23 required for build/preview: prefix `PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:$PATH"` (and ALWAYS append `:/usr/bin:/bin` so curl/grep/head are on PATH)
- Token scopes (memory `reference_cf_token_scopes.md`): no Pages, but Workers Domains + Email Routing + DNS + Workers Scripts all work

## Pre-flight

```bash
cd /home/jesse/projects/domains/ultrarough.com
set -a; . /home/jesse/projects/domains/.env; set +a
git fetch origin --quiet
git status --short
git log --oneline origin/main..HEAD HEAD..origin/main
```

If working tree is dirty → surface, don't bulldoze. If diverged from origin/main → STOP and ask Jesse.

## Step 1 — affiliate hygiene (always run first)

For every line in `site/public/_redirects` that starts with `/go/`, parse the destination and confirm it's HTTP 200 after redirect:

```bash
PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PASS=0; FAIL=0; FAILED_LINKS=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$line" ]] && continue
  src=$(echo "$line" | awk '{print $1}')
  dst=$(echo "$line" | awk '{print $2}')
  [[ "$src" =~ ^/go/ ]] || continue
  code=$(/usr/bin/curl -sS -o /dev/null -L -w "%{http_code}" -A "Mozilla/5.0 ultrarough-bot" --max-time 10 "$dst")
  if [[ "$code" =~ ^2 ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED_LINKS+=("$src → $dst (HTTP $code)"); fi
done < site/public/_redirects
echo "=== affiliate links: ${PASS} pass / ${FAIL} fail ==="
[[ ${#FAILED_LINKS[@]} -gt 0 ]] && printf '  %s\n' "${FAILED_LINKS[@]}"
```

For each failure: open a `type: affiliate` task in `ops/tasks/backlog/` describing the broken link. Do not auto-fix — affiliate replacement decisions need a human-reviewed SKU substitute.

## Step 2 — registry gap analysis

The catalog is the SEO weapon. Each SKU added = 1 review page + cross-listings on grit + form pages. Goal: 50 SKUs by month 1, 100 by month 3.

Run the gap analysis:

```bash
PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
node --input-type=module -e '
import { SKUS, FORMS, GRIT_RANGES } from "./site/src/lib/affiliate.ts";
const counts = {};
for (const f of Object.keys(FORMS)) counts[f] = 0;
for (const s of SKUS) counts[s.form]++;
console.log("=== form-factor coverage ===");
for (const [f, n] of Object.entries(counts)) console.log("  " + f.padEnd(10) + " " + n);
console.log("");
console.log("=== grit coverage (SKUs at or near each grit) ===");
for (const g of GRIT_RANGES) {
  const target = parseInt(g.slug, 10);
  const matched = SKUS.filter(s => {
    if (typeof s.grit === "number") return Math.abs(s.grit - target) <= 40;
    if (typeof s.grit === "string") {
      const nums = (s.grit.match(/\d+/g) || []).map(Number);
      if (nums.length >= 2) return target >= nums[0]-20 && target <= nums.at(-1)+20;
      if (nums.length === 1) return Math.abs(nums[0]-target) <= 60;
    }
    return false;
  }).length;
  console.log("  " + g.slug.padEnd(5) + " " + matched);
}
' 2>/dev/null || echo "(if node ts ESM fails: read site/src/lib/affiliate.ts manually and tally)"
```

Identify under-represented categories:
- Form factors with < 2 SKUs
- Grit ranges with 0 SKUs that have search demand (anything 40-3000 in the chart)
- Material gaps (e.g., no garnet entries, no 6-inch sander, no auto-detailing-specific grit)

For each gap: queue a `type: content` task `ops/tasks/backlog/<yyyy-mm-dd>-add-<sku-slug>.md` with the proposed SKU spec ready to drop into `affiliate.ts`. Do not commit additions in this skill — let the content role pick them up on its scheduled run, OR add them inline if 5+ are queued and the catalog hasn't grown in >14 days.

## Step 3 — voice audit (sample, don't rewrite)

Spot-check 3 random SKU pitches and 1 cornerstone guide passage against the voice rules in `DESIGN_SYSTEM.md`:

- ✅ Real sandpaper terminology used unironically
- ✅ Dry, magazine-punchy sentence length
- ✅ Restraint — second meaning lands on second read, not first
- ❌ Crude / vulgar / emoji / "you naughty thing" / "spicy" → **flag for rewrite**

If any piece fails the voice audit: open a `type: content` task to soften it. Do not edit in this skill — voice changes go through the content role.

## Step 4 — build + audit

```bash
PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd site
npm install --no-audit --no-fund 2>&1 | tail -5
npm run security:audit 2>&1 | tail -10
npm run build 2>&1 | tail -10
cd ..
```

If build fails: open `type: engineering` task with the error. Stop the cycle.

If audit reports HIGH or CRITICAL: open `type: engineering` task with the dependency. Continue but flag in the BOARD update.

## Step 5 — push if changes

```bash
if [[ -n "$(git status --short)" ]]; then
  git add -A
  git -c commit.gpgsign=false commit -q -m "ops: weekly update cycle (affiliate verify, gap queue)"
  git push origin main
fi
```

CF Workers Builds rebuilds on push to main automatically.

## Step 6 — live smoke test (only if site is bound)

```bash
PATH="/home/jesse/.nvm/versions/node/v23.7.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
APEX_IP=$(/usr/bin/curl -sS -H "accept: application/dns-json" \
  "https://cloudflare-dns.com/dns-query?name=ultrarough.com&type=A" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); ans=d.get("Answer") or []; print(ans[0]["data"] if ans else "")')

if [[ -z "$APEX_IP" ]]; then
  echo "ultrarough.com not yet resolving — skipping live smoke (Worker not bound, or DNS still propagating)."
else
  echo "=== smoke test on https://ultrarough.com ==="
  for path in / /reviews/ /grit/ /forms/ /grit-selector/ /guides/sandpaper-grit-chart/ /sitemap-index.xml /rss.xml; do
    code=$(/usr/bin/curl -sS -o /dev/null -L -w "%{http_code}" \
      --resolve "ultrarough.com:443:${APEX_IP}" \
      "https://ultrarough.com${path}")
    echo "  HTTP ${code}  ${path}"
  done
  # affiliate redirect spot-check
  target=$(/usr/bin/curl -sS -o /dev/null -w "%{redirect_url}" \
    --resolve "ultrarough.com:443:${APEX_IP}" \
    "https://ultrarough.com/go/3m-pro-grade-assorted")
  [[ "$target" == *"tag=ultrarough-20"* ]] \
    && echo "  ✓ affiliate cloak attributing to ultrarough-20" \
    || echo "  ✗ affiliate cloak FAILED — check _redirects"
fi
```

## Step 7 — log to BOARD_REPORT

Prepend a new dated section to `ops/board/BOARD_REPORT.md`:

```markdown
## YYYY-MM-DD — Update cycle

- Affiliate: {PASS}/{TOTAL} `/go/<id>` links resolve. {FAIL_DETAIL}
- Catalog: {N} SKUs. Form-factor low watermark: {WORST_FORM} ({N}). Grit gaps: {LIST}.
- Build: {PASS|FAIL}. Audit: {clean | N moderate, N high}.
- Smoke: {N}/{N} pages live. Affiliate cloaking verified.
- Tasks queued: {N} content, {N} affiliate, {N} engineering.

### Open items
{copy from CREDENTIALS_NEEDED.md if anything still blocks Jesse}
```

Commit + push.

## Step 8 — surface tight summary

Print a 5-line summary to Jesse:

```
ultrarough.com — update cycle complete.
Affiliate: {PASS}/{TOTAL} resolve.
Catalog: {N} SKUs ({N} added this week).
Build: clean. Live: {N}/{N} smoke tests pass.
Backlog: {N} new tasks queued (see ops/tasks/backlog/).
```

## Hard rules

- Never edit affiliate.ts in this skill *for substantive content* — that's the content/affiliate role's job. Adding queued SKUs from existing backlog tasks is fine.
- Never alter `DESIGN_SYSTEM.md` voice rules without Jesse's direct instruction.
- Never bypass the `npm audit` check.
- Never push with `--no-verify` or `--amend` published commits.
- Never deploy on a Friday after 5pm local — same rule as deployer role.
