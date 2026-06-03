import secrets
import string

ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*_+-="
LENGTH = 24


def generate() -> str:
    while True:
        pw = "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))
        has_upper = any(c in string.ascii_uppercase for c in pw)
        has_lower = any(c in string.ascii_lowercase for c in pw)
        has_digit = any(c in string.digits for c in pw)
        has_symbol = any(c in "!@#$%^&*_+-=" for c in pw)
        if has_upper and has_lower and has_digit and has_symbol:
            return pw
