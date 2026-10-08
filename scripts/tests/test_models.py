"""Every model a skill or agent names comes with an effort, and the pair is a row of MODELS.md's table.

MODELS.md (skills/productivity/coordinator/) is the one place the (model, effort) pairs are written.
This reads the pairs from its table, then checks two things against them:
- an agent definition's frontmatter (`model:` and `effort:`), and any other markdown frontmatter
  that names a model;
- every `model: "<x>"` in skills/ and agents/ markdown, which must read `model: "<x>", effort: "<y>"`.

Spawn sentences that still name a model without an effort are counted per file in BARE_ALLOWED.
The roles rollout's lane B adds the effort (or replaces the model with a role name) and lowers the
count; a file over its count fails with file:line, and a file under it fails until the count is lowered.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "skills" / "productivity" / "coordinator" / "MODELS.md"
PAIR = re.compile(r"\b(Fable|Opus|Sonnet|Haiku) (low|medium|high|xhigh|max)\b")
SPAWN = re.compile(r'model: "([a-z]+)"(?:,\s*effort: "([a-z]+)")?')

# file -> bare `model: "<x>"` mentions left for lane B. Empty when every spawn sentence names its effort.
BARE_ALLOWED = {
    "skills/engineering/arena/SKILL.md": 3,
    "skills/engineering/how/SKILL.md": 3,
    "skills/engineering/improve-animations/SKILL.md": 1,
    "skills/engineering/interrogate/SKILL.md": 3,
    "skills/engineering/lang-refresh/SKILL.md": 1,
    "skills/engineering/maintain-verification-skill/SKILL.md": 1,
    "skills/engineering/review/SKILL.md": 1,
    "skills/engineering/why/SKILL.md": 3,
    "skills/productivity/automate-me/SKILL.md": 1,
    "skills/productivity/coordinator/SKILL.md": 2,
    "skills/productivity/coordinator/assets/brief.md": 1,
    "skills/productivity/recall/SKILL.md": 1,
    "skills/productivity/reflect/SKILL.md": 1,
    "skills/productivity/show-me-your-work/SKILL.md": 2,
}


def table_rows():
    """MODELS.md's role table: role -> the pairs its row names, primary first."""
    rows = {}
    lines = MODELS.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("| Role |"))
    for line in lines[start + 2:]:
        if not line.startswith("|"):
            break
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows[cells[0]] = [(m.lower(), e) for m, e in PAIR.findall(" | ".join(cells[1:]))]
    return rows


def table_pairs():
    return {pair for pairs in table_rows().values() for pair in pairs}


def markdown_files():
    for top in ("skills", "agents"):
        yield from sorted((ROOT / top).rglob("*.md"))


def frontmatter(md: Path) -> dict[str, tuple[int, str]]:
    """The frontmatter's top-level keys -> (line number, value); empty without frontmatter."""
    lines = md.read_text().splitlines()
    if not lines or lines[0] != "---":
        return {}
    keys = {}
    for n, line in enumerate(lines[1:], start=2):
        if line == "---":
            return keys
        m = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
        if m:
            keys[m.group(1)] = (n, m.group(2).strip())
    return {}


def spawns(md: Path):
    """(line number, model, effort or None) for every `model: "<x>"` in the file."""
    for n, line in enumerate(md.read_text().splitlines(), start=1):
        for m in SPAWN.finditer(line):
            yield n, m.group(1), m.group(2)


def rel(md: Path) -> str:
    return md.relative_to(ROOT).as_posix()


class ModelsTable(unittest.TestCase):
    def test_every_role_has_a_pair_and_a_fallback(self):
        rows = table_rows()
        self.assertGreaterEqual(len(rows), 10, rows)
        thin = [role for role, pairs in rows.items() if len(pairs) < 2]
        self.assertEqual(thin, [], "roles without a model, effort and fallback pair in MODELS.md")

    def test_no_role_runs_at_max(self):
        self.assertNotIn("max", {effort for _, effort in table_pairs()})


class NamedPairs(unittest.TestCase):
    def test_frontmatter_names_an_effort_from_the_table(self):
        pairs, bad = table_pairs(), []
        for md in markdown_files():
            keys = frontmatter(md)
            if "model" not in keys:
                continue
            n, model = keys["model"]
            if "effort" not in keys:
                bad.append(f"{rel(md)}:{n}: model {model} names no effort")
            elif (model, keys["effort"][1]) not in pairs:
                bad.append(f"{rel(md)}:{keys['effort'][0]}: ({model}, {keys['effort'][1]}) is not in MODELS.md's table")
        self.assertEqual(bad, [], "\n".join(bad))

    def test_every_named_pair_is_in_the_table(self):
        pairs, bad = table_pairs(), []
        for md in markdown_files():
            for n, model, effort in spawns(md):
                if effort and (model, effort) not in pairs:
                    bad.append(f'{rel(md)}:{n}: model: "{model}", effort: "{effort}" is not in MODELS.md\'s table')
        self.assertEqual(bad, [], "\n".join(bad))

    def test_a_model_without_an_effort_is_only_where_lane_b_has_not_been(self):
        found: dict[str, list[int]] = {}
        for md in markdown_files():
            for n, model, effort in spawns(md):
                if effort is None:
                    found.setdefault(rel(md), []).append(n)
        over = [f"{path}:{n}: model named without an effort" for path, lines in found.items()
                if len(lines) > BARE_ALLOWED.get(path, 0) for n in lines]
        under = [f"{path}: {BARE_ALLOWED[path]} allowed, {len(found.get(path, []))} left; lower BARE_ALLOWED"
                 for path in BARE_ALLOWED if len(found.get(path, [])) < BARE_ALLOWED[path]]
        self.assertEqual(over + under, [], "\n".join(over + under))


if __name__ == "__main__":
    unittest.main()
