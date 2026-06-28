# tools/personas/tests/test_email_provisioner.py
import pytest
from unittest.mock import patch
from personas.email_provisioner import provision_email


def test_provision_email_returns_address():
    with patch("personas.email_provisioner.EmailClient") as MockClient:
        instance = MockClient.return_value
        instance.ensure_alias.return_value = True
        result = provision_email("Jane Doe", "americastrikes.com")

    assert result == "jane.doe@americastrikes.com"


def test_provision_email_calls_ensure_alias():
    with patch("personas.email_provisioner.EmailClient") as MockClient:
        instance = MockClient.return_value
        instance.ensure_alias.return_value = True
        provision_email("John Smith", "example.com")

    instance.ensure_alias.assert_called_once()
    call_args = instance.ensure_alias.call_args
    assert call_args[1]["domain"] == "example.com" or call_args[0][0] == "example.com"
    assert "john.smith" in str(call_args)


def test_provision_email_handles_special_chars():
    with patch("personas.email_provisioner.EmailClient") as MockClient:
        instance = MockClient.return_value
        instance.ensure_alias.return_value = False  # already existed
        result = provision_email("María López", "example.com")

    # Should produce a valid email local part
    assert "@example.com" in result
    assert " " not in result
