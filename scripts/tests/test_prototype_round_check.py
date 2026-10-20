"""Tests for the prototype skill's round-check.mjs. A page's URL reaches the browser whole, query and every "="
in it included. Each load sees its own width and color scheme. A load fails when its page never shows, throws,
or a --check is false. A run fails with a summary when the browser dies or a page hangs, removes its browser
profile, also when it is stopped by a signal or a helper of a dead browser outlives it, takes its Chromium with it
when killed outright, runs under a $TMPDIR too deep for Chromium's socket path, and refuses a Chromium that does not
run. The browser tests run a local HTTP server and the machine's Chromium; without Node or Chromium they skip and
say so; the tests that read /proc run on Linux only.

Run: just test-scripts  (or python3 -m unittest scripts.tests.test_prototype_round_check)
"""

import fcntl
import json
import os
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "skills" / "engineering" / "prototype" / "scripts" / "round-check.mjs"
NODE = shutil.which("node")
CHROMIUM = next((p for p in map(shutil.which, ("chromium", "chromium-browser", "google-chrome")) if p), None)
QUERY = "/processos?l=123&x=a=b"
LINUX = sys.platform == "linux"

PAGE = b"""<!doctype html><meta charset="utf-8"><title>t</title>
<main id="where"></main>
<script>document.getElementById("where").textContent = location.pathname + location.search;</script>"""

SEES = b"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>t</title>
<main id="where"></main>
<script>document.getElementById("where").textContent =
  innerWidth + " " + (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");</script>"""

THROWS = b"""<!doctype html><meta charset="utf-8"><title>t</title>
<main id="where">here</main>
<script>throw new Error("the page broke");</script>"""

BUSY = b"""<!doctype html><meta charset="utf-8"><title>t</title><main id="where">here</main>
<script>setTimeout(() => { for (;;) {} }, 0);</script>"""


def run(*args, env=None):
    return subprocess.run([NODE, str(SCRIPT), *args], capture_output=True, text=True, timeout=120, env=env)


def running(pid):
    """Whether `pid` is a process that has not exited (a zombie has)."""
    try:
        return "zombie" not in Path(f"/proc/{pid}/status").read_text().lower()
    except FileNotFoundError:
        return False


@unittest.skipUnless(NODE, "no node on PATH")
class Plan(unittest.TestCase):
    def test_a_url_with_equals_in_its_query_stays_whole(self):
        url = f"http://127.0.0.1:9{QUERY}"
        done = run("--plan", "--page", url, "--scheme", "light,dark", "--width", "1440,390")
        self.assertEqual(done.returncode, 0, done.stderr)
        loads = json.loads(done.stdout)
        self.assertEqual([load["url"] for load in loads], [url] * 4)
        self.assertEqual({(load["scheme"], load["width"]) for load in loads},
                         {("light", 1440), ("light", 390), ("dark", 1440), ("dark", 390)})

    def test_the_default_is_one_scheme_at_one_width(self):
        done = run("--plan", "--page", "http://127.0.0.1:9/a", "--page", "http://127.0.0.1:9/b")
        self.assertEqual([(load["scheme"], load["width"]) for load in json.loads(done.stdout)],
                         [("light", 1440), ("light", 1440)])

    def test_a_bare_path_is_refused(self):
        done = run("--plan", "--page", QUERY)
        self.assertEqual(done.returncode, 2)
        self.assertIn("full URL", done.stderr)


@unittest.skipUnless(NODE, "no node on PATH")
class NoChromium(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def test_a_chromium_path_that_does_not_run_is_refused(self):
        done = run("--out", str(self.dir / "out"), "--page", "http://127.0.0.1:9/a", "--chromium", str(self.dir / "none"))
        self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
        self.assertIn(f"--chromium {self.dir / 'none'} does not run", done.stderr)
        self.assertNotIn("usage:", done.stderr)

    def test_no_chromium_anywhere_is_not_a_usage_error(self):
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        (bin_dir / "node").symlink_to(NODE)
        env = {"PATH": str(bin_dir), "HOME": str(self.dir)}
        done = run("--out", str(self.dir / "out"), "--page", "http://127.0.0.1:9/a", env=env)
        self.assertEqual(done.returncode, 3, done.stdout + done.stderr)
        self.assertIn("no Chromium found", done.stderr)
        self.assertNotIn("usage:", done.stderr)


@unittest.skipUnless(NODE and CHROMIUM, "no node or Chromium on PATH")
class Browser(unittest.TestCase):
    def setUp(self):
        self.seen = []
        seen = self.seen
        release = threading.Event()
        self.addCleanup(release.set)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name) / "out"
        self.tmpdir = Path(tmp.name) / "tmp"
        self.tmpdir.mkdir()
        pidfile = Path(tmp.name) / "chromium.pid"
        self.pidfile = pidfile
        self.argsfile = Path(tmp.name) / "chromium.args"
        self.chromium = Path(tmp.name) / "chromium"
        self.chromium.write_text(f'#!/bin/sh\necho $$ > "{pidfile}"\nprintf \'%s\\n\' "$@" >> "{self.argsfile}"\n'
                                 f'exec "{CHROMIUM}" "$@"\n')
        self.chromium.chmod(0o755)
        pages = {"/processos": PAGE, "/sees": SEES, "/throws": THROWS, "/busy": BUSY}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                path = self.path.split("?")[0]
                if path == "/die":
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                if path in ("/die", "/hang"):
                    release.wait(60)
                    return
                body = pages.get(path)
                self.send_response(200 if body else 404)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(body or b"no")

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.env = {**os.environ, "TMPDIR": str(self.tmpdir)}

    def check(self, *args):
        return run("--out", str(self.out), "--chromium", str(self.chromium), *args, env=self.env)

    def summary(self):
        return (self.out / "summary.txt").read_text().splitlines()

    def profiles(self):
        """The profiles the run gave Chromium, read from the command lines it started Chromium with."""
        if not self.argsfile.exists():
            return []
        flag = "--user-data-dir="
        return [Path(a[len(flag):]) for a in self.argsfile.read_text().splitlines() if a.startswith(flag)]

    def profiles_left(self):
        return sorted({*map(str, self.tmpdir.glob("round-check-*")), *(str(p) for p in self.profiles() if p.exists())})

    def test_the_query_reaches_the_browser_intact(self):
        done = self.check("--page", self.base + QUERY, "--wait", "#where", "--criteria", "#where",
                          "--check", "document.querySelector('#where').textContent.endsWith('x=a=b')",
                          "--scheme", "light,dark")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn(QUERY, self.seen)
        lines = self.summary()
        self.assertEqual(len(lines), 2)
        for line, scheme in zip(lines, ("light", "dark")):
            self.assertTrue(line.startswith(f"PASS {QUERY} {scheme} 1440 errors=0 shot="), line)
            self.assertIn(f'criteria="{QUERY}"', line)
            shot = line.split(" shot=")[1].split(" ")[0]
            self.assertGreater(Path(shot).stat().st_size, 0)
        self.assertEqual(self.profiles_left(), [])

    def test_each_load_sees_its_own_width_and_scheme(self):
        done = self.check("--page", self.base + "/sees", "--wait", "#where", "--criteria", "#where",
                          "--scheme", "light,dark", "--width", "1440,390")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        got = [(line.split(" ")[2], line.split(" ")[3], line.split("criteria=")[1]) for line in self.summary()]
        self.assertEqual(got, [("light", "1440", '"1440 light"'), ("light", "390", '"390 light"'),
                               ("dark", "1440", '"1440 dark"'), ("dark", "390", '"390 dark"')])

    def test_a_page_that_never_shows_fails(self):
        done = self.check("--page", self.base + "/elsewhere", "--wait", "#where", "--timeout", "3")
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        [line] = self.summary()
        self.assertTrue(line.startswith("FAIL /elsewhere light 1440"), line)
        self.assertIn("HTTP 404", line)
        self.assertIn("#where not found", line)

    def test_a_false_check_fails(self):
        done = self.check("--page", self.base + QUERY, "--wait", "#where", "--check", "1 + 1 === 3")
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        [line] = self.summary()
        self.assertTrue(line.startswith(f"FAIL {QUERY} light 1440 errors=0"), line)
        self.assertIn("check false: 1 + 1 === 3", line)

    def test_a_page_that_throws_fails(self):
        done = self.check("--page", self.base + "/throws", "--wait", "#where")
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        [line] = self.summary()
        self.assertTrue(line.startswith("FAIL /throws light 1440 errors=1"), line)
        self.assertIn("page error: Error: the page broke", line)

    def test_a_server_that_never_answers_fails_within_the_timeout(self):
        started = time.monotonic()
        done = self.check("--page", self.base + "/hang", "--timeout", "3")
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        [line] = self.summary()
        self.assertTrue(line.startswith("FAIL "), line)
        self.assertIn("no answer to Page.navigate", line)
        self.assertEqual(self.profiles_left(), [])

    def test_a_busy_page_fails_within_the_timeout(self):
        started = time.monotonic()
        done = self.check("--page", self.base + "/busy", "--wait", "#where", "--timeout", "3")
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        [line] = self.summary()
        self.assertTrue(line.startswith("FAIL "), line)
        self.assertIn("no answer to Runtime.evaluate", line)

    def test_a_browser_that_dies_fails_the_run_with_a_summary(self):
        done = self.check("--page", self.base + "/die", "--page", self.base + QUERY, "--jobs", "1", "--timeout", "10")
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        lines = self.summary()
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertTrue(line.startswith("FAIL "), line)
            self.assertIn("Chromium exited", line)
        self.assertIn("0/2 loads pass", done.stdout)
        self.assertEqual(self.profiles_left(), [])

    @unittest.skipUnless(LINUX, "running() reads /proc")
    def test_a_helper_that_outlives_a_dead_browser_does_not_bring_its_profile_back(self):
        """Chromium's zygote, forked just before the browser is killed, outlives it by about 100 ms and creates
        --user-data-dir again on its way out. The helper here does the same, 100 ms after the browser is gone."""
        helper_pid = self.pidfile.parent / "helper.pid"
        lingers = self.pidfile.parent / "chromium-with-a-helper"
        lingers.write_text(
            '#!/bin/sh\nfor a; do case "$a" in --user-data-dir=*) profile="${a#--user-data-dir=}";; esac; done\n'
            'if [ -n "$profile" ]; then\n'
            '  (while kill -0 $$ 2>/dev/null; do sleep 0.01; done; sleep 0.1; mkdir "$profile") \\\n'
            '    </dev/null >/dev/null 2>&1 &\n'
            f'  echo $! > "{helper_pid}"\nfi\nexec "{self.chromium}" "$@"\n')
        lingers.chmod(0o755)
        done = run("--out", str(self.out), "--chromium", str(lingers), "--page", self.base + "/die", "--timeout", "10",
                   env=self.env)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        helper = int(helper_pid.read_text())
        self.addCleanup(lambda: running(helper) and os.kill(helper, signal.SIGKILL))
        deadline = time.monotonic() + 10
        while running(helper) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(running(helper))
        self.assertEqual(self.profiles_left(), [])

    def hanging_run(self, **stdio):
        """A run waiting on a page that never answers, and its browser's pid. `stdio` replaces the run's pipes."""
        stdio = stdio or {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True}
        proc = subprocess.Popen([NODE, str(SCRIPT), "--out", str(self.out), "--chromium", str(self.chromium),
                                 "--page", self.base + "/hang", "--timeout", "60"], env=self.env, **stdio)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.addCleanup(lambda: [os.kill(pid, signal.SIGKILL) for pid in self.chromiums_left()])
        deadline = time.monotonic() + 30
        while "/hang" not in self.seen and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertIn("/hang", self.seen)
        return proc, int(self.pidfile.read_text())

    def test_a_run_stopped_by_sigterm_closes_chromium_and_removes_its_profile(self):
        proc, browser = self.hanging_run()
        proc.send_signal(signal.SIGTERM)
        _, err = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 143, err)
        self.assertEqual(self.profiles_left(), [])
        self.assertFalse(running(browser))

    def test_a_run_whose_terminal_closes_closes_chromium_and_removes_its_profile(self):
        """The run's terminal is a pty, and its master closes: a hangup, after which a write to it fails (EIO)."""
        master, terminal = pty.openpty()
        try:
            proc, browser = self.hanging_run(stdin=terminal, stdout=terminal, stderr=terminal, start_new_session=True,
                                             preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        finally:
            os.close(terminal)
            os.close(master)
        proc.wait(timeout=20)
        self.assertEqual(proc.returncode, 129)
        self.assertEqual(self.profiles_left(), [])
        self.assertFalse(running(browser))

    @unittest.skipUnless(LINUX, "running() reads /proc")
    def test_a_run_killed_outright_takes_its_chromium_with_it(self):
        proc, browser = self.hanging_run()
        proc.kill()
        proc.communicate(timeout=20)
        deadline = time.monotonic() + 10
        while (running(browser) or self.chromiums_left()) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(running(browser))
        self.assertEqual(self.chromiums_left(), [])

    def chromiums_left(self):
        """The processes whose command line names this test's TMPDIR or a profile the run gave Chromium: the
        browser and its helpers."""
        pids = set()
        for path in (self.tmpdir, *self.profiles()):
            found = subprocess.run(["pgrep", "-f", str(path)], capture_output=True, text=True)
            pids.update(int(pid) for pid in found.stdout.split())
        return sorted(pids)

    def test_a_run_stopped_by_sigterm_while_chromium_starts_leaves_no_browser_and_no_profile(self):
        proc = subprocess.Popen([NODE, str(SCRIPT), "--out", str(self.out), "--chromium", str(self.chromium),
                                 "--page", self.base + QUERY],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.addCleanup(lambda: [os.kill(pid, signal.SIGKILL) for pid in self.chromiums_left()])
        deadline = time.monotonic() + 30
        while not self.profiles() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertNotEqual(self.profiles_left(), [], "the run started no Chromium with a profile")
        proc.send_signal(signal.SIGTERM)
        _, err = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 143, err)
        self.assertEqual(self.seen, [], "the signal came after the launch")
        self.assertEqual(self.profiles_left(), [])
        deadline = time.monotonic() + 5
        while self.chromiums_left() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(self.chromiums_left(), [])

    def test_a_tmpdir_too_deep_for_chromiums_socket_path_still_runs(self):
        deep = self.tmpdir / ("d" * 100)
        deep.mkdir()
        self.assertGreater(len(f"{deep}/org.chromium.Chromium.XXXXXX/SingletonSocket"), 107)
        done = run("--out", str(self.out), "--chromium", str(self.chromium), "--page", self.base + QUERY,
                   "--wait", "#where", env={**self.env, "TMPDIR": str(deep)})
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        [line] = self.summary()
        self.assertTrue(line.startswith(f"PASS {QUERY} light 1440 errors=0"), line)
        self.assertNotEqual(self.profiles(), [])
        self.assertEqual(self.profiles_left(), [])
        self.assertEqual(list(deep.iterdir()), [])
        deadline = time.monotonic() + 5
        while self.chromiums_left() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(self.chromiums_left(), [])


if __name__ == "__main__":
    unittest.main()
