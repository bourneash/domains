#!/usr/bin/env bash
# Installs pre-commit-hook.sh as this clone's .git/hooks/pre-commit.
# git doesn't track hooks, so this needs re-running on any fresh clone/box.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ln -sf ../../tools/credential-vault-backup/pre-commit-hook.sh "$REPO_ROOT/.git/hooks/pre-commit"
echo "Installed: $REPO_ROOT/.git/hooks/pre-commit -> tools/credential-vault-backup/pre-commit-hook.sh"
