# Fleet Executive

Fleet Executive is the control-plane contract for an autonomous CEO/CTO agent
that runs the domain portfolio under owner oversight. The leadership sequence
also includes CFO, Legal/Compliance, and Security review passes.

The first slice lives in the Fleet Dashboard event store and exposes:

- `GET/POST /api/executive/messages` — durable owner ↔ CEO/CTO communication;
- `GET /api/executive/proposals` — business, growth, product, engineering,
  redesign, hiring, and spend proposals;
- `POST /api/executive/proposals/:id/decision` — owner approval, decline, or
  feedback, with an audit trail.
- `GET /api/executive/actions` — durable CEO/CTO/system/owner action log,
  including status, target, linked proposal/request, result, and error.
- `GET /api/executive/scorecard` — deterministic outcome scorecard for executive
  ticks, queue delivery, active improvements, measurement state, and recorded
  metric deltas. Proposals and messages are intentionally not counted as
  business results.
- `GET /api/executive/intelligence` — the shared read-only evidence bundle,
  including compliance scan history and data-quality/attribution boundaries.
- `GET/POST/PATCH /api/executive/work-items` — the durable Executive Workbench
  for decisions, research, incidents, Legal/Security reviews, education, and
  evidence gaps. Roles may create or update bounded cases in their autonomous
  plan; owner attention is reserved for actual decisions, approvals, or
  escalations.
- `GET/POST/PATCH /api/executive/knowledge` — the provenance-aware Knowledge
  Shelf and role learning queue. Sources retain publisher, jurisdiction, date,
  license, relevance, and lifecycle status; they are educational inputs, not
  legal advice or a replacement for counsel.
- Executive messages may carry `work_id`, `reply_to`, `message_type`, and
  recipient metadata so role handoffs stay attached to the case they advance.

The CRO (research officer) runs daily at 07:15 ET from the fleet scheduler. It
searches public GitHub repositories against purpose-scoped fleet needs
(conversion, SEO/content, Astro/Cloudflare UX, and measurement), derives daily,
weekly, and monthly momentum locally, and submits up to three separate
candidate proposals to the same executive queue. Before proposing a candidate,
the CRO repo lab downloads a public archive into a disposable temporary
workspace and records a bounded evidence pass: repository files and docs,
license signal, purpose-specific fit, and safe syntax checks. It evaluates at
most three candidates sequentially per run.

The repo lab does not install dependencies or lifecycle scripts, mount the
project, expose secrets or the Docker socket, access production, or retain the
checkout after the report is written. Checks run in a read-only container with
no network, dropped capabilities, resource limits, and only the temporary
candidate workspace mounted. A lab result is evidence for CEO/CTO review, not
an adoption recommendation; any prototype, integration, spend, or deployment
still needs the normal security, measurement, and owner approval gates.

Run the autonomous tick only through `run-sandbox.sh`; it launches the model in
a constrained container with only a generated brief and an output plan mounted.
The model never receives the project checkout. The wrapper does not mount the
Docker socket, SSH keys, the host home directory, or sibling projects. Scheduled
runs enable the reviewed queue policy and route bounded SEO/content/design/
engineering work to the isolated engineer pipeline. The model still cannot
deploy directly; consequential work remains proposal- and approval-gated.

The brief includes the shared read-only executive intelligence contract. It
normalizes the Fleet Manager registry, GA4/GSC analytics, SEO intelligence,
revenue attribution, AI usage/costs, social coverage, Data Hub health and
datasets, ranked priorities, deployment/uptime/error signals, and source
freshness/errors. The same snapshot is available at
`GET /api/executive/intelligence`. A failed adapter is reported as a failed
source; it is never converted into a zero metric. The contract excludes
`3boobs.com` before source data reaches the roles.

The executive agent is expected to be proactive: inspect fleet telemetry,
identify revenue opportunities, run research, recruit specialist agents, and
bring forward concrete proposals with evidence, upside, cost, risks, and a
measurement plan. It does not wait for a human prompt to do routine discovery.

The fleet project manager is the deterministic follow-through role. Its
15-minute scheduler pass reads open executive work items, assigns an appropriate
owner, adds a concise brief and acceptance criteria, and routes eligible,
site-scoped implementation work into the normal change queue. It cannot approve
proposals, bypass review, deploy, or push code.

The executive scope is all discovered fleet sites except `3boobs.com`, which is
explicitly excluded and must not be analyzed, mentioned in an executive plan,
or receive queued work. The managed properties are satire/meme sites for
planning purposes; classification must come from registry/site evidence or
owner guidance, never from a domain name alone.

## Authority model

The owner remains the principal. The CEO/CTO can independently research,
message, create backlog work, and prepare proposals. High-impact actions must
enter the proposal flow. An approval should then create a normal change request
and use the existing isolated worktree → review → validation → deploy → measure
pipeline.

## CEO growth challenge and Legal gate

Private, password-protected, preview-only, parked, or noindex sites are not
treated as completed decisions. The CEO must ask why the site is gated, who owns
the launch decision, whether it can monetize while gated, what must be true to
go live, and what revenue/opportunity cost comes from remaining private. It
should produce a bounded launch-readiness or monetization proposal when the
evidence supports one.

Legal/Compliance runs as a sequential leadership pass. It receives the same
read-only compliance baseline, scan history, data-quality boundaries, analytics,
revenue, and site evidence. It triages privacy/consent/terms, disclosures,
data provenance, claims, rights, and launch risks; it does not certify legal
compliance or replace human counsel. Any proposal marked
`implementation.launch_gate: go_live` must carry an approved
`implementation.legal_review` from the Legal pass before the owner approval
endpoint will route it to engineering.

Security runs immediately after Legal in the leadership sequence. It receives a
read-only security baseline built from Fleet Manager site facts, TLS/page
signals, fleet-doctor container invariants, compliance, operations, and data
quality. It performs risk triage only—never penetration testing, exploitation,
credential access, or security certification. Go-live and explicitly
security-sensitive proposals require approved Legal and Security reviews before
the owner approval endpoint will route them to engineering.

## Executive-to-engineering task routing

The CEO and CTO do not edit sites directly. They create a proposal or bounded
change request with acceptance criteria, risks, tests, and rollback notes. The
owner approval flow converts an approved implementation proposal into a durable
change request and records an auditable `executive.proposal.task-routed` event.

- `engineer` handles ordinary, bounded implementation work.
- `principal-engineer` is the CTO's senior right hand for urgent technical
  investigations, incidents, architecture fixes, and emergency pickup.
- Both workers use the isolated improvement pipeline: worktree, review,
  validation, and deployment gates. Neither role receives host access or may
  bypass release controls.

Fleet Manager exposes the filtered queue at
`/api/executive/task-queue?role=principal-engineer` and shows it on Executive
Leadership. This gives the owner visibility without requiring the owner to
manually dispatch every task; high-impact changes still require approval.

The agent must never:

- use black-hat SEO, cloaking, spam, fake engagement, impersonation, or other
  deceptive growth tactics;
- expose credentials or make secrets available to a sub-agent;
- deploy destructive, irreversible, legally sensitive, or high-spend changes
  without explicit owner approval;
- treat a model response as evidence of revenue. Revenue claims need a source,
  timestamp, attribution status, and measurement window.

## Operating brief

The eventual CEO runner should execute a recurring loop:

1. Read first-party revenue, analytics, health, SEO, affiliate, social, and
   engineering signals.
2. Rank opportunities by expected contribution margin, confidence, time to
   learn, and reversibility.
3. Take low-risk, reversible actions through existing fleet tooling.
4. Delegate research or implementation to bounded specialist agents.
5. Publish a concise owner update and create proposals for material decisions.
6. Measure results and update the strategy from outcomes, not activity.

Recurring scheduling is enabled under the owner-approved 15-minute cadence. A
cheap hourly heartbeat records actionability and outcome state without invoking
an AI model; it only posts an inbox update when the delivery state changes or a
new attention item appears. The
scheduled entrypoint reads the persisted tick and queue settings, runs the
CEO/CFO/CTO/reviewer sequence, and enables bounded queue execution when the
change queue is enabled. A production tick must be single-flight, bounded by
timeout and cost, idempotent by plan fingerprint, and must leave a completed
or failed audit record.

Before each model pass, `run-approved-work.sh` performs a cheap deterministic
drain of already-approved proposals. It routes concrete implementation work and
site-specific report-only approvals through the normal worker queue while
preserving site-capacity, Legal/Security launch gates, and audit events. This
keeps approved work moving when a model pass is skipped or produces no new plan;
it never authorizes a new proposal or bypasses the queue/reviewer pipeline.

Every hourly cycle carries an action mandate: when the telemetry bundle has an
evidence-backed, low-risk implementation candidate, the executive pass must
route a concrete change request to the engineer, including scope, acceptance
criteria, tests, metric, and rollback. A message, proposal, research request,
or report-only request does not satisfy that mandate. Only explicit launch,
legal, security, credential, spend, or missing-evidence blockers may defer the
request. The trusted control plane caps a cycle at six queued actions and one
queued/active implementation per site. Sparse source-specific findings are
supplemented by a rotating cohort of bounded site-baseline checks; missing
telemetry is reported as unavailable, never treated as zero.

The one-shot scheduler entrypoint is `run-scheduled.sh`. It is installed in the
fleet scheduler at 15-minute intervals; `run-sandbox.sh` retains the
single-flight lock, a 14-minute container timeout, fail-closed validation, and
audit path. A timed-out named model container is explicitly removed before the
tick exits, so stale work cannot accumulate.
For a supervised long-running process, use `run-loop.sh` with
`EXECUTIVE_INTERVAL_SECONDS`; it handles cadence and termination while the
one-shot wrapper remains the only execution path.

`run-sandbox.sh` also performs a non-billing `codex login status` preflight from
inside the exact isolated image and credential mount used for the model. A
missing ChatGPT OAuth login fails before model work starts. If the provider
returns an authentication error before the first pass, the wrapper retries once
to tolerate a transient bearer-discovery race; it never retries a partial
leadership run.

The CRO entrypoint is `run-cro-scheduled.sh`. Disable it with
`touch tools/executive/.cro-disabled`; remove that file to resume the next
daily run.

`run-measurements.sh` is deterministic and runs hourly before the
next executive tick. It moves deployed improvements into measurement and
closes them after 14 days or 100 new search impressions, whichever comes first.
Missing telemetry produces an inconclusive result and never counts as zero or
as proof of revenue.

## Domain-manager reporting

`run-domain-reports.sh` publishes deterministic, whole-fleet reports from the
shared intelligence contract before the staggered domain-manager queue starts:

- `six_hour` — source errors, measured changes, configured thresholds, and a
  lightweight review candidate for every managed site;
- `daily` — compact status for every managed site;
- `weekly` — before/after evidence, attribution confidence, margin context, and
  investment gates;
- `deep_dive` — one explicitly selected managed site.

Reports are stored under `tools/executive/data/reports/`, recorded in the event
store, and exposed through Fleet Manager's Executive Leadership page and
`/api/executive/reports`. Domain managers run from a persisted, rate-limited
queue (two active workers, one new job every minute). Missing data is
reported as unavailable rather than zero, and does not prevent a routine site
review from being delivered.
