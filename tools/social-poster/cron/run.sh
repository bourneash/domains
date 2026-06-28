#!/usr/bin/env bash
# tools/social-poster/cron/run.sh
# Called by supercronic inside each site's ops container.
# Expects DOMAIN env var and .env.shared sourced by container entrypoint.
set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN env var required}"
LOG_DIR="${LOG_DIR:-/app/logs}"
mkdir -p "$LOG_DIR"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[$TS] social-poster starting for $DOMAIN" >> "$LOG_DIR/social-poster.log"

social-poster post "$DOMAIN" >> "$LOG_DIR/social-poster.log" 2>&1 || {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: social-poster failed for $DOMAIN" >> "$LOG_DIR/social-poster.log"

    # Slack failure notification — uses the shared bot token + per-site channel
    if [[ -n "${SLACK_BOT_TOKEN:-}" && -n "${SLACK_CHANNEL:-}" ]]; then
        curl -sf -X POST "https://slack.com/api/chat.postMessage" \
            -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
            -H "Content-Type: application/json; charset=utf-8" \
            -d "{\"channel\":\"$SLACK_CHANNEL\",\"text\":\"[social-poster] :x: post failed for $DOMAIN — check $LOG_DIR/social-poster.log\"}" \
            > /dev/null || true
    fi

    exit 1
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] social-poster done for $DOMAIN" >> "$LOG_DIR/social-poster.log"
