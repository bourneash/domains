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

Run the autonomous tick only through `run-sandbox.sh`; it launches the model in
a constrained container with only a generated brief and an output plan mounted.
The model never receives the project checkout. The wrapper does not mount the
Docker socket, SSH keys, the host home directory, or sibling projects. It defaults to applying only messages and proposals; set
`EXECUTIVE_ALLOW_QUEUE=1` only after the queue policy has been reviewed.

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

Recurring scheduling remains deliberately disabled until the owner approves the
proposal deduplication and telemetry coverage policy. A production tick must be
single-flight, bounded by timeout and cost, idempotent by plan fingerprint, and
must leave a completed or failed audit record.

The one-shot scheduler entrypoint is `run-scheduled.sh`. It is intentionally
not installed automatically. When enabled by the owner, invoke it from the
fleet scheduler at the desired interval; `run-sandbox.sh` retains the
single-flight lock, container timeout, fail-closed validation, and audit path.
For a supervised long-running process, use `run-loop.sh` with
`EXECUTIVE_INTERVAL_SECONDS`; it handles cadence and termination while the
one-shot wrapper remains the only execution path.
