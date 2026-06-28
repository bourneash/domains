import json
from datetime import date
import pytest
from unittest.mock import patch, MagicMock
from personas.generator import generate_persona
from personas.store import Persona, make_handle


MOCK_RESPONSE_TEXT = json.dumps({
    "name": "Sarah Chen",
    "dob": "1991-07-23",
    "bio": "Award-winning defense correspondent with 12 years covering Pentagon and foreign policy.",
    "employment_history": [
        {"company": "Associated Press", "role": "Staff Writer", "years": "2012-2019"},
        {"company": "Defense One", "role": "Senior Correspondent", "years": "2019-2024"},
    ]
})


def _mock_client(text=MOCK_RESPONSE_TEXT):
    mock_client = MagicMock()
    mock_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text=text)]
    )
    return mock_client


def test_generate_persona_returns_persona_instance():
    mock_client = _mock_client()
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Senior Reporter", site="America Strikes", domain="americastrikes.com")

    assert isinstance(result, Persona)


def test_generate_persona_required_fields():
    mock_client = _mock_client()
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Senior Reporter", site="America Strikes", domain="americastrikes.com")

    assert result.name == "Sarah Chen"
    assert result.dob == "1991-07-23"
    assert result.bio != ""
    assert isinstance(result.employment_history, list)
    assert len(result.employment_history) >= 1


def test_generate_persona_handle_derived_from_name():
    mock_client = _mock_client()
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Senior Reporter", site="America Strikes", domain="americastrikes.com")

    assert result.handle == make_handle(result.name)
    assert result.handle != ""


def test_generate_persona_created_is_today():
    mock_client = _mock_client()
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Senior Reporter", site="America Strikes", domain="americastrikes.com")

    assert result.created == date.today().isoformat()


def test_generate_persona_email_and_avatar_empty():
    mock_client = _mock_client()
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Senior Reporter", site="America Strikes", domain="americastrikes.com")

    assert result.email == ""
    assert result.avatar_path is None
    assert result.platforms == {}


def test_generate_persona_employment_history_has_correct_keys():
    mock_client = _mock_client()
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Senior Reporter", site="America Strikes", domain="americastrikes.com")

    for entry in result.employment_history:
        assert "company" in entry
        assert "role" in entry
        assert "years" in entry


def test_generate_persona_handles_fenced_json():
    fenced = "```json\n" + MOCK_RESPONSE_TEXT + "\n```"
    mock_client = _mock_client(text=fenced)
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona(role="Editor", site="America Strikes", domain="americastrikes.com")

    assert isinstance(result, Persona)
    assert result.name == "Sarah Chen"


def test_generate_persona_raises_on_bad_json():
    mock_client = _mock_client(text="not json at all")
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        with pytest.raises(ValueError, match="non-JSON"):
            generate_persona(role="Editor", site="America Strikes", domain="americastrikes.com")
