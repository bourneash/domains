# Evidence and recovery contract

Fleet execution borrows durable task ownership, continuation, and unchanged-state suppression from [Paperclip](https://github.com/paperclipai/paperclip). It does not install Paperclip or replace the existing control plane.

## What earns credit

`server/work-evidence.js` is shared by the runtime, executive scorecards and Overwatch. A report is recorded separately. Implementation credit requires a validated commit and review acceptance. Release credit additionally requires a verified connected build with the matching released commit and build identifier and a deployment verification timestamp. A pushed branch, successful model exit, handoff or request status alone cannot establish delivery.

Legacy records remain visible but lack delivery credit when their evidence is incomplete. A zero outcome target no longer grants free outcome points. Automatic performance recovery is disabled unless a contract explicitly enables it.

## Ownership and continuation

Owner requests are classified before selecting a manager. Deployment denials preserve the release hold; a revalidation instruction cannot authorize replacement implementation. The manager includes its task identifier in specialist requests and creates durable workflow links. Reconciliation keeps the manager and owner request open until the linked specialist satisfies the applicable contract. Retries continue that request with its original worker and workspace.

Research requests can complete with an accepted report. Implementation requests require confirmed release evidence. Revalidation without an original request reference is blocked with an explicit next action to attach that reference.

## Overwatch

Recovery admission fingerprints substantive task and linked request evidence, excluding retry labels, heartbeat timestamps and rewritten next actions. An unchanged task cannot repeatedly consume recovery attempts. Active execution paths suppress redundant audits; unrelated stopped tasks can still be investigated. A queued retry receives no recovery credit. Credit is recorded once when the original repaired task's linked request reaches a confirmed release after the attempt.

## Measurement

Measurement waits at least fourteen days. Traffic classification uses the sample for the metric being compared; impressions cannot make a one-session change significant. Missing values remain unknown. Affiliate revenue needs fresh, complete attribution. Aggregate site deltas use one latest measurement per site to avoid adding overlapping windows.

The existing `proven` state describes an observed improvement, not causal attribution. Business-result credit additionally requires verified causal attribution. These controls improve evidence quality; they do not create a controlled experiment.

## Upstream patterns

Paperclip's task continuity and watchdog suppression are useful orchestration patterns. Neither agent activity logs nor structured completion claims alone verify a deployed product or business lift. The fleet retains its connected GitHub build gate and adds explicit durable evidence checks around those patterns.
