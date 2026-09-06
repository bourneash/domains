#!/usr/bin/env bash
set -euo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
# Credentials are supplied by the broker's scoped tool-social-hub.env. Never
# source the fleet-wide .env here: aside from exposing unrelated secrets, it
# would overwrite a freshly rotated service token with the legacy file value.
export DOMAINS_ROOT
export PYTHONPATH="$DOMAINS_ROOT/tools/social-hub/src:$DOMAINS_ROOT/tools/social-lib/src${PYTHONPATH:+:$PYTHONPATH}"

exec python3 -m social_hub.cli serve --host 0.0.0.0 --port 4772
