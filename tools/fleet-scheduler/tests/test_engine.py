import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from fleetsched.db import DB  # noqa: E402
from fleetsched.engine import Config, Engine, SchedError  # noqa: E402

T0 = 1_790_000_000 - (1_790_000_000 % 3600)  # an hour boundary


class Clock:
    def __init__(self, t=T0):
        self.t = float(t)

    def __call__(self):
        return self.t


def mk(clock, executor=None, **cfg):
    db = DB(":memory:")
    e = Engine(db, Config(**cfg), now=clock, executor=executor)
    return db, e


def add(db, site="a.com", name="j", schedule="*/5 * * * *", cls="light", **kw):
    now = int(kw.pop("last_fire_ts", T0))
    return db.insert_job(site=site, name=name, schedule=schedule, command="true", **{"class": cls},
                         last_fire_ts=now, source="test", **kw)


class Gate:
    """Executor whose runs block until released — lets tests observe concurrency."""
    def __init__(self):
        self.started, self.evts = [], {}

    async def __call__(self, ctx):
        self.started.append((ctx.p.site, ctx.p.name))
        ev = self.evts.setdefault(ctx.p.run_id, asyncio.Event())
        await ev.wait()
        return "ok", 0, b"done", None

    def release_all(self):
        for e in self.evts.values():
            e.set()


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


class FireTests(unittest.IsolatedAsyncioTestCase):
    async def test_fires_only_when_adopted_and_enabled(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        add(db, name="on"); add(db, name="off", enabled=0)
        e.start()
        c.t += 300; e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started, [])  # site not adopted
        db.set_adopted("a.com", True); e.reload_all()
        c.t += 300; e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started, [("a.com", "on")])
        g.release_all(); await settle()

    async def test_overlap_skipped_not_stacked(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        add(db); db.set_adopted("a.com", True); e.start()
        for _ in range(3):
            c.t += 300; e.tick(); e.dispatch(); await settle()
        self.assertEqual(len(g.started), 1)
        st = [r["status"] for r in db.runs()]
        self.assertEqual(st.count("skipped_overlap"), 2)
        g.release_all(); await settle()

    async def test_heavy_cap_queues_then_drains(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        db.set_setting("heavy_cap", "2"); db.set_setting("site_heavy_cap", "2")
        for i in range(5):
            add(db, site=f"s{i}.com", name="w", cls="heavy", schedule="0 * * * *")
            db.set_adopted(f"s{i}.com", True)
        e.start()
        c.t += 3600; e.tick(); e.dispatch(); await settle()
        self.assertEqual(len(e.running), 2); self.assertEqual(len(e.pending), 3)
        g.release_all(); await settle(); e.dispatch(); await settle()
        self.assertEqual(len(e.running), 2); self.assertEqual(len(e.pending), 1)
        g.release_all(); await settle(); e.dispatch(); await settle(); g.release_all(); await settle()
        self.assertEqual(len(g.started), 5)

    async def test_per_site_heavy_cap(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        db.set_setting("heavy_cap", "10"); db.set_setting("site_heavy_cap", "1")
        for n in ("x", "y", "z"):
            add(db, name=n, cls="heavy", schedule="0 * * * *")
        add(db, site="b.com", name="x", cls="heavy", schedule="0 * * * *")
        db.set_adopted("a.com", True); db.set_adopted("b.com", True); e.start()
        c.t += 3600; e.tick(); e.dispatch(); await settle()
        sites = sorted(s for s, _ in g.started)
        self.assertEqual(sites, ["a.com", "b.com"])  # 1 per site
        g.release_all(); await settle()

    async def test_light_not_starved_by_full_heavy_pool(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        db.set_setting("heavy_cap", "1")
        add(db, site="a.com", name="w", cls="heavy", schedule="0 * * * *")
        add(db, site="b.com", name="w", cls="heavy", schedule="0 * * * *")
        add(db, site="c.com", name="watchdog", cls="light", schedule="0 * * * *")
        for s in ("a.com", "b.com", "c.com"):
            db.set_adopted(s, True)
        e.start(); c.t += 3600; e.tick(); e.dispatch(); await settle()
        names = sorted(n for _, n in g.started)
        self.assertEqual(names, ["w", "watchdog"])
        g.release_all(); await settle()

    async def test_priority_order(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        db.set_setting("heavy_cap", "1"); db.set_setting("site_heavy_cap", "1")
        add(db, name="lo", cls="heavy", schedule="0 * * * *", priority=0)
        add(db, site="b.com", name="hi", cls="heavy", schedule="0 * * * *", priority=5)
        db.set_adopted("a.com", True); db.set_adopted("b.com", True)
        e.start(); c.t += 3600; e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started[0], ("b.com", "hi"))
        g.release_all(); await settle()

    async def test_queue_timeout_drops_stale(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        db.set_setting("heavy_cap", "1"); db.set_setting("site_heavy_cap", "1")
        add(db, name="a", cls="heavy", schedule="0 * * * *", queue_timeout_s=600)
        add(db, name="b", cls="heavy", schedule="0 * * * *", queue_timeout_s=600)
        db.set_adopted("a.com", True); e.start()
        c.t += 3600; e.tick(); e.dispatch(); await settle()
        self.assertEqual(len(e.pending), 1)
        c.t += 601; e.tick()
        self.assertEqual(len(e.pending), 0)
        self.assertIn("skipped_queue", [r["status"] for r in db.runs()])
        g.release_all(); await settle()

    async def test_late_tick_beyond_grace_is_missed_not_fired(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        add(db, schedule="0 * * * *", misfire_grace_s=60); db.set_adopted("a.com", True); e.start()
        c.t += 3600 + 500  # loop stalled 500s
        e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started, [])
        self.assertEqual(db.runs()[0]["status"], "missed")

    async def test_catch_up_within_grace_on_restart(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        add(db, schedule="0 * * * *", misfire_grace_s=300, last_fire_ts=T0)
        db.set_adopted("a.com", True)
        c.t = T0 + 3600 + 90  # restarted 90s after the 01:00 tick was due
        e.start(); e.dispatch(); await settle()
        self.assertEqual(len(g.started), 1)
        g.release_all(); await settle()

    async def test_no_catch_up_beyond_grace(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        add(db, schedule="0 * * * *", misfire_grace_s=60, last_fire_ts=T0)
        db.set_adopted("a.com", True)
        c.t = T0 + 3600 + 900
        e.start(); e.dispatch(); await settle()
        self.assertEqual(g.started, [])

    async def test_pause_blocks_fire_dispatch_and_manual(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        jid = add(db); db.set_adopted("a.com", True); db.set_setting("paused", "1"); e.start()
        c.t += 300; e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started, [])
        with self.assertRaises(SchedError):
            e.trigger_manual(jid, "t")

    async def test_manual_bypasses_adoption_and_overlap_guard(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        jid = add(db); e.start()  # not adopted
        rid = e.trigger_manual(jid, "tester"); e.dispatch(); await settle()
        self.assertEqual(g.started, [("a.com", "j")])
        with self.assertRaises(SchedError) as cm:
            e.trigger_manual(jid, "tester")
        self.assertEqual(cm.exception.status, 409)
        g.release_all(); await settle()
        self.assertEqual(db.run(rid)["status"], "ok")
        self.assertEqual(db.run(rid)["trigger"], "manual")

    async def test_schedule_edit_invalidates_old_timer(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        jid = add(db, schedule="*/5 * * * *"); db.set_adopted("a.com", True); e.start()
        db.update_job(jid, schedule="0 0 1 1 *", last_fire_ts=int(c.t)); e.reload_job(jid)
        c.t += 300; e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started, [])

    async def test_delete_job_drops_timer(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        jid = add(db); db.set_adopted("a.com", True); e.start()
        db.delete_job(jid); e.reload_job(jid)
        c.t += 300; e.tick(); e.dispatch(); await settle()
        self.assertEqual(g.started, [])

    async def test_orphans_reconciled_on_start(self):
        c = Clock(); db, e = mk(c)
        jid = add(db)
        db.insert_run(job_id=jid, site="a.com", name="j", **{"class": "light"}, status="running",
                      scheduled_for=1, queued_at=1, started_at=1)
        e.start()
        self.assertEqual(db.runs()[0]["status"], "lost")

    async def test_runner_crash_frees_slot(self):
        async def boom(ctx):
            raise RuntimeError("bug")
        c = Clock(); db, e = mk(c, boom)
        db.set_setting("light_cap", "1")
        add(db, name="a"); add(db, name="b")
        db.set_adopted("a.com", True); e.start()
        c.t += 300; e.tick(); e.dispatch(); await settle(); e.dispatch(); await settle()
        sts = {r["name"]: r["status"] for r in db.runs()}
        self.assertEqual(sts, {"a": "failed", "b": "failed"})
        self.assertEqual(len(e.running), 0)

    async def test_status_and_health(self):
        c = Clock(); db, e = mk(c); e.start()
        self.assertTrue(e.healthy())
        c.t += 1000
        self.assertFalse(e.healthy())


class TxnTests(unittest.IsolatedAsyncioTestCase):
    async def test_burst_of_fires_is_one_commit(self):
        c = Clock(); g = Gate(); db, e = mk(c, g)
        for i in range(40):
            add(db, site=f"s{i}.com", name="w", schedule="0 * * * *")
            db.set_adopted(f"s{i}.com", True)
        e.start()
        commits = []
        db.conn.set_trace_callback(lambda q: commits.append(q) if q.strip().upper().startswith("COMMIT") else None)
        c.t += 3600; e.tick(); e.dispatch(); await settle()
        self.assertEqual(len(g.started), 40)
        self.assertLessEqual(len(commits), 2)  # one for tick, one for dispatch (not ~120)
        g.release_all(); await settle()

    def test_txn_rolls_back_on_error_and_is_reentrant(self):
        db = DB(":memory:")
        with self.assertRaises(RuntimeError):
            with db.txn():
                db.set_setting("x", "1")
                with db.txn():
                    db.set_setting("y", "2")
                raise RuntimeError("boom")
        self.assertNotIn("x", db.settings()); self.assertNotIn("y", db.settings())
        with db.txn():
            with db.txn():
                db.set_setting("z", "3")
        self.assertEqual(db.settings()["z"], "3")


class SubprocessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "sites" / "a.com").mkdir(parents=True)
        self.site = self.root / "sites" / "a.com"

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def engine(self, **cfg):
        db = DB(":memory:")
        e = Engine(db, Config(root=self.root, kill_grace_s=1, **cfg))
        return db, e

    async def run_cmd(self, cmd, timeout=10, env=None, **cfg):
        db, e = self.engine(**cfg)
        jid = db.insert_job(site="a.com", name="t", schedule="0 0 1 1 *", command=cmd, timeout_s=timeout,
                            env_json=json.dumps(env or {}), source="test", last_fire_ts=int(time.time()))
        e.start()
        rid = e.trigger_manual(jid, "test")
        e.dispatch()
        for _ in range(400):
            await asyncio.sleep(0.05)
            if db.run(rid)["status"] not in ("queued", "running"):
                break
        return db.run(rid), e

    async def test_success_captures_output_and_cwd(self):
        r, _ = await self.run_cmd("pwd; echo out; echo err >&2")
        self.assertEqual(r["status"], "ok"); self.assertEqual(r["exit_code"], 0)
        self.assertIn(str(self.site), r["output_tail"]); self.assertIn("err", r["output_tail"])

    async def test_failure_exit_code(self):
        r, _ = await self.run_cmd("echo bad; exit 3")
        self.assertEqual((r["status"], r["exit_code"]), ("failed", 3))

    async def test_env_shared_sourced_and_job_env_applied(self):
        (self.site / ".env.shared").write_text("SLACK_TOKEN=abc\nexport OTHER='x y'\n")
        r, _ = await self.run_cmd('echo "$SLACK_TOKEN|$OTHER|$COMPOSE_PROJECT_NAME|$SITE_NAME"',
                                  env={"COMPOSE_PROJECT_NAME": "a-ops"})
        self.assertIn("abc|x y|a-ops|a.com", r["output_tail"])

    async def test_scheduler_secrets_not_leaked_to_jobs(self):
        os.environ["FS_TOKEN"] = "S3CRET" * 6
        try:
            r, _ = await self.run_cmd('echo "tok=[$FS_TOKEN]"')
        finally:
            del os.environ["FS_TOKEN"]
        self.assertIn("tok=[]", r["output_tail"])

    async def test_timeout_kills_whole_process_group(self):
        marker = self.site / "child-alive"
        uniq = f"30.{os.getpid()}"  # unique so pgrep can't match unrelated host processes
        r, _ = await self.run_cmd(f"(sleep {uniq}; touch {marker}) & sleep {uniq}", timeout=1)
        self.assertEqual(r["status"], "timeout")
        await asyncio.sleep(0.3)
        self.assertFalse(marker.exists())
        out = os.popen(f"pgrep -f '[s]leep {uniq}'").read().split()
        self.assertEqual(out, [], "grandchild survived the timeout")

    async def test_single_group_mode_uses_cwd_envfile_and_extra_env(self):
        from fleetsched.engine import make_wrapper
        (self.root / "tools").mkdir()
        (self.root / "tools" / ".env").write_text("SHARED=from-dotenv\n")
        os.environ["VAULT_SERVER"] = "https://vault"
        try:
            db = DB(":memory:")
            e = Engine(db, Config(root=self.root, cwd=self.root / "tools", group="fleet",
                                  wrapper=make_wrapper(".env"), env_extra=("VAULT_SERVER",), kill_grace_s=1))
            jid = db.insert_job(site="fleet", name="t", schedule="0 0 1 1 *", source="test", timeout_s=10,
                                command='pwd; echo "$SHARED|$VAULT_SERVER"', last_fire_ts=int(time.time()))
            e.start(); rid = e.trigger_manual(jid, "t"); e.dispatch()
            for _ in range(100):
                await asyncio.sleep(0.05)
                if db.run(rid)["status"] not in ("queued", "running"):
                    break
        finally:
            del os.environ["VAULT_SERVER"]
        out = db.run(rid)["output_tail"]
        self.assertIn(str(self.root / "tools"), out)
        self.assertIn("from-dotenv|https://vault", out)

    def test_wrapper_rejects_path_like_env_file(self):
        from fleetsched.engine import make_wrapper
        for bad in ("../x", "a b", "$(id)", "a;b", ""):
            with self.assertRaises(ValueError):
                make_wrapper(bad)

    async def test_missing_site_dir(self):
        shutil.rmtree(self.site)
        r, _ = await self.run_cmd("true")
        self.assertEqual((r["status"], r["exit_code"]), ("failed", 127))

    async def test_output_flood_is_bounded(self):
        r, _ = await self.run_cmd("head -c 5000000 /dev/zero | tr '\\0' 'x'; echo END")
        self.assertEqual(r["status"], "ok")
        self.assertLessEqual(len(r["output_tail"]), 4096)
        self.assertTrue(r["output_tail"].rstrip().endswith("END"))

    async def test_cancel_running(self):
        db, e = self.engine()
        jid = db.insert_job(site="a.com", name="t", schedule="0 0 1 1 *", command="sleep 30",
                            timeout_s=60, source="test", last_fire_ts=int(time.time()))
        e.start(); rid = e.trigger_manual(jid, "t"); e.dispatch()
        await asyncio.sleep(0.3)
        self.assertEqual(e.cancel_run(rid, "tester"), "cancelling")
        for _ in range(100):
            await asyncio.sleep(0.05)
            if db.run(rid)["status"] == "killed":
                break
        self.assertEqual(db.run(rid)["status"], "killed")

    async def test_shutdown_terminates_running(self):
        db, e = self.engine()
        jid = db.insert_job(site="a.com", name="t", schedule="0 0 1 1 *", command="sleep 30",
                            timeout_s=60, source="test", last_fire_ts=int(time.time()))
        e.start(); rid = e.trigger_manual(jid, "t"); e.dispatch()
        await asyncio.sleep(0.3)
        await e.shutdown(grace_s=3)
        self.assertEqual(db.run(rid)["status"], "killed")
        self.assertEqual(len(e.running), 0)


if __name__ == "__main__":
    unittest.main()
