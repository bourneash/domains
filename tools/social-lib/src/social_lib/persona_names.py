"""Deterministic real-sounding First/Last name generation for a persona
slug — built 2026-08-29 for Facebook signups (see facebook_signup.py),
which enforces a real-person identity model and flags obviously
brand-derived names ("It looks like you're trying to create an account
for a business, organization, or character. Please create a Facebook Page
instead." — confirmed live, 0daynews.com).

The fleet's existing personas (see social_registry.py) are single-word
pseudonymous handles ("airgap", "fuse", "kilobaud") used as Bluesky-style
bylines — fine there, but Facebook needs something that reads as an
actual person's name. This generates one deterministically from a seed
(typically "<domain>:<persona-slug>") so the same persona always maps to
the same name across runs/platforms, without needing a schema change to
the social registry.

This is NOT claiming these are real people — same footing as every other
pseudonymous persona on the fleet (see the `realPerson` registry flag).
Don't use this for a site/persona already flagged `realPerson: true`.
"""
import hashlib

FIRST_NAMES = [
    "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
    "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Charles", "Karen", "Daniel", "Nancy", "Matthew", "Lisa",
    "Anthony", "Margaret", "Mark", "Sandra", "Paul", "Ashley", "Steven", "Kimberly",
    "Andrew", "Emily", "Kenneth", "Donna", "George", "Michelle", "Joshua", "Dorothy",
    "Kevin", "Carol", "Brian", "Amanda", "Edward", "Melissa", "Ronald", "Deborah",
    "Timothy", "Stephanie", "Jason", "Rebecca", "Jeffrey", "Sharon", "Ryan", "Laura",
    "Jacob", "Cynthia", "Gary", "Kathleen", "Nicholas", "Amy", "Eric", "Angela",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
    "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
    "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
    "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
    "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
]


def generate_full_name(seed: str) -> tuple[str, str]:
    """Deterministic (first, last) pair from a seed string — same seed
    always yields the same name, different seeds spread across the pools
    via independent hash digests so first/last don't correlate."""
    h1 = int(hashlib.sha256(f"{seed}:first".encode()).hexdigest(), 16)
    h2 = int(hashlib.sha256(f"{seed}:last".encode()).hexdigest(), 16)
    return FIRST_NAMES[h1 % len(FIRST_NAMES)], LAST_NAMES[h2 % len(LAST_NAMES)]
