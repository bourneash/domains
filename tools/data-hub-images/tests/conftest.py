import pytest


@pytest.fixture
def tmp_db(tmp_path):
    """Return a temp sqlite db path for tests that need Settings.db_path."""
    return str(tmp_path / "images.db")


@pytest.fixture
def tmp_blob(tmp_path):
    """Return a temp blob directory path for tests that need Settings.blob_dir."""
    d = tmp_path / "blobs"
    d.mkdir()
    return str(d)
