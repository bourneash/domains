from __future__ import annotations
import json
import os
import time
from pathlib import Path

import httpx

GATE_DIR = Path("/tmp/cloak-gates")
GATE_DIR.mkdir(parents=True, exist_ok=True)

MANUAL_NUMBER = "6107378479"

# SMSPool — real carrier numbers, pay-per-verify. https://api.smspool.net
# Service/country IDs confirmed live against the account 2026-08-28 (see
# reference_sms_verification_smspool memory) — country=1 is US, and service
# IDs are SMSPool's own, not guessable/stable across their catalog, so look
# them up via /service/retrieve_all if you need a new platform rather than
# assuming a pattern.
SMSPOOL_BASE = "https://api.smspool.net"
SMSPOOL_COUNTRY_US = 1
SMSPOOL_SERVICE_IDS = {
    "twitter": 948, "x": 948,
    "facebook": 329, "meta": 329,
    "instagram": 457, "threads": 457,
}


def _smspool_key() -> str:
    key = os.environ.get("SMSPOOL_API_KEY", "")
    if not key:
        raise RuntimeError("SMSPOOL_API_KEY not set — check .env / vault")
    return key


def manual_gate(gate_name: str, number: str = MANUAL_NUMBER) -> str:
    """Block until Jesse enters the SMS code. Returns the code string."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    waiting = GATE_DIR / f"{gate_name}.waiting"
    continue_file = GATE_DIR / f"{gate_name}.continue"

    continue_file.unlink(missing_ok=True)
    waiting.write_text(json.dumps({
        "message": f"SMS verification needed — check {number} for the code",
        "number": number,
        "gate": gate_name,
    }))
    print(f"\n[SMS GATE] Code sent to {number}. Write it to {continue_file} to continue.")

    while True:
        if continue_file.exists():
            code = continue_file.read_text().strip()
            continue_file.unlink(missing_ok=True)
            waiting.unlink(missing_ok=True)
            return code
        time.sleep(1)


def smspool_order(platform: str, country: int = SMSPOOL_COUNTRY_US) -> dict:
    """Rent a real number for the given platform. Returns the raw purchase
    response — callers need at least order_id and phonenumber. Raises if
    SMSPool reports failure (bad balance, no numbers in stock, etc)."""
    service = SMSPOOL_SERVICE_IDS.get(platform.lower())
    if service is None:
        raise ValueError(f"no known SMSPool service id for {platform!r} — check /service/retrieve_all")
    resp = httpx.get(f"{SMSPOOL_BASE}/purchase/sms", params={
        "key": _smspool_key(), "country": country, "service": service,
    }, timeout=20)
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"SMSPool purchase failed: {data}")
    return data


def smspool_wait_for_code(order_id: str, timeout: int = 600, poll: int = 8) -> str | None:
    """Poll sms/check until a code lands or timeout. Returns the code string,
    or None if it never arrives (caller should then smspool_cancel — a
    still-pending order refunds in full; a delivered-but-unused one does not).
    SMSPool's check response only carries a real `sms`/`full_sms` field once a
    text has actually landed — an empty/absent one just means still pending,
    not failure, so this only gives up on the timeout, not on any single
    empty poll."""
    deadline = time.time() + timeout
    key = _smspool_key()
    while time.time() < deadline:
        resp = httpx.get(f"{SMSPOOL_BASE}/sms/check", params={"key": key, "orderid": order_id}, timeout=20)
        data = resp.json()
        code = (data.get("sms") or data.get("code") or "").strip()
        if code:
            return code
        time.sleep(poll)
    return None


def smspool_cancel(order_id: str) -> dict:
    resp = httpx.get(f"{SMSPOOL_BASE}/sms/cancel", params={"key": _smspool_key(), "orderid": order_id}, timeout=20)
    return resp.json()


def smspool_gate(platform: str, gate_name: str, timeout: int = 600) -> tuple[str, str]:
    """Full rent-number-and-wait flow for a browser-driven signup. Returns
    (phone_number_e164_or_local, code). Prints STATUS lines the same shape
    as manual_gate() so callers/log-watchers don't need two code paths."""
    order = smspool_order(platform)
    order_id = order.get("order_id") or order.get("orderid")
    number = order.get("phonenumber") or str(order.get("number"))
    print(f"[SMS GATE:{gate_name}] rented {number} from SMSPool (order {order_id}), waiting for code", flush=True)
    code = smspool_wait_for_code(order_id, timeout=timeout)
    if not code:
        cancel_result = smspool_cancel(order_id)
        print(f"[SMS GATE:{gate_name}] no code within {timeout}s, cancelled: {cancel_result}", flush=True)
        raise TimeoutError(f"SMSPool order {order_id} never received a code")
    print(f"[SMS GATE:{gate_name}] code received", flush=True)
    return number, code
