#!/usr/bin/env python3
"""principal-engineer-scan.py — the ZERO-token half of the principal-engineer
cron-direct role. Reads ops/logs/slack-*.jsonl (the disk record every Slack
post now makes — see notify-slack.sh), finds new error/warning entries since
the last cursor, dedupes them against open incident records using the same
overlap-coefficient vocabulary matching as run-engineer.sh's escalation
de-dupe (deliberately not Jaccard — see that script's comment for why), and
decides AT MOST ONE incident to act on this tick (cost bound, same guardrail
watchdog uses).

Prints one JSON object to stdout:
  {"action": "none"}
  {"action": "act", "fp": "...", "summary": "...", "text": "...",
   "occurrence": N, "channel": "..."}

Never raises past main() — a scanning bug must fail safe to "no work found",
not crash the cron tick or (worse) spin a worker every 5 minutes forever.
"""
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOG_DIR = os.path.join(REPO_ROOT, "ops", "logs")
INCIDENT_DIR = os.path.join(REPO_ROOT, "ops", "health", "principal-incidents")
CURSOR_FILE = os.path.join(REPO_ROOT, "ops", ".locks", "principal-engineer-cursor.json")

DEFAULT_LOOKBACK_SECS = 3600  # first-ever run: don't replay ancient history
COOLDOWN_SECS = 20 * 60       # never re-dispatch the same open fingerprint inside this window
MAX_ATTEMPTS = 3              # after this many dispatches, stop auto-acting (human-triage territory)

# This role's OWN Slack posts must never become its own next incident — the
# ack/resolution/escalation messages it posts are matched and skipped here.
SELF_SIGNATURE = "principal engineer"

# Synthetic/test messages injected for end-to-end pipeline verification — skip
# them before any incident record is created so no worker is ever spun.
# Convention: test injectors prefix with "TEST " (case-insensitive).
TEST_PREFIXES = ("test ", "[test]", "test:")
SYNTHETIC_MARKER = "synthetic failure"

STOP = {"the", "a", "an", "is", "are", "was", "were", "and", "or", "but", "for",
        "to", "of", "in", "on", "at", "by", "it", "its", "this", "that", "must",
        "needs", "need", "owner", "jesse", "check", "fix", "keeps", "every",
        "com", "not", "no", "be", "been", "has", "have", "with", "from"}


def stem(w):
    for suf in ("ing", "ers", "er", "ed", "es", "s"):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def tokens(text):
    t = re.sub(r"[0-9a-f]{6,}|\d+", " ", text.lower())
    t = re.sub(r"[^a-z ]+", " ", t)
    return {stem(w) for w in t.split() if len(w) >= 3 and w not in STOP}


def overlap(new, vocab):
    if not new or not vocab:
        return 0.0
    return len(new & vocab) / len(new)


def load_cursor():
    try:
        with open(CURSOR_FILE) as f:
            return json.load(f).get("last_ts")
    except Exception:
        return None


def save_cursor(ts):
    try:
        os.makedirs(os.path.dirname(CURSOR_FILE), exist_ok=True)
        tmp = CURSOR_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"last_ts": ts}, f)
        os.replace(tmp, CURSOR_FILE)
    except Exception:
        pass


def parse_ts(s):
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def read_slack_lines(since_dt):
    """Today's + yesterday's slack-*.jsonl (UTC-dated filenames) — enough to
    cover any lookback this role uses without walking the whole log dir."""
    lines = []
    for days_ago in (0, 1):
        d = (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        path = os.path.join(LOG_DIR, f"slack-{d}.jsonl")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    ts = parse_ts(rec.get("ts", ""))
                    if ts is None or (since_dt and ts <= since_dt):
                        continue
                    if rec.get("severity") not in ("error", "warning"):
                        continue
                    if SELF_SIGNATURE in rec.get("text", "").lower():
                        continue
                    _tlow = rec.get("text", "").lower()
                    if any(_tlow.startswith(p) for p in TEST_PREFIXES) or SYNTHETIC_MARKER in _tlow:
                        continue
                    lines.append(rec)
        except Exception:
            continue
    return lines


def load_incidents():
    recs = {}
    if not os.path.isdir(INCIDENT_DIR):
        return recs
    for name in os.listdir(INCIDENT_DIR):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(INCIDENT_DIR, name)) as f:
                recs[name[:-5]] = json.load(f)
        except Exception:
            continue
    return recs


def save_incident(fp, rec):
    try:
        os.makedirs(INCIDENT_DIR, exist_ok=True)
        path = os.path.join(INCIDENT_DIR, fp + ".json")
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(rec, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        pass


def match_or_new(mine_tokens, incidents):
    best, best_fp = 0.0, None
    for fp, rec in incidents.items():
        vocab = set(rec.get("vocab") or [])
        score = overlap(mine_tokens, vocab)
        shared = len(mine_tokens & vocab)
        if score > best and score >= 0.34 and (shared >= 2 or len(mine_tokens) < 3):
            best, best_fp = score, fp
    if best_fp:
        return best_fp
    return hashlib.sha1(" ".join(sorted(mine_tokens)).encode()).hexdigest()[:12]


def main():
    now = datetime.now(timezone.utc)
    now_s = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    cursor_s = load_cursor()
    cursor_dt = parse_ts(cursor_s) if cursor_s else (now - timedelta(seconds=DEFAULT_LOOKBACK_SECS))

    new_lines = read_slack_lines(cursor_dt)
    incidents = load_incidents()

    # Fold every new line into an incident record (open or new), independent
    # of whether we act on it this tick — bookkeeping always happens so
    # cooldown/attempt math stays correct even on a tick that defers.
    touched = {}
    for rec in new_lines:
        text = rec.get("text", "")
        mine = tokens(text)
        fp = match_or_new(mine, incidents)
        inc = incidents.get(fp) or touched.get(fp) or {
            "fingerprint": fp, "status": "open", "attempts": 0,
            "first_seen": now_s, "vocab": [], "occurrences": 0,
            "channel": rec.get("channel", ""), "last_text": "",
        }
        inc["last_seen"] = now_s
        inc["last_text"] = text
        inc["channel"] = rec.get("channel") or inc.get("channel", "")
        inc["occurrences"] = int(inc.get("occurrences", 0)) + 1
        inc["vocab"] = sorted(set(inc.get("vocab") or []) | mine)
        incidents[fp] = inc
        touched[fp] = inc

    # Decide at most ONE incident to act on this tick: prefer a touched
    # (freshly-seen) fingerprint that is open, under the attempt cap, and
    # past cooldown since its last dispatch.
    action_fp = None
    for fp, inc in touched.items():
        if inc.get("status") not in ("open", None):
            continue
        if int(inc.get("attempts", 0)) >= MAX_ATTEMPTS:
            continue
        last_dispatched = inc.get("last_dispatched")
        if last_dispatched:
            dt = parse_ts(last_dispatched)
            if dt and (now - dt).total_seconds() < COOLDOWN_SECS:
                continue
        action_fp = fp
        break

    result = {"action": "none"}
    if action_fp:
        inc = incidents[action_fp]
        inc["status"] = "investigating"
        inc["attempts"] = int(inc.get("attempts", 0)) + 1
        inc["last_dispatched"] = now_s
        result = {
            "action": "act",
            "fp": action_fp,
            "summary": inc["last_text"][:200],
            "text": inc["last_text"],
            "occurrence": inc["occurrences"],
            "attempt": inc["attempts"],
            "channel": inc.get("channel") or "",
        }

    for fp, inc in incidents.items():
        save_incident(fp, inc)
    save_cursor(now_s)

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # fail safe: never spin a worker on a scan bug
        print(json.dumps({"action": "none", "error": str(e)}))
