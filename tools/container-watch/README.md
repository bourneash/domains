# container-watch — host-wide container watchdog

Reports containers that are broken but **look fine from a distance**. Zero AI:
collection is `docker inspect`, the rules are pure functions.

## Why this exists

The Fleet Dashboard's Containers tab filters to containers whose compose
`working_dir` is inside the domains checkout. That is the right scope for a tab
about this fleet and the wrong scope for a watchdog: on 2026-08-25 an
`Exited (255)` container from a different project sat dead for **six days** with
nothing anywhere mentioning it (B11). It only surfaced during a whole-project
audit. A watchdog that only watches what it owns cannot tell you about the thing
nobody owns — so this one looks at every container on the host.

## What it reports

| kind | why it is invisible otherwise |
|---|---|
| `dead-nonzero` | exited nonzero and stayed dead — nothing polls it |
| `should-be-running` | `restart=always/unless-stopped` yet stopped; docker gave up |
| `crashloop` | up *right now*, so it never reads as "down" |
| `unhealthy` | running and failing its own healthcheck |

## Use

```bash
python3 tools/container-watch/check_containers.py          # human report
python3 tools/container-watch/check_containers.py --json    # for cron/dashboards
```

Exit `0` clean · `1` findings · `2` **could not query docker**. That third code
matters: a blind watchdog reporting "nothing wrong" is worse than no watchdog,
so the cron wrapper always alerts on `2`.

## Hardening — the false positives that got designed out

The first live run flagged 12 things; 10 were the tool's fault. Both fixes have
regression tests:

- **`RestartCount` is cumulative over a container's entire life.** `credential-vault`
  showed 14 restarts while having been up for six days — history, not a loop. A
  `crashloop` now needs high restarts **and** a recent start
  (`crashloop_window_minutes`).
- **Exit 143 is `128+SIGTERM`** — exactly what `docker stop` / `compose down`
  leaves behind. Benign by default. **137 (`128+SIGKILL`) deliberately is not**,
  because the OOM killer produces it too and silencing it would hide a container
  dying of memory.

- **A transient docker failure is not blindness.** Collection retries 3× with a
  backoff before reporting `2`. One miss seconds after a `docker restart` fired a
  "watchdog is BLIND" page during development; a real outage still fails every
  attempt.

Other deliberate choices: a freshly-dead container is given `dead_after_hours`
before it counts; an unhealthy one gets `unhealthy_after_minutes` to settle;
unparseable/zero timestamps can never raise; one `docker inspect` covers all
~240 containers, because 240 separate calls would let one cron run overlap the
next.

## Config

`config.json` — thresholds, and `ignore` by `names` / `projects` / `images`.

An ignore entry **requires a reason**, and may carry `"until": "YYYY-MM-DD"` so
a temporary mute expires by itself:

```json
"ignore": { "names": { "some-container": {"reason": "retired, kept for logs", "until": "2026-10-01"} } }
```

A bare string is accepted as the reason for a permanent mute. An exclusion
nobody wrote down is just the next invisible failure.

## Cron

`tools/scripts/container-watch-cron.sh` — `flock`ed, silent when healthy, and
alerts only when the finding set **changes**. A container unhealthy for a week
must not re-alert hourly; that is how an alert becomes noise and the next real
one gets skipped. State in `state/last.json` (gitignored).

## Tests

```bash
cd tools/container-watch && python3 -m pytest tests/ -q
```

15 tests, all against fixtures — never against this host's live docker. A
watchdog you cannot test is how a container sits dead for six days.
