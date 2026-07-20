"""Typed failures so callers distinguish missing creds from bad scopes."""


class GoogleAuthFleetError(Exception):
    """Base for all credential/client failures."""


class CredentialsMissing(GoogleAuthFleetError):
    """The service-account key file does not exist."""


class CredentialsMalformed(GoogleAuthFleetError):
    """The key file exists but is not a usable service-account key."""


class ScopeUnauthorized(GoogleAuthFleetError):
    """Credentials are valid but lack the scope the caller needs."""
