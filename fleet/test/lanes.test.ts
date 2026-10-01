/**
 * Lane entries and whether two meet (L7): the intersection the automata decide, checked against matching
 * every path of a small alphabet one by one with the regular expression.
 */
import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { laneMatches, lanesMeet, laneWitness } from "../src/ledger/lanes.ts";

/** Every path over `a`, `b`, `c` and `/` up to five characters. */
const PATHS: readonly string[] = (() => {
  const out: string[] = [];
  let level = [""];

  for (let n = 0; n < 5; n += 1) {
    level = level.flatMap((p) => ["a", "b", "c", "/"].map((c) => p + c));
    out.push(...level);
  }

  return out;
})();

const piece = fc.constantFrom("a", "b", "c", "*", "?", "[ab]", "[!a]", "[a-c]", "{a,b}", "{b,c/a}");

const segment = fc.oneof(fc.constant("**"), fc.array(piece, { minLength: 1, maxLength: 3 }).map((p) => p.join("")));

const entry = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));

describe("lane entries", () => {
  test("a path covers itself and what is under it; `*` stays in its segment, `**` does not", () => {
    expect(laneMatches("src/a/b.ts", "src/")).toBe(true);
    expect(laneMatches("src/a/b.ts", "./src")).toBe(true);
    expect(laneMatches("srcx/a.ts", "src")).toBe(false);
    expect(laneMatches("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(laneMatches("src/b.ts", "src/*.ts")).toBe(true);
    expect(laneMatches("src/a/b.ts", "src/**")).toBe(true);
    expect(laneMatches("src/x.ts", "src/**/x.ts")).toBe(true);
    expect(laneMatches("src/a/b/x.ts", "src/**/x.ts")).toBe(true);
    expect(laneMatches("docs/a.md", "**/*.md")).toBe(true);
    expect(laneMatches("src/b/x.ts", "src/{a,b}/*.ts")).toBe(true);
    expect(laneMatches("src/c/x.ts", "src/{a,b}/*.ts")).toBe(false);
  });

  test("the cases Luiz named", () => {
    expect(lanesMeet("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(lanesMeet("src/**", "src/a/b.ts")).toBe(true);
    expect(lanesMeet("src/x.ts", "src/*.ts")).toBe(true);
    expect(lanesMeet("src/billing/", "src/usage/**")).toBe(false);
    expect(lanesMeet("src/[a-c].ts", "src/[!ac].ts")).toBe(true);
    expect(lanesMeet("a*", "b*")).toBe(false);
  });

  test("two entries meet exactly when some path matches both (property, against every short path)", () => {
    fc.assert(
      fc.property(entry, entry, (a, b) => {
        const witness = laneWitness(a, b);

        if (witness !== undefined) return laneMatches(witness, a) && laneMatches(witness, b);

        return !PATHS.some((p) => laneMatches(p, a) && laneMatches(p, b));
      }),
      { numRuns: 400 },
    );
  });

  test("an entry always meets itself, and meeting is symmetric (property)", () => {
    fc.assert(
      fc.property(entry, entry, (a, b) => lanesMeet(a, a) && lanesMeet(a, b) === lanesMeet(b, a)),
      { numRuns: 300 },
    );
  });
});
