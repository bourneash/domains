"""Format the fleet-smoke status message and post it to Slack."""
import json
import urllib.request


def format_message(site_name, results, icon, headline_word):
    total = len(results)
    pass_count = sum(1 for r in results if r["ok"])
    fail_count = total - pass_count

    if headline_word == "healthy":
        headline = f"{site_name} is healthy — {pass_count}/{total} checks green"
    elif headline_word == "recovered":
        headline = f"{site_name} recovered — {pass_count}/{total} checks green"
    else:
        headline = f"{site_name} needs attention — {fail_count}/{total} check(s) failing"

    bullets = []
    for r in results:
        mark = "👍" if r["ok"] else "⚠️"
        bullets.append(f"• {r['label']} (`{r['path']}`) — {r['actual']} {mark}")

    return f"{icon} *{headline}*\n" + "\n".join(bullets)


def _default_post_fn(payload, token):
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode())
            return bool(body.get("ok", False))
    except Exception:
        return False


def post_message(channel, text, color, token, post_fn=None):
    """POST one Slack message. Returns False (silent no-op) if token is empty."""
    if not token:
        return False
    if post_fn is None:
        post_fn = _default_post_fn
    payload = json.dumps({
        "channel": channel,
        "attachments": [{"color": color, "text": text, "mrkdwn_in": ["text"]}],
    }).encode()
    return post_fn(payload, token)
