"""serve_dashboard.py DIR [--restart | --stop], driven through its CLI with a fake `tailscale` named by $TAILSCALE."""
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SERVE = str(Path(__file__).resolve().parent.parent / "scripts" / "serve_dashboard.py")

FAKE_TAILSCALE = """#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "calls.log"), "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["status", "--json"]:
    print(json.dumps({"BackendState": "Running",
                      "Self": {"DNSName": "box.tail.ts.net.", "TailscaleIPs": ["127.0.0.1"], "UserID": 7},
                      "User": {"7": {"LoginName": "luiz@example.com"}}}))
elif sys.argv[1] == "serve" and os.path.exists(os.path.join(here, "refuse-serve")):
    sys.exit("serve refused")
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


class ServeCliTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.bin, self.root = base / "bin", base / "dash"
        self.bin.mkdir()
        self.root.mkdir()
        fake = self.bin / "tailscale"
        fake.write_text(FAKE_TAILSCALE)
        fake.chmod(0o755)
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(self.kill_recorded)

    def serve(self, *flags: str, env: dict | None = None) -> subprocess.CompletedProcess:
        env = {**os.environ, "TAILSCALE": str(self.bin / "tailscale"), **(env or {})}
        return subprocess.run([sys.executable, SERVE, str(self.root), *flags], capture_output=True, text=True,
                              env=env, timeout=30)

    def record(self) -> dict:
        return json.loads((self.root / "server.json").read_text())

    def write_record(self, **fields) -> None:
        (self.root / "server.json").write_text(json.dumps(fields))

    def calls(self) -> list[str]:
        path = self.bin / "calls.log"
        return path.read_text().splitlines() if path.exists() else []

    def kill_recorded(self):
        try:
            os.kill(self.record()["pid"], signal.SIGTERM)
        except (OSError, ValueError, KeyError):
            pass

    def assert_serving(self, port: int):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.05)
        self.fail(f"nothing serves port {port}")

    def test_restart_keeps_the_url_with_a_new_worker_and_reserves_the_port(self):
        first = self.serve()
        self.assertEqual(first.returncode, 0, first.stderr)
        before = self.record()
        self.assert_serving(before["port"])
        again = self.serve("--restart")
        self.assertEqual(again.returncode, 0, again.stderr)
        after = self.record()
        self.assertEqual(again.stdout, first.stdout)
        self.assertEqual(first.stdout.strip(), f"https://box.tail.ts.net:{before['port']}/")
        self.assertNotEqual(after["pid"], before["pid"])
        self.assertEqual((after["port"], after["tls"], after["post"]), (before["port"], True, "login:luiz@example.com"))
        self.assert_serving(after["port"])
        serves = [c for c in self.calls() if c.startswith("serve --bg")]
        self.assertEqual(serves, [f"serve --bg --https={before['port']} http://127.0.0.1:{before['port']}"] * 2)

    def test_the_worker_answers_to_the_url_host_and_to_127_0_0_1(self):
        self.assertEqual(self.serve().returncode, 0)
        port = self.record()["port"]
        for host, expected in [(f"box.tail.ts.net:{port}", 200), (f"127.0.0.1:{port}", 200), (f"evil.com:{port}", 421)]:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/chat", headers={"Host": host})
            self.assertEqual(conn.getresponse().status, expected, host)
            conn.close()

    def test_restart_without_a_record_is_a_plain_start(self):
        result = self.serve("--restart")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.record()["url"])
        self.assert_serving(self.record()["port"])

    def test_a_start_over_a_dead_record_prefers_its_port(self):
        port = free_port()
        self.write_record(pid=dead_pid(), port=port, url=f"https://box.tail.ts.net:{port}/", tls=True)
        result = self.serve()
        self.assertEqual(result.stdout.strip(), f"https://box.tail.ts.net:{port}/")
        self.assertEqual(self.record()["post"], "login:luiz@example.com")
        self.assert_serving(port)

    def test_a_plain_http_record_restarts_as_plain_http_with_the_chat_closed(self):
        port = free_port()
        self.write_record(pid=dead_pid(), port=port, url=f"http://box.tail.ts.net:{port}/", tls=False)
        result = self.serve("--restart")
        self.assertEqual(result.stdout.strip(), f"http://box.tail.ts.net:{port}/")
        self.assertEqual((self.record()["tls"], self.record()["post"]), (False, "closed"))
        self.assertFalse([c for c in self.calls() if c.startswith("serve --bg")])

    def test_a_taken_port_moves_the_server_and_warns(self):
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen()
            port = holder.getsockname()[1]
            self.write_record(pid=dead_pid(), port=port, url=f"https://box.tail.ts.net:{port}/", tls=True)
            result = self.serve("--restart")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(self.record()["port"], port)
        self.assertEqual(result.stdout.strip(), self.record()["url"])
        self.assertIn("address changed", result.stderr)
        self.assertIn(f"serve --https={port} off", self.calls())

    def test_a_record_from_the_previous_version_restarts_and_stops(self):
        self.assertEqual(self.serve().returncode, 0)
        old = self.record()
        del old["post"]
        self.write_record(**old)
        self.assertEqual(self.serve("--restart").stdout.strip(), old["url"])
        del_post = self.record()
        del del_post["post"]
        self.write_record(**del_post)
        stopped = self.serve("--stop")
        self.assertEqual((stopped.returncode, stopped.stdout.strip()), (0, f"stopped {old['url']}"))
        self.assertFalse((self.root / "server.json").exists())

    def test_a_request_right_after_the_command_returns_is_served(self):
        for flags in [(), ("--restart",)]:
            self.assertEqual(self.serve(*flags).returncode, 0)
            conn = http.client.HTTPConnection("127.0.0.1", self.record()["port"], timeout=5)
            conn.request("GET", "/chat")
            self.assertEqual(conn.getresponse().status, 200)
            conn.close()

    def test_a_worker_that_cannot_start_fails_with_its_log_and_leaves_no_record(self):
        port = free_port()
        self.write_record(pid=dead_pid(), port=port, url=f"https://box.tail.ts.net:{port}/", tls=True)
        broken = self.bin / "broken"
        (broken / "http").mkdir(parents=True)
        (broken / "http" / "__init__.py").write_text("raise SystemExit('worker boom')\n")
        result = self.serve(env={"PYTHONPATH": str(broken)})
        self.assertEqual(result.returncode, 1)
        self.assertIn("worker boom", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse((self.root / "server.json").exists())


if __name__ == "__main__":
    unittest.main()
