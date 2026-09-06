# Social Controller

Fleet-wide editorial approval agent for Social Hub. It discovers every opted-in
site through `sites/*/ops/social/hub.yaml`, reviews public drafts in the site's
own voice, and approves or rejects each one. `console` previews are excluded.

The no-cost path is structural: `run.sh` calls the deterministic `prepare`
command first and exits on count `0`; Claude is not started, configured, or
probed. A non-empty packet contains source/mention context, site voice paths,
relevant writer roles, and prior feedback. The model can only change queue state
through guarded `approve`/`reject` commands, which re-check live row status.

The role may improve a site's `hub.yaml` or an upstream writer role when
repeated evidence warrants it. Feedback is categorized and bad drafts are
parked as `needs_rewrite`, so rejection cannot regenerate the same source into
another paid review loop. Durable changes require two feedback records;
fleet-wide changes are recorded as learning proposals and need operator
approval. New sites require no controller edit. The maintainable source of
truth remains the site's own configuration.

Operations:

```bash
# Dry, zero-AI queue inspection
python3 tools/social-controller/controller.py prepare --output /tmp/social-review.json

# Status, cost, backlog, fallback rate, feedback and learning proposals
python3 tools/social-controller/controller.py status

# Run now (will invoke AI only if public drafts exist)
tools/social-controller/run.sh

# Kill switch
touch tools/social-controller/.controller-disabled
```

Runtime logs and AI usage ledgers are under ignored `tools/social-controller/data/`
and `tools/social-controller/ops/logs/`. The fleet cron runs at :08/:23/:38/:53,
eight minutes after Social Hub's quarter-hour content tick (the live 27-site
tick takes about four minutes, so this avoids reviewing a half-built batch).

`monitor.py` runs five minutes after each controller slot. Healthy is silent; it
alerts only for stale/failed runs, old draft backlogs, rewrite pileups, or recent
Social Hub stage errors. `SKILL.md` is the reusable operating contract for
interactive agents; `role.md` remains the cron agent's authoritative prompt.
