"""CloakBrowser driver — launch stealth browser, expose actions via CLI args.

Usage:
    python -m social_setup.cloak_driver launch          # start browser, print CDP endpoint
    python -m social_setup.cloak_driver goto <url>
    python -m social_setup.cloak_driver screenshot <path>
    python -m social_setup.cloak_driver fill <selector> <value>
    python -m social_setup.cloak_driver click <selector>
    python -m social_setup.cloak_driver type <selector> <value>
    python -m social_setup.cloak_driver press <key>
    python -m social_setup.cloak_driver eval <js_code>
    python -m social_setup.cloak_driver snap             # accessibility snapshot
    python -m social_setup.cloak_driver wait <ms>
    python -m social_setup.cloak_driver close

State persists via a pickle file between invocations using persistent context.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

STATE_DIR = Path("/tmp/cloak-driver")
PROFILE_DIR = STATE_DIR / "profile"
SCREENSHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")
CDP_FILE = STATE_DIR / "cdp_endpoint.txt"
PID_FILE = STATE_DIR / "pid"


def ensure_dirs():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def _get_context_and_page():
    from cloakbrowser import launch_persistent_context

    ensure_dirs()
    context = launch_persistent_context(
        str(PROFILE_DIR),
        headless=False,
        humanize=True,
        viewport={"width": 1000, "height": 700},
    )

    if context.pages:
        page = context.pages[-1]
    else:
        page = context.new_page()

    return context, page


def cmd_launch():
    context, page = _get_context_and_page()
    print(f"Browser launched. Pages: {len(context.pages)}")
    print(f"Profile: {PROFILE_DIR}")
    # Keep alive — this blocks
    try:
        input("Press Enter to close browser...\n")
    except (EOFError, KeyboardInterrupt):
        pass
    context.close()


def cmd_action(action: str, args: list[str]):
    """Run a single action and close. Persistent context keeps state."""
    context, page = _get_context_and_page()

    try:
        result = _do_action(page, action, args)
        print(result)
    finally:
        context.close()


def _do_action(page, action: str, args: list[str]) -> str:
    if action == "goto":
        url = args[0]
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)
        return f"OK — {page.url} — {page.title()}"

    elif action == "screenshot":
        path = args[0] if args else str(SCREENSHOT_DIR / "latest.png")
        page.screenshot(path=path)
        return f"OK — saved to {path}"

    elif action == "fill":
        selector, value = args[0], args[1]
        page.locator(selector).fill(value)
        return f"OK — filled {selector}"

    elif action == "click":
        selector = args[0]
        page.locator(selector).click(timeout=10000)
        time.sleep(1)
        return f"OK — clicked {selector}"

    elif action == "click_text":
        text = args[0]
        page.get_by_text(text, exact=True).first.click(timeout=10000)
        time.sleep(1)
        return f"OK — clicked text '{text}'"

    elif action == "click_role":
        role, name = args[0], args[1] if len(args) > 1 else None
        if name:
            page.get_by_role(role, name=name).first.click(timeout=10000)
        else:
            page.get_by_role(role).first.click(timeout=10000)
        time.sleep(1)
        return f"OK — clicked role={role} name={name}"

    elif action == "type":
        selector, value = args[0], args[1]
        page.locator(selector).type(value, delay=80)
        return f"OK — typed into {selector}"

    elif action == "press":
        key = args[0]
        page.keyboard.press(key)
        time.sleep(1)
        return f"OK — pressed {key}"

    elif action == "eval":
        code = " ".join(args)
        result = page.evaluate(code)
        return f"OK — {json.dumps(result, default=str)[:2000]}"

    elif action == "snap":
        snapshot = page.accessibility.snapshot()
        return json.dumps(snapshot, indent=2, default=str)[:5000]

    elif action == "wait":
        ms = int(args[0])
        time.sleep(ms / 1000)
        return f"OK — waited {ms}ms"

    elif action == "url":
        return page.url

    elif action == "title":
        return page.title()

    elif action == "inputs":
        inputs = page.locator("input, textarea, select").all()
        results = []
        for inp in inputs:
            try:
                results.append({
                    "tag": inp.evaluate("e => e.tagName"),
                    "name": inp.get_attribute("name") or "",
                    "id": inp.get_attribute("id") or "",
                    "type": inp.get_attribute("type") or "",
                    "placeholder": inp.get_attribute("placeholder") or "",
                    "value": inp.input_value()[:50] if inp.is_visible() else "",
                    "visible": inp.is_visible(),
                })
            except Exception:
                pass
        return json.dumps(results, indent=2)

    elif action == "close":
        return "OK — closing"

    else:
        return f"Unknown action: {action}"


def main():
    if len(sys.argv) < 2:
        print("Usage: python -m social_setup.cloak_driver <action> [args...]")
        sys.exit(1)

    action = sys.argv[1]

    if action == "launch":
        cmd_launch()
    else:
        cmd_action(action, sys.argv[2:])


if __name__ == "__main__":
    main()
