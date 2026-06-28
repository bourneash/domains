import re
from social_lib.totp import generate_secret, current_code, get_uri


def test_generate_secret_is_base32():
    secret = generate_secret()
    assert re.match(r"^[A-Z2-7]+=*$", secret)
    assert len(secret) == 32


def test_current_code_is_six_digits():
    secret = generate_secret()
    code = current_code(secret)
    assert re.match(r"^\d{6}$", code)


def test_current_code_consistent_within_window():
    secret = generate_secret()
    assert current_code(secret) == current_code(secret)


def test_get_uri_format():
    uri = get_uri("ABCDEFGHIJKLMNOP", "jane@example.com", "ExampleApp")
    assert uri.startswith("otpauth://totp/")
    assert "jane%40example.com" in uri or "jane@example.com" in uri
    assert "ExampleApp" in uri
    assert "secret=ABCDEFGHIJKLMNOP" in uri
