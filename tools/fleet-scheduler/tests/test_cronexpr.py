import datetime as dt
import glob
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from fleetsched.cronexpr import CronError, UTC, parse, zone  # noqa: E402

NY = zone("America/New_York")


def U(*a):
    return dt.datetime(*a, tzinfo=UTC)


class Parse(unittest.TestCase):
    def test_bad(self):
        for bad in ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *",
                    "*/0 * * * *", "5-1 * * * *", "a * * * *", "* * 31 2 *", "1,,2 * * * *", "*/x * * * *"]:
            with self.assertRaises(CronError, msg=bad):
                parse(bad)

    def test_names_and_macros(self):
        self.assertEqual(parse("0 7 * * mon-fri").dows, frozenset({1, 2, 3, 4, 5}))
        self.assertEqual(parse("0 0 1 jan,jul *").months, frozenset({1, 7}))
        self.assertEqual(parse("@hourly").minutes, frozenset({0}))
        self.assertEqual(parse("0 0 * * 7").dows, frozenset({0}))
        self.assertEqual(parse("0 0 * * 0-7/7").dows, frozenset({0}))

    def test_steps(self):
        self.assertEqual(parse("*/15 * * * *").minutes, frozenset({0, 15, 30, 45}))
        self.assertEqual(parse("10-30/10 * * * *").minutes, frozenset({10, 20, 30}))
        self.assertEqual(parse("5/20 * * * *").minutes, frozenset({5, 25, 45}))


class Next(unittest.TestCase):
    def test_basic(self):
        e = parse("7,22,37,52 * * * *")
        self.assertEqual(e.next_after(U(2026, 9, 19, 23, 17)), U(2026, 9, 19, 23, 22))
        self.assertEqual(e.next_after(U(2026, 9, 19, 23, 52)), U(2026, 9, 20, 0, 7))

    def test_strictly_after(self):
        e = parse("* * * * *")
        t = U(2026, 1, 1, 0, 0, 30)
        self.assertEqual(e.next_after(t), U(2026, 1, 1, 0, 1))

    def test_dom_dow_or(self):
        e = parse("0 0 13 * 5")  # 13th OR any Friday
        self.assertEqual(e.next_after(U(2026, 9, 1)), U(2026, 9, 4))   # Friday
        self.assertEqual(e.next_after(U(2026, 9, 12, 12)), U(2026, 9, 13))  # 13th (Sunday)

    def test_dow_only_and(self):
        e = parse("0 7 * * 6")
        self.assertEqual(e.next_after(U(2026, 9, 19, 12), UTC).weekday(), 5)

    def test_leap_day(self):
        self.assertEqual(parse("0 0 29 2 *").next_after(U(2026, 1, 1)), U(2028, 2, 29))

    def test_year_rollover(self):
        self.assertEqual(parse("0 0 1 1 *").next_after(U(2026, 12, 31, 23, 59)), U(2027, 1, 1))

    def test_tz_local_time(self):
        # 07:00 New York in September (EDT, UTC-4) is 11:00 UTC
        self.assertEqual(parse("0 7 * * *").next_after(U(2026, 9, 19, 12), NY), U(2026, 9, 20, 11))
        # ...and in January (EST, UTC-5) 12:00 UTC
        self.assertEqual(parse("0 7 * * *").next_after(U(2026, 1, 19, 13), NY), U(2026, 1, 20, 12))

    def test_dst_gap_skips_nonexistent(self):
        # 2026-03-08 02:30 New York does not exist
        e = parse("30 2 * * *")
        self.assertEqual(e.next_after(U(2026, 3, 8, 5), NY), U(2026, 3, 9, 6, 30))

    def test_dst_fold_fires_once(self):
        # 2026-11-01 01:30 happens twice in New York; must fire once (first occurrence, EDT)
        e = parse("30 1 * * *")
        first = e.next_after(U(2026, 11, 1, 4), NY)
        self.assertEqual(first, U(2026, 11, 1, 5, 30))
        second = e.next_after(first, NY)
        self.assertEqual(second, U(2026, 11, 2, 6, 30))  # next day, EST

    def test_hour_wildcard_runs_through_fold(self):
        # */15 must fire in BOTH passes of the repeated 01:xx hour (real elapsed time)
        e = parse("*/15 * * * *")
        t, seen = U(2026, 11, 1, 4, 50), []
        for _ in range(12):
            t = e.next_after(t, NY)
            seen.append(t)
        gaps = {(b - a) for a, b in zip(seen, seen[1:])}
        self.assertEqual(gaps, {dt.timedelta(minutes=15)})

    def test_hour_wildcard_spring_forward(self):
        e = parse("30 * * * *")
        t = e.next_after(U(2026, 3, 8, 6, 45), NY)  # 01:45 EST -> next real :30 is 03:30 EDT (07:30Z)
        self.assertEqual(t, U(2026, 3, 8, 7, 30))

    def test_monotonic_hourly_across_fold(self):
        e = parse("0 * * * *")
        t, prev = U(2026, 11, 1, 3), None
        for _ in range(8):
            t = e.next_after(t, NY)
            if prev:
                self.assertEqual(t - prev, dt.timedelta(hours=1))
            prev = t

    def test_naive_rejected(self):
        with self.assertRaises(ValueError):
            parse("* * * * *").next_after(dt.datetime(2026, 1, 1))


class RealCrontabs(unittest.TestCase):
    """Every schedule in the fleet parses and yields sane, ordered fires."""

    def test_all_real_schedules(self):
        from fleetsched.importer import parse_crontab
        root = os.environ.get("FS_ROOT", "/home/jesse/projects/domains")
        files = glob.glob(f"{root}/sites/*/ops/docker/crontab.docker")
        if not files:
            self.skipTest("no crontabs present")
        n = 0
        for f in files:
            r = parse_crontab(open(f).read())
            self.assertEqual(r.errors, [], f)
            for j in r.jobs:
                t = U(2026, 9, 19)
                for _ in range(3):
                    nt = parse(j.schedule).next_after(t, NY)
                    self.assertGreater(nt, t)
                    t = nt
                n += 1
        self.assertGreater(n, 100)


@unittest.skipUnless(os.environ.get("CROSSCHECK"), "set CROSSCHECK=1 with croniter installed")
class CrossCheck(unittest.TestCase):
    def test_against_croniter(self):
        from croniter import croniter
        rnd = random.Random(1234)

        def rf(lo, hi):
            kind = rnd.choice(["*", "n", "list", "range", "step"])
            if kind == "*":
                return "*"
            if kind == "n":
                return str(rnd.randint(lo, hi))
            if kind == "list":
                return ",".join(str(x) for x in sorted(rnd.sample(range(lo, hi + 1), rnd.randint(2, 4))))
            a = rnd.randint(lo, hi - 1)
            b = rnd.randint(a + 1, hi)
            if kind == "range":
                return f"{a}-{b}"
            return f"{a}-{b}/{rnd.randint(1, 5)}"

        for _ in range(400):
            expr = f"{rf(0, 59)} {rf(0, 23)} {rf(1, 28)} {rf(1, 12)} {rf(0, 6)}"
            start = dt.datetime(2026, 1, 1, tzinfo=UTC) + dt.timedelta(minutes=rnd.randint(0, 600000))
            mine = parse(expr).next_after(start)
            ref = croniter(expr, start).get_next(dt.datetime)
            self.assertEqual(mine, ref.astimezone(UTC), expr)


if __name__ == "__main__":
    unittest.main()
