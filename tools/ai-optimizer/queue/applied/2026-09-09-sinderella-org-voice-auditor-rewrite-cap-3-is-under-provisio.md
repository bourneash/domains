---
ticket_id: 2026-09-09-sinderella-org-voice-auditor-rewrite-cap-3-is-under-provisio
status: applied
title: "sinderella.org voice-auditor: rewrite cap 3 is under-provisioned — pending queue at 148 and growing +3.8/day"
created: 2026-09-09
decided: 2026-09-11
finding_class: rewrite-cap-too-low-backlog-growing
dedupe_key: cca8495d14352ff6
scope: site
sites: [sinderella.org]
role: voice-auditor
window_from: 2026-09-03
window_to: 2026-09-09
measured_cost_usd: 13.43
estimated_savings_usd_per_day: -0.9
risk: medium
verified_current_code: true
verified_git_check: "Confirmed cap=3 at ops/roles/voice-auditor.md:74-78. Counted 148 files with 'voice_score: pending' via grep -rl in site/src/content/ (run live). Read voice-auditor-2026-09-08T20-00-01Z.log: '20 scored / 5 passed / 3 rewritten / 2 escalation-skip / 10 deferred' — hitting cap and deferring every run. Read voice-auditor-2026-09-08T14-00-02Z.log: '20 scored / 5 passed / 3 rewritten / 3 escalated-skip / 9 deferred' — same pattern. Cap was cut from 5 on 2026-08-29 per git log ('voice-auditor: drop rewrite cap 5→3, cutting run cost ~40%'). Pending count at cap cut is not independently verifiable from current code but is documented as 106 in the analyzer rule commentary; current count 148 is a ~40% increase in 11 days confirming monotonic growth."
evidence_files: ["sites/sinderella.org/ops/roles/voice-auditor.md:74", sites/sinderella.org/ops/logs/voice-auditor-2026-09-08T20-00-01Z.log]
decision_note: "raised cap 3->5 in sites/sinderella.org/ops/roles/voice-auditor.md:75"
---

## Problem

This is an under-provisioning finding, not a cost-savings finding (estimated_savings_usd_per_day is negative — the fix costs more). Filed per analyzer rules: 'if the role is deferring work or the backlog is growing, the honest finding is the opposite one.'

The rewrite cap in `ops/roles/voice-auditor.md:74` was cut from 5 to 3 on 2026-08-29. Current state:

- **148 files** with `voice_score: pending` (confirmed live count)
- Every recent run hits the cap and defers: **10 deferred** (2026-09-08T20:00), **9 deferred** (2026-09-08T14:00)
- The reading-generator produces 12 new horoscopes/day + daily tea pours, all starting as `voice_score: pending`
- With cap=3 and 2 runs/day: ~6 rewrites/day clearing capacity vs ~14 new pending files/day + historical backlog
- Net: backlog grows ~3-4 files/day; at 148 now vs ~106 at cap cut = +42 in 11 days

The deploy consequence is documented in `voice-auditor.md:27` and `ops/board/incidents.md` (2026-06-13 incident): a stalled voice-audit queue deadlocks the deployer indefinitely via the 24h voice-drift gate. A deploy wedge from this pattern costs far more than the +$0.90/day to restore the original cap.

## Proposed change

Raise the rewrite cap in `ops/roles/voice-auditor.md:74` from 3 back to 5:

```
7. **Cost cap per run:** rewrite at most **5** sub-threshold pieces per run.
```

This adds ~$0.90/day (~40% more per run; 2 runs/day at the current call frequency) but restores clearing capacity above the daily content generation rate. At cap=5: estimated clearing ~19/day vs ~14 new files/day = net 5 cleared/day, draining 148-file backlog in ~30 days.

## Risk

Medium. Changes what the role does per run — more rewrites per session means more context used and more committed changes per run. This is correct behavior (the role was designed for cap=5). The risk of NOT fixing is a deploy wedge, documented as having happened on 2026-06-13.

## Verification

After fix: run `grep -rl 'voice_score: pending' site/src/content/ | wc -l` daily for 7 days. Should trend downward from 148. If deferred count per run drops below 5, cap is adequate. If deferred count stays at 10+, the problem is generation quality (too many files failing) rather than the cap.
