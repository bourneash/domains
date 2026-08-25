# fleet-git — fleet-wide git hygiene

Keeps the monorepo and all 48 `sites/*` submodules **clean by default**: every
dirty path is classified against a policy, then committed, ignored, or queued
for exactly one operator decision. Unpushed autonomous commits — the failure
mode where a cron role "succeeds" but the site silently never deploys — are
closed by the same sweep.

Zero dependencies. Same library backs the CLI, the hourly cron, and the Fleet
Dashboard's **Ops → Git Hygiene** tab, so an unattended decision and a
button-click decision are the same code path.

## Use

```bash
node tools/fleet-git/bin/fleet-git.js audit          # dry run, exits 1 if not clean
node tools/fleet-git/bin/fleet-git.js sweep --apply  # commit + ignore + push for real
node tools/fleet-git/bin/fleet-git.js queue          # what still needs a human
node tools/fleet-git/bin/fleet-git.js resolve --slug shoptopless.com \
     --path ops/tasks/hold --action always-commit --fleet
node tools/fleet-git/bin/fleet-git.js ignore-sync --apply   # adopt the managed .gitignore block
```

Flags: `--json`, `--site a.com,b.com`, `--no-push`, `--dry-run`.

## How a path is decided

`policy.json` holds ordered rules; **first match wins**, `block` rules are
always evaluated first, and **an unmatched path is never touched** — it goes to
the review queue.

| action | what the sweep does |
|---|---|
| `block` | halts the entire repo — nothing committed, ignored or pushed while a credential-shaped path sits in the tree |
| `ignore` | ensures git ignores it; `untrack: true` additionally `git rm --cached`s it if it was already committed |
| `commit` | stages **only** that path and commits it with the rule's `group` message |
| `review` | queued for an operator |

## Safety properties

These are the invariants, each covered by a test in `test/`:

- **Never `git add -A`.** Every commit is path-limited to the paths policy chose.
- **A secret halts the repo.** `.env`, `*.pem`, `*.key`, `*credentials*.json`… → `block`.
  `.env.example` is explicitly exempt.
- **A repo behind upstream is never acted on** — a merge is an operator decision.
  Same for a detached HEAD.
- **Untracking is opt-in per rule**, and is skipped (never forced) if the repo has
  unrelated staged work, because `git rm --cached` needs an index commit.
- **Oversize guards**: a commit group over `max_files_per_commit`, or a file over
  `max_file_bytes`, is routed to review instead of rubber-stamped.
- **No silent fleet rollout.** The sweep only maintains the managed `.gitignore`
  block in repos that already adopted it; adoption is the deliberate
  `ignore-sync --apply` step.
- **Submodule pointers are bumped last, and only for a site the sweep left clean
  AND pushed.** A parent pointer commit referencing an unpushed submodule commit
  is exactly the "silently stale site" bug this tool exists to end.
- **`GIT_DIR`/`GIT_WORK_TREE` are stripped** from the environment, so `-C <repo>`
  is the only thing that decides which repo a command touches.

## The managed .gitignore block

`policy.json → ignore_block` is rendered between markers in each repo's
`.gitignore`. Lines outside the markers are the site's own and are never
touched. Editing the block by hand is pointless — edit `policy.json` and run
`ignore-sync --apply`.

## The review queue

`state/queue.json`. Items keep `first_seen` (so "unresolved for 6 days" is
answerable) and **auto-close when the path stops appearing** — fixing something
by hand drains the board without clicking anything.

On the dashboard, *Always commit* / *Always ignore* append a rule to
`policy.json`, so the whole class stops asking. The pattern is editable before
it is written: widen `ops/tasks/hold/x.md` to `ops/tasks/**`.

## Cron

`tools/scripts/fleet-git-hygiene-cron.sh` — hourly, `flock`ed, silent when
healthy. It speaks on Slack only for a blocked credential, a git error, or a
review item unresolved for more than `REVIEW_NAG_HOURS` (default 24).

```
17 * * * * /home/jesse/projects/domains/tools/scripts/fleet-git-hygiene-cron.sh
```

## Also reported (never auto-fixed)

Directories under `sites/` that are **not** registered submodules. Git commands
run inside one of those silently operate on the parent monorepo — which is how
a "site is dirty" report can actually be the monorepo's own status.

## Tests

```bash
cd tools/fleet-git && npm test
```

Includes end-to-end tests that create a real repo + bare remote in a temp dir
and assert on the resulting history — the mutating paths are not mocked.
