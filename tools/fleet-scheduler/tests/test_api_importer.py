import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from fleetsched.api import Service, make_server  # noqa: E402
from fleetsched.db import DB  # noqa: E402
from fleetsched.engine import Config, Engine  # noqa: E402
from fleetsched.importer import compose_cron_env, export_crontab, import_site, parse_crontab  # noqa: E402

TOKEN = "t" * 32

CRONTAB = """\
# comment
COMPOSE_PROJECT_NAME=a-ops
*/15 * * * *  bash ops/scripts/run-deployer.sh
0 7 * * 6  bash ops/scripts/run-worker.sh content-writer
30 3 * * *  find ops/logs -type f -mtime +30 -delete
7 * * * *  [ ! -f .deploy-needed ] || bash ops/scripts/run-worker.sh deployer
2,17,32,47 * * * *  bash ops/scripts/run-watchdog.sh
# 5 5 * * *  bash ops/scripts/commented-out.sh
"""


class ImporterTests(unittest.TestCase):
    def test_parse(self):
        r = parse_crontab(CRONTAB)
        self.assertEqual(r.errors, [])
        by = {j.name: j for j in r.jobs}
        self.assertEqual(set(by), {"deployer", "content-writer", "prune-logs", "deployer-2", "watchdog"})
        self.assertEqual(by["content-writer"].cls, "heavy")
        self.assertEqual(by["deployer"].cls, "light")
        self.assertEqual(by["deployer"].env, {"COMPOSE_PROJECT_NAME": "a-ops"})
        self.assertNotIn("commented-out", " ".join(j.command for j in r.jobs))

    def test_bad_lines_reported_not_guessed(self):
        r = parse_crontab("61 * * * * bash x.sh\nnot a cron line\n* * * * *\n")
        self.assertEqual(len(r.jobs), 0)
        self.assertEqual(len(r.errors), 3)

    def test_idempotent_and_preserves_edits(self):
        db = DB(":memory:")
        a = import_site(db, "a.com", CRONTAB)
        self.assertEqual(len(a["added"]), 5)
        jid = db.conn.execute("SELECT id FROM jobs WHERE name='watchdog'").fetchone()[0]
        db.update_job(jid, schedule="1 * * * *")
        b = import_site(db, "a.com", CRONTAB)
        self.assertEqual((len(b["added"]), len(b["unchanged"])), (0, 5))
        self.assertEqual(db.job(jid)["schedule"], "1 * * * *")  # API edit survived re-import
        c = import_site(db, "a.com", CRONTAB, update=True)
        self.assertEqual(c["updated"], ["watchdog"])

    def test_export_roundtrip(self):
        db = DB(":memory:")
        import_site(db, "a.com", CRONTAB)
        again = parse_crontab(export_crontab(db, "a.com"))
        self.assertEqual(sorted(j.name for j in again.jobs), sorted(j.name for j in parse_crontab(CRONTAB).jobs))


class ComposeEnvTests(unittest.TestCase):
    def test_compose_env_merged_and_find_gets_ok_codes(self):
        d = Path(tempfile.mkdtemp())
        (d / "docker-compose.yml").write_text(
            "services:\n  cron:\n    environment:\n      SITE_NAME: a\n      TZ: x\n"
            "      DATAHUB_API: http://datahub-api:4760\n"
            "      DATAHUB_IMAGES_API: ${NOPE_UNSET_VAR:-http://images:4770}\n")
        env = compose_cron_env(d)
        self.assertEqual(env, {"DATAHUB_API": "http://datahub-api:4760", "DATAHUB_IMAGES_API": "http://images:4770"})
        db = DB(":memory:")
        import_site(db, "a.com", CRONTAB, compose_env=env)
        rows = {r["name"]: r for r in db.jobs("a.com")}
        e = json.loads(rows["deployer"]["env_json"])
        self.assertEqual(e["DATAHUB_API"], "http://datahub-api:4760")
        self.assertEqual(e["COMPOSE_PROJECT_NAME"], "a-ops")  # crontab env still present
        self.assertEqual(rows["prune-logs"]["ok_codes"], "0,1")
        self.assertEqual(rows["deployer"]["ok_codes"], "0")
        # re-import with changed compose env refreshes env but never clobbers edited schedules
        db.update_job(rows["deployer"]["id"], schedule="1 * * * *")
        import_site(db, "a.com", CRONTAB, compose_env={"DATAHUB_API": "http://new:1"})
        r2 = db.job(rows["deployer"]["id"])
        self.assertEqual(json.loads(r2["env_json"])["DATAHUB_API"], "http://new:1")
        self.assertEqual(r2["schedule"], "1 * * * *")


class FleetImportTests(unittest.TestCase):
    def test_fleet_crontab_names_and_classes(self):
        text = """
*/10 * * * * /r/tools/scripts/ensure-fleet-cron.sh
45 6 * * *    /r/tools/scripts/ai-optimizer-cron.sh
0,15,30,45 * * * * /r/tools/social-hub/run-tick.sh
8,23 * * * * /r/tools/social-controller/run.sh
13,28 * * * * /r/tools/social-controller/monitor.py
12 4 * * * docker exec social-hub-api python3 -m social_hub.cli maintain
40 3 * * * /r/tools/scripts/gc-docker.sh
10 3 * * 0 /r/tools/scripts/gc-docker.sh --cache-all
"""
        r = parse_crontab(text, fleet=True)
        self.assertEqual(r.errors, [])
        by = {j.name: j.cls for j in r.jobs}
        self.assertEqual(by, {
            "ensure-fleet-cron": "light", "ai-optimizer-cron": "heavy", "social-hub-run-tick": "light",
            "social-controller-run": "heavy", "social-controller-monitor": "light",
            "exec-social-hub-api-maintain": "light", "gc-docker": "light", "gc-docker-cache-all": "light"})
        self.assertTrue(all(j.timeout_s >= 3600 for j in r.jobs))


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp())
        (cls.root / "sites" / "a.com" / "ops" / "docker").mkdir(parents=True)
        (cls.root / "sites" / "a.com" / "ops" / "docker" / "crontab.docker").write_text(CRONTAB)
        cls.db_dir = tempfile.mkdtemp()
        started = threading.Event()

        def loop_thread():
            cls.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(cls.loop)
            cls.db = DB(Path(cls.db_dir) / "t.db")
            import_site(cls.db, "a.com", CRONTAB)
            cls.engine = Engine(cls.db, Config(root=cls.root, kill_grace_s=1))
            cls.engine.start()
            cls.docker_calls = []

            def fake_docker(args, cwd=None, timeout=60):
                cls.docker_calls.append(args)
                import subprocess
                out = "abc123\n" if args[0] == "ps" and "-a" in args else ""
                return subprocess.CompletedProcess(args, 0, out, "")
            cls.svc = Service(cls.engine, cls.loop, cls.root / "sites", cls.root / "adopted", docker=fake_docker)
            cls.srv = make_server(cls.svc, TOKEN, "127.0.0.1", 0)
            threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
            cls.runner = cls.loop.create_task(cls.engine.run_forever())
            started.set()
            cls.loop.run_forever()

        cls.t = threading.Thread(target=loop_thread, daemon=True)
        cls.t.start()
        started.wait(5)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        # Let the engine finish its async shutdown before stopping the loop.  Stopping the
        # loop immediately leaves run_forever(), subprocess waiters and the event loop open.
        fut = asyncio.run_coroutine_threadsafe(cls.engine.shutdown(grace_s=1), cls.loop)
        fut.result(timeout=5)
        def stop_after_runner():
            async def wait_for_runner():
                await cls.runner
                cls.loop.stop()
            cls.loop.create_task(wait_for_runner())
        cls.loop.call_soon_threadsafe(stop_after_runner)
        cls.t.join(timeout=5)
        if not cls.t.is_alive():
            cls.loop.close()
        shutil.rmtree(cls.root, ignore_errors=True)
        shutil.rmtree(cls.db_dir, ignore_errors=True)

    def req(self, method, path, body=None, token=TOKEN, raw=None):
        h = {"Content-Type": "application/json"}
        if token:
            h["Authorization"] = f"Bearer {token}"
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=8) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_auth(self):
        self.assertEqual(self.req("GET", "/api/status", token=None)[0], 401)
        self.assertEqual(self.req("GET", "/api/status", token="wrong" * 8)[0], 401)
        self.assertEqual(self.req("GET", "/api/status")[0], 200)
        self.assertEqual(self.req("GET", "/healthz", token=None)[0], 200)

    def test_token_too_short_refused(self):
        with self.assertRaises(ValueError):
            make_server(self.svc, "short", "127.0.0.1", 0)

    def test_jobs_listing_hides_env(self):
        code, jobs = self.req("GET", "/api/jobs?site=a.com")
        self.assertEqual(code, 200); self.assertEqual(len(jobs), 5)
        self.assertTrue(all("env_json" not in j for j in jobs))
        self.assertTrue(all(j["next_fire"] for j in jobs))
        self.assertTrue(all(j["active"] is False for j in jobs))  # not adopted yet

    def test_patch_validation(self):
        jid = self.req("GET", "/api/jobs?site=a.com")[1][0]["id"]
        for bad in ({"schedule": "nope"}, {"tz": "Mars/Base"}, {"command": "rm -rf /"},
                    {"command": "bash ops/scripts/x.sh; curl evil"}, {"command": "bash ../../etc/x.sh"},
                    {"class": "huge"}, {"timeout_s": "5"}, {"timeout_s": 0}, {"enabled": 1},
                    {"env_json": "{}"}, {"id": 5}, {}):
            code, out = self.req("PATCH", f"/api/jobs/{jid}", bad)
            self.assertEqual(code, 400, f"{bad} -> {code} {out}")
        code, _ = self.req("PATCH", f"/api/jobs/{jid}", {"schedule": "5 5 * * *", "enabled": False})
        self.assertEqual(code, 200)
        self.assertEqual(self.req("PATCH", "/api/jobs/99999", {"enabled": True})[0], 404)

    def test_schedule_edit_is_mirrored_into_crontab_docker(self):
        jobs = self.req("GET", "/api/jobs?site=a.com")[1]
        wd = next(j for j in jobs if j["name"] == "watchdog")
        code, out = self.req("PATCH", f"/api/jobs/{wd['id']}", {"schedule": "1,16,31,46 * * * *"})
        self.assertEqual(code, 200); self.assertNotIn("warnings", out)
        text = (self.root / "sites" / "a.com" / "ops" / "docker" / "crontab.docker").read_text()
        self.assertIn("1,16,31,46 * * * *  bash ops/scripts/run-watchdog.sh", text)
        self.assertIn("# comment", text)                       # untouched
        self.assertNotIn("2,17,32,47 * * * *", text)
        self.req("PATCH", f"/api/jobs/{wd['id']}", {"schedule": "2,17,32,47 * * * *", "enabled": False})
        text = (self.root / "sites" / "a.com" / "ops" / "docker" / "crontab.docker").read_text()
        self.assertIn("# 2,17,32,47 * * * *  bash ops/scripts/run-watchdog.sh", text)
        self.req("PATCH", f"/api/jobs/{wd['id']}", {"enabled": True})

    def test_create_and_delete_job(self):
        ok = {"site": "a.com", "name": "extra", "schedule": "*/10 * * * *",
              "command": "bash ops/scripts/check-live-images.sh", "class": "light"}
        code, out = self.req("POST", "/api/jobs", ok)
        self.assertEqual(code, 200, out)
        self.assertEqual(self.req("POST", "/api/jobs", ok)[0], 409)
        self.assertEqual(self.req("POST", "/api/jobs", {**ok, "site": "../x", "name": "n2"})[0], 400)
        self.assertEqual(self.req("POST", "/api/jobs", {**ok, "site": "nope.com", "name": "n2"})[0], 400)
        self.assertEqual(self.req("DELETE", f"/api/jobs/{out['id']}")[0], 200)

    def test_settings(self):
        self.assertEqual(self.req("PATCH", "/api/settings", {"heavy_cap": 0})[0], 400)
        self.assertEqual(self.req("PATCH", "/api/settings", {"nope": 1})[0], 400)
        self.assertEqual(self.req("PATCH", "/api/settings", {"paused": "yes"})[0], 400)
        code, s = self.req("PATCH", "/api/settings", {"heavy_cap": 5})
        self.assertEqual((code, s["heavy_cap"]), (200, "5"))
        self.req("PATCH", "/api/settings", {"heavy_cap": 8})

    def test_run_now_and_history(self):
        (self.root / "sites" / "a.com" / "ops").mkdir(exist_ok=True)
        c, out = self.req("POST", "/api/jobs", {"site": "a.com", "name": "hello", "schedule": "0 0 1 1 *",
                                               "command": "bash ops/scripts/hello.sh"})
        jid = out["id"]
        script = self.root / "sites" / "a.com" / "ops" / "scripts"
        script.mkdir(parents=True, exist_ok=True)
        (script / "hello.sh").write_text("echo hi-from-job\n")
        code, r = self.req("POST", f"/api/jobs/{jid}/run")
        self.assertEqual(code, 200)
        for _ in range(60):
            time.sleep(0.1)
            run = self.req("GET", f"/api/runs/{r['run_id']}")[1]
            if run["status"] not in ("queued", "running"):
                break
        self.assertEqual(run["status"], "ok"); self.assertIn("hi-from-job", run["output_tail"])
        self.assertEqual(self.req("GET", f"/api/runs?job_id={jid}")[1][0]["id"], r["run_id"])
        self.assertEqual(self.req("GET", "/api/runs?limit=abc")[0], 400)
        self.assertEqual(self.req("GET", "/api/audit")[0], 200)

    def test_adopt_release(self):
        self.assertEqual(self.req("POST", "/api/sites/ghost.com/adopt")[0], 404)
        sd = self.root / "sites" / "a.com"
        self.assertEqual(self.req("POST", "/api/sites/a.com/adopt")[0], 409)  # overlays missing -> refuse
        self.assertNotIn("a.com", self.req("GET", "/api/status")[1]["adopted_sites"])
        (sd / ".env.shared").write_text("K=v\n"); (sd / ".monorepo-tools").mkdir(exist_ok=True)
        (sd / ".monorepo-tools" / "x").write_text("1")
        self.docker_calls.clear()
        r = self.req("POST", "/api/sites/a.com/adopt")
        self.assertEqual(r[1]["adopted"], True)
        self.assertEqual([c[0] for c in self.docker_calls], ["ps", "stop", "ps", "rm"])
        st = self.req("GET", "/api/status")[1]
        self.assertIn("a.com", st["adopted_sites"]); self.assertGreater(st["scheduled"], 0)
        self.assertTrue((self.root / "adopted" / "a.com").exists())
        self.assertEqual(self.req("POST", "/api/sites/a.com/release")[1]["adopted"], False)
        self.assertEqual(self.req("GET", "/api/status")[1]["scheduled"], 0)
        self.assertFalse((self.root / "adopted" / "a.com").exists())

    def test_body_limits_and_garbage(self):
        self.assertEqual(self.req("POST", "/api/jobs", raw=b"x" * 70000)[0], 413)
        self.assertEqual(self.req("POST", "/api/jobs", raw=b"{not json")[0], 400)
        self.assertEqual(self.req("POST", "/api/jobs", raw=b"[1,2]")[0], 400)
        self.assertEqual(self.req("GET", "/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
