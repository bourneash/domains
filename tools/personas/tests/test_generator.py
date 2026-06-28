import json
import pytest
from unittest.mock import patch, MagicMock
from personas.generator import generate_persona


MOCK_RESPONSE_TEXT = json.dumps({
    "name": "Sarah Chen",
    "dob": "1991-07-23",
    "bio": "Award-winning defense correspondent with 12 years covering Pentagon and foreign policy.",
    "employment_history": [
        {"company": "Associated Press", "role": "Staff Writer", "years": "2012-2019"},
        {"company": "Defense One", "role": "Senior Correspondent", "years": "2019-2024"},
    ]
})


def test_generate_persona_returns_required_fields():
    mock_client = MagicMock()
    mock_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text=MOCK_RESPONSE_TEXT)]
    )
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona("americastrikes.com", "reporter", existing_names=[])

    assert "name" in result
    assert "dob" in result
    assert "bio" in result
    assert isinstance(result["employment_history"], list)
    assert len(result["employment_history"]) >= 1


def test_generate_persona_excludes_existing_names():
    mock_client = MagicMock()
    mock_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text=MOCK_RESPONSE_TEXT)]
    )
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        generate_persona("americastrikes.com", "editor", existing_names=["Jane Doe", "Bob Smith"])

    call_args = mock_client.messages.create.call_args
    prompt = str(call_args)
    assert "Jane Doe" in prompt
    assert "Bob Smith" in prompt


def test_generate_persona_employment_history_has_correct_keys():
    mock_client = MagicMock()
    mock_client.messages.create.return_value = MagicMock(
        content=[MagicMock(text=MOCK_RESPONSE_TEXT)]
    )
    with patch("personas.generator.anthropic.Anthropic", return_value=mock_client):
        result = generate_persona("americastrikes.com", "reporter", existing_names=[])

    for entry in result["employment_history"]:
        assert "company" in entry
        assert "role" in entry
        assert "years" in entry
