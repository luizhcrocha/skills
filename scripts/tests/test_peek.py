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

    def test_a_mermaid_block_arrives_drawn_and_a_broken_one_stays_code(self):
        self.tool("pandoc")
        mmdr = self.bin_dir / "mmdr"
        mmdr.write_text(
            "#!/bin/sh\n"
            "grep -q broken && exit 1\n"
            "echo '<svg class=\"drawn\"></svg>'\n")
        mmdr.chmod(0o755)
        (self.bin_dir / "sh").symlink_to(shutil.which("sh"))
        (self.bin_dir / "grep").symlink_to(shutil.which("grep"))
        self.doc.write_text("# Model\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nbroken\n```\n")
        [url] = self.peek(str(self.doc))
        status, kind, body = self.get(url)
        self.assertEqual(status, 200)
        self.assertIn(b'<svg class="drawn">', body)
        self.assertIn(b'<pre class="mermaid" hidden>flowchart LR\n  A --&gt; B\n</pre>', body)
        self.assertIn(b'<pre class="mermaid">broken\n</pre>', body)
        self.assertIn(b"mermaid.esm.min.mjs", body)

    def tool(self, *names):
        for name in names:
            found = shutil.which(name)
            if found:
                if not (self.bin_dir / name).exists():
                    (self.bin_dir / name).symlink_to(found)
                return found
        self.skipTest(f"{names[0]} is not installed")

    def office_file(self, source, ext):
        office = self.tool("soffice", "libreoffice")
        out = Path(self.tmp.name)
        subprocess.run([office, "--headless", f"-env:UserInstallation={(out / 'profile').as_uri()}",
                        "--convert-to", ext, "--outdir", str(out), str(source)],
                       capture_output=True, timeout=120, check=True)
        return out / f"{source.stem}.{ext}"

    def test_a_docx_arrives_as_html_and_follows_edits(self):
        pandoc = self.tool("pandoc")
        docx = Path(self.tmp.name) / "contrato.docx"
        subprocess.run([pandoc, str(self.doc), "-o", str(docx)], check=True)
        self.tool("soffice", "libreoffice")
        [url] = self.peek(str(docx))
        self.assertTrue(url.endswith("contrato.docx.html"), url)
        status, kind, body = self.get(url)
        self.assertEqual((status, kind), (200, "text/html; charset=utf-8"))
        self.assertIn(b"<table", body)
        cache = Path(self.env["XDG_STATE_HOME"]) / "tstack/peek/cache"
        self.assertEqual(self.get(url)[2], body)
        self.assertEqual(len(list(cache.iterdir())), 1)
        self.doc.write_text("# Other\n\nchanged clause\n")
        subprocess.run([pandoc, str(self.doc), "-o", str(docx)], check=True)
        self.assertIn(b"changed clause", self.get(url)[2])
        self.assertEqual(len(list(cache.iterdir())), 1)

    def test_a_docx_falls_back_to_html_without_libreoffice(self):
        pandoc = shutil.which("pandoc")
        if not pandoc:
            self.skipTest("pandoc is not installed")
        docx = Path(self.tmp.name) / "contrato.docx"
        subprocess.run([pandoc, str(self.doc), "-o", str(docx)], check=True)
        (self.bin_dir / "pandoc").symlink_to(pandoc)
        [url] = self.peek(str(docx))
        status, kind, body = self.get(url)
        self.assertEqual(status, 200)
        self.assertTrue(kind.startswith("text/html"), kind)
        self.assertIn(b"<table", body)

    def test_spreadsheets_arrive_as_html_tables(self):
        csv = Path(self.tmp.name) / "planilha.csv"
        csv.write_text("nome,valor\nA\u00e7\u00e3o,20\n")
        for ext in ("xlsx", "xls"):
            sheet = self.office_file(csv, ext)
            [url] = self.peek(str(sheet))
            self.assertTrue(url.endswith(f".{ext}.html"), url)
            status, kind, body = self.get(url)
            self.assertEqual(status, 200, ext)
            self.assertTrue(kind.startswith("text/html"), kind)
            self.assertIn(b"<table", body)
            self.assertIn("A\u00e7\u00e3o".encode(), body)

    def test_without_converters_office_files_go_out_typed(self):
        for name, kind in (("Contrato de M\u00fatuo.docx", "wordprocessingml.document"),
                           ("planilha.xlsx", "spreadsheetml.sheet"),
                           ("planilha.xls", "application/vnd.ms-excel")):
            office = Path(self.tmp.name) / name
            office.write_bytes(b"PK\x03\x04 original bytes")
            [url] = self.peek(str(office))
            with urllib.request.urlopen(url, timeout=5) as r:
                self.assertIn(kind, r.headers["Content-Type"], name)
                self.assertTrue(r.headers["Content-Disposition"].startswith("inline;"), name)
                self.assertEqual(r.read(), b"PK\x03\x04 original bytes")

    def test_only_peeked_files_are_served(self):
        [url] = self.peek(str(self.doc))
        base = url.rsplit("/", 2)[0]
        entry = url.rsplit("/", 2)[1]
        for path in (f"{entry}/..%2f..%2f..%2fsecret.txt", f"{entry}/secret.txt", "secret.txt", ""):
            self.assertEqual(self.get(f"{base}/{path}")[0], 404, path)


if __name__ == "__main__":
    unittest.main()
