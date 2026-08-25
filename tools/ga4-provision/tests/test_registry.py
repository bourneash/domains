import yaml

from ga4_provision import registry
from ga4_provision.discover import Property


def test_build_registry_maps_sites():
    props = [Property("123", "saveusfarms.com", "396394354")]
    data = registry.build_registry(props, {"saveusfarms.com": "G-GDYX2GPMMJ"})
    entry = data["sites"]["saveusfarms.com"]
    assert entry["ga4_property_id"] == "123"
    assert entry["ga4_measurement_id"] == "G-GDYX2GPMMJ"
    assert entry["gsc_property"] == "sc-domain:saveusfarms.com"


def test_consent_gated_sites_are_flagged():
    """Every fleet site gates GA4 behind the cookie banner, so both are True.

    This previously asserted xxxtea.com was UNGATED. That encoded the drifted
    allowlist rather than reality — verified 2026-08-25 by loading each live
    site with no consent given, where 0 of 29 fired a googletagmanager request.
    Ungated is now the explicit exception (registry.CONSENT_UNGATED), so the
    override path is what this pins.
    """
    props = [
        Property("1", "saveusfarms.com", "396394354"),
        Property("2", "xxxtea.com", "396394354"),
    ]
    data = registry.build_registry(props, {})
    assert data["sites"]["saveusfarms.com"]["consent_gated"] is True
    assert data["sites"]["xxxtea.com"]["consent_gated"] is True

    # An explicit gated-set override still narrows it.
    pinned = registry.build_registry(props, {}, consent_gated={"saveusfarms.com"})
    assert pinned["sites"]["saveusfarms.com"]["consent_gated"] is True
    assert pinned["sites"]["xxxtea.com"]["consent_gated"] is False


def test_unknown_measurement_id_is_null_not_empty_string():
    # Absence must be distinguishable from a real value.
    props = [Property("1", "newsite.com", "396394354")]
    data = registry.build_registry(props, {})
    assert data["sites"]["newsite.com"]["ga4_measurement_id"] is None


def test_empty_string_measurement_id_is_null():
    # Empty string must become None, not survive as "".
    props = [Property("1", "newsite.com", "396394354")]
    data = registry.build_registry(props, {"newsite.com": ""})
    assert data["sites"]["newsite.com"]["ga4_measurement_id"] is None


def test_whitespace_only_measurement_id_is_null():
    # Whitespace-only string must become None, not survive as "   ".
    props = [Property("1", "newsite.com", "396394354")]
    data = registry.build_registry(props, {"newsite.com": "   "})
    assert data["sites"]["newsite.com"]["ga4_measurement_id"] is None


def test_measurement_id_with_surrounding_whitespace_is_stripped():
    # Real value with incidental whitespace must be stripped to exact value.
    props = [Property("1", "newsite.com", "396394354")]
    data = registry.build_registry(props, {"newsite.com": "  G-ABC12345  "})
    assert data["sites"]["newsite.com"]["ga4_measurement_id"] == "G-ABC12345"


def test_write_registry_roundtrips(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    props = [Property("123", "saveusfarms.com", "396394354")]
    data = registry.build_registry(props, {"saveusfarms.com": "G-GDYX2GPMMJ"})
    registry.write_registry(data, path)
    loaded = yaml.safe_load(path.read_text())
    assert loaded["sites"]["saveusfarms.com"]["ga4_property_id"] == "123"
