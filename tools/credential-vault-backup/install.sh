#!/usr/bin/env bash
# Points this clone at the repository's versioned shared hooks. That shared
# pre-commit hook invokes the Vaultwarden snapshot helper. A .git/hooks symlink
# does not work when core.hooksPath is configured, which this repository does.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
git -C "$REPO_ROOT" config core.hooksPath tools/git-hooks
echo "Configured core.hooksPath=tools/git-hooks (includes Vaultwarden snapshot)"
