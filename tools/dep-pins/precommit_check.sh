#!/bin/sh
# Pre-commit guard: no caret/tilde ranges on the fleet-pinned dependencies.
#
# Wired into the shared hook (tools/git-hooks/pre-commit), same pattern as
# fleet-registry/precommit_check.sh and fleet-images/precommit_check.sh. Works
# in both environments the hook runs in: the monorepo (paths look like
# sites/<name>/site/package.json) and inside a site submodule or worker
# container (paths look like site/package.json).
#
# WHY THIS EXISTS
# These repos build with `npm ci`, so a range does not float at build time — it
# floats at lock-refresh time, per site, silently. That is how the fleet ended
# up running four @astrojs/cloudflare builds and six astro builds at once with
# nothing reporting it (B10, 2026-08-25). Pinning without closing the path that
# reintroduces ranges just restarts the clock.
#
# Only fires on a STAGED package.json that actually changes one of the pinned
# deps, so unrelated commits are never slowed down.
#
# Override for a deliberate exception (a site that genuinely must diverge):
#   DEP_PINS_ALLOW_RANGE=1 git commit ...
# If you use it, add the site to `exempt` in tools/dep-pins/pins.json with the
# reason — an exception nobody wrote down becomes drift again.

[ -n "$DEP_PINS_ALLOW_RANGE" ] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd)"
PINS="$HOOK_DIR/pins.json"
[ -f "$PINS" ] || exit 0

staged=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null | grep -E '(^|/)package\.json$')
[ -z "$staged" ] && exit 0

fail=0
for f in $staged; do
  # Read the STAGED content, not the worktree copy.
  blob=$(git show ":$f" 2>/dev/null) || continue
  bad=$(PINS="$PINS" BLOB="$blob" python3 - <<'PY'
import json, os, sys
pins = json.load(open(os.environ["PINS"]))["pins"]
try:
    pkg = json.loads(os.environ["BLOB"])
except ValueError:
    sys.exit(0)
deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
for name, want in pins.items():
    got = deps.get(name)
    if got is None:
        continue
    if got != want:
        print(f"{name}: {got} (fleet pin is exactly {want})")
PY
)
  if [ -n "$bad" ]; then
    echo "dep-pins: $f declares a non-pinned version:"
    echo "$bad" | sed 's/^/  /'
    fail=1
  fi
done

if [ "$fail" = "1" ]; then
  echo ""
  echo "These deps decide whether a site builds and deploys, so the fleet pins them"
  echo "exactly. Use the pinned version, or bump the whole fleet by editing"
  echo "tools/dep-pins/pins.json. Genuine one-off: DEP_PINS_ALLOW_RANGE=1 git commit"
  exit 1
fi
exit 0
