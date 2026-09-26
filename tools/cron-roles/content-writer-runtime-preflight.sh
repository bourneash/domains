#!/usr/bin/env bash
# Cheap, no-model preflight used by every shared worker before content-writer.
set -euo pipefail
ROOT="${1:-/work}"
command -v bwrap >/dev/null 2>&1 || { echo "content-writer deferred: bwrap missing" >&2; exit 75; }
[[ -d "$ROOT" ]] || { echo "content-writer deferred: worker root missing" >&2; exit 75; }
bwrap --unshare-user --die-with-parent --new-session \
  --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /sbin /sbin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc \
  --ro-bind /opt /opt --tmpfs /tmp \
  --bind "$ROOT" /work --chdir /work true
