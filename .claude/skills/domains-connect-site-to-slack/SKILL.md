---
name: domains-connect-site-to-slack
description: Wire a portfolio site's autonomous ops into the shared "Domain Ops" Slack bot so role runs post status (failures + high-signal successes) to the site's own channel. Use when the user asks to "add <site> to Slack", "connect <site> to Slack", "wire Slack notifications", "get Slack alerts for <site>", "why isn't <site> on Slack", or audits which live sites are/aren't posting to Slack. Covers the architecture (one shared bot, per-site channels), the notify-slack.sh mechanism, run-role.sh integration, the .env channel line, the live-verification test, and the load-bearing gotchas (chmod +x guard, bot must be /invite'd, runner must exist first). Stamps from the americastrikes/weapontester/shoptopless reference implementations.
---

# Connect a site to Slack

## Architecture (how the whole fleet does Slack)

- **One shared bot** — "Domain Ops" (`user: domain_ops`, team WhaleShark). A single
  `SLACK_BOT_TOKEN` (`xoxb-…`) lives in **`/home/jesse/projects/domains/.env`** and is
  reused by every site. There is no per-site token.
- **Per-site channels** — one Slack channel per site, named
  **`domain-<host-with-dots-as-dashes>`** (e.g. `domain-americastrikes-com`,
  `domain-rc-9-com`, `domain-saveusfarms-com`). A human creates the channel in Slack.
- **Per-site channel var** — root `.env` holds `SLACK_CHANNEL_<SITE>=domain-<site>-com`.
  Scripts resolve `CHANNEL="${SLACK_CHANNEL_<SITE>:-domain-<site>-com}"` — the var is
  a convenience; the literal fallback means wiring works even if the var is absent.
- **Mechanism** — each site has `ops/scripts/notify-slack.sh` (site-agnostic), called
  from `run-role.sh` (and watchdog/deployer scripts) to post on role failure/success.

## ⛔ Prerequisite: the site must have an autonomous runner

Slack is meaningless without a process to emit messages. A site needs an
`ops/scripts/run-role.sh` (driven by a cron container / `docker-compose.yml`).
If the site has **no runner** (no `run-role.sh`, no `docker-compose.yml`), STOP —
install a cron role first (e.g. `domains-cron-role-engineer`, which already self-posts
a Slack heartbeat), then this skill is moot or trivial. Sites with only `ops/roles/*.md`
docs but no runner are NOT ready. Confirm before wiring:

```bash
d=sites/<site>; ls "$d/ops/scripts/run-role.sh" "$d/docker-compose.yml" 2>/dev/null
```

## Procedure

Reference implementations to copy from: **americastrikes.com** (richest, 13 call sites),
**weapontester.com** (minimal), **shoptopless.com** (latest clean wiring).

1. **Channel name + `.env` line.** Channel = `domain-<host-dashes>`. Add to
   `/home/jesse/projects/domains/.env` under the Slack block:
   ```
   # Slack channel for <site>
   SLACK_CHANNEL_<SITE>=domain-<host-dashes>
   ```
   (`.env` is gitignored — this line lives only on the host. That's fine: the runner
   sources `/home/jesse/projects/domains/.env`, and the container sources `/work/.env.shared`.)

2. **Copy `notify-slack.sh`** verbatim — it is site-agnostic:
   ```bash
   cp sites/weapontester.com/ops/scripts/notify-slack.sh sites/<site>/ops/scripts/notify-slack.sh
   chmod +x sites/<site>/ops/scripts/notify-slack.sh    # ← MANDATORY, see gotcha #1
   ```
   It reads `SLACK_BOT_TOKEN`, no-ops silently if unset, and POSTs via `chat.postMessage`
   with an attachment (`color`: `good`|`warning`|`danger`|`#rrggbb`). Usage:
   `notify-slack.sh <channel> <text> [color]`.

3. **Integrate into `run-role.sh`** — insert before the final `exit "$STATUS"`, after the
   `last-run.json` update. Failures notify always (`danger`, last 5 log lines); successes
   notify only for high-signal roles (`good`, with the model's closing summary extracted):
   ```bash
   NOTIFY="$REPO_ROOT/ops/scripts/notify-slack.sh"
   CHANNEL="${SLACK_CHANNEL_<SITE>:-domain-<host-dashes>}"
   if [[ -x "$NOTIFY" ]]; then
     if [[ "$STATUS" -ne 0 ]]; then
       TAIL=$(tail -5 "$LOG" 2>/dev/null | tr '\n' ' ' || true)
       MSG=$(printf ':x: *<site>* `%s` failed (exit=%d)\n```%s```' "$ROLE" "$STATUS" "$TAIL")
       "$NOTIFY" "$CHANNEL" "$MSG" "danger" 2>/dev/null || true
     else
       case "$ROLE" in
         <high-signal-roles>)   # e.g. deployer|content-writer|planner|affiliate-editor
           SUMMARY=$(...)       # see shoptopless run-role.sh for the python log-summary extractor
           MSG="*<site>* \`${ROLE}\` — ${SUMMARY:-completed}"
           "$NOTIFY" "$CHANNEL" "$MSG" "good" 2>/dev/null || true
           ;;
       esac
     fi
   fi
   ```
   Copy the `SUMMARY=$(python3 - "$LOG" <<'PY' … PY)` block from
   `sites/shoptopless.com/ops/scripts/run-role.sh` unchanged.

4. **Human step (tell the user):** create the channel in Slack, then **`/invite @domain_ops`**
   in it. The bot can only post where it is a member (gotcha #2).

5. **Verify** (see below).

## ⚠️ Load-bearing gotchas

1. **`notify-slack.sh` MUST be executable.** Every caller guards with
   `[[ -x "$NOTIFY" ]]` — a non-executable script makes Slack **silently never fire**
   with zero errors. (This exact bug shipped on saveusfarms-ops.) Always `chmod +x` and
   verify `ls -l` shows `-rwx`.
2. **The bot must be `/invite`d** to each channel, or posts return `not_in_channel` /
   `channel_not_found`. Channel creation + invite is a human action in Slack.
3. **A self-notifying role double-posts.** Roles whose runner self-posts (engineer via
   `run-engineer.sh`, `meta.self_notifies: true`) must NOT also be in `run-role.sh`'s
   success allowlist. Check the cron-role `meta.yml`.
4. **`.env` is gitignored.** Channel lines are host-local; never assume they're in git.
   Containers get the token/channel via `/work/.env.shared`.

## Verify

```bash
cd /home/jesse/projects/domains
bash -n sites/<site>/ops/scripts/run-role.sh && bash -n sites/<site>/ops/scripts/notify-slack.sh
set -a; . ./.env; set +a; echo "channel=${SLACK_CHANNEL_<SITE>:-domain-<host-dashes>} token=${SLACK_BOT_TOKEN:+present}"
ls -l sites/<site>/ops/scripts/notify-slack.sh   # confirm -rwx
```

**Proving end-to-end delivery requires an outward-facing test post** (the bot token lacks
`channels:read`/`users.conversations` scope, so membership can't be read via API — a real
post is the only proof). This is outward-facing: **get explicit user approval first**, then:
```bash
set -a; . ./.env; set +a
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
  -d "$(python3 -c "import json;print(json.dumps({'channel':'domain-<host-dashes>','text':'Slack wiring test — Domain Ops bot is live.'}))")" \
| python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('ok') else 'FAIL: '+str(d.get('error')))"
```
`ok` → delivered. `not_in_channel`/`channel_not_found` → the `/invite` or channel is missing.

## Audit mode ("which live sites are/aren't on Slack?")

A site is wired iff: has a runner (`run-role.sh`), `notify-slack.sh` exists **and is `-rwx`**,
`run-role.sh` invokes it, and a channel exists+invited. Quick sweep:
```bash
for d in sites/*/; do s=$(basename "$d")
  [[ -f "$d/ops/scripts/run-role.sh" ]] || continue              # only runner sites matter
  inv=$(grep -rl notify-slack "$d" 2>/dev/null | grep -v notify-slack.sh | grep -v /done/ | wc -l)
  x=$([[ -x "$d/ops/scripts/notify-slack.sh" ]] && echo +x || echo NO-x)
  echo "$s  invokes=$inv  notify-slack=$x"
done
grep -oE 'SLACK_CHANNEL_[A-Z0-9_]+' .env | sort -u   # channels declared
```
Sites with a runner but `invokes=0` or `notify-slack=NO-x` are the gaps.
