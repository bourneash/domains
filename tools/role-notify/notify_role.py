#!/usr/bin/env python3
"""notify_role.py — shared "role completed" Slack notifier for domain sites.

Replaces the fleet's ad-hoc flat-string notify-slack.sh calls
("<site> deployer completed") with one consistent, information-dense format:
role emoji + a real success/failure glyph + what actually happened (files
changed, build/smoke status, article headline, live URL) — built from data
the calling script already computed, not scraped from an LLM's log output.

Two modes:
  --mode structured   Caller passes explicit fields (preferred — bash-driven
                       roles like deployer/update already know their own
                       status objectively: exit codes, git diff, smoke counts).
  --mode log           Fallback for AI-role-driven roles with no structured
                       harness: extracts the LAST bold markdown line
                       (**...**) from --log-file as the headline. Last line
                       wins (not first-to-EOF) so trailing chatter after the
                       real status line doesn't get swept in.

Usage:
  notify_role.py --mode structured --site americastrikes.com --role deployer \
      --status ok --headline "Deploy shipped and verified live" \
      --detail "Smoke: 12/12 pass" --files site/src/content/articles/x.md ... \
      --url https://americastrikes.com --channel-env SLACK_CHANNEL_AMERICA_STRIKES \
      --channel-default domain-americastrikes-com

  notify_role.py --mode log --site aliencouncil.com --role deployer \
      --status ok --log-file ops/logs/deployer-2026-07-06.log \
      --channel-env SLACK_CHANNEL_ALIENCOUNCIL --channel-default domain-aliencouncil-com

Silent no-op if SLACK_BOT_TOKEN is unset. Never raises — a broken notification
must never fail the caller's role/deploy.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROLE_EMOJI = {
    "update": "📝",
    "news-writer": "✍️",
    "news-writer-local": "✍️",
    "breaking-news": "🚨",
    "weekly-editorial": "🗞️",
    "deployer": "🚀",
    "planner": "🗓️",
    "seo-analyst": "🔍",
    "engineer": "🛠️",
    "affiliate-editor": "🔗",
    "affiliate-ops": "🔗",
    "social-media": "📣",
    "social-poster": "📣",
    "social-ops": "📣",
    "watchdog": "🩺",
    "newsletter-editor": "📧",
    "page-designer": "🎨",
    "brief-writer": "🗞️",
    "news-desk": "📡",
    "content-writer": "✍️",
}
DEFAULT_EMOJI = "⚙️"

STATUS_GLYPH = {"ok": "✅", "fail": "❌", "warn": "⚠️"}
STATUS_COLOR = {"ok": "#2eb67d", "fail": "#e01e5a", "warn": "#ecb22e"}

BOLD_LINE_RE = re.compile(r"^\*\*(.+)\*\*\s*$", re.MULTILINE)

MAX_FILES_SHOWN = 10


def extract_headline_from_log(log_file):
    if not log_file or not os.path.exists(log_file):
        return None
    with open(log_file, encoding="utf-8", errors="replace") as f:
        text = f.read()
    matches = BOLD_LINE_RE.findall(text)
    return matches[-1].strip() if matches else None


def build_blocks(site, role, status, headline, details, files, url):
    emoji = ROLE_EMOJI.get(role, DEFAULT_EMOJI)
    glyph = STATUS_GLYPH.get(status, "❔")
    headline = headline or f"{role} completed"

    blocks = [
        {"type": "context", "elements": [
            {"type": "mrkdwn", "text": f"{emoji} *{site}* · `{role}`"}]},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"{glyph} {headline}"[:2900]}},
    ]

    if details:
        text = "\n".join("• " + d for d in details)
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": text[:2900]}})

    if files:
        shown = files[:MAX_FILES_SHOWN]
        lines = [f"*Files changed ({len(files)}):*"] + [f"• `{f}`" for f in shown]
        if len(files) > MAX_FILES_SHOWN:
            lines.append(f"_+{len(files) - MAX_FILES_SHOWN} more_")
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)[:2900]}})

    if url:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"🔗 {url}"}]})

    fallback = f"{glyph} {site} {role} — {headline}"
    return blocks, fallback


def post_to_slack(token, channel, blocks, fallback, color):
    payload = json.dumps({
        "channel": channel,
        "text": fallback,
        "unfurl_links": False,
        "unfurl_media": False,
        "attachments": [{"color": color, "blocks": blocks}],
    }).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage", data=payload,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read().decode())
            if not resp.get("ok"):
                print("  ! slack error:", resp.get("error"))
                return resp.get("error") or "error"
            return None
    except Exception as e:
        print("  ! slack post failed:", e)
        return "exception"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["structured", "log"], default="structured")
    ap.add_argument("--site", required=True)
    ap.add_argument("--role", required=True)
    ap.add_argument("--status", choices=["ok", "fail", "warn"], required=True)
    ap.add_argument("--headline", default=None)
    ap.add_argument("--detail", action="append", default=[])
    ap.add_argument("--files", nargs="*", default=[])
    ap.add_argument("--url", default=None)
    ap.add_argument("--log-file", default=None)
    ap.add_argument("--channel-env", required=True)
    ap.add_argument("--channel-default", required=True)
    args = ap.parse_args()

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("[notify-role] SLACK_BOT_TOKEN unset — skipping")
        return 0

    channel = os.environ.get(args.channel_env) or args.channel_default

    headline = args.headline
    if args.mode == "log" and not headline:
        headline = extract_headline_from_log(args.log_file)

    files = [f for f in args.files if f]
    blocks, fallback = build_blocks(args.site, args.role, args.status, headline, args.detail, files, args.url)
    color = STATUS_COLOR.get(args.status, "#cccccc")

    err = post_to_slack(token, channel, blocks, fallback, color)
    if err:
        return 0  # never fail the caller over a notification problem
    return 0


if __name__ == "__main__":
    sys.exit(main())
