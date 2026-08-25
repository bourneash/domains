# fleet-test

Runs every **first-party** test suite under `tools/` in one pass. Zero AI,
offline, ~2 minutes fleet-wide.

    npm test                      # from the repo root
    python3 tools/fleet-test/run_tests.py
    python3 tools/fleet-test/run_tests.py --only fleet-dashboard --only data-hub
    python3 tools/fleet-test/run_tests.py --json
    python3 tools/fleet-test/run_tests.py --check-drift

Scheduled as **Job 13** in `tools/fleet-cron/crontab.docker` (06:50 daily) via
`tools/scripts/fleet-test-cron.sh`.

## Why

~150 first-party test files across 21 tools had **no automatic runner**: no
root CI, no root `test` script, no cron line. They cover the control plane that
pushes commits to 48 repos (`fleet-dashboard`), the collectors the portfolio's
entire history rests on (`cf-stats`, `data-hub`), and the tooling that spends
real money (`amz-stats`, `ai-usage`). A regression there shipped silent.

The first sweep found two suites already rotted, both invisible for weeks:

- **social-lib** — `tests/test_credentials.py` imported `cred_path`, deleted by
  the Vaultwarden migration (eeee6db). An ImportError at collection meant *all*
  of that module's credential coverage was gone, not just the stale cases. It
  also masked a second stale test (`x-api-key` vs the email-client API's actual
  `Authorization: Bearer`).
- **data-hub** — four `/metrics` tests used literal dates that sat inside the
  default 28-day window when written and quietly fell out of it five weeks
  later. Four unrelated tests went red on the same day for the same reason.

## Roster, not glob

`suites.yaml` is an explicit roster. A bare glob for `test_*.py` under `tools/`
hits ~50 vendored third-party files — `domain-developer/state/*/agent-sdk-venv/
.../site-packages/`, and the whole upstream `lama-cleaner/iopaint-src/`
checkout. Running those would produce permanent red nobody can fix, which is
how a quality gate dies.

`--check-drift` is what keeps the roster honest: a tool that grows first-party
tests without a `suites.yaml` entry is reported (and Slacked once). It caught
`fleet-git` the first time it ran. New tools cannot silently escape the sweep;
vendored code cannot silently join it.

## Status vocabulary

| status  | meaning |
|---------|---------|
| `ok`    | suite ran, everything passed |
| `fail`  | suite ran, assertions failed — a real regression |
| `error` | suite could **not run**: deps not installed, no runner on PATH, timeout, nothing collected, or a node suite that exited 0 having reported zero tests |
| `skip`  | listed on purpose with a reason (vendored / not ours) |

`error` is deliberately not `fail`. Conflating "this is broken" with "I could
not check" trains you to ignore both.

## Runners

- `pytest` — `python -m pytest -q`, cwd = the tool dir, using that tool's own
  `.venv/bin/python` when it has one, else system `python3`. `src/` is put on
  `PYTHONPATH` for the tools whose `pyproject.toml` doesn't already do it.
- `node-test` — `npm test` when `package.json` declares a test script, else
  `node --test <files>`.

Suites inherit the ambient environment and nothing else. `run_tests.py` never
sources the fleet `.env`, and the cron wrapper pulls only `SLACK_BOT_TOKEN` out
of it for its own notification — a unit test must not be able to reach live
Cloudflare, Amazon or Slack.

## Output

- `reports/latest.json` — full report (per-suite status, counts, failing tail)
- `reports/history.jsonl` — one summary line per run
- `state.json` — last-known status per suite, used for transition detection
- `fleet-test.log` — rotating wrapper log

Exit codes: `0` all green, `1` a suite failed or errored, `2` roster drift
(`--check-drift` only).

## Notifications

Healthy is **silent**. The cron wrapper Slacks `domain-ops` (override with
`FLEET_TEST_CHANNEL`) only when a suite *changes* state or when roster drift
appears. A daily "still 2 suites red" post trains everyone to ignore the
channel. `FLEET_TEST_NOTIFY=0` disables Slack entirely.
