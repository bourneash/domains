---
ticket_id: 2026-09-14-engineer-archetype-max-turns-25-29-too-low-turn-cap-failures
status: applied
title: "engineer archetype: MAX_TURNS=25/29 too low — turn-cap failures + near-misses fleet-wide"
created: 2026-09-14
decided: 2026-09-14
finding_class: turn-budget-too-low
dedupe_key: 8bb8a115cc683dc1
scope: fleet
sites: [0daynews.com, 0xroulette.com, 3boobs.com, aliencouncil.com, americastrikes.com, arttogogh.com, broadwayshowgirls.com, deeppenetrations.com, eastcoastrappers.com, fishhooklabs.com, girlpain.com, greatamericanlakes.com, howfishthink.com, marineactivity.com, offshorehookup.com, oventoheaven.com, rc-9.com, reviewtattoo.com, rodhat.com, saveusfarms.com, seedstosauce.com, shoppinkflamingo.com, shoptopless.com, sinderella.org, stinkyleftfoot.com, totaljerks.com, trainingsharks.com, ultrarough.com, unsupervisedmedia.com, weapontester.com, wetpages.com, xxxtea.com]
role: engineer
window_from: 2026-09-13
window_to: 2026-09-14
measured_cost_usd: 3.5
estimated_savings_usd_per_day: 0
risk: low
verified_current_code: true
verified_git_check: "Confirmed all 32 sites' run-engineer.sh shared identical MAX_TURNS=25 (24 sites) or MAX_TURNS=29 (8 sites) lines before patching (grep -h sorted unique = exactly two values), so the mechanical sed replace was safe fleet-wide. bash -n syntax-checked all 32 post-patch. allthingsmasonic.com and amputeenews.com excluded — confirmed they do not run the engineer archetype (no MAX_TURNS/max-turns in their run-engineer.sh)."
evidence_files: [tools/ai-usage/aggregate.py --json --from 2026-09-13 --to 2026-09-14 (alerts array), sites/marineactivity.com/ops/scripts/run-engineer.sh (error_max_turns 30/29), sites/sinderella.org/ops/scripts/run-engineer.sh (error_max_turns 26/25), sites/xxxtea.com/ops/scripts/run-engineer.sh (error_max_turns 26/25), "tools/cron-roles/archetypes/engineer/scripts/run-engineer.sh.tmpl:22"]
decision_note: "MAX_TURNS 25->30 / 29->34 applied to all 32 run-engineer.sh copies + tools/cron-roles/archetypes/engineer/scripts/run-engineer.sh.tmpl. Each site committed+pushed individually (31 sites, submodule per-site ownership), parent repo pointer-bump commit 6cda9927 on main."
---


