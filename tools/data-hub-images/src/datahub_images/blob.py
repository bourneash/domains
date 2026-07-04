import hashlib
import os


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def blob_path(blob_dir: str, sha: str, ext: str) -> str:
    return os.path.join(blob_dir, sha[:2], f"{sha}.{ext}")


def write_blob(blob_dir: str, b: bytes, ext: str):
    sha = sha256_bytes(b)
    path = blob_path(blob_dir, sha, ext)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(b)
    return sha, path


def read_blob(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()
