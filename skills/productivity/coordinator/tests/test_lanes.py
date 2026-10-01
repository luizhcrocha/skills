"""Lane entries and whether two meet (L7): the intersection the automata decide, checked against matching
every short path one by one with the regular expression, over seeded random entries."""
import itertools
import os
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import lanes  # noqa: E402

PATHS = ["".join(p) for n in range(1, 6) for p in itertools.product("abc/", repeat=n)]
PIECES = ["a", "b", "c", "*", "?", "[ab]", "[!a]", "[a-c]", "{a,b}", "{b,c/a}"]


def entry(rng: random.Random) -> str:
    segments = ["**" if rng.random() < 0.2 else "".join(rng.choice(PIECES) for _ in range(rng.randint(1, 3)))
                for _ in range(rng.randint(1, 3))]
    return "/".join(segments)


class LanesTest(unittest.TestCase):
    def test_a_path_covers_what_is_under_it_and_a_star_stays_in_its_segment(self):
        self.assertTrue(lanes.matches("src/a/b.ts", "src/"))
        self.assertFalse(lanes.matches("srcx/a.ts", "src"))
        self.assertFalse(lanes.matches("src/a/b.ts", "src/*.ts"))
        self.assertTrue(lanes.matches("src/a/b.ts", "src/**"))
        self.assertTrue(lanes.matches("src/x.ts", "src/**/x.ts"))
        self.assertTrue(lanes.matches("src/b/x.ts", "src/{a,b}/*.ts"))

    def test_the_cases_luiz_named(self):
        self.assertFalse(lanes.meet("src/*.ts", "src/a/b.ts"))
        self.assertTrue(lanes.meet("src/**", "src/a/b.ts"))
        self.assertTrue(lanes.meet("src/x.ts", "src/*.ts"))
        self.assertFalse(lanes.meet("src/billing/", "src/usage/**"))
        self.assertTrue(lanes.meet("src/[a-c].ts", "src/[!ac].ts"))

    def test_two_entries_meet_exactly_when_some_path_matches_both(self):
        seed = int(os.environ.get("FLEET_LANES_SEED", random.randrange(1 << 30)))
        rng = random.Random(seed)
        for _ in range(int(os.environ.get("FLEET_LANES_RUNS", 300))):
            a, b = entry(rng), entry(rng)
            found = lanes.witness(a, b)
            if found is not None:
                self.assertTrue(lanes.matches(found, a) and lanes.matches(found, b), f"seed {seed}: {a!r} {b!r} -> {found!r}")
            else:
                hit = next((p for p in PATHS if lanes.matches(p, a) and lanes.matches(p, b)), None)
                self.assertIsNone(hit, f"seed {seed}: {a!r} and {b!r} both match {hit!r}, the automata said they do not meet")
            self.assertEqual(found is not None, lanes.meet(b, a), f"seed {seed}: {a!r} {b!r} is not symmetric")


if __name__ == "__main__":
    unittest.main()
