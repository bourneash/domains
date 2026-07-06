# role-notify

Shared "role completed" Slack notifier. Replaces the fleet's flat, ad-hoc
`notify-slack.sh "<site> deployer completed" "good"` calls with one
consistent, information-dense format: a per-role emoji, a real ✅/❌/⚠️
glyph, and — where the caller has it — a headline, extra detail lines, a
files-changed list, and a live URL.

Not the same tool as [`tools/post-notify`](../post-notify/README.md), which
announces *new articles* with a rich OG-style card. This tool announces
*role runs* (did the deployer ship, did the update cycle write anything,
did it succeed).

## Two modes

**`--mode structured`** (preferred) — the caller passes explicit fields.
Use this whenever the calling script is bash-driven and already knows its
own status objectively: build/smoke exit codes, `git diff --cached
--name-only` for the files list, a `HEADLINE` already derived from
frontmatter. This is real data, not an LLM's self-report — prefer it over
`--mode log` whenever the harness can compute it directly.

```bash
python3 "$MONOREPO_ROOT/tools/role-notify/notify_role.py" \
  --mode structured --site americastrikes.com --role deployer --status ok \
  --headline "Deploy shipped and verified live" \
  --detail "Smoke: ${SMOKE_PASS}/${SMOKE_TOTAL} pass" \
  --files "${FILES[@]}" \
  --url https://americastrikes.com \
  --channel-env SLACK_CHANNEL_AMERICA_STRIKES --channel-default domain-americastrikes-com
```

**`--mode log`** — fallback for AI-role-driven roles with no structured
harness (e.g. aliencouncil's `deployer.md`, an LLM prompt, not a bash
script). Extracts the **last** bold markdown line (`**...**`) from
`--log-file` as the headline — last line, not first-to-EOF, so trailing
chatter after the real status line doesn't get swept in. The role prompt
must end its run with exactly one bold summary line (see
`ops/roles/deployer.md`'s "Final status line" convention on aliencouncil —
that's the template to copy for any new AI-driven role).

## Adding a new role/site call site

1. Pick `--status ok|fail|warn` from the caller's own exit code / check —
   never guess.
2. Pass whatever structured fields you already have (`--headline`,
   `--detail` repeatable, `--files`, `--url`). Don't invent data you don't
   have; omit a field rather than faking it.
3. `--channel-env` / `--channel-default` match the site's existing
   `SLACK_CHANNEL_*` var (same as `tools/post-notify`).
4. If a role's generic per-log notify block in `run-role.sh` already fires
   for this role, guard against a double-post the same way
   `affiliate-editor` does today (keep the role's own structured/log call
   as the ONLY notify path; exclude it from `run-role.sh`'s generic
   allowlist).

## Rollout (2026-07)

- americastrikes.com, saveusfarms.com — `deploy.sh` (deployer) and
  `post-write.sh` (update) both migrated to `--mode structured` with real
  git-diff file lists, build/smoke status, and article headline.
- 0daynews.com — `deploy.sh` migrated to `--mode structured`.
- aliencouncil.com — `run-role.sh`'s deployer notify path migrated to
  `--mode log` (deployer is an AI role prompt, not bash).
- sinderella.org — **not migrated**. Its per-role Slack threading pattern
  (headline + threaded per-item digest via `slack_thread_digest.py`) is a
  different, already-working mechanism; revisit only if it needs the same
  files/status detail this tool provides.
