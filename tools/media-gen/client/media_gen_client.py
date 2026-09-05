"""media-gen client — stdlib-only (mirrors tools/data-hub-images' client shape
so a call site already using that broker recognizes this immediately).

    from media_gen_client import MediaGenClient

    client = MediaGenClient()
    result = client.generate(
        site="0daynews", prompt="...", slug="some-article",
        dest_path="/path/to/cover.png",
    )
    # result = {"id": ..., "url": ..., "backend": ..., "credit": {...}}
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


class MediaGenError(RuntimeError):
    pass


class MediaGenBusyError(MediaGenError):
    """The backend answered 429 — a known, expected contention state (e.g.
    Nano Banana's single fleet-wide CloakBrowser profile already busy), not
    a broken service. Distinct from MediaGenError so a caller can choose to
    treat "still busy after retries" differently from a real failure."""


class MediaGenClient:
    def __init__(self, base_url: str | None = None, timeout: float = 300.0):
        # Workers reach the host through host.docker.internal, while direct
        # host runs use loopback. An explicit constructor/env URL is
        # authoritative and therefore never falls through to another service.
        configured_url = base_url or os.environ.get("MEDIA_GEN_API")
        self.base_urls = [configured_url] if configured_url else [
            "http://host.docker.internal:4780",
            "http://127.0.0.1:4780",
        ]
        self.base_urls = [url.rstrip("/") for url in self.base_urls]
        self.base_url = self.base_urls[0]
        self.timeout = timeout

    def _candidates(self) -> list[str]:
        """Try the last healthy endpoint first, followed by other defaults."""
        return [self.base_url, *(url for url in self.base_urls if url != self.base_url)]

    def _open(self, path: str, *, data: bytes | None = None,
              headers: dict[str, str] | None = None, method: str | None = None,
              timeout: float | None = None):
        candidates = self._candidates()
        last_error: urllib.error.URLError | None = None
        for candidate in candidates:
            request = urllib.request.Request(
                f"{candidate}{path}", data=data, headers=headers or {}, method=method,
            )
            try:
                response = urllib.request.urlopen(
                    request, timeout=self.timeout if timeout is None else timeout,
                )
                self.base_url = candidate
                return response
            except urllib.error.HTTPError:
                # The configured service answered. Preserve its application
                # error instead of silently sending the request elsewhere.
                raise
            except urllib.error.URLError as error:
                last_error = error
        joined = " or ".join(candidates)
        raise MediaGenError(f"media-gen unreachable at {joined}: {last_error}") from last_error

    def _post(self, path: str, body: dict, *, retries: int = 2, retry_wait_s: float = 20.0) -> dict:
        # 429 means "another Nano Banana generation is using the shared
        # CloakBrowser profile fleet-wide right now" (see nanobanana.py) —
        # transient, usually gone within a couple minutes, not a real
        # failure. Absorb it with a short wait-and-retry here so every
        # caller gets that behavior for free instead of bailing to a
        # fallback backend (or erroring out entirely) on the first bump.
        # Any other status is a real error and is not retried.
        attempt = 0
        while True:
            try:
                with self._open(
                    path,
                    data=json.dumps(body).encode(),
                    headers={"content-type": "application/json"},
                    method="POST",
                ) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")
                if e.code == 429 and attempt < retries:
                    attempt += 1
                    print(
                        f"media-gen busy (429) — waiting {retry_wait_s:.0f}s and retrying "
                        f"(attempt {attempt}/{retries})", file=sys.stderr,
                    )
                    time.sleep(retry_wait_s)
                    continue
                error_cls = MediaGenBusyError if e.code == 429 else MediaGenError
                raise error_cls(f"{e.code} from media-gen: {detail}") from e

    def generate(
        self,
        site: str,
        prompt: str,
        *,
        backend: str = "comfyui",
        profile: str = "fast",
        slug: str | None = None,
        negative_prompt: str | None = None,
        width: int = 1216,
        height: int = 832,
        dest_path: str | Path | None = None,
    ) -> dict[str, Any]:
        """Generate one image. If dest_path is given, also downloads the
        bytes there and adds `saved: <path>` to the returned dict."""
        body = {
            "site": site, "prompt": prompt, "backend": backend,
            "profile": profile, "width": width, "height": height,
        }
        if slug:
            body["slug"] = slug
        if negative_prompt:
            body["negative_prompt"] = negative_prompt

        result = self._post("/generate", body)

        if dest_path:
            with self._open(result["url"]) as r:
                data = r.read()
            dest = Path(dest_path)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            result["saved"] = str(dest)

        return result

    def health(self) -> dict:
        with self._open("/health", timeout=10) as r:
            return json.loads(r.read())
