import pyotp


def generate_secret() -> str:
    return pyotp.random_base32()


def current_code(secret: str) -> str:
    return pyotp.TOTP(secret).now()


def get_uri(secret: str, account: str, issuer: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=account, issuer_name=issuer)
