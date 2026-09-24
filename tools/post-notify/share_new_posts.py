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
# runs right after deploy. Slack's own fetcher then can't retrieve it and
# rejects the whole block (invalid_blocks). Preflight the image with HEAD so
# we can skip the image before posting when the edge is not ready. If the URL
# is reachable but Slack still rejects it, retain a bounded retry before the
# text-only fallback.
IMAGE_RETRY_DELAYS = (10, 30, 60)
IMAGE_PROBE_UA = "AmericaStrikesImageWatchdog/1.0 (+https://americastrikes.com)"

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


def log_to_disk(repo_root, channel, severity, text):
    """Append one line to ops/logs/slack-<UTC-date>.jsonl in the same schema
    tools/scripts/notify-slack.sh writes, under the CALLING SITE'S own ops/
    dir. This tool posts to the Slack API directly (not via that shim), so
    without this its failures were invisible to principal-engineer-scan.py —
    which reads only that JSONL feed — even though they landed on stdout in
    ops/logs/slack-share-*.log. Confirmed gap: americastrikes-cron's
    invalid_blocks errors (2026-09-13) never reached the disk log the
    watchdog actually reads. Best-effort; must never affect posting behavior.
    """
    try:
        log_dir = os.path.join(repo_root, "ops", "logs")
        os.makedirs(log_dir, exist_ok=True)
        log_file = os.path.join(log_dir, "slack-%s.jsonl" % datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"))
        rec = {
            "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "channel": channel,
            "color": "danger" if severity == "error" else "warning",
            "severity": severity,
            "text": text,
        }
        with open(log_file, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def check_image_url(url, timeout=5):
    """Return True when an image URL is ready for Slack to fetch.

    Use a bounded GET rather than HEAD. Cloudflare Workers static-assets routes
    can serve the image correctly to GET while returning an unusable response
    to HEAD. A normal GET with a small identifying User-Agent is also required
    by this site's edge guard; Range requests are rejected. Reading one byte
    keeps this a cheap readiness probe and matches Slack's fetch more closely.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": IMAGE_PROBE_UA})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "").lower()
            if not (200 <= response.status < 400 and content_type.startswith("image/")):
                return False
            response.read(1)
            return True
    except Exception:
        return False


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
                err = resp.get("error") or "error"
                # invalid_blocks is an expected, recoverable response for an
                # image card. Keep it out of the fleet error-line classifier;
                # the final fallback is logged as a warning below.
                if err == "invalid_blocks":
                    print("  ! slack rejected image blocks:", err)
                else:
                    print("  ! slack error:", err)
                return err
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
        image_url = next(
            (b.get("image_url") for b in blocks if b.get("type") == "image"),
            None,
        )
        if not image_url:
            # Do not publish a text-only announcement when the content itself
            # has no image reference. Leave the slug out of state so a later
            # image backfill can make it eligible for sharing.
            print("  ! article has no cover URL — deferring share until image is added")
            log_to_disk(repo_root, channel, "warning",
                        "post-notify: deferred share for %r because frontmatter has no image URL" % slug)
            continue
        if not check_image_url(image_url):
            # Do not publish a text-only announcement. Leave this slug out of
            # state so the next deploy/share tick retries after edge
            # propagation. A missing cover is a recoverable timing problem,
            # not a reason to permanently announce an image-less card.
            print("  ! image preflight failed — deferring share until cover is live")
            log_to_disk(repo_root, channel, "warning",
                        "post-notify: deferred share for %r after image preflight failed; cover must be live before posting" % slug)
            continue
        err = post_to_slack(token, channel, blocks, fallback)
        if err == "invalid_blocks":
            image_url = next(
                (b.get("image_url") for b in blocks if b.get("type") == "image"),
                None,
            )
            if image_url and check_image_url(image_url):
                for delay in IMAGE_RETRY_DELAYS:
                    print("  ⟳ invalid_blocks (Slack fetcher issue) — retrying with image in %ds" % delay)
                    time.sleep(delay)
                    err = post_to_slack(token, channel, blocks, fallback)
                    if err != "invalid_blocks":
                        break
            else:
                print("  ⟳ image no longer passes HEAD preflight — skipping retries")
        if err == "invalid_blocks":
            # Never silently downgrade to a text-only announcement. Keep the
            # slug unrecorded so a later tick can retry with the cover.
            print("  ! image card still rejected — deferring share; will retry later")
            log_to_disk(repo_root, channel, "warning",
                        "post-notify: deferred share for %r after Slack rejected image card; cover was not dropped" % slug)
        if err is not None:
            log_to_disk(repo_root, channel, "error",
                        "post-notify: failed to share %r to Slack — %s" % (slug, err))
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
