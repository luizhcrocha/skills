"""served.py: which fleet a server the machine serves belongs to."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
os.environ["FLEET_HOME"] = tempfile.mkdtemp(prefix="fleet-home-")
import served  # noqa: E402


class MentionedByTest(unittest.TestCase):
    def setUp(self):
        self.config = Path(tempfile.mkdtemp(prefix="claude-"))
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.config)
        self.addCleanup(os.environ.pop, "CLAUDE_CONFIG_DIR", None)
        served._said.clear()

    def fleet(self, fid: str, sid: str, lines: list[tuple[str, str]], role: str = "coordinator") -> dict:
        path = self.config / "projects" / "-home-x" / f"{sid}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps({"timestamp": at, "text": text}) + "\n" for at, text in lines))
        return {"id": fid, "role": role, "dir": f"/tmp/x/-home-x/{sid}/scratchpad/coordinator"}

    def test_the_first_to_write_the_address_started_it(self):
        infra = self.fleet("infra", "s1", [("2026-09-29T10:00:00Z", "serving on https://box.ts.net:5555/")])
        manager = self.fleet("manager", "s2", [("2026-09-29T09:00:00Z", "port 5555 is busy"),
                                               ("2026-09-29T11:00:00Z", "infra's review: https://box.ts.net:5555/")], role="manager")
        ui = self.fleet("ui", "s3", [("2026-09-29T12:00:00Z", "see 127.0.0.1:5555")])
        self.assertEqual(served.mentioned_by(5555, 42, [manager, ui, infra]), "infra", "a bare port number is not an address")
        self.assertIsNone(served.mentioned_by(6666, 43, [manager, ui, infra]))

    def test_unlisted_leaves_out_what_a_link_names(self):
        import fleets
        found = [{"port": 1, "url": "https://b.ts.net:1/"}, {"port": 2, "url": "https://b.ts.net:2/"}]
        self.assertEqual(fleets._unlisted(found, [{"url": "https://b.ts.net:2/x"}]), [found[0]])


if __name__ == "__main__":
    unittest.main()
