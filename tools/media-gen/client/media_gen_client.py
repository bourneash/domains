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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


class MediaGenError(RuntimeError):
    pass


class MediaGenClient:
    def __init__(self, base_url: str | None = None, timeout: float = 300.0):
        # host.docker.internal resolves from inside a site's cron container
        # (extra_hosts: host.docker.internal:host-gateway, the same pattern
        # already used for host-Ollama wiring); localhost when run on the
        # host directly.
        self.base_url = (
            base_url
            or os.environ.get("MEDIA_GEN_API")
            or "http://host.docker.internal:4780"
        ).rstrip("/")
        self.timeout = timeout

    def _post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise MediaGenError(f"{e.code} from media-gen: {detail}") from e
        except urllib.error.URLError as e:
            raise MediaGenError(f"media-gen unreachable at {self.base_url}: {e}") from e

    def generate(
        self,
        site: str,
        prompt: str,
        *,
        backend: str = "comfyui",
        slug: str | None = None,
        negative_prompt: str | None = None,
        width: int = 1216,
        height: int = 832,
        dest_path: str | Path | None = None,
    ) -> dict[str, Any]:
        """Generate one image. If dest_path is given, also downloads the
        bytes there and adds `saved: <path>` to the returned dict."""
        body = {"site": site, "prompt": prompt, "backend": backend, "width": width, "height": height}
        if slug:
            body["slug"] = slug
        if negative_prompt:
            body["negative_prompt"] = negative_prompt

        result = self._post("/generate", body)

        if dest_path:
            image_url = f"{self.base_url}{result['url']}"
            with urllib.request.urlopen(image_url, timeout=self.timeout) as r:
                data = r.read()
            dest = Path(dest_path)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            result["saved"] = str(dest)

        return result

    def health(self) -> dict:
        with urllib.request.urlopen(f"{self.base_url}/health", timeout=10) as r:
            return json.loads(r.read())
