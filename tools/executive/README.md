# Fleet Executive

Fleet Executive is the control-plane contract for an autonomous CEO/CTO agent
that runs the domain portfolio under owner oversight.

The first slice lives in the Fleet Dashboard event store and exposes:

- `GET/POST /api/executive/messages` — durable owner ↔ CEO/CTO communication;
- `GET /api/executive/proposals` — business, growth, product, engineering,
  redesign, hiring, and spend proposals;
- `POST /api/executive/proposals/:id/decision` — owner approval, decline, or
  feedback, with an audit trail.
- `GET /api/executive/actions` — durable CEO/CTO/system/owner action log,
  including status, target, linked proposal/request, result, and error.

The CRO (research officer) runs daily at 07:15 ET from the fleet scheduler. It
searches public GitHub repositories against purpose-scoped fleet needs
(conversion, SEO/content, Astro/Cloudflare UX, and measurement), derives daily,
weekly, and monthly momentum locally, stores a dated snapshot, and submits up
to three separate candidate proposals to the same executive queue. Each
proposal must state the intended fleet use, fit evidence, license signal, and
bounded follow-up request. It never clones, installs, executes, or deploys
third-party code.

Run the autonomous tick only through `run-sandbox.sh`; it launches the model in
a constrained container with only a generated brief and an output plan mounted.
The model never receives the project checkout. The wrapper does not mount the
Docker socket, SSH keys, the host home directory, or sibling projects. It defaults to applying only messages and proposals; set
`EXECUTIVE_ALLOW_QUEUE=1` only after the queue policy has been reviewed.

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

Recurring scheduling is enabled under the owner-approved six-hour cadence. A production tick must be
single-flight, bounded by timeout and cost, idempotent by plan fingerprint, and
must leave a completed or failed audit record.

The one-shot scheduler entrypoint is `run-scheduled.sh`. It is installed in the
fleet scheduler at six-hour intervals; `run-sandbox.sh` retains the
single-flight lock, container timeout, fail-closed validation, and audit path.
For a supervised long-running process, use `run-loop.sh` with
`EXECUTIVE_INTERVAL_SECONDS`; it handles cadence and termination while the
one-shot wrapper remains the only execution path.

The CRO entrypoint is `run-cro-scheduled.sh`. Disable it with
`touch tools/executive/.cro-disabled`; remove that file to resume the next
daily run.

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
