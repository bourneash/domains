"""Image source adapter framework + dispatch registry."""
import httpx


class SourceUnavailable(Exception):
    """Raised by keyed adapters when their required key env var is absent.
    The collector records this as a 'skipped' egress, not an 'error'."""


def _get_json(url: str, proxy: str | None = None, headers: dict | None = None,
              timeout: float = 20, client: httpx.Client | None = None) -> dict:
    owns = client is None
    client = client or httpx.Client(proxy=proxy)
    try:
        r = client.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()
    finally:
        if owns:
            client.close()


def _redact(msg: str, *secrets: str) -> str:
    out = msg or ""
    for secret in secrets:
        if secret:
            out = out.replace(secret, "***")
    return out


# Built after fetcher modules are imported (bottom of file) to avoid circular imports.
from . import wikimedia  # noqa: E402
from . import unsplash  # noqa: E402
from . import pexels  # noqa: E402
from . import pixabay  # noqa: E402

SOURCE_FETCHERS = {
    "wikimedia": wikimedia.search,
    "unsplash": unsplash.search,
    "pexels": pexels.search,
    "pixabay": pixabay.search,
}
