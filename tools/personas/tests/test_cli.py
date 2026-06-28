# tools/personas/tests/test_cli.py
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from personas.cli import _domain_to_brand, cli
from personas.store import Persona, make_handle, save_persona


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_persona(name: str = "Jane Doe", role: str = "Staff Writer") -> Persona:
    handle = make_handle(name)
    return Persona(
        name=name,
        handle=handle,
        role=role,
        email="",
        dob="1990-03-15",
        bio="A seasoned writer.",
        employment_history=[
            {"company": "The Post", "role": "Reporter", "years": "2015-2022"}
        ],
        avatar_path=None,
        platforms={},
        created="2026-06-28T00:00:00+00:00",
    )


@pytest.fixture()
def runner():
    return CliRunner()


@pytest.fixture()
def fake_root(tmp_path, monkeypatch):
    """Point DOMAINS_ROOT at tmp_path so no real files are touched."""
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    # cli.py reads DOMAINS_ROOT at module import time; patch the module attr too
    monkeypatch.setattr("personas.cli.DOMAINS_ROOT", str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# _domain_to_brand helper
# ---------------------------------------------------------------------------

def test_domain_to_brand_hyphenated():
    assert _domain_to_brand("america-strikes.com") == "America Strikes"


def test_domain_to_brand_single_word():
    assert _domain_to_brand("xxxtea.com") == "Xxxtea"


def test_domain_to_brand_underscored():
    assert _domain_to_brand("save_us_farms.org") == "Save Us Farms"


def test_domain_to_brand_strips_tld():
    brand = _domain_to_brand("example.co.uk")
    # strips last segment only
    assert "co" in brand.lower() or "example" in brand.lower()


# ---------------------------------------------------------------------------
# create command
# ---------------------------------------------------------------------------

def test_create_success(runner, fake_root):
    persona = _fake_persona()
    with (
        patch("personas.cli.generate_persona", return_value=persona) as mock_gen,
        patch("personas.cli.fetch_face", return_value=Path("/fake/path.jpg")) as mock_face,
        patch("personas.cli.provision_email", return_value="jane.doe@example.com") as mock_email,
        patch("personas.cli.save_persona", return_value=Path("/fake/jane-doe.yaml")) as mock_save,
    ):
        result = runner.invoke(cli, ["create", "--site", "example.com", "--role", "Reporter"])

    assert result.exit_code == 0, result.output
    mock_gen.assert_called_once_with(role="Reporter", site="Example", domain="example.com")
    mock_face.assert_called_once()
    mock_email.assert_called_once_with("Jane Doe", "example.com")
    mock_save.assert_called_once()


def test_create_face_failure_continues(runner, fake_root):
    persona = _fake_persona()
    with (
        patch("personas.cli.generate_persona", return_value=persona),
        patch("personas.cli.fetch_face", side_effect=Exception("network error")),
        patch("personas.cli.provision_email", return_value="jane.doe@example.com"),
        patch("personas.cli.save_persona", return_value=Path("/fake/jane-doe.yaml")) as mock_save,
    ):
        result = runner.invoke(cli, ["create", "--site", "example.com", "--role", "Reporter"])

    assert result.exit_code == 0, result.output
    assert "Face fetch failed" in result.output
    mock_save.assert_called_once()


def test_create_email_failure_uses_fallback(runner, fake_root):
    persona = _fake_persona()
    with (
        patch("personas.cli.generate_persona", return_value=persona),
        patch("personas.cli.fetch_face", return_value=Path("/fake/path.jpg")),
        patch("personas.cli.provision_email", side_effect=Exception("CF error")),
        patch("personas.cli.save_persona", return_value=Path("/fake/jane-doe.yaml")),
    ):
        result = runner.invoke(cli, ["create", "--site", "example.com"])

    assert result.exit_code == 0, result.output
    assert "Email alias failed" in result.output
    # persona was still saved despite the email failure
    assert "Saved to" in result.output


def test_create_count_multiple(runner, fake_root):
    persona = _fake_persona()
    with (
        patch("personas.cli.generate_persona", return_value=persona),
        patch("personas.cli.fetch_face", return_value=Path("/fake/path.jpg")),
        patch("personas.cli.provision_email", return_value="jane.doe@example.com"),
        patch("personas.cli.save_persona", return_value=Path("/fake/jane-doe.yaml")) as mock_save,
    ):
        result = runner.invoke(cli, ["create", "--site", "example.com", "--count", "3"])

    assert result.exit_code == 0, result.output
    assert mock_save.call_count == 3


def test_create_default_role(runner, fake_root):
    persona = _fake_persona()
    with (
        patch("personas.cli.generate_persona", return_value=persona) as mock_gen,
        patch("personas.cli.fetch_face", return_value=Path("/fake/path.jpg")),
        patch("personas.cli.provision_email", return_value="jane.doe@example.com"),
        patch("personas.cli.save_persona", return_value=Path("/fake/jane-doe.yaml")),
    ):
        runner.invoke(cli, ["create", "--site", "example.com"])

    _, kwargs = mock_gen.call_args
    assert kwargs["role"] == "staff writer"


# ---------------------------------------------------------------------------
# list command
# ---------------------------------------------------------------------------

def test_list_no_personas(runner, fake_root):
    with patch("personas.cli.list_personas", return_value=[]):
        result = runner.invoke(cli, ["list", "--site", "example.com"])
    assert result.exit_code == 0
    assert "No personas" in result.output


def test_list_shows_personas(runner, fake_root):
    p1 = _fake_persona("Jane Doe", "Reporter")
    p2 = _fake_persona("John Smith", "Editor")
    with patch("personas.cli.list_personas", return_value=[p1, p2]):
        result = runner.invoke(cli, ["list", "--site", "example.com"])
    assert result.exit_code == 0
    assert "jane-doe" in result.output
    assert "John Smith" in result.output
    assert "Editor" in result.output


def test_list_requires_site(runner):
    result = runner.invoke(cli, ["list"])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# show command
# ---------------------------------------------------------------------------

def test_show_existing_persona(runner, fake_root):
    p = _fake_persona("Jane Doe", "Reporter")
    with patch("personas.cli.load_persona", return_value=p):
        result = runner.invoke(cli, ["show", "jane-doe", "--site", "example.com"])
    assert result.exit_code == 0
    assert "Jane Doe" in result.output
    assert "Reporter" in result.output
    assert "A seasoned writer." in result.output


def test_show_missing_persona(runner, fake_root):
    with patch("personas.cli.load_persona", side_effect=FileNotFoundError):
        result = runner.invoke(cli, ["show", "nobody", "--site", "example.com"])
    assert result.exit_code != 0
    assert "not found" in result.output


def test_show_requires_site(runner):
    result = runner.invoke(cli, ["show", "some-handle"])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# status command
# ---------------------------------------------------------------------------

def test_status_all_with_sites(runner, fake_root):
    # Create two fake site dirs under fake_root/sites/
    sites_dir = fake_root / "sites"
    (sites_dir / "example.com").mkdir(parents=True)
    (sites_dir / "other.com").mkdir(parents=True)

    p = _fake_persona()

    def fake_list(domain):
        if domain == "example.com":
            return [p]
        return []

    with patch("personas.cli.list_personas", side_effect=fake_list):
        result = runner.invoke(cli, ["status", "--all"])

    assert result.exit_code == 0
    assert "example.com" in result.output
    assert "jane-doe" in result.output


def test_status_no_sites_dir(runner, fake_root):
    result = runner.invoke(cli, ["status", "--all"])
    assert result.exit_code == 0
    assert "No sites directory" in result.output


def test_status_no_flag_shows_nothing(runner, fake_root):
    result = runner.invoke(cli, ["status"])
    assert result.exit_code == 0
    # No sites dir + no --all flag → empty output (or no-personas message)
