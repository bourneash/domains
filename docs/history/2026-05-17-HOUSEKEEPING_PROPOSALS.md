# Housekeeping Proposals — 2026-05-17

> **STALE — superseded 2026-06/07.** Most of the portfolio-ops-container
> proposals below were superseded by `tools/fleet-dashboard/` (Cron tab) and
> the `tools/cron-roles/` family. Kept for history; do not treat as an open
> checklist — check `tools/fleet-dashboard/` and current cron-role skills for
> live state.

Recurring cleanup + reliability tasks that should be automated, prioritized
by blast radius if neglected.

## Current ops-loop hardening matrix

| Site                  | Containerized | run-role push | Slack | Log prune |
|-----------------------|---------------|---------------|-------|-----------|
| **americastrikes.com**| ✅            | (deployer)    | ✅    | ✅        |
| **sinderella.org**    | ✅            | ✅            | ✅    | ✅        |
| aliencouncil.com      | ❌ host cron  | ❌            | ❌    | ❌        |
| reviewtattoo.com      | ❌ host cron  | ❌            | ❌    | ❌        |
| ultrarough.com        | ❌ host cron  | ❌            | ❌    | ❌        |
| weapontester.com      | ❌ host cron  | ❌            | ❌    | ❌        |
| rc-9.com              | ❌ (no run-role.sh) | —       | —     | —         |

Two sites are at the proven americastrikes-pattern baseline. Five are not.

---

## Tier 1 — Do these soon (high blast radius if neglected)

### 1.1 Containerize the remaining 4 ops loops
**Sites:** aliencouncil, reviewtattoo, ultrarough, weapontester.

**Why:** Host crontab was discovered EMPTY on 2026-05-17 — cf-stats had
been silently dead for 9 days as a result, and these four sites'
autonomous ops were presumably also dead. There's no signal in the host
crontab being wiped; the operator has no idea until they happen to look.
The container pattern is restart-by-Docker and survives `crontab -r`.

**Effort:** ~30 min/site. Copy `sites/sinderella.org/docker-compose.yml`
+ `ops/docker/{Dockerfile.{cron,worker},crontab.docker,entrypoint-*.sh}`,
adapt the role list per site's existing crontab.example, swap in the
site's roles. The americastrikes pattern is documented at
[americastrikes.com/ops/docker/README.md](../sites/americastrikes.com/ops/docker/README.md).

### 1.2 Standardize run-role.sh across all sites
**Three things every site's run-role.sh needs:**

1. **`git push origin main` after a successful role** — without this,
   autonomous commits accumulate locally and silently diverge from origin
   (sinderella incident, 2026-05-17). One-line addition, see sinderella's
   patch at `8f34391`.
2. **Slack notify on completion + failure** — port `notify-slack.sh`
   from americastrikes verbatim, add `SLACK_CHANNEL_<SITE>` to
   `/home/jesse/projects/domains/.env`.
3. **Pre-flight skip** when there's nothing for the role to do —
   the cheap-check-before-claude pattern. Examples per site:
   - aliencouncil **news-desk**: skip if the feed cache hasn't changed
     since the last run (compare mtime + content hash).
   - reviewtattoo **content-writer**: skip if no new tasks in
     `ops/tasks/backlog/`.
   - sinderella **voice-auditor**: 0 pending files → skip (DONE).
   - americastrikes **update**: already gap-aware, no action.

### 1.3 Daily submodule-pointer sync cron
**Why:** Parent repo perpetually has `+`-prefixed submodule status because
autonomous-ops sites push new commits faster than humans bump pointers.
After today's sync, americastrikes drifted again within minutes and
xxxtea drifted again before I'd even finished writing the commit. This is
a moving target by design.

**Proposal:** Add a `submodule-pointer-sync` cron line that runs daily at
04:00 UTC (after all the per-site nightly ops have settled):

```cron
0 4 * * * cd /home/jesse/projects/domains && \
  git submodule update --remote --merge && \
  git diff --quiet --cached || git commit -m "submodules: nightly pointer sync" && \
  git push origin main
```

Should live in a domains-level cron container, NOT host crontab. See 1.4.

### 1.4 Domain-level ops container
**Why:** `cf-stats` is now containerized at `tools/cf-stats/`. The
submodule-sync from 1.3 + any future portfolio-wide automation needs a
home. Today there's nowhere to put a "runs across all sites" job.

**Proposal:** `tools/portfolio-ops/` with its own supercronic container.
Jobs initially: submodule pointer sync (1.3), portfolio-wide health snapshot
(see Tier 2), stale-task pruning. Same pattern as `tools/cf-stats/`.

---

## Tier 2 — Worth the effort (medium blast radius)

### 2.1 GitHub bot-PR autocheck
**Why:** CF Workers Builds bot opened a PR on bourneash/xxxtea.com fixing
the wrangler name mismatch on 2026-05-16 16:08. It sat unmerged for
~24 hours until I caught it during today's audit. Auto-opened PRs from
trusted bots (CF Workers Builds, Dependabot) should be surfaced loudly.

**Proposal:** Daily cron in `tools/portfolio-ops/` that calls `gh pr list`
across all `bourneash/*` repos, filters for bot-authored PRs older than
24h, and Slack-pings the bourneash-ops channel.

### 2.2 Apothecary-curator scrape-then-AI split (sinderella-specific)
**Why:** Per `sites/sinderella.org/ops/board/cost-pattern-audit-2026-05-17.md`,
apothecary is the one sinderella role where the americastrikes
scrape-then-AI pattern would directly apply. Currently the role does
Playwright ASIN verification *inside* the claude session.

**Proposal:** Defer until the catalog hits ~50 SKUs or the cadence
increases above bi-weekly. At current scale (≤ 8 runs/month) the cost
isn't worth the engineering.

### 2.3 `tools/status` cron in the cf-grafana container
**Why:** `tools/status` is a manual CLI today. Surfacing portfolio-wide
ops health in Slack daily would catch silent failures across sites
(stale ops boards, deploy-needed flags accumulating, etc.).

**Proposal:** Add a `tools/status --json` mode + a 09:00 ET cron in
`tools/portfolio-ops/` that runs it, formats the red/yellow/green
rollup, and posts to Slack #bourneash-ops.

### 2.4 Worker-name-drift pre-deploy check
**Why:** xxxtea's deployed worker (`xxxtea-com`) didn't match wrangler.jsonc's
declared name (`xxxtea`) for the entire post-launch window — only caught
because the CF bot opened a PR. Future dot-bearing domains (e.g.
`complicated.work`, `synapticworkshop.net`) will hit the same trap.

**Proposal:** Add to each site's `.github/workflows/security-and-build.yml`:
a step that reads wrangler.jsonc's `name` field, queries CF API for
workers, fails the build if the wrangler name has no matching deployed
worker. Costs nothing on the green path, catches the drift loudly.

### 2.5 Stale local file sweep
**Why:** During today's audit I found:
- `sites/sinderella.org/site/playwright.firefox.tmp.config.ts` — orphaned
  Playwright test config
- `sites/xxxtea.com/images_for_use/new/` + `used/` — intake/outbox dirs,
  unclear policy
- Various uncommitted `M ops/board/incidents.md` style work-in-progress files

**Proposal:** A weekly `find sites/*/site/*.tmp.* -mtime +7` + uncommitted-
work survey. Output to a board file, not a hard fail.

---

## Tier 3 — Nice to have (low blast radius)

### 3.1 Docker resource pruning
Periodic `docker image prune` + `docker container prune` to recover disk.
Anywhere from 1-2GB/month based on rebuild cadence.

### 3.2 Memory file currency check
Auto-flag memory entries (`~/.claude/projects/-home-jesse-projects-domains/memory/`)
referencing files that no longer exist. Caught during today's audit
that `project_xxxtea_worker_name_drift.md` had become stale once fixed.

### 3.3 DOMAINS_INDEX.md auto-regeneration
DASHBOARD_BACKLOG.md item 1.1 — promote DOMAINS_INDEX.md to be generated
from a machine-readable `sites.yml`. Reduces manual drift like the
2026-05-17 case where xxxtea was live for 16 days before getting moved
from parked → active.

### 3.4 Cron-failure pager
If supercronic itself dies in a container, the container exits and
Docker restart-policy brings it back. But supercronic going into a
permanent restart loop (e.g. the reaper.go forkExec bug from 2026-05-17)
generates no Slack signal today. A container-exit-count watcher would
catch this.

---

## Suggested order of operations

1. **This week:** Containerize the 4 remaining sites (1.1). Forces the
   ops-loop hardening (1.2) at the same time and eliminates the
   host-crontab failure mode forever.
2. **Once containerized:** Stand up `tools/portfolio-ops/` (1.4) and
   move the submodule sync (1.3) into it.
3. **Within the month:** Bot-PR autocheck (2.1), worker-name-drift gate (2.4),
   status-to-Slack (2.3).
4. **Later:** The persona-specific cost lever (2.2) and Tier 3 polish.
