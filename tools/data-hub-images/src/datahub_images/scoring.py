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
    return bool((imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)) <= max_dist)


def validate(b, min_w=1200, min_entropy=4.0):
    try:
        w, h = dimensions(b)
    except Exception:
        return False
    return w >= min_w and h >= int(min_w * 0.5) and entropy(b) >= min_entropy


def has_topical_overlap(cand: dict, topic: Topic) -> bool:
    """True if the candidate's tags or free-text description share a
    meaningful (>3 char) word with the topic's queries/tags — or the topic
    carries no query/tag terms to check against (nothing to reject on).

    Stock search (Unsplash/Pexels/...) is relevance-ranked full-text, not a
    keyword filter — a long, specific query ("tanker attack strait of hormuz")
    can still return a confidently wrong top result (a fish-tank photo for
    "tanker"). Unlike score_candidate's soft nudge, this is a hard gate used
    by the collector to refuse a stock candidate with zero topical signal
    rather than accept whatever the API ranked first.
    """
    terms = [t.lower() for t in (topic.tags + topic.queries)]
    if not terms:
        return True
    tset = {t.lower() for t in cand.get("tags", [])}
    desc = (cand.get("description") or "").lower()
    for term in terms:
        for w in term.split():
            if len(w) <= 3:
                continue
            if w in tset or w in desc:
                return True
    return False


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
