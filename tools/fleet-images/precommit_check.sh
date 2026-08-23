#!/bin/sh
# Pre-commit guard: no new per-site cron/worker Dockerfiles.
#
# Wired into the shared hook (tools/git-hooks/pre-commit), same pattern as
# fleet-registry/precommit_check.sh. Works in both environments the hook runs
# in: the monorepo (paths look like sites/<name>/ops/docker/...) and inside a
# site submodule or worker container (paths look like ops/docker/...).
#
# WHY THIS EXISTS
# The fleet reached 53 hand-maintained image definitions in 23 substantive
# variants — five different base images spanning musl and glibc — purely
# because adding "just one more" per-site Dockerfile was always the path of
# least resistance. Consolidating them without closing that path would restart
# the same clock. This is the close.
#
# ONLY fires on ADDED files (--diff-filter=A). A site that has not been
# migrated yet still has its Dockerfile tracked, and editing it must stay
# possible — otherwise this would block the very commits that unblock the
# migration. Re-adding a deleted one is the thing being prevented.
#
# Override for a genuinely justified exception:
#   FLEET_IMAGES_ALLOW_SITE_DOCKERFILE=1 git commit ...
# If you use it, write down why in the commit message. A site that truly needs
# its own image is a finding about the shared image, not a private workaround —
# the fix is usually to fold the missing dependency into
# tools/fleet-images/{cron,worker}/Dockerfile, which every site then gets.

[ -n "$FLEET_IMAGES_ALLOW_SITE_DOCKERFILE" ] && exit 0

added=$(git diff --cached --name-only --diff-filter=A 2>/dev/null \
        | grep -E '(^|/)ops/docker/Dockerfile\.(cron|worker)([.-].*)?$' || true)

[ -z "$added" ] && exit 0

echo ""
echo "✗ BLOCKED: this commit adds a per-site cron/worker Dockerfile."
echo ""
for f in $added; do echo "    $f"; done
echo ""
echo "  The fleet uses two SHARED images, built from:"
echo "      tools/fleet-images/cron/Dockerfile"
echo "      tools/fleet-images/worker/Dockerfile"
echo ""
echo "  Per-site copies are what produced 53 divergent definitions and an"
echo "  11-site musl/glibc landmine. If this site needs something the shared"
echo "  image lacks, add it to the shared image — every site benefits and"
echo "  nothing drifts."
echo ""
echo "  Genuinely an exception? Re-run with:"
echo "      FLEET_IMAGES_ALLOW_SITE_DOCKERFILE=1 git commit ..."
echo "  and say why in the commit message."
echo ""
exit 1
