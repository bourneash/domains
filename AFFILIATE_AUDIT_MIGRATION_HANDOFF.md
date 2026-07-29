# Affiliate Audit Migration — Handoff

**Status as of 2026-07-29:** in progress, paused after root-causing why both
real e2e validation runs on totaljerks.com looked broken (they were being
killed mid-run by an unrelated fleet-wide reaper — now fixed) and cleaning up
after them. **The actual "does this work end-to-end" question is still
unanswered** — read Section 3.6 and Section 6 before doing anything else.
Read this top-to-bottom before resuming — it captures a lot of ground truth
discovered the hard way that isn't written down anywhere else yet.

---

## 1. The original ask

Jesse was looking at a shoptopless.com affiliate-audit Slack message that used
a `👀` eyes emoji and reported "11 inconclusive (HTTP 500 from Amazon)" with no
indication of whether those get rechecked. Questions raised:

1. Is the affiliate audit role deployed fleet-wide or per-site?
2. Does it retry/recheck flagged links, or just accept them?
3. Is it AI-driven or scripted?

Follow-up ask, once the gaps above were mapped: **"add retry/backoff, migrate
shoptopless and any others to the new method, get rid of dead/old code, and
fix the Slack messaging (clear emoji, bullets, URLs, professional)."**

That request turned into a much bigger project once we started pulling
threads — see Section 3.

---

## 2. The landscape (as found, 2026-07-29)

Two different affiliate-checking tools exist in the fleet:

### A. `tools/affiliate-link-check/check_links.py` (the OLD tool)
- Bare `urllib` curl-style checker. No browser, no VPN, no retry on the
  landing-page fetch — a single attempt; any non-200 landing status is
  immediately classified `inconclusive` with **zero recheck**.
- Used (or *meant* to be used) by 12 sites via each site's
  `ops/scripts/run-role.sh` `affiliate-editor` branch, which shells out to
  `check_links.py` and only invokes a `claude -p` agent to *file* a task when
  something is actually flagged.
- **Real bug found:** 9 of these 12 sites (`broadwayshowgirls`,
  `deeppenetrations`, `reviewtattoo`, `sinderella`, `ultrarough`,
  `weapontester`, `wetpages`, `xxxtea`, `shoptopless`) had **no
  `.monorepo-tools` bind mount at all** in their `docker-compose.yml`, so
  `run-role.sh`'s lookup for `check_links.py` always failed and every one of
  these sites silently fell back to a full 50-turn `claude -p` sweep doing
  **bare curl with no retry logic whatsoever** — literally the exact problem
  the tool was built to eliminate. This had presumably been happening for
  weeks/months undetected. **Fixed** (see Section 4).
- Only `aliencouncil`, `americastrikes`, `saveusfarms` had the mount already
  and were actually running the deterministic script.

### B. `tools/affiliate-audit/` (the NEW tool, CloakBrowser-based)
- Proper design: `discover.mjs` (imports `affiliate.ts` → JSON) →
  `checker.py` (CloakBrowser: real stealth Chromium, VPN-routed, humanized) →
  `classify.py` (pure verdict function) → `state.py` (per-product
  consecutive-run tracking with grace periods) → `resolve.py` (spawns a
  turn-capped `claude -p` agent **only** for actionable flagged products).
  Zero LLM tokens on a clean run.
- Spec: `docs/superpowers/specs/2026-07-15-affiliate-audit-fleet-service-design.md`
- Plan: `docs/superpowers/plans/2026-07-15-affiliate-audit-fleet-service.md`
- As of 2026-07-15 this had only ever been **piloted on totaljerks.com**, and
  even there it had never actually fired successfully (see Section 3).
- Design intent (per the plan): validate end-to-end on totaljerks, then roll
  out to the other 12 sites, retiring `check_links.py` + the old
  `affiliate-editor` cron-role archetype entirely.

**This handoff is about finishing that rollout — migrating everyone onto tool
B and deleting tool A — but tool B needed a lot of real fixes first.**

---

## 3. What we actually found and fixed (chronological)

### 3.1 Live incident (unrelated, found by accident): totaljerks-cron bad mount
`totaljerks-cron` container was bind-mounted to
`tools/fleet-dashboard` instead of its own `sites/totaljerks.com` directory
(looks like it was brought up with `$PWD` set wrong). Result: the `engineer`
role had been failing every cycle (`exit 127`) for 2+ days, and `deployer`
was silently no-op'ing. **Fixed**: recreated the container from the correct
directory.

### 3.2 New-tool reliability gaps (tools/affiliate-audit)
- `checker.py` didn't capture the landing page's HTTP status at all —
  `classify.py` had no concept of "Amazon returned a 5xx." **Fixed**: status
  captured, non-200-with-no-marker → `inconclusive`.
- `inconclusive` verdicts were **never rechecked and never escalated** — they
  reset every run, forever, even if a product had been unreadable for months.
  **Fixed**: every non-`ok` verdict (including `inconclusive`) now gets one
  recheck in a fresh browser context; `state.py` tracks `inconclusive` as its
  own graced streak (`inconclusive_grace_runs`, default 3) and escalates to a
  **deterministic** (no LLM) filed task via
  `resolve.file_persistent_inconclusive()` after 3 consecutive weeks.
- `run.py` never actually **committed or pushed** `ops/state/affiliate-audit.json`
  or any deterministically-filed task — added `_commit_and_push()`, called
  once at the end of `run_once()`.
- Slack messaging rewritten: `✅`/`⚠️`/`🚨` severity emoji (no more ambiguous
  `👀`), bulleted per-item detail with Slack mrkdwn links to the actual
  `/go/<id>` URL and filed task path. Applied to **both** the new tool's
  `notify_summary()` and (since full migration will take a while) the
  currently-live `check_links.py` clean-path message + all 12 sites'
  `ops/roles/affiliate-editor.md` "Notify" sections + the
  `tools/cron-roles/archetypes/affiliate-editor/role.md.tmpl` template.

### 3.3 Containerizing CloakBrowser (Jesse's explicit call, via AskUserQuestion)
CloakBrowser (`tools/creator-connections/cc_lib.py`) had **never run inside
any Docker container in this fleet** — only ever invoked manually on the
host. Properly containerizing it for totaljerks' `worker` image required:
- Installing `cloakbrowser==0.3.31` + `playwright` + `pyyaml` + `httpx` via
  pip (`--break-system-packages`, Debian bookworm PEP 668) in
  `Dockerfile.worker`, and pre-downloading the patched Chromium binary at
  **build time** (`RUN cloakbrowser install`, run as the `ops` user so the
  cache dir is correctly owned) so the first cron fire doesn't eat a ~10min
  download.
- `checker.launch_browser()` now always forces `headless=True` — the old
  default (`cc_lib.launch()`'s own `headless=False`) opens a **visible**
  Chromium window, fine for interactive Creator Connections logins, useless
  (and container-incompatible, no display server) for an unattended weekly
  batch job.
- `social_lib.vpn_session.get_proxy_url()` defaulted to `127.0.0.1:8181` —
  gluetun's proxy port **on the host's own loopback**, unreachable from
  inside a container (which has its own loopback). Added
  `VPN_PROXY_URL_US`/`VPN_PROXY_URL_EU` env-var overrides; totaljerks'
  `docker-compose.yml` worker service now sets these to
  `http://vpn-us:8888` / `http://vpn-eu:8888` (gluetun's Docker DNS name +
  *internal* port) and joins the external `vpn-proxy_default` network.
- `cc_lib.py` had a **stale, silently-dead** `sys.path` fallback pointing at
  `tools/social-setup/src` (wrong package — `social_lib` actually lives in
  `tools/social-lib/src`; `social-setup` is the unrelated CloakBrowser-driven
  social-account-provisioner tool). Fixed to resolve relative to `cc_lib.py`'s
  own location (`parents[1]/social-lib/src`), so it's correct whether `tools/`
  is the real directory (host) or a read-only bind mount of it at
  `.monorepo-tools/` inside a container. Also reinstalled `social-lib` as
  `pip install -e` on the host (it was a stale non-editable copy).
- New cron dispatch: `ops/scripts/run-affiliate-audit.sh` (bash-driven,
  mirrors the `engineer` role's pattern) + a new `elif` branch in
  `ops/scripts/run-role.sh` + a stub `ops/roles/affiliate-audit.md` (needed
  only so `run-role.sh`'s `ROLE_FILE` existence check passes — it's
  bash-driven, never read as a prompt) + `crontab.docker`'s Wednesday line
  now calls `bash ops/scripts/run-worker.sh affiliate-audit` like every other
  role, instead of the broken direct-in-cron-container invocation it had
  before (`cd /home/jesse/projects/domains && python3 tools/affiliate-audit/run.py`
  — this never worked; that container only ever mounted the site's own repo).
- `run.py`'s `site_dir` resolution: falls back to `Path.cwd()` when the full
  monorepo (`ROOT/sites/<site>`) isn't on disk, matching every other
  in-container role script's convention.

### 3.4 First real e2e run (totaljerks, ~09:22–10:36) — FAILED, root-caused
Ran the actual `docker compose run --rm worker affiliate-audit` for real
(not a unit test, not a smoke test — the genuine weekly cron path). Findings:

- **Mechanics all worked**: discover → 127-product CloakBrowser sweep through
  the VPN → classify → state → actionable-detection all ran correctly and
  took genuinely-OOS products to the resolution stage.
- **But 5 of 6 resolution-agent invocations hit `Error: Reached max turns
  (20)`** without completing — only 1 (`acme-kastmaster-flash-tape`) managed
  to reach its own git commit before getting cut off.
- **No fallback existed for a killed agent** — `resolve.py` didn't check the
  exit code at all. Those failed products got **nothing**: no task file, no
  commit, no push, no Slack line. Silent total failure.
- Also surfaced **stray uncommitted files** left in the live totaljerks.com
  working tree by killed agents (`verify-*-candidates.py` helper scripts, 2
  uncommitted backlog `.md` files) — some possibly dating back to the
  original 2026-07-15 pilot testing, never cleaned up. **These are still
  there** — see Section 6 (open items).
- `ops/state/affiliate-audit.json` was never actually updated by this run
  (mtime stayed 2026-07-18) and `ops/board/last-run.json` got **no entry at
  all** for `affiliate-audit` — meaning `run-role.sh` likely exited before
  reaching its own tail bookkeeping. **Root cause not fully confirmed** — see
  Section 6.
- Manual smoke-testing during triage also caught a **separate classify.py
  bug**: Amazon's real soft-block interstitial ("Click the button below to
  continue shopping") wasn't in `ANTI_BOT_MARKERS` at all, so a VPN-flagged
  session would misread it as "no Prime badge" (`no_prime`) — a false
  positive that could have sent a perfectly healthy product to the
  resolution agent. **Fixed**, plus added a generic short-body (<200 chars)
  heuristic mirroring `cc_lib.is_maintenance_or_empty()`'s existing threshold.

### 3.5 The "should we just raise the turn budget?" conversation
Jesse pushed back hard and correctly on my first instinct ("raise
`max_agent_turns`") — that's literally spending more tokens to paper over a
bug. Re-diagnosed: the real fix is (a) a deterministic fallback so a killed
agent can never vanish silently, and (b) **tightening** scope so an attempt
reliably fits its *existing* budget instead of needing more. Concretely:

- `resolve.py`: new `file_fallback_unresolved()` — deterministic (zero LLM
  cost), idempotent (leaves an existing partial task file alone if the killed
  agent got that far), always ensures a flagged product that the agent failed
  to resolve gets a task filed. `run.py` checks `resolve_product()`'s exit
  code; on non-zero, calls the fallback and sweeps its task path into the
  same end-of-run commit the persistent-inconclusive path already uses.
- `config.default.yaml`: `max_search_attempts` **3 → 1**. Each CloakBrowser
  search+verify round trip costs several turns; three of them routinely blew
  the 20-turn budget. "Couldn't find a confident replacement quickly, file a
  task for a human" is a normal outcome, not a failure to engineer around
  with more turns/searching.
- **Also found and fixed while implementing this**: `resolve.py`'s
  `claude -p` spawn was **missing `--dangerously-skip-permissions`** — every
  other headless role in the fleet passes this (see `run-role.sh`'s generic
  dispatch); without it, under the worker's `acceptEdits`-only default
  permission mode with no TTY to approve anything else, the agent was very
  likely fighting permission friction on every Bash/browser tool call instead
  of doing productive work. This is plausibly the *actual* root cause of the
  turn-cap failures, more so than attempt count. Added the flag.
- 11 new/updated tests. All committed + pushed
  (`43a055c` in the domains repo).

### 3.6 Second real e2e run — ALSO reaped, and that's what actually root-caused everything

Ran a second real `docker compose run --rm worker affiliate-audit` (started
~11:25) to validate the 3.5 fixes. Same shape as run 1: full 127-product
sweep completed (~51min), into the resolution stage (correctly showing
`--dangerously-skip-permissions` and "At most 1 search attempt" in the
spawned agent's prompt this time) — and then it also silently produced no
state update, no `last-run.json` entry, and several uncommitted task files.

**This time it got root-caused for real**, because the *same* failure
pattern recurring after fixing permissions + attempt count proved those
weren't the actual cause. Checked
`tools/scripts/reap-stuck-workers-fleet.log` directly:

```
2026-07-29T10:37:02-04:00 [totaljerks.com] reap-stuck-workers: killing totaljerks-ops-worker-run-3fe14ee93305 (id=d841cbb3bffa, age=74m, threshold=60m)
2026-07-29T12:37:02-04:00 [totaljerks.com] reap-stuck-workers: killing totaljerks-ops-worker-run-d696f94f9591 (id=6bd24e4d61e6, age=71m, threshold=60m)
```

**Both e2e runs were killed by `tools/scripts/reap-stuck-workers-fleet.sh`**
— a host cron job (every 15 min) that force-kills any one-shot
`docker compose run` worker container older than `REAPER_MAX_AGE_SEC`
(default 3600s/60min), on the stated assumption that "nothing legitimately
takes anywhere close to an hour." That assumption is simply false for
`affiliate-audit`: the 127-product paced CloakBrowser sweep alone is
35-50min, plus multiple sequential turn-capped resolution agents on top —
routinely over an hour by design, not by bug.

This fully explains everything that looked broken in 3.4/3.5: no state
persistence (killed before `state.save_state()`/`_commit_and_push()`), no
`last-run.json` entry (killed before `run-role.sh`'s own tail bookkeeping),
task files present-but-uncommitted (agents' Edit-tool writes survive; the
process just never reached its own final `git commit`), stray scratch
files (same reason). **The permissions and turn-budget fixes in 3.5 were
real, valid fixes on their own merits — they just weren't why the runs
looked "broken."** Neither e2e run ever actually ran to completion, so
neither one is evidence one way or the other about resolution-agent
reliability under the new config. That's still an open question — see
Section 6.

**Fixed**: `reap-stuck-workers-fleet.sh` now detects the invoked role from
the container's own args (`docker inspect -f '{{index .Args 0}}'` — the
role name isn't part of the container name, only its args) and gives
`affiliate-audit` a 3-hour threshold instead of the global 60 minutes,
via a `ROLE_MAX_AGE_SEC` map — deliberately not just raising the global
default, which would blunt the reaper's whole purpose for every
genuinely-fast role. Committed as `a1dcb70` (which also turned out to be
this script's **first-ever commit to the domains repo** — it existed and
ran in production but was never actually tracked in git before; unrelated
pre-existing gap, not something this session caused).

**Cleanup after the two reaped runs**: the 6 legitimate backlog task files
they'd produced (`daiwa-bg-3000`, `daiwa-crossfire-7ft-medium-casting`,
`kastking-superpower-braid-300yd`, `mepps-aglia-dressed`,
`mepps-musky-killer`, `worden-rooster-tail`) were committed+pushed
(totaljerks `2ad930a`); the 9 disposable per-product
`verify-*-candidates.py` scratch scripts the killed agents also left
behind were deleted (single-use search helpers, no lasting value, a fresh
one gets generated per attempt regardless).

**Next validation step (not yet done)**: with the reaper fix in place, a
real run should be able to run to completion uninterrupted. Either kick off
a third manual `docker compose run --rm worker affiliate-audit` (expect
1-2h+, let it run fully this time), or just let it fire naturally next
Wednesday via cron and check the results after. Either way, **this is the
run that actually tells us whether the fleet rollout is safe** — check:
- `git -C sites/totaljerks.com log --oneline -15` — clean
  `affiliate: replace <id> ...` / `affiliate: flag unresolved <id> ...`
  commits from the bot, no stray uncommitted files left behind.
- `git -C sites/totaljerks.com status` — clean.
- `cat sites/totaljerks.com/ops/board/last-run.json` — has an
  `affiliate-audit` entry now.
- `stat sites/totaljerks.com/ops/state/affiliate-audit.json` — mtime
  actually updated.
- Slack `#domain-totaljerks-com` — new-format summary line + bullets
  posted.
- Resolve logs (`ops/logs/affiliate-audit-resolve-*.log`) — did agents
  finish comfortably under the 20-turn cap this time, confirming the
  permissions + tighter-scope fixes from 3.5 actually help (still unproven).

---

## 4. What's committed and pushed so far

**Domains repo (`bourneash/domains`, shared `tools/`):**
- `941e464` — affiliate-audit retry/escalate + Slack messaging rewrite
- `7c5d416` — headless + anti-bot detection gaps + container-portable proxy
  (cc_lib.py, social_lib/vpn_session.py)
- `b6bdc6b` — bump totaljerks.com submodule (cron fix)
- `8e5ed99`/`b757e5f` — bump 9 site submodules (`.monorepo-tools` mount fix)
- `43a055c` — fallback filer + tighter resolution scope (`--dangerously-skip-permissions`,
  `max_search_attempts` 1, `file_fallback_unresolved`)
- `a1dcb70` — reaper role-aware timeout (the actual root cause fix; first-ever
  commit of `reap-stuck-workers-fleet.sh`)

**Per-site repos:**
- `totaljerks.com` — `564346d` (cron wiring: Dockerfile.worker, docker-compose.yml,
  run-role.sh, run-affiliate-audit.sh, affiliate-audit.md stub, crontab.docker,
  .gitignore), `b8d6ba5` (state.json + first backlog task commit, from a
  manual diagnostic `_commit_and_push()` call), `2ad930a` (remaining 6
  backlog task files from the two reaped runs, scratch scripts deleted)
- 9 sites (`broadwayshowgirls`, `deeppenetrations`, `reviewtattoo`, `sinderella`,
  `ultrarough`, `weapontester`, `wetpages`, `xxxtea`, `shoptopless`) — one
  commit each: `.gitignore` + `docker-compose.yml` (`.monorepo-tools` mount) +
  `ops/roles/affiliate-editor.md` (Notify section rewrite)

**All test suites green:** `tools/affiliate-audit` (48 tests),
`tools/social-lib` (34 tests).

**Live infra changes already applied** (not just committed — actually
running):
- `totaljerks-cron` recreated with correct mount
- `totaljerks-worker` image rebuilt with cloakbrowser/playwright/VPN wiring
- 9 sites' `-cron` containers recreated with the `.monorepo-tools` mount live

---

## 5. Remaining work (original task list, still open)

Tracked as tasks #5–#8 in this session (re-create in the next session — they
were session-scoped, not persisted anywhere else):

- **#5 — Add frontmatter-directory registry support to `discover.mjs`.**
  shoptopless's affiliate registry is a directory of markdown files with
  frontmatter (`site/src/content/products/*.md`), not a single `affiliate.ts`.
  `discover.mjs` currently only handles importing a TS module. The OLD tool's
  `check_links.py` already has a working reference implementation
  (`parse_products_frontmatter_dir()`) to port the logic from.
- **#6 — Migrate shoptopless to the new tool** (second canary, first
  non-`affiliate.ts` registry shape). Needs: `ops/affiliate-audit.yaml`
  config override, swap `crontab.docker`'s affiliate-editor line for the new
  dispatch (mirror totaljerks' `run-affiliate-audit.sh` + `run-role.sh`
  branch + role stub), retire `ops/roles/affiliate-editor.md`, migrate
  `ops/state/affiliate-oos.json` → the new `ops/state/affiliate-audit.json`
  schema (or just let it start fresh — old OOS-only tracking doesn't map
  1:1), **and** repeat the Dockerfile.worker CloakBrowser containerization
  work from Section 3.3 for shoptopless's own worker image. Verify a clean
  run before moving on.
- **#7 — Migrate the remaining ~10 sites** the same way, one at a time, each
  verified:  `aliencouncil`, `americastrikes`, `deeppenetrations`,
  `broadwayshowgirls`, `reviewtattoo`, `saveusfarms`, `sinderella`,
  `ultrarough`, `weapontester`, `wetpages`, `xxxtea`. (aliencouncil/
  americastrikes/saveusfarms currently run `check_links.py` correctly since
  they already had the mount — lower urgency than the 9 that were silently
  broken, but still on the list for the full migration.)
- **#8 — Delete dead code** once everyone's migrated and verified:
  `tools/affiliate-link-check/`, `tools/cron-roles/archetypes/affiliate-editor/`,
  and any remaining `run-role.sh` wiring that still references
  `check_links.py`.

**Per Jesse's explicit instruction:** don't roll the CloakBrowser
containerization out to the other sites until the totaljerks pilot has
"passed e2e on its own without help" — i.e., a real cron-triggered run
completes cleanly with no manual intervention, no stray files, correct state
persistence, correct Slack notification. Check Section 3.6 first.

---

## 6. Known open items / risks to carry forward

1. ~~Stray files in totaljerks.com's working tree~~ — **done.** The 6
   legitimate backlog task files were committed+pushed and the 9 disposable
   `verify-*-candidates.py` scratch scripts were deleted (Section 3.6).
   Working tree is clean as of this handoff.
2. ~~State-file/status-file persistence "bug"~~ — **root-caused, not a code
   bug.** Both runs were killed by the fleet reaper at its 60min threshold
   before ever reaching `state.save_state()`/the tail of `run-role.sh`. Fixed
   via the reaper's new role-aware timeout (Section 3.6). **Not yet proven
   with a real completed run** — the next validation run (see 3.6) needs to
   actually confirm state persists and `last-run.json` gets an entry now
   that the process won't be killed mid-flight.
3. **Resolution-agent reliability is still an open, unanswered question.**
   Neither e2e run ever ran to completion, so we still don't know whether
   `--dangerously-skip-permissions` + `max_search_attempts=1` actually gets
   agents finishing comfortably under 20 turns, or whether they'll still
   blow the budget for a different reason once they're allowed to run long
   enough to find out. This is the single most important thing the next
   validation run needs to answer.
5. **`cloakbrowser` is pinned to `0.3.31`** in `Dockerfile.worker`, matching
   what's on the host — a newer version (`0.5.2` as of this writing) is
   available. Deliberately not auto-upgraded; revisit if there's a reason to.
6. **VPN exit-node health** — during initial smoke-testing, the `vpn-us`
   gluetun exit node was consistently soft-blocked by Amazon (the
   "Click the button below to continue shopping" interstitial, on every
   product tried). This is now correctly classified as `inconclusive`
   instead of a false positive, but if it's a *persistent* IP-reputation
   problem (not transient), real detection rate will suffer regardless of
   code correctness. Worth checking whether `vpn-eu` fares better, or
   whether PIA's US exit nodes need rotating.
7. Tasks #5–#8 above are effectively a **repeat of Section 3.3's
   containerization work, per remaining site** — budget real time for each
   one (pip installs, Chromium pre-download, VPN network wiring, a real
   verification run), it is not a config-only change.
8. **The reaper fix itself is unvalidated in production** — `a1dcb70` is
   committed and the logic was checked (`bash -n`, `docker inspect` args
   format confirmed live), but it hasn't yet been proven against a real
   affiliate-audit run that legitimately runs past 60 minutes. The next
   validation run doubles as this fix's own test.

---

## 7. Key files for orientation

- `tools/affiliate-audit/` — the shared tool (discover.mjs, checker.py,
  classify.py, state.py, resolve.py, run.py, config.default.yaml, tests/)
- `tools/affiliate-link-check/check_links.py` — the old tool (to be deleted
  once migration is complete; also the reference implementation for
  frontmatter-dir registry parsing, needed for task #5)
- `tools/cron-roles/archetypes/affiliate-editor/role.md.tmpl` — old role
  template (to be deleted with the old tool)
- `tools/creator-connections/cc_lib.py` — shared CloakBrowser driver
- `tools/social-lib/src/social_lib/vpn_session.py` — VPN proxy URL resolution
- `docs/superpowers/specs/2026-07-15-affiliate-audit-fleet-service-design.md` —
  original design spec for the new tool
- `docs/superpowers/plans/2026-07-15-affiliate-audit-fleet-service.md` —
  original implementation plan
- `sites/totaljerks.com/ops/docker/Dockerfile.worker` — reference
  implementation for containerizing CloakBrowser (use as the template for
  tasks #6/#7)
- `sites/totaljerks.com/ops/scripts/run-affiliate-audit.sh` — reference bash
  dispatch wrapper (same, template for other sites)
