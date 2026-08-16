#!/usr/bin/env bash
# Shared `git push` retry helper for every cron role in the fleet.
#
# Source it with the standard dual-path idiom (works inside a worker container,
# where tools/ is bind-mounted at .monorepo-tools, and on the host):
#
#   source "$REPO_ROOT/.monorepo-tools/scripts/git-push-retry.sh" 2>/dev/null \
#     || source "$REPO_ROOT/../../tools/scripts/git-push-retry.sh"
#
#   git_push_retry >>"$LOG" 2>&1 || { ...failure handling... }
#
# ---------------------------------------------------------------------------
# Why this exists
#
# Worker containers resolve github.com through Docker's embedded resolver
# (127.0.0.11) which forwards to the host's systemd-resolved. When the host's
# DNS is slow to answer a cache miss, the embedded resolver's own timeout fires
# first and ssh reports:
#
#   ssh: Could not resolve hostname github.com: Try again
#   fatal: Could not read from remote repository.
#
# Every push site in the fleet used to be single-shot, so a DNS hiccup lasting
# a few seconds turned into a SKIPPED DEPLOY: the commit stayed local,
# Cloudflare never saw a push, and the site served stale content until some
# later role happened to push. That is the true source of most "stale CF build"
# / article-404 reports — the push never happened at all.
#
# Retrying costs nothing on the happy path and absorbs the hiccup. It is a
# mitigation, not a cure: if pushes are retrying often, fix the host resolver.
#
# Do NOT "fix" this by pinning `dns:` on the worker service — workers join the
# vpn_proxy network and need 127.0.0.11 for Docker service-name discovery.
# ---------------------------------------------------------------------------
#
# Env overrides: GIT_PUSH_TRIES (default 4), GIT_PUSH_TIMEOUT (default 120s).

git_push_retry() {
  local remote="${1:-origin}" branch="${2:-main}"
  local tries="${GIT_PUSH_TRIES:-4}" to="${GIT_PUSH_TIMEOUT:-120}"
  local n=1 delay=5

  while :; do
    if timeout "$to" git push "$remote" "$branch"; then
      [ "$n" -gt 1 ] && echo "git_push_retry: succeeded on attempt ${n}/${tries}"
      return 0
    fi
    if [ "$n" -ge "$tries" ]; then
      echo "git_push_retry: push to ${remote}/${branch} failed after ${tries} attempts"
      return 1
    fi
    echo "git_push_retry: attempt ${n}/${tries} failed — retrying in ${delay}s"
    # Warm the resolver so a stale/empty cache isn't reused on the next try.
    getent hosts github.com >/dev/null 2>&1 || true
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 3))
  done
}
