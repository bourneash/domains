from datahub_images import blob


def test_write_read_roundtrip(tmp_path):
    sha, path = blob.write_blob(str(tmp_path), b"hello", "jpg")
    assert sha == blob.sha256_bytes(b"hello")
    assert path.endswith(f"{sha}.jpg") and blob.read_blob(path) == b"hello"
