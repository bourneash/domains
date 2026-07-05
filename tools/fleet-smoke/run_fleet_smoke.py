#!/usr/bin/env python3
"""Fleet-wide smoke test runner.

Discovers sites/*/ops/smoke.yaml, runs each site's configured checks, posts a
formatted Slack status message (unless that site's config disables it), and
staggers between sites so checks don't all fire in the same second.

Usage:
    python3 run_fleet_smoke.py [--sites-dir DIR] [--state-dir DIR]
                                [--stagger-seconds N] [--only SITE]
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.config import discover_configs, load_config
from lib.checks import run_checks as _run_checks
from lib.status import load_state, save_state, compute_status
from lib.slack import format_message, post_message as _post_message

DEFAULT_SITES_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sites")
)
DEFAULT_STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")


def check_one_site(site_dir, config_path, state_dir, slack_token,
                    run_checks_fn=_run_checks, post_fn=_post_message):
    site_name = os.path.basename(site_dir)
    config = load_config(config_path)

    if not config.get("enabled", True):
        print(f"[{site_name}] disabled — skipping")
        return True

    try:
        results = run_checks_fn(config)
    except Exception as exc:
        print(f"[{site_name}] ERROR running checks: {exc}")
        results = [{
            "label": "Check run",
            "path": "",
            "expect": "n/a",
            "actual": str(exc),
            "ok": False,
        }]

    fail_count = sum(1 for r in results if not r["ok"])
    prev = load_state(state_dir, site_name)
    icon, color, headline_word = compute_status(fail_count, prev.get("fail", 0))
    save_state(state_dir, site_name, fail_count)

    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        print(f"[{site_name}]   {mark} {r['actual']} (want {r['expect']}) {r['path']}")
    print(f"[{site_name}] {headline_word}: {len(results) - fail_count}/{len(results)} passing")

    slack_cfg = config.get("slack", {})
    if slack_cfg.get("enabled", True):
        channel = os.environ.get(slack_cfg.get("channel_env", ""), slack_cfg.get("channel"))
        if channel:
            message = format_message(site_name, results, icon, headline_word)
            post_fn(channel, message, color, slack_token)
        else:
            print(f"[{site_name}] WARNING: slack enabled but no channel resolved "
                  f"(checked env var {slack_cfg.get('channel_env')!r})")

    return fail_count == 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sites-dir", default=DEFAULT_SITES_DIR)
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument(
        "--stagger-seconds", type=int,
        default=int(os.environ.get("FLEET_SMOKE_STAGGER_SECONDS", "20")),
    )
    parser.add_argument("--only", default=None, help="only run this one site's slug")
    args = parser.parse_args(argv)

    slack_token = os.environ.get("SLACK_BOT_TOKEN", "")

    configs = discover_configs(args.sites_dir)
    if args.only:
        configs = [(d, p) for d, p in configs if os.path.basename(d) == args.only]

    if not configs:
        print("fleet-smoke: no sites/*/ops/smoke.yaml found — nothing to do")
        return 0

    print(f"fleet-smoke: {len(configs)} site(s) configured")
    all_ok = True
    for i, (site_dir, config_path) in enumerate(configs):
        ok = check_one_site(site_dir, config_path, args.state_dir, slack_token)
        all_ok = all_ok and ok
        if i < len(configs) - 1:
            time.sleep(args.stagger_seconds)

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
