"""The machine's news (news.py): items that wake nobody, a cursor per fleet, and the one line that names them."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import news  # noqa: E402

NEWS = str(SCRIPTS / "news.py")
STATE = str(SCRIPTS / "state.py")
CHAT = str(SCRIPTS / "chat.py")


class NewsCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.home = self.tmp / "registry"
        self.home.mkdir()
        self.env = {**os.environ, "FLEET_HOME": str(self.home), "FLEET_DISCOVER": "0", "FLEET_NOW": "2026-01-05T09:00:00+00:00",
                    "TZ": "UTC", "FLEET_WATCH_SETTLE": "0"}
        old = os.environ.get("FLEET_HOME")
        os.environ["FLEET_HOME"] = str(self.home)
        self.addCleanup(lambda: os.environ.__setitem__("FLEET_HOME", old) if old else os.environ.pop("FLEET_HOME", None))

    def cli(self, *args):
        return subprocess.run([sys.executable, NEWS, *args], capture_output=True, text=True, env=self.env, timeout=20)

    def fleet(self, name):
        root = self.tmp / name
        subprocess.run([sys.executable, STATE, str(root), "init", "--project", name, "--goal", "g", "--no-render"],
                       capture_output=True, text=True, env=self.env, check=True)
        (self.home / f"{name}.json").write_text(json.dumps({"id": name, "role": "coordinator", "dir": str(root), "url": "u",
                                                            "pid": os.getpid(), "session": None, "since": "2026-01-05T08:00:00+00:00"}))
        return root


class PostAndReadTest(NewsCase):
    def test_cursors_are_per_fleet_and_a_reader_never_sees_its_own(self):
        self.assertEqual(self.cli("post", "--from", "skills", "--kind", "release", "1.9.20 is out").returncode, 0)
        self.assertEqual(self.cli("post", "--from", "pipeline", "--to", "infra", "schema moved").returncode, 0)
        self.assertEqual(self.cli("post", "--from", "skills", "--to", "pipeline", "--kind", "rule", "--keep", "gate slot first").returncode, 0)
        self.assertEqual([i["id"] for i in news.unread("pipeline")], [1, 3])
        self.assertEqual([i["id"] for i in news.unread("infra")], [1, 2])
        out = self.cli("read", "--as", "pipeline").stdout
        self.assertEqual(out, "#1 2026-01-05 09:00 skills -> all [release, do not save]: 1.9.20 is out\n"
                              "#3 2026-01-05 09:00 skills -> pipeline [rule, keep]: gate slot first\n")
        self.assertEqual(self.cli("read", "--as", "pipeline").stdout, "no news for pipeline\n")
        self.assertEqual([i["id"] for i in news.unread("infra")], [1, 2], "pipeline's read moved only its own cursor")
        self.assertEqual((self.home / "news" / "read" / "pipeline").read_text(), "3")
        self.cli("post", "--from", "infra", "--to", "pipeline,infra", "staging is back")
        self.assertEqual([i["id"] for i in news.unread("pipeline")], [4])
        self.assertEqual([i["id"] for i in news.unread("infra")], [1, 2], "its own item is not news to infra")

    def test_refusals_write_nothing(self):
        for args, why in ((["--to", "all,infra", "x"], "--to is `all` or a list of fleets"),
                          (["  "], "the item has no text"),
                          (["x" * (news.TEXT_MAX + 1)], f"at most {news.TEXT_MAX} characters")):
            out = self.cli("post", "--from", "skills", *args)
            self.assertEqual(out.returncode, 1, args)
            self.assertIn(why, out.stderr)
        self.assertFalse((self.home / "news" / "news.jsonl").exists())
        self.assertEqual(self.cli("post", "--from", "skills", "--kind", "act", "x").returncode, 2)


class UnreadLineTest(NewsCase):
    def test_state_commands_and_the_watch_name_unread_news(self):
        root = self.fleet("pipeline")
        show = lambda: subprocess.run([sys.executable, STATE, str(root), "show"], capture_output=True, text=True, env=self.env)
        self.assertEqual(show().stderr, "", "no news file: nothing")
        self.cli("post", "--from", "skills", "--to", "infra", "not for pipeline")
        self.assertEqual(show().stderr, "")
        self.cli("post", "--from", "skills", "1.9.20 is out")
        line = "news: 1 unread for pipeline, never a wake: `fleet news read --as pipeline`\n"
        self.assertEqual(show().stderr, line)
        with open(root / "chat.jsonl", "a") as f:
            f.write(json.dumps({"id": 1, "at": "2026-01-05T09:00:00+00:00", "from": "user", "to": ["coordinator"], "text": "hi", "re": None}) + "\n")
        out = subprocess.run([sys.executable, CHAT, str(root), "watch", "--as", "coordinator", "--all", "--resume", "--once"],
                             capture_output=True, text=True, env=self.env, timeout=20)
        self.assertEqual(out.stdout, "#1 user -> coordinator: hi\n" + line, "the news rides on the wake the chat makes")
        self.cli("read", "--as", "pipeline")
        self.assertIsNone(news.unread_line(root))
        self.assertEqual(show().stderr, "", "read: the line is gone")

    def test_a_fleet_the_registry_does_not_name_hears_nothing(self):
        self.cli("post", "--from", "skills", "for everyone")
        self.assertIsNone(news.unread_line(self.tmp / "nowhere"))


if __name__ == "__main__":
    unittest.main()
