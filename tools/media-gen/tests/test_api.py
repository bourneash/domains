from fastapi.testclient import TestClient

from media_gen import comfyui, nanobanana
from media_gen.api import app

# TestClient's default fake client host ("testclient") isn't a real IP, so
# it fails the loopback/docker0 access-restriction middleware (see
# test_middleware.py) before reaching any route — every test in this file is
# about route behavior, not that middleware, so simulate a real loopback caller.
client = TestClient(app, client=("127.0.0.1", 12345))


def test_health_reports_both_backends(monkeypatch):
    monkeypatch.setattr(comfyui, "ping", lambda: True)
    monkeypatch.setattr(nanobanana, "available", lambda: False)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["comfyui"]["reachable"] is True
    assert body["nanobanana"]["available"] is False


def test_generate_comfyui_success(monkeypatch, tmp_path):
    def fake_generate(prompt, negative=None, width=1216, height=832, steps=4, seed=None):
        return b"fake-image-bytes", {
            "backend": "comfyui", "width": width, "height": height,
            "credit": {"source": "Media Gen (ComfyUI / fake)", "photographer": "AI-generated",
                       "license": "Generated", "url": ""},
        }
    monkeypatch.setattr(comfyui, "generate", fake_generate)
    from media_gen import store
    monkeypatch.setattr(store.config, "DATA_DIR", tmp_path)

    r = client.post("/generate", json={"site": "0daynews", "prompt": "a cracked shield"})
    assert r.status_code == 200
    body = r.json()
    assert body["backend"] == "comfyui"
    assert body["width"] == 1216

    img = client.get(body["url"])
    assert img.status_code == 200
    assert img.content == b"fake-image-bytes"


def test_generate_comfyui_error_returns_503(monkeypatch):
    def fake_generate(*a, **kw):
        raise comfyui.ComfyUIError("ComfyUI unreachable")
    monkeypatch.setattr(comfyui, "generate", fake_generate)

    r = client.post("/generate", json={"site": "0daynews", "prompt": "a cracked shield"})
    assert r.status_code == 503


def test_generate_nanobanana_lock_contention_returns_429(monkeypatch):
    def fake_generate(prompt, aspect_ratio="3:2"):
        raise nanobanana.NanoBananaError("another Nano Banana generation is already running fleet-wide")
    monkeypatch.setattr(nanobanana, "generate", fake_generate)

    r = client.post("/generate", json={"site": "0daynews", "prompt": "a cracked shield", "backend": "nanobanana"})
    assert r.status_code == 429


def test_get_unknown_image_404():
    r = client.get("/image/does-not-exist")
    assert r.status_code == 404


def test_generate_requires_prompt():
    r = client.post("/generate", json={"site": "0daynews", "prompt": "ab"})
    assert r.status_code == 422  # min_length=3
