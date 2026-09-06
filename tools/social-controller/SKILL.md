---
name: social-controller
description: Operate, diagnose, or improve the domains fleet Social Hub editorial controller, including draft approval, brand voice, structured writer feedback, channel readiness, attribution, and cron/container health.
metadata:
  version: 1.0.0
---

# Social Controller

Use the central Social Hub and its existing controller; do not create a second
queue or scheduler. Read `role.md` before changing editorial policy and
`README.md` before changing operations.

Preserve these invariants:

- `run.sh` performs a deterministic public-draft check before any AI setup or
  invocation. An empty queue must remain zero-token.
- A site's `ops/social/hub.yaml` is authoritative for its voice. Explicit
  satire is not adult content and must not be sanitized merely for profanity or
  innuendo; clean brands must not be made gratuitously explicit.
- Obvious defects are quarantined as `needs_rewrite` without AI. Editing a
  quarantined post returns it to `draft`; rejection must not create an
  automatic redraft/review cost loop.
- Record feedback using the maintained taxonomy. Require two concrete feedback
  records before proposing durable guidance. Site guidance may be changed only
  within that site's `ops/`; fleet guidance requires an approved learning
  proposal before it is applied.
- Registry `active` means an account exists, not that API writes work. Use
  `social-hub channels canary SITE PLATFORM`; platforms listed in
  `readiness.require_verified_for` must verify before drafting.
- Publishing owns UTM attribution and channel circuit-breaking. Never bypass
  queue claims, cadence, credentials, or platform adapters.

Start audits with the zero-AI commands:

```bash
python3 tools/social-controller/controller.py status
social-hub strategy --site DOMAIN
social-hub feedback --site DOMAIN
```

After code changes, run the Social Hub, controller, and Fleet Dashboard tests.
Server-side Dashboard changes require its normal restart; static files are
bind-mounted and update without rebuilding.
