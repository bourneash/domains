#!/usr/bin/env python3
"""share_new_posts.py — shared "new post" Slack announcer for domain sites.

Generalizes the americastrikes/saveusfarms share-new-articles-slack.sh
pattern into one tool every site config-drives. Scans a content collection,
diffs against a per-site state file, and posts a Block Kit card (cover image
+ title + description + context line + "Read" button) for anything new.

content_dir is scanned recursively (subfolders like posts/<pillar>/*.md are
picked up), and url_template may reference frontmatter fields declared in
url_fields (e.g. {pillar}) alongside the built-in {base}/{slug}.

State: <state_file> maps slug -> ISO timestamp shared.
  - First run (no state file): SEED only. Every current post is recorded as
    already-shared and nothing is posted, so we never flood the channel with
    the back catalogue.
  - Thereafter: any post not in state, not unlisted, and dated within
    recent_days is posted, then recorded. Posts older than the window are
    recorded (not reconsidered) but not announced.

Cron-container friendly: stdlib only (no requests, no node, no curl).
Silent no-op if SLACK_BOT_TOKEN is unset.

Usage: share_new_posts.py --config <path/to/post-notify.json> [--base-url URL]
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# A just-deployed image can still be propagating to Cloudflare's edge when this
# runs right after deploy — Slack's own fetcher then can't retrieve it and
# rejects the whole block (invalid_blocks). Retry WITH the image after a short
# backoff before giving up on it, instead of immediately falling back to a
# text-only card (see saveusfarms.com 2026-08-24: ~93% of posts were losing
# their image this way).
IMAGE_RETRY_DELAYS = (5, 15)

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


def frontmatter(text):
    m = FRONTMATTER_RE.match(text)
    return m.group(1) if m else ""


def field(fm, key):
    m = re.search(r"(?m)^%s:\s*(.+?)\s*$" % re.escape(key), fm)
    if not m:
        return ""
    v = m.group(1).strip()
    if v in (">", ">-", "|", "|-"):
        block_m = re.match(r"\n[ \t]+(.+?)(?:\n|$)", fm[m.end():])
        v = block_m.group(1).strip() if block_m else ""
    if v and v[0] in "\"'" and v[-1:] == v[0]:
        v = v[1:-1]
    return v.strip()


def parse_dt(s):
    s = s.strip().strip('"').strip("'")
    if not s:
        return None
    try:
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def render_context(cfg, fm):
    parts = []
    brand = cfg.get("brand_context")
    if brand:
        parts.append(brand)
    for item in cfg.get("context_fields", []):
        raw = field(fm, item["field"])
        if not raw:
            continue
        transform = item.get("transform", "raw")
        if transform == "upper":
            val = raw.upper()
        elif transform == "title_dash":
            val = raw.replace("-", " ").title()
        elif transform == "emoji_map":
            emoji = item.get("map", {}).get(raw, "")
            val = (emoji + " " + raw.title()).strip()
        else:
            val = raw
        parts.append(val)
    return " · ".join(parts)


def build_card(cfg, slug, fm):
    title = field(fm, cfg.get("title_field", "title")) or slug
    desc_field = cfg.get("description_field", "description")
    desc = field(fm, desc_field) if desc_field else ""
    image = ""
    for f in cfg.get("image_fields", ["image"]):
        image = field(fm, f)
        if image:
            break
    base = cfg["base_url"].rstrip("/")
    # url_fields lets a per-post frontmatter value (e.g. a pillar/category used
    # to route the URL) fill a {placeholder} in url_template alongside {slug}.
    url_vars = {f: field(fm, f) for f in cfg.get("url_fields", [])}
    url = cfg["url_template"].format(base=base, slug=slug, **url_vars)
    img = (base + image) if image.startswith("/") else image
    ctx = render_context(cfg, fm)

    blocks = []
    if ctx:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": ctx}]})
    blocks.append({"type": "header", "text": {"type": "plain_text", "text": title[:150]}})
    if desc:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": desc[:2900]}})
    if img:
        blocks.append({"type": "image", "image_url": img, "alt_text": title[:1000]})
    blocks.append({
        "type": "actions",
        "elements": [{
            "type": "button",
            "text": {"type": "plain_text", "text": cfg.get("button_label", "Read more")},
            "url": url,
            "style": "primary",
        }],
    })
    return blocks, "New post: " + title


def post_to_slack(token, channel, blocks, fallback):
    payload = json.dumps({
        "channel": channel,
        "text": fallback,
        "unfurl_links": False,
        "unfurl_media": False,
        "blocks": blocks,
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
    ap.add_argument("--config", required=True, help="path to per-site post-notify.json")
    ap.add_argument("--base-url", default=None, help="override base_url from config")
    ap.add_argument("--repo-root", default=None, help="override repo root (default: site's own repo)")
    args = ap.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)
    if args.base_url:
        cfg["base_url"] = args.base_url

    repo_root = args.repo_root or os.path.dirname(os.path.abspath(args.config))
    # config lives at <site_repo_root>/ops/social/post-notify.json by convention
    while repo_root and not os.path.isdir(os.path.join(repo_root, "ops")):
        parent = os.path.dirname(repo_root)
        if parent == repo_root:
            break
        repo_root = parent

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("[share-new-posts] SLACK_BOT_TOKEN unset — skipping")
        return 0

    channel = os.environ.get(cfg["channel_env"]) or cfg.get("channel_default")
    content_dir = os.path.join(repo_root, cfg["content_dir"])
    state_path = os.path.join(repo_root, cfg.get("state_file", "ops/social/slack-shared.json"))
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    recent_days = cfg.get("recent_days", 2)
    unlisted_field = cfg.get("unlisted_field")
    date_field = cfg.get("date_field", "published")

    seed = not os.path.exists(state_path)
    state = {}
    if not seed:
        try:
            with open(state_path) as f:
                state = json.load(f)
        except Exception:
            state = {}

    now = datetime.datetime.now(datetime.timezone.utc)
    posted = seeded = 0

    if not os.path.isdir(content_dir):
        print("[share-new-posts] content dir not found:", content_dir)
        return 0

    post_files = []
    for root, dirs, files in os.walk(content_dir):
        dirs.sort()
        for fn in sorted(files):
            if fn.endswith(".md") or fn.endswith(".mdx"):
                post_files.append(os.path.join(root, fn))

    for path in sorted(post_files):
        fn = os.path.basename(path)
        slug = fn.rsplit(".", 1)[0]
        if slug in state:
            continue
        with open(path, encoding="utf-8") as f:
            fm = frontmatter(f.read())

        if unlisted_field and field(fm, unlisted_field).lower() == "true":
            state[slug] = now.isoformat()
            continue

        pub = parse_dt(field(fm, date_field))
        recent = pub is not None and (now - pub).days <= recent_days and pub <= now + datetime.timedelta(hours=12)

        if seed:
            state[slug] = now.isoformat()
            seeded += 1
            continue
        if not recent:
            state[slug] = now.isoformat()
            continue

        blocks, fallback = build_card(cfg, slug, fm)
        err = post_to_slack(token, channel, blocks, fallback)
        if err == "invalid_blocks":
            for delay in IMAGE_RETRY_DELAYS:
                print("  ⟳ invalid_blocks (image likely still propagating) — retrying with image in %ds" % delay)
                time.sleep(delay)
                err = post_to_slack(token, channel, blocks, fallback)
                if err != "invalid_blocks":
                    break
        if err == "invalid_blocks":
            no_img = [b for b in blocks if b.get("type") != "image"]
            if len(no_img) != len(blocks):
                print("  ⟳ giving up on the image — retrying Slack card without it (invalid_blocks)")
                err = post_to_slack(token, channel, no_img, fallback)
        if err is None:
            state[slug] = now.isoformat()
            posted += 1
            print("  ✓ shared:", slug)

    with open(state_path, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)

    if seed:
        print("seeded %d existing post(s) (none posted on first run)" % seeded)
    else:
        print("posted %d new post(s) to Slack" % posted)
    return 0


if __name__ == "__main__":
    sys.exit(main())
