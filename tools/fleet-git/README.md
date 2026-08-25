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

These are the invariants. Every one has a test in `test/` — several of them
exist *because* an adversarial review found the claim was false when first
written.

- **Never `git add -A`.** Commits of content are path-limited to the paths policy
  chose (so the shared pre-commit content-guardrails hook still runs on them).
  The mechanical `.gitignore`/untrack commit and the parent pointer commit are
  built in a **scratch index** (`lib/scratchindex.js`) and land via a
  compare-and-swap on `HEAD` — each site is a repo its own cron container also
  stages and commits into, and a live-index commit would sweep that in-flight
  work in. A concurrent `git add` can neither ride along nor be unstaged.
- **A secret halts the repo.** `.env*`, `*.pem/key/p12/jks`, `id_rsa*`, `.netrc`,
  `**/*secret*`, `**/*token*`, `**/*credential*`, `**/*.env` and friends → `block`;
  nothing in that repo is committed, ignored or pushed. A **rename** is classified
  on its ORIGINAL path too, so `git mv .env ops/config.txt` cannot launder one.
  `.env.example` / `.env.sample` are explicitly exempt.
- **Deletions are not edits.** A rule must opt in with `allow_deletes` before a
  deletion is committed unattended (queues that legitimately drain do; published
  content and media do not), and a burst over `max_deletions_per_commit` goes to
  review — an emptied bind mount is not a queue draining.
- **A repo behind upstream, or on a detached HEAD, is never acted on.** The sweep
  `git fetch`es first, so `behind` is measured against the real remote rather than
  a stale local ref.
- **Untracking is opt-in per rule, capped per repo** (`max_untrack_per_repo`), and
  on the dashboard it is a separate explicit confirmation — clicking *Ignore*
  never implies `git rm --cached`.
- **Operator globs cannot be universal.** `policy.json` refuses `**`, `*`, `**/*`
  and unsupported syntax (a leading `/`, `!`, `[...]`) at load time — a pattern
  that would silently never match is how a `block` rule fails open.
- **Oversize guards**: a commit group over `max_files_per_commit`, or a file over
  `max_file_bytes`, goes to review instead of being rubber-stamped.
- **No silent fleet rollout.** The sweep only maintains the managed `.gitignore`
  block in repos that already adopted it; adoption is the deliberate
  `ignore-sync --apply` step.
- **Submodule pointers are bumped last, and only for a site whose HEAD is provably
  the commit on its remote** — not merely `ahead === 0`, which is also true of a
  branch with no upstream. The verified SHA is pinned with `update-index
  --cacheinfo`, so a submodule that moves mid-sweep cannot substitute an unpushed
  commit into the pointer commit.
- **A failed `git status` is never parsed.** A timeout or buffer overflow returns
  partial stdout, which would read as a *clean* repo; any non-zero exit is treated
  as an unusable status.
- **One sweep at a time across every caller** — CLI, cron and the dashboard (a
  different container) share a lock file in the repo, not a per-process flag.
- **The git environment is an allowlist.** The cron sources a `.env` full of live
  tokens; only `PATH`/`HOME`/`GIT_SSH_COMMAND`/identity vars reach a `git` child.
  Repo-location vars (`GIT_DIR`, `GIT_INDEX_FILE`, ...) never do, so `-C <repo>` is
  the only thing choosing the repo. Slack/log output is redacted for token shapes.
- **State files are written atomically** and a corrupt queue throws (and is copied
  aside) rather than being silently replaced by an empty one.

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

## If a sweep did something wrong

Every commit the tool makes carries the trailer `fleet-git: automated hygiene
sweep`, so its work is always separable from a human's or a site role's.

```bash
# What has the sweep done in this repo?
git log --grep='fleet-git: automated hygiene sweep' --oneline

# Undo one of its commits without rewriting history (safe on a pushed branch)
git revert <sha>

# Stop it immediately, fleet-wide: comment out job 14 and restart the driver
#   tools/fleet-cron/crontab.docker   ->  # 17 * * * * .../fleet-git-hygiene-cron.sh
docker restart fleet-cron

# Stop it for ONE repo only: it never touches a repo whose plan is skipped.
git -C sites/<site> checkout --detach   # detached HEAD is an unconditional skip
```

A wedged lock (a sweep killed mid-run) is self-healing after 45 minutes; to
clear it sooner, delete `tools/fleet-git/state/sweep.lock` — but check
`state/cron.log` first, because a sweep that is genuinely still running holds
that file.

The queue and the last report are plain JSON under `state/` and can be read or
edited by hand; a corrupt one is copied aside rather than silently reset.

## Also reported (never auto-fixed)

Directories under `sites/` that are **not** registered submodules. Git commands
run inside one of those silently operate on the parent monorepo — which is how
a "site is dirty" report can actually be the monorepo's own status.

Deliberate exceptions go in `policy.json -> unregistered_ok` with a reason, so
the warning keeps meaning "this is unexplained" instead of becoming background
noise an operator learns to skip.

## Tests

```bash
cd tools/fleet-git && npm test
```

Includes end-to-end tests that build real repos + bare remotes in a temp dir —
including a **parent repo with a real submodule** — and assert on the resulting
history. The mutating paths are not mocked.
