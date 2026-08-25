---
name: domains-cron-role-affiliate-editor
description: Wire affiliate-link monitoring onto a portfolio site under /home/jesse/projects/domains/sites/. Since 2026-08-25 this is tools/affiliate-sentinel — a host-side daily check that uses the Amazon Creators API for product liveness and a direct /go/ fetch for cloak health, spends zero tokens on a healthy run, and auto-replaces a confirmed-dead ASIN behind a build gate. Use when the user asks to "add the affiliate editor", "install affiliate link checking", "add the affiliate sentinel", "wire affiliate monitoring", "give <site> affiliate link monitoring", or asks why a site's affiliate links are not being checked. The old per-site curl role this replaced is retired — do NOT install it.
---

# Wire affiliate monitoring onto a site

**There is no per-site role to install any more.** `tools/affiliate-sentinel`
derives everything it needs from the site itself at run time, so onboarding is
one line in the host crontab.

## Onboarding a site

1. **Check it has a registry.** The sentinel searches for it — `site/src/lib/affiliate.ts`
   is the fleet standard, but `site/src/data/affiliate.ts` and `affiliates.ts` also
   work, and field names may vary (`id`/`slug`, `asin`/`searchOrAsin`/`url`,
   `name`/`label`/`title`). Confirm with a dry run:

   ```sh
   python3 tools/affiliate-sentinel/sentinel.py --site-root sites/<domain> --dry-run --json
   ```

   If it reports "no affiliate registry found", the site has nothing to monitor
   yet — stop here.

2. **Read the dry-run output before scheduling it.** Anything it flags is real
   and will be filed as a task on the first live run. Sanity-check a couple of
   findings by hand (`curl -sI https://<domain>/go/<id>/`) so you are not
   scheduling a run that files a pile of bogus tasks.

3. **Add the site to the host crontab line** (append to the existing one; do not
   create a second line):

   ```sh
   crontab -e
   # 40 3 * * * /home/jesse/projects/domains/tools/affiliate-sentinel/run-fleet.sh <...existing...> <domain>
   ```

4. **Run it once for real** to confirm the whole path — Slack post, state commit,
   task filing:

   ```sh
   bash tools/affiliate-sentinel/run-fleet.sh <domain>
   ```

## Why it is host-side and not a cron container role

The shared Alpine cron image has no `httpx` (needed by the Amazon client and the
cloak check), and musl cannot run workerd for the heal's `npm run build` gate —
the same mismatch that deadlocked broadwayshowgirls' engineer build gate. Same
precedent as the fleet reaper and the cron-freshness sweep.

## Do NOT install the old role

`tools/cron-roles/archetypes/affiliate-editor/` is **retired**. It curled every
`/go/` link through to Amazon and grepped the landed HTML for soft-404 strings,
which meant a large permanent share of every run was "inconclusive — Robot Check"
(Amazon serves an anti-bot wall to datacenter IPs) and liveness rode on brittle
English marker strings. Installing it now would double up on the sentinel and
reintroduce that noise.

`ops/scripts/run-affiliate-editor.sh` is kept **unscheduled** on the sites that
already have it, as a manual fallback for when the Amazon API is unavailable. If
a site does not have it, do not add it.

## Maintenance / debugging

- Full docs, including the heal path and its guardrails: `tools/affiliate-sentinel/README.md`
- Per-run logs: `tools/affiliate-sentinel/logs/run-<date>.log`, plus
  `<site>/ops/logs/affiliate-sentinel-<date>.log`
- Streak state: `<site>/ops/state/affiliate-sentinel.json`
- Check without writing or spending tokens: `--dry-run`
- Check and file tasks but never auto-replace: `--no-heal`
- Tests: `python3 tools/affiliate-sentinel/tests/test_sentinel.py`
