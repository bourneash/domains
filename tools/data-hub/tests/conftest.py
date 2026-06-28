import sqlite3
import pytest

try:
    from datahub import store as store_mod
except ImportError:
    store_mod = None


@pytest.fixture
def db(tmp_path):
    if store_mod is None:
        pytest.skip("datahub.store not yet implemented")
    path = str(tmp_path / "data-hub.db")
    conn = store_mod.connect(path)
    store_mod.init_schema(conn)
    yield conn
    conn.close()
