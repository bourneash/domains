# tools/personas/tests/test_store.py
import os
import pytest
from personas.store import Persona, save_persona, load_persona, list_personas, make_handle, persona_dir


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def _make_persona(name="Jane Doe", role="Reporter") -> Persona:
    return Persona(
        name=name,
        handle=make_handle(name),
        role=role,
        email=f"{make_handle(name).replace('-', '.')}@example.com",
        dob="1988-04-12",
        bio="Test bio.",
        employment_history=[{"company": "Reuters", "role": "Correspondent", "years": "2015-2022"}],
        avatar_path="ops/personas/avatars/jane-doe.jpg",
        platforms={},
        created="2026-06-28T00:00:00Z",
    )


def test_make_handle():
    assert make_handle("Jane Doe") == "jane-doe"
    assert make_handle("John O'Brien") == "john-obrien"
    assert make_handle("María López") == "maria-lopez"


def test_save_load_roundtrip(fake_root):
    p = _make_persona()
    save_persona("example.com", p)
    loaded = load_persona("example.com", "jane-doe")
    assert loaded.name == "Jane Doe"
    assert loaded.role == "Reporter"
    assert loaded.bio == "Test bio."


def test_list_personas_empty(fake_root):
    assert list_personas("example.com") == []


def test_list_personas_returns_all(fake_root):
    save_persona("example.com", _make_persona("Jane Doe"))
    save_persona("example.com", _make_persona("John Smith", "Editor"))
    personas = list_personas("example.com")
    assert len(personas) == 2
    names = {p.name for p in personas}
    assert "Jane Doe" in names
    assert "John Smith" in names


def test_persona_dir_structure(fake_root):
    p = _make_persona()
    path = save_persona("example.com", p)
    assert path.name == "jane-doe.yaml"
    assert "personas" in str(path)
