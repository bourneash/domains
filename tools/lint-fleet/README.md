# lint-fleet — fleet-wide prettier parse + format sweep

## Why

`tools/git-hooks/pre-commit` formats staged `.ts/.tsx/.js/.astro` files with the
shared prettier:

```sh
printf '%s\n' $STAGED | xargs "$PRETTIER" --write --ignore-unknown
```

`xargs`' exit code is never checked. So a file prettier **cannot parse** fails
silently — the commit succeeds, the file is never formatted, and nothing reports
it. reviewtattoo.com carried 4 such files for months before one was noticed by
accident (2026-08-09); the first fleet sweep found **23 across 13 sites**.

This tool is the detector the hook isn't.

## Two signals, deliberately not conflated

| | What it means | Urgency |
|---|---|---|
| **parse error** | prettier can't parse the file at all — the hook is silently skipping it and will never format it | real; needs a source fix |
| **drift** | parses fine, just isn't formatted | cosmetic; the next commit that stages it fixes it automatically |

Only parse errors trigger Slack. Drift is reported in the dashboard and nowhere else.

## Zero AI by default

The sweep is prettier + string parsing. Nothing in it calls a model.

AI enters exactly one way, opt-in: `--file-tasks` writes an `engineering` task
into each affected site's `ops/tasks/backlog/`, and that site's **existing**
engineer role picks it up on its own schedule. One open task per site, never
stacked. Enable it in the cron with `LINT_SWEEP_FILE_TASKS=1` when you want the
fleet to self-heal these rather than just report them.

## Usage

```sh
python3 tools/lint-fleet/lint-sweep.py                  # table
python3 tools/lint-fleet/lint-sweep.py --json           # machine-readable
python3 tools/lint-fleet/lint-sweep.py --site rodhat.com
python3 tools/lint-fleet/lint-sweep.py --fail-on-new    # cron/CI gate
python3 tools/lint-fleet/lint-sweep.py --file-tasks     # escalate to AI roles
```

~25s fleet-wide (45 sites, ~1,200 files) as one batched prettier invocation —
prettier reports every unparseable file and keeps going, so batching loses
nothing and is roughly twice as fast as spawning per site.

Every run writes `reports/latest.json` and appends `reports/history.jsonl`, so
"what's new since last time" is diffed against real history rather than guessed.
A `--site` rescan merges into the fleet report instead of clobbering it, and its
new/resolved diff is scoped to that site.

`reports/` and the logs are gitignored — they're host state, not source.

## Scheduling

Host cron (not a per-site container — this is a fleet-level sweep, like
`ensure-fleet-cron.sh`):

```
20 6 * * * /home/jesse/projects/domains/tools/scripts/lint-sweep-cron.sh
```

The wrapper flocks, rotates `lint-sweep.log`, and **Slacks only on change** —
same contract as the engineer pulse, healthy is silent:

- a parse error that wasn't there last sweep → `warn` to that site's `domain-<host>` channel
- a site's last parse error clearing → `ok` to the same channel

Env toggles: `LINT_SWEEP_NOTIFY=0` (no Slack), `LINT_SWEEP_FILE_TASKS=1` (queue
tasks), `LINT_SWEEP_CHANNEL=<channel>` (route every alert to one ops channel
instead of fanning out per site).

## Dashboard

Fleet Dashboard → **Lint** tab (`#lint`), backed by
`tools/fleet-dashboard/server/lintfleet.js`:

- `GET /api/lint` — serves the cached report (a live sweep is far too slow for a request)
- `POST /api/lint/scan[?site=<host>]` — kicks off a sweep in the background; the UI polls until it clears

The Python CLI stays the single source of truth for classification — the
dashboard never re-derives it, same division of labour as `aiinventory.js` and
`aiusage.js`.

## Fixing a parse error

Fix the source; don't add a `.prettierignore`. The three causes found across the
fleet so far, all worked through in reviewtattoo.com commit `d1c52c0`:

1. **`<!-- HTML comment -->` inside a template expression** (`{items.map(...)}`,
   `{cond && (...)}`) — not valid as a JSX child. Use `{/* ... */}`. Comments in
   the plain top-level template are fine.
2. **A raw `<svg>`/`<`-bearing data URI inside an attribute** — hoist it to a
   percent-encoded const in the frontmatter, reference with `style={...}`.
3. **A `<script>` with a real JS body inside a template expression** — move the
   body to a sibling `.js`, `import x from './x.js?raw'`, render with `set:html`.

Then rebuild and diff the rendered HTML before pushing: prettier reformatting
`.astro` can shift inline whitespace, which is how the original
`Every style,dissected.` heading bug happened.
