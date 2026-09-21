#!/usr/bin/env bash
set -euo pipefail

# ── Host-path bridge ───────────────────────────────────────────────────────
# Mounted ~/.claude config (notably plugins/known_marketplaces.json) records
# marketplace installLocations as ABSOLUTE host paths, e.g.
#   /home/<hostuser>/.claude/plugins/marketplaces/marketingskills
# The container's home is /home/dev, so those paths don't resolve and whole
# plugin marketplaces (marketing-skills, superpowers, …) silently fail to
# load — personal skills under ~/.claude/skills still work because they
# resolve relative to $HOME, which masks the problem. Symlink the host home's
# .claude onto the container's so absolute host paths resolve. HOST_HOME is
# passed in by both entry points (bin/domain-developer, server.js).
if [[ -n "${HOST_HOME:-}" && "${HOST_HOME}" != "/home/dev" ]]; then
    if [[ ! -e "${HOST_HOME}/.claude" || -L "${HOST_HOME}/.claude" ]]; then
        sudo mkdir -p "${HOST_HOME}"
        sudo ln -sfn /home/dev/.claude "${HOST_HOME}/.claude"
    fi
fi

# ── First-boot init of the per-site .claude state ──────────────────────────
# Volume `dd-claude-<site>` is mounted at /home/dev/.claude. On first boot
# it's empty (besides the image's pre-created `projects/` subdir). We seed
# it from the host's RO-mounted .claude.json so the container's claude can
# write project state freely without ever touching the host file.
CLAUDE_DIR=/home/dev/.claude
HOST_CLAUDE_JSON_RO=/host-claude-json-ro

# .claude + persist are now HOST BIND MOUNTS (durability redesign). Docker may
# create the host dir as root on first run, so claim the mountpoints for the dev
# user before we (or claude) write into them. Non-recursive: cheap and enough to
# allow writes; migrated content is chowned by bin/dd-migrate-state.
sudo chown dev:dev "${CLAUDE_DIR}" /home/dev/persist 2>/dev/null || true

if [[ ! -f /home/dev/.claude.json && -r "${HOST_CLAUDE_JSON_RO}" ]]; then
    cp "${HOST_CLAUDE_JSON_RO}" /home/dev/.claude.json
    chmod 600 /home/dev/.claude.json
fi

# ── Per-worker Claude auth and settings ─────────────────────────────────────
# The worker receives settings from the host, but never the host OAuth
# credential. Its .credentials.json is private state under the worker's host
# bind and is created by `claude /login` inside this worker.
RO_STAGE=/host-claude-ro
# The old design copied the host's rotating OAuth credential into every
# worker. Invalidate that legacy copy once so this worker can establish its
# own independent session with `claude /login`.
AUTH_MIGRATION_MARKER=/home/dev/.claude/.independent-auth-v1
if [[ ! -e "${AUTH_MIGRATION_MARKER}" ]]; then
    rm -f /home/dev/.claude/.credentials.json
    (umask 077 && : > "${AUTH_MIGRATION_MARKER}")
fi

# Codex uses its own per-worker state directory. Seed only the operator's
# auth/config files from read-only staging; sessions, caches, and logs remain
# isolated inside the worker's writable host-backed state directory.
CODEX_DIR=/home/dev/.codex
CODEX_RO_STAGE=/host-codex-ro
mkdir -p "${CODEX_DIR}"
if [[ -r "${CODEX_RO_STAGE}/auth.json" ]]; then
    cp "${CODEX_RO_STAGE}/auth.json" "${CODEX_DIR}/auth.json"
    chmod 600 "${CODEX_DIR}/auth.json"
fi
if [[ -r "${CODEX_RO_STAGE}/config.toml" ]]; then
    cp "${CODEX_RO_STAGE}/config.toml" "${CODEX_DIR}/config.toml"
    chmod 600 "${CODEX_DIR}/config.toml"
fi
if [[ -r "${RO_STAGE}/settings.json" ]]; then
    cp "${RO_STAGE}/settings.json" "${CLAUDE_DIR}/settings.json"
    chmod 644 "${CLAUDE_DIR}/settings.json"
fi

# The host runs the NATIVE installer (installMethod=native, binary in
# ~/.local/bin), but this container's claude is the npm-global install. The
# copied value makes claude warn "installMethod is native, but directory
# /home/dev/.local/bin does not exist". Normalize native → global to match
# reality. Runs every boot (outside the first-boot guard) so existing volumes
# self-heal on restart; only touches the file when the value is "native".
if [[ -f /home/dev/.claude.json ]] && command -v jq >/dev/null 2>&1; then
    if [[ "$(jq -r '.installMethod // empty' /home/dev/.claude.json)" == "native" ]]; then
        _cj="$(mktemp)"
        if jq '.installMethod = "global"' /home/dev/.claude.json > "${_cj}"; then
            mv "${_cj}" /home/dev/.claude.json && chmod 600 /home/dev/.claude.json
        else
            rm -f "${_cj}"
        fi
    fi
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
║             independent auth; run claude /login if needed     ║
║                                                                ║
║  Dangerous mode:                                               ║
║    claude --dangerously-skip-permissions                       ║
║                                                                ║
║  Aliases:                                                      ║
║    yolo  = claude --dangerously-skip-permissions               ║
║    sane  = claude                                              ║
║                                                                ║
║  Copy text:  drag to select (auto-copied to clipboard)         ║
╚════════════════════════════════════════════════════════════════╝
EOF

cd "${SITE_DIR:-/work}"

PORT="${TTYD_PORT:-7681}"

# Run the interactive session inside tmux so it survives ttyd reconnects and
# browser closes — close the tab or restart ttyd and you reattach exactly where
# you were. (A full container restart ends the tmux server, but all state is on
# host binds and the transcript is on disk, so `claude --resume` continues it.)
cat > /home/dev/.tmux.conf <<'TMUXCONF'
set -g default-command "bash -l"
set -g history-limit 100000
set -g mouse on
# Mouse mode stays on for wheel-scroll of tmux scrollback. Left-button drag
# selection and clipboard copy are handled in JS (ttyd-enhance.js §3) by
# injecting shiftKey to bypass tmux's mouse capture — no OSC 52 needed.
set -g status-style "bg=#0a0a0a,fg=#ffaa00"
TMUXCONF

# Augmented index.html (built into the image) maps Shift+Enter → ESC+CR so
# Claude Code's TUI inserts a newline instead of submitting. Fall back to
# ttyd's built-in page if it's somehow missing.
TTYD_INDEX_ARGS=()
if [[ -f /opt/ttyd/index.html ]]; then
    TTYD_INDEX_ARGS=(--index /opt/ttyd/index.html)
fi

exec ttyd \
    --writable \
    --port "${PORT}" \
    --interface 0.0.0.0 \
    "${TTYD_INDEX_ARGS[@]}" \
    -t "titleFixed=domain-developer · ${SITE_NAME:-?}" \
    -t fontSize=14 \
    -t rendererType=canvas \
    -t 'theme={"background":"#0a0a0a","foreground":"#e6e6e6","cursor":"#ffaa00"}' \
    tmux new-session -A -s dd
