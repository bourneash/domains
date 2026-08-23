#!/usr/bin/env bash
# Shared worker-container entrypoint — a DISPATCHER, deliberately thin.
#
# The role logic itself stays in each site's repo (ops/docker/entrypoint-worker.sh
# or ops/scripts/run-worker.sh, both bind-mounted at /work). This file exists
# only because the fleet had three different conventions for where that script
# lives, and hardcoding one of them into a shared image would have forced two
# sites to keep bespoke images forever:
#
#   /work/ops/docker/entrypoint-worker.sh   24 sites
#   ops/docker/entrypoint-worker.sh (rel.)  amputeenews.com
#   /repo/ops/scripts/run-worker.sh         broadwayshowgirls.com (mounts /repo)
#
# Resolution order below covers all three plus an explicit override. Keep this
# file boring: anything that varies per site belongs on the other side of the
# dispatch, in the site's own repo.
set -uo pipefail

STAMP() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }

# Some sites bind their repo somewhere other than /work (broadwayshowgirls uses
# /repo). Honour the compose working_dir we were started in rather than
# assuming.
ROOT="${FLEET_WORKER_ROOT:-$PWD}"

candidates=(
    "${WORKER_ENTRYPOINT:-}"
    "${ROOT}/ops/docker/entrypoint-worker.sh"
    "${ROOT}/ops/scripts/run-worker.sh"
    "/work/ops/docker/entrypoint-worker.sh"
    "/work/ops/scripts/run-worker.sh"
    "/repo/ops/docker/entrypoint-worker.sh"
    "/repo/ops/scripts/run-worker.sh"
)

# ── Playwright browser readiness (only for sites that need it) ──────────────
# With PLAYWRIGHT_BROWSERS_PATH=0 the browsers live inside node_modules, which
# is a persistent named volume for these sites — so this downloads once per
# site per version, not once per run. `playwright install` is a fast no-op when
# the matching revision is already there.
#
# Deliberately best-effort: a browser fetch failing (offline, upstream blip)
# must not stop a content or deployer role that has nothing to do with
# Playwright. The role that actually needs it will fail on its own with a
# clearer message.
ensure_playwright_browsers() {
    local site_dir="${ROOT}/site"
    [[ -d "${site_dir}/node_modules/@playwright/test" ]] || return 0
    # Skip when the browser is already there. With PLAYWRIGHT_BROWSERS_PATH=0
    # Playwright installs to node_modules/playwright-core/.local-browsers/ —
    # THREE levels below node_modules, which matters: the first version of this
    # guard globbed `node_modules/**/chromium*-*`, and `**` without `shopt -s
    # globstar` collapses to a single `*`, so it matched nothing and re-ran the
    # installer on every single worker invocation for these five sites.
    # Verified against the real layout, not assumed:
    #   node_modules/playwright-core/.local-browsers/chromium-1234
    #   node_modules/playwright-core/.local-browsers/chromium_headless_shell-1234
    shopt -s nullglob
    local found=( "${site_dir}"/node_modules/playwright-core/.local-browsers/chromium-* )
    shopt -u nullglob
    if (( ${#found[@]} > 0 )); then
        return 0
    fi
    STAMP "installing Playwright chromium for $(basename "$ROOT") (cached in node_modules, one-time per version)"
    ( cd "$site_dir" && timeout 600 npx --no-install playwright install chromium >/dev/null 2>&1 ) \
        && STAMP "Playwright chromium ready" \
        || STAMP "WARNING: Playwright chromium install failed — roles that use @playwright/test will report it"
}
ensure_playwright_browsers

for target in "${candidates[@]}"; do
    [[ -n "$target" && -f "$target" ]] || continue
    STAMP "fleet-site-worker ${FLEET_IMAGE_VERSION:-unknown} · uid=$(id -u) · dispatching to ${target}"
    if [[ -x "$target" ]]; then
        exec "$target" "$@"
    fi
    # Repo checkouts don't always carry the exec bit (and /work may be mounted
    # from a host filesystem that drops it). Falling back to an explicit
    # interpreter is better than failing on a permission bit.
    exec bash "$target" "$@"
done

STAMP "FATAL: no worker entrypoint found under ${ROOT}."
STAMP "Looked for: ops/docker/entrypoint-worker.sh, ops/scripts/run-worker.sh (also under /work and /repo)."
STAMP "Set WORKER_ENTRYPOINT in this site's compose if the script lives elsewhere."
exit 127
