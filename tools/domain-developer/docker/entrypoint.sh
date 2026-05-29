#!/usr/bin/env bash
set -euo pipefail

# ── First-boot init of the per-site .claude state ──────────────────────────
# Volume `dd-claude-<site>` is mounted at /home/dev/.claude. On first boot
# it's empty (besides the image's pre-created `projects/` subdir). We seed
# it from the host's RO-mounted .claude.json so the container's claude can
# write project state freely without ever touching the host file.
CLAUDE_DIR=/home/dev/.claude
HOST_CLAUDE_JSON_RO=/host-claude-json-ro

if [[ ! -f /home/dev/.claude.json && -r "${HOST_CLAUDE_JSON_RO}" ]]; then
    cp "${HOST_CLAUDE_JSON_RO}" /home/dev/.claude.json
    chmod 600 /home/dev/.claude.json
fi

# Load per-site env if mounted at <site-dir>/.env. SITE_DIR is the host
# absolute path to the site, bind-mounted at the same path inside.
if [[ -n "${SITE_DIR:-}" && -f "${SITE_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${SITE_DIR}/.env"
    set +a
fi

cat > /home/dev/.banner <<EOF

╔════════════════════════════════════════════════════════════════╗
║  domain-developer — sandboxed dev shell                        ║
║  site:     ${SITE_NAME:-unknown}
║  workdir:  ${SITE_DIR:-/work}
║  claude:   per-site state (host ~/.claude is RO)               ║
║                                                                ║
║  Dangerous mode:                                               ║
║    claude --dangerously-skip-permissions                       ║
║                                                                ║
║  Aliases:                                                      ║
║    yolo  = claude --dangerously-skip-permissions               ║
║    sane  = claude                                              ║
╚════════════════════════════════════════════════════════════════╝
EOF

cd "${SITE_DIR:-/work}"

PORT="${TTYD_PORT:-7681}"

exec ttyd \
    --writable \
    --port "${PORT}" \
    --interface 0.0.0.0 \
    -t "titleFixed=domain-developer · ${SITE_NAME:-?}" \
    -t fontSize=14 \
    -t 'theme={"background":"#0a0a0a","foreground":"#e6e6e6","cursor":"#ffaa00"}' \
    bash -lc 'cat ~/.banner; exec bash -l'
