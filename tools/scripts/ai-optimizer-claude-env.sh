#!/usr/bin/env bash
# Shared by ai-optimizer-cron.sh and ai-optimizer-implement.sh. Source, don't run.
#
# WHY THIS EXISTS
# fleet-cron bind-mounts the host's whole ~/.claude READ-ONLY at the host path
# (tools/fleet-cron/docker-compose.yml — deliberate, see the comment block
# there), and sets HOME=/home/jesse. `claude -p` writes a shell snapshot under
# its config dir before EVERY Bash tool call, so on that mount every Bash call
# dies with EROFS.
#
# That was invisible until an ai-optimizer job needed tools: the only other AI
# job in this container (job 4, the auth probe) is a toolless one-shot and
# never writes. The 2026-08-25 implementer run hit it — the session made its
# file edits, could not run git at all, and reported success with no commit.
#
# The fix is NOT to make that mount writable: it is intentionally RO and the
# compose comment explains the tradeoff already accepted. Instead point Claude
# at a writable config dir of our own, containing a SYMLINK to the real
# credential file. A symlink (not a copy) is load-bearing — the host daemon
# rotates that token roughly every 8h via atomic write-temp+rename, and a copy
# would silently go stale, which is the exact 2026-08-16 failure mode that made
# the directory bind necessary in the first place.
#
# Site worker containers do not need this: they mount ONLY .credentials.json
# into a container-local writable ~/.claude (see any site's docker-compose.yml).
# This gives the shared fleet-cron container the same property without touching
# a mount other jobs depend on.
ai_optimizer_claude_env() {
  local dir="${AI_OPT_CLAUDE_HOME:-/tmp/aiopt-claude-home}"
  local cred="${HOME:-/home/jesse}/.claude/.credentials.json"

  # Nothing to do outside the RO-mount case (e.g. running on the host, where
  # ~/.claude is already writable) — leave the caller's environment alone.
  if [[ -w "${HOME:-/home/jesse}/.claude" ]]; then
    return 0
  fi

  mkdir -p "$dir" 2>/dev/null || return 0
  if [[ -e "$cred" && ! -e "$dir/.credentials.json" ]]; then
    ln -sf "$cred" "$dir/.credentials.json" 2>/dev/null || true
  fi
  export CLAUDE_CONFIG_DIR="$dir"
}
