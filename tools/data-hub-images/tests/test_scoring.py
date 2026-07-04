from datahub_images import scoring
from datahub_images.config import Topic
from PIL import Image
import io


def _png(color, size=(1300, 800)):
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def test_flat_image_low_entropy_fails_validate():
    assert scoring.validate(_png((10, 10, 10))) is False   # flat = low entropy


def test_small_image_fails_validate():
    assert scoring.validate(_png((10, 20, 30), size=(400, 300))) is False


def test_score_prefers_tag_overlap():
    t = Topic(id="iran", queries=["Iran"], tags=["iran", "hormuz"])
    hi = {"width": 1300, "height": 800, "credit": {}, "tags": ["iran", "strait"], "license": "cc0"}
    lo = {"width": 1300, "height": 800, "credit": {}, "tags": ["kitten"], "license": "cc0"}
    assert scoring.score_candidate(hi, t) < scoring.score_candidate(lo, t)  # lower = better


def test_near_dup_detects_identical():
    p = scoring.phash_hex(_png((120, 60, 30)))
    assert scoring.is_near_dup(p, p) is True
