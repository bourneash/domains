#!/usr/bin/env python3
"""Data Hub Images — client library + CLI (stdlib-only Python port).

The single, shared way portfolio sites talk to the data-hub-images broker
(tools/data-hub-images). Sites call this to SEARCH/GET/RETRIEVE images through
the VPN-gated, multi-source pool: one request either serves a matching image
from the shared library or fetches it live on demand, then hands back the
image bytes plus attribution.

Zero runtime dependencies — Python 3.11 stdlib only (urllib, json, pathlib).
Import it as a library, or run it as a CLI (see --help). It is a THIN
transport layer: the broker owns sourcing, dedup, reuse and the VPN gate;
the client owns request shaping, retrieval-to-disk, retry/backoff, and
honest failure.

The broker binds loopback (127.0.0.1:4770) or, in-network,
datahub-images-api:4770. Point the client with DATAHUB_IMAGES_API. It NEVER
reaches the public internet itself — every external fetch happens inside
the broker, behind the VPN.

This is the Python counterpart to datahub-images-client.mjs — mirror its
behavior; method names are adapted to snake_case.
"""

from __future__ import annotations

import argparse
import json as json_module
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

DEFAULT_BASE_URL = os.environ.get("DATAHUB_IMAGES_API") or "http://127.0.0.1:4770"
# A sync /request may fetch live on a pool miss (the broker caps it at
# on_demand_timeout_s + one download); give it real headroom. Image bytes can
# be several MB. Light metadata calls get a short timeout.
DEFAULT_REQUEST_TIMEOUT_MS = float(os.environ.get("DATAHUB_IMAGES_TIMEOUT_MS") or 90_000)
DEFAULT_META_TIMEOUT_MS = 15_000


class DataHubImagesError(Exception):
    """Raised for transport/protocol failures (network, non-2xx, bad JSON). A
    request that simply found no image is NOT an error — it resolves
    normally with an empty `images` list and a `note`."""

    def __init__(self, message: str, *, status: Optional[int] = None,
                 cause: Optional[BaseException] = None, retryable: Optional[bool] = None):
        super().__init__(message)
        self.status = status
        self.cause = cause
        # Deterministic client-side errors (arg validation) set retryable=False so
        # the source_image() retry loop surfaces them immediately instead of sleeping.
        self.retryable = retryable


def _is_plain_dict(v: Any) -> bool:
    return isinstance(v, dict)


EXT_BY_CONTENT_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}


def ext_for_content_type(content_type: Optional[str]) -> str:
    """Map an image content-type to a file extension; unknown -> 'img'."""
    ct = (content_type or "").split(";")[0].strip().lower()
    return EXT_BY_CONTENT_TYPE.get(ct, "img")


def normalize_keywords(keywords: Any) -> list[str]:
    """Normalize keywords into a clean list[str] from a list or a comma/space string."""
    if isinstance(keywords, (list, tuple)):
        return [str(k).strip() for k in keywords if str(k).strip()]
    if isinstance(keywords, str):
        return [k.strip() for k in re.split(r"[,\s]+", keywords) if k.strip()]
    return []


def validate_request_args(body: Optional[dict] = None) -> dict:
    """Validate + normalize request args. Raises DataHubImagesError (no
    `.status` — these are deterministic client bugs, so callers must NOT
    retry them). Returns the cleaned {site, keywords, topic, count}."""
    body = body or {}
    site = body.get("site")
    if not site or not isinstance(site, str):
        raise DataHubImagesError("request: `site` is required (string)", retryable=False)
    keywords = normalize_keywords(body.get("keywords"))
    topic = body.get("topic")
    if not keywords and not topic:
        raise DataHubImagesError(
            "request: provide `keywords` (non-empty) or a registered `topic`", retryable=False
        )
    count = body.get("count", 1)
    if count is None:
        count = 1
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise DataHubImagesError("request: `count` must be a positive integer", retryable=False)
    return {"site": site, "keywords": keywords, "topic": topic, "count": count}


# Type: (method, url, headers, body_bytes, timeout_s) -> (status, headers_dict, body_bytes)
Opener = Callable[[str, str, dict, Optional[bytes], float], tuple]


def _default_opener(method: str, url: str, headers: dict, body: Optional[bytes], timeout: float):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            resp_headers = dict(resp.headers.items())
            return resp.status, resp_headers, data
    except urllib.error.HTTPError as e:
        data = e.read() if e.fp else b""
        resp_headers = dict(e.headers.items()) if e.headers else {}
        return e.code, resp_headers, data


class DataHubImagesClient:
    """Client for the data-hub-images broker.

    Args:
        base_url: Broker base URL. Default DATAHUB_IMAGES_API or http://127.0.0.1:4770.
        timeout: Per-request timeout for /request + image downloads (seconds).
        meta_timeout: Per-request timeout for light calls (/health, /stats, poll) (seconds).
        retries: Retry attempts on transport 5xx/network AND on a "busy" note. Default 2.
        retry_base: Base backoff between retries (seconds). Default 0.75. Grows *2 each attempt.
        user_agent: User-Agent header sent to the broker.
        opener: Injectable transport callable (for tests). Default wraps urllib.
        sleep: Injectable sleep callable (for tests, avoids real backoff sleeps).
    """

    def __init__(self, base_url: Optional[str] = None, timeout: Optional[float] = None,
                 meta_timeout: Optional[float] = None, retries: int = 2,
                 retry_base: float = 0.75, user_agent: str = "datahub-images-client/1.0",
                 opener: Optional[Opener] = None, sleep: Callable[[float], None] = time.sleep):
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout if timeout is not None else DEFAULT_REQUEST_TIMEOUT_MS / 1000.0
        self.meta_timeout = meta_timeout if meta_timeout is not None else DEFAULT_META_TIMEOUT_MS / 1000.0
        self.retries = retries
        self.retry_base = retry_base
        self.user_agent = user_agent
        self._opener = opener or _default_opener
        self._sleep = sleep

    # ── low-level transport ────────────────────────────────────────────────

    def _fetch(self, method: str, pathname: str, *, headers: Optional[dict] = None,
               body: Optional[bytes] = None, timeout: Optional[float] = None):
        url = f"{self.base_url}{pathname}"
        hdrs = dict(headers or {})
        hdrs.setdefault("user-agent", self.user_agent)
        try:
            status, resp_headers, data = self._opener(
                method, url, hdrs, body, timeout if timeout is not None else self.timeout
            )
        except urllib.error.URLError as err:
            reason = getattr(err, "reason", err)
            if "timed out" in str(reason).lower():
                raise DataHubImagesError(
                    f"request to {url} timed out after "
                    f"{(timeout if timeout is not None else self.timeout) * 1000:.0f}ms",
                    cause=err,
                ) from err
            raise DataHubImagesError(f"network error contacting {url}: {reason}", cause=err) from err
        except TimeoutError as err:
            raise DataHubImagesError(
                f"request to {url} timed out after "
                f"{(timeout if timeout is not None else self.timeout) * 1000:.0f}ms",
                cause=err,
            ) from err
        except OSError as err:
            raise DataHubImagesError(f"network error contacting {url}: {err}", cause=err) from err
        return status, resp_headers, data

    def _get_json(self, pathname: str, *, timeout: Optional[float] = None) -> Any:
        status, headers, data = self._fetch(
            "GET", pathname,
            headers={"accept": "application/json"},
            timeout=timeout if timeout is not None else self.meta_timeout,
        )
        if not (200 <= status < 300):
            raise DataHubImagesError(f"GET {pathname} -> HTTP {status}", status=status)
        try:
            return json_module.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as err:
            raise DataHubImagesError(f"GET {pathname} returned invalid JSON", cause=err) from err

    # ── public API ──────────────────────────────────────────────────────────

    def request(self, site: Optional[str] = None, keywords: Any = None, count: int = 1,
                slug: Optional[str] = None, topic: Optional[str] = None,
                async_: bool = False) -> dict:
        """Low-level POST /request. Returns the broker's JSON verbatim:
        sync  -> {images: [{id,url,credit,license,width,height}, ...], note?}
        async -> {status: "pending", request_id: <int>}
        Never retries on a "busy" note here — that policy lives in source_image().
        """
        args = {"site": site, "keywords": keywords, "count": count, "topic": topic}
        validated = validate_request_args(args)
        payload = {"site": validated["site"], "keywords": validated["keywords"],
                   "count": validated["count"]}
        if slug:
            payload["slug"] = slug
        if validated["topic"]:
            payload["topic"] = validated["topic"]
        if async_:
            payload["async"] = True  # JSON key is "async" (broker aliases it), NOT async_

        body = json_module.dumps(payload).encode("utf-8")
        status, headers, data = self._fetch(
            "POST", "/request",
            headers={"content-type": "application/json", "accept": "application/json"},
            body=body, timeout=self.timeout,
        )
        if not (200 <= status < 300):
            raise DataHubImagesError(f"POST /request -> HTTP {status}", status=status)
        try:
            result = json_module.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as err:
            raise DataHubImagesError("POST /request returned invalid JSON", cause=err) from err
        if not _is_plain_dict(result):
            raise DataHubImagesError("POST /request returned a non-object body")
        return result

    def poll_request(self, request_id: int) -> dict:
        """GET /request/{id} — poll an async request. Returns the full status
        row incl. `status` ("pending"|"done"|"failed") and `result.image_ids`."""
        if not isinstance(request_id, int) or isinstance(request_id, bool):
            raise DataHubImagesError("poll_request: request_id must be an integer")
        return self._get_json(f"/request/{request_id}")

    def wait_for_request(self, request_id: int, interval: float = 2.0,
                          timeout: float = 120.0) -> dict:
        """Poll an async request until it leaves 'pending' or the deadline
        passes. Resolves with the terminal status row; raises only on
        timeout/transport."""
        deadline = time.monotonic() + timeout
        while True:
            row = self.poll_request(request_id)
            if row and row.get("status") and row.get("status") != "pending":
                return row
            if time.monotonic() >= deadline:
                raise DataHubImagesError(
                    f"request {request_id} still pending after {timeout * 1000:.0f}ms"
                )
            self._sleep(interval)

    def get_image_bytes(self, image_id: str) -> bytes:
        """Fetch raw image bytes for an id. Raises if the response is not an
        image/* content-type. Use download_image() if you also need the
        resolved content-type/extension."""
        data, _ct = self._get_image_bytes_ct(image_id)
        return data

    def _get_image_bytes_ct(self, image_id: str) -> tuple[bytes, str]:
        if not image_id or not isinstance(image_id, str):
            raise DataHubImagesError("get_image_bytes: image_id is required (string)")
        import urllib.parse as _uparse
        pathname = f"/image/{_uparse.quote(image_id, safe='')}"
        status, headers, data = self._fetch("GET", pathname, timeout=self.timeout)
        if not (200 <= status < 300):
            raise DataHubImagesError(f"GET {pathname} -> HTTP {status}", status=status)
        content_type = ""
        for k, v in headers.items():
            if k.lower() == "content-type":
                content_type = v
                break
        if not content_type.startswith("image/"):
            raise DataHubImagesError(
                f"GET {pathname} returned non-image content-type \"{content_type}\""
            )
        return data, content_type

    def download_image(self, image_id: str, dest_path: str) -> dict:
        """Download an image to disk, creating parent dirs. Returns
        {path, bytes, content_type}."""
        if not dest_path or not isinstance(dest_path, str):
            raise DataHubImagesError("download_image: dest_path is required (string)")
        data, content_type = self._get_image_bytes_ct(image_id)
        dest = Path(dest_path)
        dest.resolve().parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return {"path": dest_path, "bytes": len(data), "content_type": content_type or ""}

    def health(self) -> dict:
        return self._get_json("/health")

    def stats(self) -> dict:
        return self._get_json("/stats")

    def sources(self) -> dict:
        return self._get_json("/sources")

    # ── high-level ───────────────────────────────────────────────────────────

    def source_image(self, site: Optional[str] = None, keywords: Any = None,
                      topic: Optional[str] = None, count: int = 1,
                      slug: Optional[str] = None, async_: bool = False,
                      dest_dir: Optional[str] = None,
                      filename: Optional[Callable[[dict, int], str]] = None,
                      wait_opts: Optional[dict] = None) -> dict:
        """High-level: get images for a subject and (optionally) write them to
        disk. This is what most site code should call. Sync by default: on a
        pool miss the broker fetches live through the VPN. Handles the
        broker's transient "busy" note and transport 5xx with bounded
        backoff. Returns {images: [...], note?, request_id?} — images is
        empty (never raising) when the broker genuinely has nothing to
        offer.
        """
        args = {"site": site, "keywords": keywords, "topic": topic, "count": count,
                "slug": slug}
        # Fail fast on bad args — deterministic, so never enter the retry loop with them.
        validate_request_args(args)

        if async_:
            created = self.request(site=site, keywords=keywords, count=count,
                                    slug=slug, topic=topic, async_=True)
            request_id = created.get("request_id")
            if not isinstance(request_id, int) or isinstance(request_id, bool):
                # Broker satisfied it inline or returned an unexpected shape —
                # fall through to whatever images it handed back, if any.
                inline = self._materialize(created.get("images") or [], dest_dir, filename)
                return {"images": inline, "note": created.get("note"), "request_id": None}
            wait_opts = wait_opts or {}
            row = self.wait_for_request(request_id, **wait_opts)
            ids = ((row or {}).get("result") or {}).get("image_ids") or []
            note = (row or {}).get("note") or ((row or {}).get("result") or {}).get("note")
            if not note and (row or {}).get("status") == "failed":
                note = "request failed — no image produced"
            # Async poll returns ids only; enrich credit best-effort from the library.
            enriched = self._enrich_by_ids(ids, site)
            images = self._materialize(enriched, dest_dir, filename)
            return {"images": images, "note": None if images else note, "request_id": request_id}

        # Sync path with busy/transport retry.
        last_note = None
        for attempt in range(self.retries + 1):
            try:
                body = self.request(site=site, keywords=keywords, count=count,
                                     slug=slug, topic=topic, async_=False)
            except DataHubImagesError as err:
                # Retry only transient transport failures (5xx / network / timeout).
                # A validation error (retryable=False) or a 4xx is deterministic —
                # rethrow now.
                non_retryable = (err.retryable is False) or (
                    isinstance(err.status, int) and err.status < 500
                )
                transient = not non_retryable
                if transient and attempt < self.retries:
                    self._sleep(self.retry_base * (2 ** attempt))
                    continue
                raise
            images = body.get("images") if isinstance(body.get("images"), list) else []
            if images:
                materialized = self._materialize(images, dest_dir, filename)
                return {"images": materialized, "note": body.get("note")}
            # No images. If the broker signalled "busy" (no free fetch slot),
            # back off and retry; a genuine miss returns immediately with note
            # preserved.
            last_note = body.get("note")
            busy = isinstance(body.get("note"), str) and re.search(
                r"busy|no free fetch slot", body.get("note"), re.IGNORECASE
            )
            if busy and attempt < self.retries:
                self._sleep(self.retry_base * (2 ** attempt))
                continue
            return {"images": [], "note": last_note}
        return {"images": [], "note": last_note}

    def _enrich_by_ids(self, ids: list[str], site: Optional[str]) -> list[dict]:
        """Best-effort: turn bare image ids into {id, credit, width, height}
        via GET /images."""
        if not ids:
            return []
        index: dict[str, dict] = {}
        try:
            import urllib.parse as _uparse
            q = f"?site={_uparse.quote(site)}&limit=500" if site else "?limit=500"
            listing = self._get_json(f"/images{q}")
            items = (listing or {}).get("images") or (listing or {}).get("items") or []
            for it in items:
                if it.get("id"):
                    index[it["id"]] = it
        except Exception:
            # Listing is an enrichment nicety; ids alone are enough to download bytes.
            pass
        return [index.get(i, {"id": i}) for i in ids]

    def _materialize(self, images: list[dict], dest_dir: Optional[str],
                      filename: Optional[Callable[[dict, int], str]]) -> list[dict]:
        """Optionally write each image to dest_dir; always returns normalized
        objects."""
        out = []
        for i, img in enumerate(images or []):
            img = img or {}
            rec = {
                "id": img.get("id"),
                "url": img.get("url"),
                "credit": img.get("credit"),
                "license": img.get("license"),
                "width": img.get("width"),
                "height": img.get("height"),
            }
            if dest_dir and img.get("id"):
                # Fetch first so the extension can follow the real content-type
                # (the broker serves jpg/png/webp/gif). A caller-supplied
                # filename wins as-is.
                data, content_type = self._get_image_bytes_ct(img["id"])
                name = filename(img, i) if filename else f"{img['id']}.{ext_for_content_type(content_type)}"
                dest = Path(dest_dir) / name
                dest.resolve().parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                rec["path"] = str(dest)
                rec["bytes"] = len(data)
                rec["content_type"] = content_type or ""
            out.append(rec)
        return out


def create_client(**kwargs) -> DataHubImagesClient:
    """Convenience factory."""
    return DataHubImagesClient(**kwargs)


# ── CLI ──────────────────────────────────────────────────────────────────────

HELP_EPILOG = """
Exit codes: 0 = at least one image; 3 = no image (miss/busy); 2 = bad args; 1 = transport error.

Env: DATAHUB_IMAGES_API, DATAHUB_IMAGES_TIMEOUT_MS
"""


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="datahub_images_client",
        description="datahub-images-client — query the data-hub-images broker",
        epilog=HELP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--site", help="Consuming site key (required for image requests)")
    p.add_argument("--keywords", help='Comma/space-separated subject terms (or repeat --keyword)')
    p.add_argument("--keyword", action="append", default=[], help="Add a single keyword (repeatable)")
    p.add_argument("--topic", help="Registered topic id (bucket) instead of keyword-derived")
    p.add_argument("--count", type=int, default=1, help="Number of images to return (default 1)")
    p.add_argument("--slug", help="Page/article slug (reuse avoids repeating within a slug)")
    p.add_argument("--out", help="Download returned images into this directory")
    p.add_argument("--async", dest="async_", action="store_true",
                    help="Queue the request and poll for completion")
    p.add_argument("--base", help="Broker base URL (default $DATAHUB_IMAGES_API or 127.0.0.1:4770)")
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON only")
    p.add_argument("--health", action="store_true", help="Print broker health and exit")
    p.add_argument("--stats", action="store_true", help="Print broker stats and exit")
    p.add_argument("--sources", action="store_true", help="Print broker sources and exit")
    # Bare words are treated as keywords (parity with the Node CLI), so
    # `--site x mount fuji` works the same in both.
    p.add_argument("keywords_pos", nargs="*", default=[], metavar="KEYWORD",
                   help="Bare keyword terms (equivalent to --keyword)")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = _build_arg_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        # argparse prints its own usage/error and calls sys.exit(2) on bad args.
        return e.code if isinstance(e.code, int) else 2

    keywords: list[str] = list(args.keyword or [])
    if args.keywords:
        keywords.extend(normalize_keywords(args.keywords))
    if args.keywords_pos:
        keywords.extend(normalize_keywords(args.keywords_pos))

    if args.count is not None and (not isinstance(args.count, int) or args.count < 1):
        print("--count must be a positive integer", file=sys.stderr)
        return 2

    client = DataHubImagesClient(base_url=args.base)

    try:
        if args.health or args.stats or args.sources:
            which = "health" if args.health else ("stats" if args.stats else "sources")
            data = getattr(client, which)()
            print(json_module.dumps(data, indent=None if args.json else 2))
            return 0

        if not args.site:
            print("error: --site is required", file=sys.stderr)
            return 2
        if not keywords and not args.topic:
            print("error: provide --keywords or --topic", file=sys.stderr)
            return 2

        result = client.source_image(
            site=args.site,
            keywords=keywords,
            topic=args.topic,
            slug=args.slug,
            count=args.count if isinstance(args.count, int) else 1,
            async_=args.async_,
            dest_dir=args.out,
        )

        if args.json:
            print(json_module.dumps(result))
        elif result["images"]:
            for img in result["images"]:
                credit = img.get("credit")
                by = f" — {credit.get('source')} / {credit.get('photographer')}" if credit else ""
                where = f"  -> {img.get('path')} ({img.get('bytes')}b)" if img.get("path") else ""
                iid = (img.get("id") or "")[:12]
                print(f"✓ {iid}  {img.get('width') or '?'}x{img.get('height') or '?'}{by}{where}")
        else:
            print(f"✗ no image — {result.get('note') or 'broker returned nothing'}", file=sys.stderr)
        return 0 if result["images"] else 3
    except DataHubImagesError as err:
        print(f"✗ {err}", file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001 - CLI top-level guard
        print(f"✗ {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
