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

# ── Writable per-site copies of files Claude REWRITES at runtime ────────────
# .credentials.json is rewritten on every OAuth token refresh; settings.json
# can be written too. The old design bound both RO at their destination, so
# those writes failed → auth broke on a timer ("periodic permission issues").
# Instead the entry points now RO-bind the host copies at a staging dir and we
# copy them in WRITABLE here.
#   - .credentials.json: first-boot only, so the container then owns its own
#     refresh chain and a restart won't clobber an in-session refreshed token.
#   - settings.json: refreshed from host every boot (host is config source of
#     truth; Claude's own writes go to settings.local.json / .claude.json).
RO_STAGE=/host-claude-ro
if [[ -r "${RO_STAGE}/.credentials.json" && ! -f "${CLAUDE_DIR}/.credentials.json" ]]; then
    cp "${RO_STAGE}/.credentials.json" "${CLAUDE_DIR}/.credentials.json"
    chmod 600 "${CLAUDE_DIR}/.credentials.json"
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
║                                                                ║
║  Dangerous mode:                                               ║
║    claude --dangerously-skip-permissions                       ║
║                                                                ║
║  Aliases:                                                      ║
║    yolo  = claude --dangerously-skip-permissions               ║
║    sane  = claude                                              ║
║                                                                ║
║  Copy text:  Shift+drag to select, then Ctrl+Shift+C / Cmd+C   ║
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
# Copy/paste in the browser:
#   - mouse on lets the wheel scroll tmux history, but a plain drag is captured
#     by tmux's copy-mode — it lands in tmux's INTERNAL buffer, not your OS
#     clipboard, so it looks like "nothing got selected". Two things fix that:
#   1. set-clipboard on + the copy-mode bindings below emit OSC 52, which ttyd's
#      xterm relays to the actual system clipboard — so drag-select now copies.
#   2. Hold SHIFT while dragging to bypass tmux entirely and do a native browser
#      selection (then Ctrl+Shift+C / Cmd+C) — always works as a fallback.
set -g set-clipboard on
set -g mouse-utf8 off 2>/dev/null
# Drag-release in copy-mode → copy via OSC 52 to the system clipboard, keep it
# highlighted (don't clear) so the selection is visible after release.
bind -T copy-mode    MouseDragEnd1Pane send -X copy-selection-no-clear
bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-selection-no-clear
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
