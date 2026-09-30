"""Every relative link in a registered skill's markdown points at a file that exists."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r"\]\(([^)\s]+)\)")


def relative_links(md: Path):
    text = re.sub(r"```.*?```", "", md.read_text(), flags=re.S)
    for target in LINK.findall(text):
        if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
            continue
        if "/" not in target and "." not in target:
            continue  # a template placeholder, e.g. [PR #123](url)
        yield target.split("#", 1)[0]


class SkillLinks(unittest.TestCase):
    def test_relative_links_resolve(self):
        skills = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())["skills"]
        broken = []
        for skill in skills:
            for md in sorted((ROOT / skill).rglob("*.md")):
                for target in relative_links(md):
                    if target and not (md.parent / target).exists():
                        broken.append(f"{md.relative_to(ROOT)} -> {target}")
        self.assertEqual(broken, [], "broken links:\n" + "\n".join(broken))


if __name__ == "__main__":
    unittest.main()
