# Feature & Improvement Findings — domains management platform

Generated: 2026-06-07 11:45:23
Scope: Domain fleet management tooling gap analysis — what a best-in-class multi-domain portfolio operator would have that this platform is missing or could significantly improve.

---

## 🚀 Major — missing capabilities

- [ ] **[ops]** **Unified ops dashboard (visual portfolio view)** — A single-page card grid showing all 8+ active sites: thumbnail, last-publish timestamp, ops role health (last-run.json), CF traffic (24h requests), git freshness (hours since last commit), and deploy status. Currently `tools/status` shows a CLI-only list and `cf-grafana` shows raw metrics — there's no visual overview that answers "what's the health of my fleet right now?" at a glance. Skeleton deferred in `DASHBOARD_BACKLOG.md §1`. Build it as a static page served by site-tracker or a standalone Grafana dashboard panel that embeds the data already in SQLite. — **payoff: single pane of glass for the whole fleet; reduces time-to-notice for stalled sites from hours to seconds**

- [ ] **[ops]** **Dead-man-switch alerting (ops staleness monitor)** — A tool/cron that reads `ops/board/last-run.json` across all sites and fires a Slack alert if any site's last successful role run is older than a configurable threshold (e.g., 36h for daily-cadence sites). No such check exists today — a site's publishing loop can stop silently and the only signal is traffic decay days later. Could be a 50-line Python script in `tools/status/` added to the cf-stats container cron. — **payoff: catches publishing failures within hours, not days; equivalent of an uptime monitor for content ops**

- [ ] **[monitoring]** **Revenue & affiliate click tracking dashboard** — Zero visibility into Amazon affiliate clicks, conversion rates, or which pages are driving revenue exists in any current tool. cf-grafana shows CF traffic, but not affiliate link click-through or estimated earnings. A lightweight collector that polls Amazon Associates API (or scrapes the Associates dashboard) and stores earnings-by-site in SQLite, visualized in Grafana, would close this gap. — **payoff: allows data-driven decisions about which sites/content types to invest in; currently flying blind on revenue**

- [ ] **[ops]** **Fleet-wide containerization of all 8 sites** — 4 of 8 live sites are still on host cron (aliencouncil, reviewtattoo, ultrarough, weapontester). This is a proven single point of failure (2026-05-17 incident). The americastrikes Docker pattern is the proven template; containerizing the remaining 4 is estimated at ~2h total. This should be Tier 0, not Tier 1. — **payoff: eliminates the biggest operational risk in the fleet; makes restart-on-failure automatic for all sites**

- [ ] **[ci]** **Worker-name drift pre-deploy check** — A CI step (or wrangler pre-hook) that reads the local `wrangler.jsonc` `name` field, queries the CF API for the actual deployed worker name, and fails the deploy if they don't match. Could be added to `.github/workflows/security-and-build.yml` as a 20-line Bash check. xxxtea was silently broken for 16 days before this was caught manually. — **payoff: prevents silent deploy failures; zero ongoing maintenance cost once written**

- [ ] **[data]** **Automated `sites.yml` + `DOMAINS_INDEX.md` sync** — A script (or site-tracker admin action) that regenerates `DOMAINS_INDEX.md` from `sites.yml` on every push so the two never drift. Currently both are manually maintained. This could also enforce that a new site cannot be added to one without adding it to the other (pre-commit hook or CI check). — **payoff: eliminates the monitoring blind spot for new sites; ensures any site in the portfolio is immediately tracked**

- [ ] **[ops]** **Centralized task + kanban view across all sites** — Each site has its own `ops/tasks/{backlog,in-progress,done}/` file-based kanban. There's no aggregated view. A tool that reads all sites' task directories and surfaces a cross-fleet backlog (filterable by site, by type) would let Jesse prioritize work across the portfolio instead of diving into each site separately. Could be a page in site-tracker. — **payoff: replaces site-by-site context switching for backlog review with a single inbox**

---

## ⭐ High-impact improvements

- [ ] **[monitoring]** **Per-site smoke string health checks** — `sites.yml` should have a `smoke_string` field per site (a unique phrase that appears in the live page body). A cron in cf-stats or a new `tools/smoke-check/` runs daily: `curl https://<domain>/ | grep "<smoke_string>"` for each site and fires Slack if a site is down or serving a CF error page instead of content. Currently there's zero automated "is the site actually up and returning correct content?" check. — **payoff: catches broken deploys, CF routing failures, and SSR crashes that look healthy to Workers Builds but serve errors to real users**

- [ ] **[ci]** **Automated stale bot-PR detection and merge** — A daily cron (`tools/gh-stats/` or new) that runs `gh pr list --author=app/cloudflare-workers-builds` across all site repos and either auto-merges dependency PRs older than 24h (if CI passes) or sends a Slack alert. Currently these block the deploy pipeline silently. — **payoff: eliminates blocked deploys from unreviewed bot PRs; recovers ~1h/week of manual review**

- [ ] **[ops]** **Submodule auto-bump cron** — A `tools/portfolio-ops/` container (proposed in HOUSEKEEPING §1.3) that runs `git submodule update --remote --merge` on the parent repo daily (off-hours, with conflict detection) and pushes if pointers advanced. Prevents the parent repo from perpetually showing dirty submodule state. Include a guard: bail if any site repo has uncommitted changes. — **payoff: parent repo stays clean; `git status` is meaningful again**

- [ ] **[data]** **Email routing health checker** — A script that iterates `EMAIL_VERIFY_PENDING.md` (or `sites.yml` `email` fields), sends a test message to each `contact@<domain>`, and waits for delivery confirmation to jessetamburino@hotmail.com. Marks each address verified and updates the pending list. Could use Resend API to send + SES/IMAP to confirm receipt. Currently 23 domains are in an unknown email state. — **payoff: closes the 23-domain email verification backlog automatically; catches broken routing rules before a real contact goes to /dev/null**

- [ ] **[ops]** **Fleet-wide role log aggregator** — A simple page in site-tracker (or Grafana dashboard) that aggregates the last N lines from each site's `ops/logs/` directory (mounted via Docker volume or read via SSH) into a single searchable log stream. Currently diagnosing a failing role requires SSHing into the host, navigating to the site dir, and catting a timestamped log file. — **payoff: reduces MTTR for ops failures from minutes to seconds; no context switching between terminals**

- [ ] **[ux]** **site-tracker: per-site "open in domain-developer" button** — Add a link from each row in the site-tracker dashboard that launches the corresponding domain-developer container for that site (or shows instructions if the container isn't running). Currently the workflow is: identify a site needing work in site-tracker → close tab → open domain-developer panel → find the site. — **payoff: one-click to start coding on any site from the portfolio view**

- [ ] **[ops]** **Automated FLEET_STANDARD compliance check** — A script that reads `sites.yml`, clones/reads each site's `package.json`, and reports which sites are off-spec (Astro version, adapter version, Tailwind version, wrangler version). Currently compliance is manual and drift is invisible until a deploy breaks. Could be a column in site-tracker. — **payoff: makes fleet upgrade decisions data-driven; flags which sites need migration before they break**

- [ ] **[security]** **Per-site CF API token scoping** — Replace the single account-scoped token in shared `.env` with per-site tokens scoped to only the zones and workers for that site. Each site's `domain-developer` container and ops container would get only its own token. Requires a token provisioning step in `tools/scripts/bootstrap-domain.sh`. — **payoff: blast radius of a compromised site's container drops from "full fleet" to "one site"**

- [ ] **[data]** **CF-stats retention/archival policy** — Add a daily job to cf-grafana's ingest container that: (1) prunes SQLite rows older than 90 days, (2) gzips and archives JSONL files older than 30 days to a `cf-stats/archive/` dir. Prevents unbounded disk growth. — **payoff: prevents the SQLite DB from becoming a performance problem in 12 months without any intervention**

---

## ⚡ Quick wins

- [ ] **[ux]** **`tools/status` — add `--json` output flag** — The CLI status tool emits human-readable text. Adding `--json` would allow piping to `jq`, scripting, or feeding into site-tracker's collector. Two lines of change to the Python output path. — **payoff: enables programmatic use without scraping text output**

- [ ] **[ci]** **Add `wrangler whoami` smoke to bootstrap script** — `tools/scripts/bootstrap-domain.sh` should run `wrangler whoami` at startup and fail fast with a clear error if the CF token is invalid or expired, before doing any domain setup. Currently the script runs several steps before hitting an auth failure. — **payoff: eliminates confusing mid-bootstrap failures when the token has rotated**

- [ ] **[docs]** **`DOMAINS_INDEX.md` — add "last updated" + income status columns** — The portfolio manifest shows domain names and status but not estimated revenue tier, last content publish date, or income model (affiliate / ads / merch). Adding these columns (even manually) makes triage decisions faster. Could eventually be generated from sites.yml. — **payoff: answers "which sites are making money and when did they last publish?" without opening each site**

- [ ] **[ux]** **site-tracker: click-to-open Grafana zone detail** — Each site-tracker row already has the CF zone ID. Add a link that deep-links to the Grafana zone detail dashboard (`localhost:4741/d/zone-detail?var-zone=<id>`) so traffic graphs are one click away. — **payoff: eliminates the "open Grafana → find the zone in the dropdown" workflow**

- [ ] **[ops]** **Slack channel per-site vs. single #bourneash-ops** — All ops notifications currently go to a single Slack channel. As the fleet grows, high-volume sites will bury alerts from quieter ones. Add a `slack_channel` field to `sites.yml` so high-value sites get their own channel while parked/low-traffic sites share one. — **payoff: prevents alert fatigue; makes critical failures visible even when the fleet is busy**

- [ ] **[ux]** **`tools/domain-developer` — show active container list on panel landing page** — The domain-developer panel at `:7777` currently requires knowing which site containers are running. Add a sidebar or table that lists running containers (from `docker ps`) with a one-click stop/start toggle. — **payoff: eliminates the need to run `docker ps` in a separate terminal to manage dev sessions**

- [ ] **[docs]** **Runbook for "site is down" incident response** — There's no documented procedure for what to do when a site is serving errors. A 10-step runbook (check CF worker status → check last deploy → check ops logs → rollback command → escalation) would make incident response consistent and trainable. — **payoff: reduces MTTR and cognitive load during stressful outages; one Markdown file**

- [ ] **[ops]** **`ops/board/last-run.json` schema enforcement** — Each site writes its own `last-run.json` with no schema contract. If a role's output format changes, the status tool silently shows stale data. Add a JSON Schema file and a validator step in `run-role.sh` that rejects malformed board writes. — **payoff: prevents silent data corruption in the ops health dashboard**

- [ ] **[data]** **cf-stats: add per-site revenue signal (GA4 session count)** — cf-stats currently tracks CF requests/bandwidth. Adding a GA4 Data API collector (one call per property ID from `sites.yml`) would bring session counts and engagement rate into Grafana alongside traffic data — giving a complete picture of quality traffic, not just raw requests. — **payoff: distinguishes bot traffic from real sessions; enables content ROI decisions without leaving the Grafana dashboard**

- [ ] **[ci]** **GitHub Actions: notify Slack on deploy success/failure** — CF Workers Builds deploys silently succeed or fail with no notification. Adding a GitHub Actions step (triggered on `push` to main) that reads the Workers Builds deploy status via CF API and posts to Slack gives the same deploy-complete visibility that americastrikes has manually baked into its ops scripts — but for ALL sites automatically. — **payoff: closes the "deploy went out, but did it actually work?" gap for all 8+ sites**
