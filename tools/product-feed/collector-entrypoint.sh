#!/usr/bin/env sh
set -eu

# CloakBrowser's patched Chromium is installed at runtime into the persistent
# home volume. The command is a fast no-op after the first successful start.
cloakbrowser install
exec python -m productfeed.collector --loop
