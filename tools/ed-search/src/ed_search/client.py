from __future__ import annotations

import json
import os
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any

import httpx
from platformdirs import user_cache_dir

BASE = "https://member.expireddomains.net"
LOGIN_URL = f"{BASE}/login/"
LOGIN_POST_URL = f"{BASE}/logincheck/"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

CACHE_DIR = Path(user_cache_dir("ed-search"))
COOKIE_FILE = CACHE_DIR / "cookies.txt"  # Netscape/Mozilla format
MFA_FILE = CACHE_DIR / "mfa.txt"


class AuthError(RuntimeError):
    pass


class MFARequired(RuntimeError):
    """Raised when login redirects to /emailauth/<token>/ — caller must run `verify`."""

    def __init__(self, action_path: str):
        super().__init__(f"MFA required at {action_path}")
        self.action_path = action_path


def _load_jar(path: Path) -> MozillaCookieJar:
    jar = MozillaCookieJar(str(path))
    if path.exists():
        jar.load(ignore_discard=True, ignore_expires=True)
    return jar


def _save_jar(jar: MozillaCookieJar, path: Path) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    jar.filename = str(path)
    jar.save(ignore_discard=True, ignore_expires=True)


def _httpx_to_mozilla(client: httpx.Client) -> MozillaCookieJar:
    """Copy cookies out of an httpx client's jar into a MozillaCookieJar."""
    jar = MozillaCookieJar()
    for c in client.cookies.jar:
        jar.set_cookie(c)
    return jar


def make_client(cookies_path: Path | None = COOKIE_FILE) -> httpx.Client:
    """Return an httpx client whose jar is loaded from `cookies_path`.

    Pass `None` for an empty jar (e.g. starting a fresh login).
    """
    if cookies_path is not None and cookies_path.exists():
        jar = _load_jar(cookies_path)
    else:
        jar = MozillaCookieJar()
    return httpx.Client(
        base_url=BASE,
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        cookies=jar,
        follow_redirects=True,
        timeout=30.0,
    )


def _looks_logged_in(text: str) -> bool:
    """Heuristic: logged-in pages link /logout/ in the nav."""
    return "/logout/" in text.lower()


def login(username: str, password: str) -> httpx.Client:
    """Start login. Returns a session client on success.

    Raises MFARequired if the account has email MFA enabled — caller should
    prompt user for the emailed code and call `verify_mfa(code)`.
    """
    client = make_client(cookies_path=None)
    r = client.get("/login/")
    r.raise_for_status()

    payload: dict[str, Any] = {
        "login": username,
        "password": password,
        "rememberme": "1",
    }
    r = client.post(
        "/logincheck/",
        data=payload,
        headers={"Referer": LOGIN_URL, "Origin": BASE},
    )
    r.raise_for_status()

    final_path = str(r.url).removeprefix(BASE)

    # Email MFA: final URL is /emailauth/<token>/
    if final_path.startswith("/emailauth/"):
        # Persist the in-flight cookies to a separate "mfa" jar plus a sidecar
        # JSON for the action_path, so `verify` can pick up where we left off.
        _save_jar(_httpx_to_mozilla(client), MFA_FILE)
        (MFA_FILE.with_suffix(".action")).write_text(final_path)
        raise MFARequired(final_path)

    if not _looks_logged_in(r.text):
        raise AuthError(
            "Login failed — no /logout/ link in response. "
            "Check ED_USERNAME / ED_PASSWORD, or look for a captcha."
        )

    _clear_mfa_state()
    _save_jar(_httpx_to_mozilla(client), COOKIE_FILE)
    return client


def _clear_mfa_state() -> None:
    for p in (MFA_FILE, MFA_FILE.with_suffix(".action")):
        if p.exists():
            p.unlink()


def verify_mfa(code: str) -> httpx.Client:
    """Submit the emailed MFA code, finalize the session."""
    action_file = MFA_FILE.with_suffix(".action")
    if not MFA_FILE.exists() or not action_file.exists():
        raise AuthError("No MFA flow in progress — run `ed-search login` first.")

    action_path = action_file.read_text().strip()
    client = make_client(cookies_path=MFA_FILE)
    r = client.post(
        action_path,
        data={"secret_code": code.strip(), "rememberme": "1"},
        headers={"Referer": f"{BASE}{action_path}", "Origin": BASE},
    )
    r.raise_for_status()

    if not _looks_logged_in(r.text):
        raise AuthError(
            "MFA verification failed — code rejected or expired. "
            "Re-run `ed-search login` to get a fresh code."
        )

    _clear_mfa_state()
    _save_jar(_httpx_to_mozilla(client), COOKIE_FILE)
    return client


def authed_client() -> httpx.Client:
    """Return a client with cached cookies. Caller verifies via probe()."""
    return make_client(cookies_path=COOKIE_FILE)


def probe(client: httpx.Client) -> bool:
    """Cheap check: is the cached session still logged in?"""
    r = client.get("/domains/")
    if r.status_code != 200:
        return False
    return _looks_logged_in(r.text)


def get_credentials() -> tuple[str, str]:
    user = os.environ.get("ED_USERNAME")
    pw = os.environ.get("ED_PASSWORD")
    if not user or not pw:
        raise AuthError(
            "ED_USERNAME / ED_PASSWORD not set. "
            "Add them to /home/jesse/projects/domains/.env"
        )
    return user, pw
