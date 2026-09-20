"""Cron expression parsing and next-fire computation. Stdlib only.

Supports the 5-field dialect the fleet's crontabs use: lists, ranges, steps
(`*/n`, `a-b/n`, `a/n`), month/day names, `?` as `*`, and the @hourly/@daily/
@weekly/@monthly/@yearly macros. Anything else raises CronError — the importer
reports it instead of guessing.

Semantics (match Vixie cron / supercronic):
  * day-of-month and day-of-week: if BOTH are restricted the job fires when
    EITHER matches; otherwise both must match.
  * DST: schedules are evaluated in wall-clock time of the job's zone. A local
    time that does not exist (spring-forward gap) does not fire that day; a
    repeated local time (fall-back) fires once, on its first occurrence.
"""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc

MACROS = {
    "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}
MONTHS = {n: i + 1 for i, n in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split())}
DOWS = {n: i for i, n in enumerate("sun mon tue wed thu fri sat".split())}


class CronError(ValueError):
    pass


def _field(text: str, lo: int, hi: int, names: dict[str, int] | None, what: str) -> tuple[frozenset[int], bool]:
    """Return (allowed values, is_wildcard)."""
    if not text:
        raise CronError(f"empty {what} field")
    out: set[int] = set()
    wildcard = False
    for part in text.split(","):
        if not part:
            raise CronError(f"empty list element in {what}: {text!r}")
        rng, _, step_s = part.partition("/")
        if "/" in part and not step_s.isdigit():
            raise CronError(f"bad step in {what}: {part!r}")
        step = int(step_s) if step_s else 1
        if step < 1:
            raise CronError(f"step must be >= 1 in {what}: {part!r}")

        def val(tok: str) -> int:
            t = tok.lower()
            if names and t in names:
                return names[t]
            if not tok.isdigit():
                raise CronError(f"bad value {tok!r} in {what}")
            return int(tok)

        if rng in ("*", "?"):
            a, b = lo, hi
            if not step_s:
                wildcard = True
            elif step == 1:
                wildcard = True
        elif "-" in rng:
            x, _, y = rng.partition("-")
            a, b = val(x), val(y)
        else:
            a = val(rng)
            b = hi if step_s else a
        if what == "day-of-week":
            if not (lo <= a <= 7 and lo <= b <= 7):
                raise CronError(f"{what} value out of range in {part!r}")
        elif not (lo <= a <= hi and lo <= b <= hi):
            raise CronError(f"{what} value out of range in {part!r}")
        if a > b:
            raise CronError(f"descending range in {what}: {part!r}")
        for v in range(a, b + 1, step):
            out.add(0 if (what == "day-of-week" and v == 7) else v)
    return frozenset(out), wildcard


class CronExpr:
    __slots__ = ("text", "minutes", "hours", "doms", "months", "dows",
                 "dom_star", "dow_star", "hour_star", "_mins_sorted")

    def __init__(self, text: str):
        raw = " ".join(text.split())
        expanded = MACROS.get(raw.lower(), raw)
        parts = expanded.split(" ")
        if len(parts) != 5:
            raise CronError(f"expected 5 fields, got {len(parts)}: {text!r}")
        self.text = raw
        self.minutes, _ = _field(parts[0], 0, 59, None, "minute")
        self.hours, _ = _field(parts[1], 0, 23, None, "hour")
        self.doms, self.dom_star = _field(parts[2], 1, 31, None, "day-of-month")
        self.months, _ = _field(parts[3], 1, 12, MONTHS, "month")
        self.dows, self.dow_star = _field(parts[4], 0, 6, DOWS, "day-of-week")
        self._mins_sorted = sorted(self.minutes)
        self.hour_star = len(self.hours) == 24
        # Reject schedules that can never fire (e.g. Feb 30) up front.
        if self.dom_star is False and self.dow_star is True:
            if not any(d <= _MAXDAYS[m] for m in self.months for d in self.doms):
                raise CronError(f"schedule can never fire: {text!r}")

    def _day_ok(self, d: dt.date) -> bool:
        dom = d.day in self.doms
        dow = ((d.weekday() + 1) % 7) in self.dows
        if not self.dom_star and not self.dow_star:
            return dom or dow
        return dom and dow

    def _next_naive(self, t: dt.datetime) -> dt.datetime | None:
        """Smallest naive local datetime >= t (minute-aligned) that matches."""
        limit = t.year + 9
        while t.year <= limit:
            if t.month not in self.months:
                t = dt.datetime(t.year + (t.month == 12), t.month % 12 + 1, 1)
                continue
            if not self._day_ok(t.date()):
                t = dt.datetime(t.year, t.month, t.day) + dt.timedelta(days=1)
                continue
            if t.hour not in self.hours:
                t = t.replace(minute=0) + dt.timedelta(hours=1)
                continue
            for m in self._mins_sorted:
                if m >= t.minute:
                    return t.replace(minute=m)
            t = t.replace(minute=0) + dt.timedelta(hours=1)
        return None

    def next_after(self, after: dt.datetime, tz: ZoneInfo | dt.tzinfo = UTC) -> dt.datetime:
        """First fire time strictly after `after` (aware), returned in UTC."""
        if after.tzinfo is None:
            raise ValueError("after must be timezone-aware")
        after = after.astimezone(UTC)
        if self.hour_star:
            return self._walk_utc(after, tz)
        cursor = after.astimezone(tz).replace(tzinfo=None, second=0, microsecond=0) + dt.timedelta(minutes=1)
        for _ in range(10000):  # bounded: DST gaps can only reject a few candidates
            n = self._next_naive(cursor)
            if n is None:
                raise CronError(f"no future fire time for {self.text!r}")
            aware = n.replace(tzinfo=tz)  # fold=0: first occurrence of a repeated time
            as_utc = aware.astimezone(UTC)
            exists = as_utc.astimezone(tz).replace(tzinfo=None) == n
            if exists and as_utc > after:
                return as_utc
            cursor = n + dt.timedelta(minutes=1)
        raise CronError(f"no future fire time for {self.text!r}")

    def _walk_utc(self, after: dt.datetime, tz) -> dt.datetime:
        """Hour-wildcard schedules (e.g. */15 * * * *) run on real elapsed time, so they
        keep firing through a DST fall-back's repeated hour (Vixie cron behaviour)."""
        t = after.replace(second=0, microsecond=0) + dt.timedelta(minutes=1)
        for _ in range(200000):
            loc = t.astimezone(tz)
            if loc.month not in self.months or not self._day_ok(loc.date()):
                midnight = (dt.datetime(loc.year, loc.month, loc.day) + dt.timedelta(days=1)).replace(tzinfo=tz)
                t = max(t + dt.timedelta(minutes=1), midnight.astimezone(UTC))
                continue
            if loc.minute in self.minutes:
                return t
            nxt = next((m for m in self._mins_sorted if m > loc.minute), None)
            t += dt.timedelta(minutes=(nxt - loc.minute) if nxt is not None else 60 - loc.minute)
        raise CronError(f"no future fire time for {self.text!r}")


_MAXDAYS = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}


def parse(text: str) -> CronExpr:
    return CronExpr(text)


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception as e:  # ZoneInfoNotFoundError, ValueError on odd keys
        raise CronError(f"unknown timezone {name!r}") from e
