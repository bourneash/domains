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
    props = [
        Property("1", "saveusfarms.com", "396394354"),
        Property("2", "xxxtea.com", "396394354"),
    ]
    data = registry.build_registry(props, {})
    assert data["sites"]["saveusfarms.com"]["consent_gated"] is True
    assert data["sites"]["xxxtea.com"]["consent_gated"] is False


def test_unknown_measurement_id_is_null_not_empty_string():
    # Absence must be distinguishable from a real value.
    props = [Property("1", "newsite.com", "396394354")]
    data = registry.build_registry(props, {})
    assert data["sites"]["newsite.com"]["ga4_measurement_id"] is None


def test_write_registry_roundtrips(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    props = [Property("123", "saveusfarms.com", "396394354")]
    data = registry.build_registry(props, {"saveusfarms.com": "G-GDYX2GPMMJ"})
    registry.write_registry(data, path)
    loaded = yaml.safe_load(path.read_text())
    assert loaded["sites"]["saveusfarms.com"]["ga4_property_id"] == "123"
