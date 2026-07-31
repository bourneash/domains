# AI inventory

Dispatch-aware inventory of scheduled fleet services and their effective AI
provider/model.

```bash
python3 tools/ai-inventory/audit-ai.py
python3 tools/ai-inventory/audit-ai.py --json
python3 tools/ai-inventory/audit-ai.py --root /path/to/domains --json
```

The classifier reads active `ops/docker/crontab*` entries, follows common
`run-role.sh` dispatches into dedicated scripts, resolves compose model settings,
and checks role kill-switch files. It reports deterministic services as `None`
instead of dropping them, which makes false-positive decisions auditable.

The Fleet Dashboard consumes `--json` at `GET /api/ai-inventory` and displays it
in the **AI Inventory** tab. Keep classification logic here rather than copying
heuristics into the dashboard.

Run regression tests with:

```bash
python3 -m unittest discover -s tools/ai-inventory/tests -v
```
