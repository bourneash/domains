#!/usr/bin/env python3
"""Generate Gatus's config.yaml from a pilot subset of sites/*/ops/smoke.yaml.

POC scope: converts only the sites listed in PILOT_SITES below. Each site
still owns its checks in its own ops/smoke.yaml (same file fleet-smoke
reads) — this script never edits a site's repo, it just re-renders those
checks into Gatus's format on every regen.

Run: python3 scripts/generate_config.py   (from tools/fleet-gatus/)
Then: docker compose up -d --build   (or `docker compose restart` if the
image is already built — Gatus hot-reloads config.yaml on change, no
rebuild needed for config-only edits).
"""
import json
import os

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SITES_DIR = os.path.join(REPO_ROOT, "sites")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "config.yaml")

# POC scope — expand this list once the pilot proves out.
PILOT_SITES = ["wetpages.com", "americastrikes.com", "reviewtattoo.com"]

CHECK_INTERVAL = "5m"          # vs fleet-smoke's twice-daily — real uptime detection
FAILURE_THRESHOLD = 2          # consecutive fails before alerting (kills single-blip noise)
SUCCESS_THRESHOLD = 2          # consecutive passes before "recovered"


def load_smoke_yaml(site):
    path = os.path.join(SITES_DIR, site, "ops", "smoke.yaml")
    with open(path) as f:
        return yaml.safe_load(f)


def slack_alert_body(channel):
    """Custom-provider body that posts through the same bot token + channel
    fleet-smoke already uses (chat.postMessage), so this reuses existing
    Slack app membership/channel wiring instead of standing up new webhooks."""
    payload = {
        "channel": channel,
        "attachments": [{
            "color": "#e01e5a",
            "mrkdwn_in": ["text"],
            "text": (
                "*[ENDPOINT_GROUP] — [ENDPOINT_NAME] — [ALERT_TRIGGERED_OR_RESOLVED]*\\n"
                "[ALERT_DESCRIPTION]\\n[RESULT_ERRORS]"
            ),
        }],
    }
    return json.dumps(payload)


def build_endpoints():
    endpoints = []
    for site in PILOT_SITES:
        cfg = load_smoke_yaml(site)
        apex = cfg["apex"]
        channel = cfg.get("slack", {}).get("channel")
        for check in cfg.get("checks", []):
            name = check["label"]
            path = check["path"]
            expect = check["expect"]
            endpoint = {
                "name": name,
                "group": apex,
                "url": f"https://{apex}{path}",
                "interval": CHECK_INTERVAL,
                "conditions": [f"[STATUS] == {expect}"],
            }
            if str(expect).startswith("3"):
                # e.g. /go/* affiliate redirects (expect: 302) — without this
                # the client follows the redirect and asserts on the final
                # destination's 200, not the redirect itself.
                endpoint["client"] = {"ignore-redirect": True}
            endpoint["alerts"] = [{
                "type": "custom",
                "enabled": True,
                "failure-threshold": FAILURE_THRESHOLD,
                "success-threshold": SUCCESS_THRESHOLD,
                "send-on-resolved": True,
                "provider-override": {
                    "body": slack_alert_body(channel),
                },
            }]
            endpoints.append(endpoint)
    return endpoints


def main():
    config = {
        "storage": {
            "type": "sqlite",
            "path": "/data/data.db",
            "maximum-number-of-results": 200,
            "maximum-number-of-events": 50,
        },
        "alerting": {
            "custom": {
                "url": "https://slack.com/api/chat.postMessage",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer ${SLACK_BOT_TOKEN}",
                },
            },
        },
        "endpoints": build_endpoints(),
    }
    header = (
        "# GENERATED FILE — do not edit by hand.\n"
        "# Regenerate with: python3 scripts/generate_config.py\n"
        "# Source of truth for checks is each site's own sites/<domain>/ops/smoke.yaml\n"
        f"# Pilot scope: {', '.join(PILOT_SITES)}\n\n"
    )
    with open(OUT_PATH, "w") as f:
        f.write(header)
        yaml.safe_dump(config, f, sort_keys=False, width=100)
    total = len(config["endpoints"])
    print(f"Wrote {OUT_PATH} — {total} endpoints across {len(PILOT_SITES)} sites")


if __name__ == "__main__":
    main()
