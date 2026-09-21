from fastapi.testclient import TestClient

from media_gen import codex, comfyui, nanobanana
from media_gen.api import app

# TestClient's default fake client host ("testclient") isn't a real IP, so
# it fails the loopback/docker0 access-restriction middleware (see
# test_middleware.py) before reaching any route — every test in this file is
# about route behavior, not that middleware, so simulate a real loopback caller.
client = TestClient(app, client=("127.0.0.1", 12345))


def test_health_reports_all_backends(monkeypatch):
    monkeypatch.setattr(comfyui, "status", lambda: {
        "reachable": True, "busy": False, "queue_running": 0, "queue_pending": 0,
        "last_success_at": None, "last_error_at": None, "last_error": None,
    })
    monkeypatch.setattr(nanobanana, "status", lambda: {
        "available": False, "busy": False, "last_success_at": None,
        "last_error_at": None, "last_error": None,
    })
    monkeypatch.setattr(codex, "status", lambda: {
        "available": True, "busy": False, "last_success_at": None,
        "last_error_at": None, "last_error": None,
    })
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["comfyui"]["reachable"] is True
    assert body["nanobanana"]["available"] is False
    assert body["codex"]["available"] is True
    assert body["degraded"] is False


def test_generate_comfyui_success(monkeypatch, tmp_path):
    def fake_generate(prompt, negative=None, width=1216, height=832, steps=4, seed=None, profile="fast"):
        return b"fake-image-bytes", {
            "backend": "comfyui", "width": width, "height": height, "profile": profile,
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
    assert body["backend"] == "comfyui"

    img = client.get(body["url"])
    assert img.status_code == 200
    assert img.content == b"fake-image-bytes"


def test_generate_comfyui_forwards_quality_profile(monkeypatch, tmp_path):
    requested = {}

    def fake_generate(**kwargs):
        requested.update(kwargs)
        return b"quality-image", {
            "backend": "comfyui", "width": kwargs["width"], "height": kwargs["height"],
            "credit": {"source": "Media Gen", "photographer": "AI-generated",
                       "license": "Generated", "url": ""},
        }

    monkeypatch.setattr(comfyui, "generate", fake_generate)
    from media_gen import store
    monkeypatch.setattr(store.config, "DATA_DIR", tmp_path)

    r = client.post("/generate", json={
        "site": "rodhat", "prompt": "a mechanical cutaway", "profile": "quality",
    })
    assert r.status_code == 200
    assert requested["profile"] == "quality"


def test_generate_comfyui_error_returns_503(monkeypatch):
    def fake_generate(*a, **kw):
        raise comfyui.ComfyUIError("ComfyUI unreachable")
    monkeypatch.setattr(comfyui, "generate", fake_generate)

    r = client.post("/generate", json={"site": "0daynews", "prompt": "a cracked shield"})
    assert r.status_code == 503


def test_generate_comfyui_contention_returns_429(monkeypatch):
    def fake_generate(*a, **kw):
        raise comfyui.ComfyUIBusyError("ComfyUI stayed busy; retry shortly")
    monkeypatch.setattr(comfyui, "generate", fake_generate)

    r = client.post("/generate", json={"site": "0daynews", "prompt": "a cracked shield"})
    assert r.status_code == 429


def test_generate_nanobanana_lock_contention_returns_429(monkeypatch):
    def fake_generate(prompt, aspect_ratio="3:2"):
        raise nanobanana.NanoBananaError("another Nano Banana generation is already running fleet-wide")
    monkeypatch.setattr(nanobanana, "generate", fake_generate)

    r = client.post("/generate", json={"site": "0daynews", "prompt": "a cracked shield", "backend": "nanobanana"})
    assert r.status_code == 429


def test_generate_codex_success(monkeypatch, tmp_path):
    requested = {}

    def fake_generate(prompt, **kwargs):
        requested.update({"prompt": prompt, **kwargs})
        return b"fake-codex-png", {
            "backend": "codex", "width": 1536, "height": 1024,
            "credit": {"source": "Media Gen (Codex ImageGen)",
                       "photographer": "AI-generated", "license": "Generated", "url": ""},
        }

    monkeypatch.setattr(codex, "generate", fake_generate)
    from media_gen import store
    monkeypatch.setattr(store.config, "DATA_DIR", tmp_path)

    r = client.post("/generate", json={
        "site": "americastrikes", "prompt": "a brass compass on a map",
        "backend": "codex", "width": 1200, "height": 675, "aspect_ratio": "16:9",
    })
    assert r.status_code == 200
    assert r.json()["backend"] == "codex"
    assert requested == {
        "prompt": "a brass compass on a map", "aspect_ratio": "16:9",
        "width": 1200, "height": 675,
    }


def test_generate_codex_contention_returns_429(monkeypatch):
    def fake_generate(*args, **kwargs):
        raise codex.CodexBusyError("another Codex ImageGen request is already running")

    monkeypatch.setattr(codex, "generate", fake_generate)
    r = client.post("/generate", json={
        "site": "americastrikes", "prompt": "a brass compass", "backend": "codex",
    })
    assert r.status_code == 429


def test_get_unknown_image_404():
    r = client.get("/image/does-not-exist")
    assert r.status_code == 404


def test_generate_requires_prompt():
    r = client.post("/generate", json={"site": "0daynews", "prompt": "ab"})
    assert r.status_code == 422  # min_length=3
