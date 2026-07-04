import io
import imagehash
from PIL import Image
from .config import Topic


def _img(b):
    return Image.open(io.BytesIO(b)).convert("RGB")


def dimensions(b):
    im = _img(b)
    return im.width, im.height


def entropy(b):
    return _img(b).entropy()


def phash_hex(b):
    return str(imagehash.phash(_img(b)))


def is_near_dup(a, b, max_dist=6):
    return (imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)) <= max_dist


def validate(b, min_w=1200, min_entropy=4.0):
    try:
        w, h = dimensions(b)
    except Exception:
        return False
    return w >= min_w and h >= int(min_w * 0.5) and entropy(b) >= min_entropy


def score_candidate(cand: dict, topic: Topic) -> float:
    s = 0.0
    if cand["height"] > cand["width"]:
        s += 10   # penalize portrait
    if cand["width"] < 1200:
        s += 5
    tset = {t.lower() for t in cand.get("tags", [])}
    for term in [t.lower() for t in (topic.tags + topic.queries)]:
        for w in term.split():
            if len(w) > 3 and w in tset:
                s -= 2   # reward topical overlap (lower=better)
    return s
