# tools/personas/tests/test_face.py
import respx
import httpx
import pytest
from pathlib import Path
from personas.face import fetch_face


FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 100  # minimal JPEG header


@respx.mock
def test_fetch_face_saves_file(tmp_path):
    respx.get("https://thispersondoesnotexist.com/").mock(
        return_value=httpx.Response(200, content=FAKE_JPEG, headers={"content-type": "image/jpeg"})
    )
    out = tmp_path / "test-face.jpg"
    result = fetch_face(out)
    assert result == out
    assert out.exists()
    assert out.read_bytes() == FAKE_JPEG


@respx.mock
def test_fetch_face_creates_parent_dirs(tmp_path):
    respx.get("https://thispersondoesnotexist.com/").mock(
        return_value=httpx.Response(200, content=FAKE_JPEG)
    )
    out = tmp_path / "deep" / "nested" / "face.jpg"
    fetch_face(out)
    assert out.exists()


@respx.mock
def test_fetch_face_raises_on_http_error(tmp_path):
    respx.get("https://thispersondoesnotexist.com/").mock(
        return_value=httpx.Response(503)
    )
    with pytest.raises(httpx.HTTPStatusError):
        fetch_face(tmp_path / "face.jpg")
