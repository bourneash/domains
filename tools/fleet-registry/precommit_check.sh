#!/bin/sh
# Registry guard for the shared pre-commit hook.
#
# Fires ONLY when a commit adds files under a sites/<domain> that the canonical
# registry has never heard of — i.e. exactly the moment onboarding forgets the
# registry. Routine content/submodule commits never pay for this, and site
# repos (where registry/ doesn't exist) skip it entirely.
set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
REGISTRY="$REPO_ROOT/registry/fleet.yaml"
[ -f "$REGISTRY" ] || exit 0   # not the monorepo — nothing to guard

# Domains touched by newly added/renamed paths in this commit.
DOMAINS=$(git diff --cached --name-only --diff-filter=AR \
  | sed -n 's|^sites/\([^/]*\).*|\1|p' | sort -u)
[ -n "$DOMAINS" ] || exit 0

MISSING=""
for d in $DOMAINS; do
  case "$d" in
    example.com|DISABLED-*) continue ;;
  esac
  grep -q "^  $d:" "$REGISTRY" || MISSING="$MISSING $d"
done
[ -n "$MISSING" ] || exit 0

echo "pre-commit: site(s) not in registry/fleet.yaml:"
for d in $MISSING; do echo "  - $d"; done
echo ""
echo "  Every site must exist in the canonical registry or half the fleet tooling"
echo "  will never see it (site-tracker, gh-stats, analytics, smoke, social)."
echo "  Fix with:"
echo "    bash tools/scripts/onboard-site.sh <domain>   # or --all to reconcile"
echo "    git add registry/fleet.yaml"
exit 1
