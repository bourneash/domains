import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from client.media_gen_client import MediaGenClient, MediaGenError


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def test_default_client_falls_back_to_loopback_and_remembers_it(monkeypatch):
    requested = []

    def urlopen(request, timeout):
        requested.append(request.full_url)
        if request.full_url.startswith("http://host.docker.internal:4780"):
            raise urllib.error.URLError("hostname unavailable")
        return Response(json.dumps({"ok": True}).encode())

    monkeypatch.delenv("MEDIA_GEN_API", raising=False)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    client = MediaGenClient()

    assert client.health() == {"ok": True}
    assert client.health() == {"ok": True}
    assert client.base_url == "http://127.0.0.1:4780"
    assert requested == [
        "http://host.docker.internal:4780/health",
        "http://127.0.0.1:4780/health",
        "http://127.0.0.1:4780/health",
    ]


def test_explicit_endpoint_remains_authoritative(monkeypatch):
    requested = []

    def urlopen(request, timeout):
        requested.append(request.full_url)
        raise urllib.error.URLError("unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    client = MediaGenClient(base_url="http://configured.example:4780/")

    with pytest.raises(MediaGenError, match="configured.example:4780"):
        client.health()
    assert requested == ["http://configured.example:4780/health"]


def test_http_failure_does_not_fall_through(monkeypatch):
    requested = []

    def urlopen(request, timeout):
        requested.append(request.full_url)
        raise urllib.error.HTTPError(
            request.full_url, 503, "unavailable", {}, Response(b"backend unavailable")
        )

    monkeypatch.delenv("MEDIA_GEN_API", raising=False)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    client = MediaGenClient()

    with pytest.raises(MediaGenError, match="503 from media-gen: backend unavailable"):
        client.generate(site="test", prompt="test")
    assert requested == ["http://host.docker.internal:4780/generate"]
