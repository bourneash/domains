import json

from media_gen import store


def test_save_and_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(store.config, "DATA_DIR", tmp_path)
    image_id = store.save(b"fake-png-bytes", "png", {"backend": "comfyui", "prompt": "a test"})

    data, content_type = store.load_bytes(image_id)
    assert data == b"fake-png-bytes"
    assert content_type == "image/png"

    meta = store.load_meta(image_id)
    assert meta["id"] == image_id
    assert meta["prompt"] == "a test"
    assert meta["backend"] == "comfyui"


def test_load_unknown_id_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(store.config, "DATA_DIR", tmp_path)
    assert store.load_bytes("does-not-exist") is None
    assert store.load_meta("does-not-exist") is None


def test_meta_sidecar_is_readable_json(tmp_path, monkeypatch):
    monkeypatch.setattr(store.config, "DATA_DIR", tmp_path)
    image_id = store.save(b"x", "jpg", {"backend": "nanobanana"})
    sidecar = tmp_path / f"{image_id}.json"
    assert json.loads(sidecar.read_text())["backend"] == "nanobanana"
