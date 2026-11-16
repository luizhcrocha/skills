import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

PEEK = Path(__file__).resolve().parents[1] / "peek"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class PeekTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (bin_dir / "python3").symlink_to(sys.executable)
        self.bin_dir = bin_dir
        self.env = {
            **os.environ,
            "XDG_STATE_HOME": str(root / "state"),
            "TSTACK_PEEK_PORT": str(free_port()),
            "PATH": str(bin_dir),
        }
        self.doc = root / "notes.md"
        self.doc.write_text("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")
        self.secret = root / "secret.txt"
        self.secret.write_text("never served")

    def tearDown(self):
        self.peek("stop")

    def peek(self, *args):
        run = subprocess.run([sys.executable, str(PEEK), *args], env=self.env,
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.stderr = run.stderr
        return run.stdout.split()

    def get(self, url):
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                return r.status, r.headers["Content-Type"], r.read()
        except urllib.error.HTTPError as e:
            return e.code, None, b""

    def test_a_peeked_file_keeps_its_url_and_serves_its_current_content(self):
        [url] = self.peek(str(self.doc))
        self.assertTrue(url.startswith(f"http://127.0.0.1:{self.env['TSTACK_PEEK_PORT']}/"), url)
        self.assertEqual(self.peek(str(self.doc)), [url])
        self.doc.write_text("changed after peek\n")
        status, kind, body = self.get(url)
        self.assertEqual(status, 200)
        self.assertTrue(kind.startswith("text/html"), kind)
        self.assertIn(b"changed after peek", body)

    def test_without_a_tailnet_route_peek_says_the_url_is_local(self):
        self.peek(str(self.doc))
        self.assertIn("only on this machine", self.stderr)

    def test_markdown_renders_without_pulling_in_unpeeked_files(self):
        pandoc = shutil.which("pandoc")
        if not pandoc:
            self.skipTest("pandoc is not installed")
        (self.bin_dir / "pandoc").symlink_to(pandoc)
        self.doc.write_text("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![x](secret.txt)\n")
        [url] = self.peek(str(self.doc))
        status, kind, body = self.get(url)
        self.assertEqual(status, 200)
        self.assertIn(b"<table", body)
        self.assertNotIn(b"never served", body)
        self.assertNotIn(b"bmV2ZXIgc2VydmVk", body)
        self.assertNotIn(b"never%20served", body)

    def test_only_peeked_files_are_served(self):
        [url] = self.peek(str(self.doc))
        base = url.rsplit("/", 2)[0]
        entry = url.rsplit("/", 2)[1]
        for path in (f"{entry}/..%2f..%2f..%2fsecret.txt", f"{entry}/secret.txt", "secret.txt", ""):
            self.assertEqual(self.get(f"{base}/{path}")[0], 404, path)


if __name__ == "__main__":
    unittest.main()
