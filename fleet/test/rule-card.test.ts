/**
 * The rule card's check against the cases it shares with the fleet repo (src/ledger/rule-card.cases.json, the same
 * bytes as that repo's packages/ledger/src/rule-card.cases.json): each case is ok or refused with the same code.
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { asArray, asObject, asString, type Json } from "../src/json.ts";
import { ruleFault, whyNoRule } from "../src/ledger/rule-card.ts";

interface Case {
  readonly about: string;
  readonly text: string;
  readonly refused: string | undefined;
}

/** A case's text: its rule, then `pad.with` until it holds `pad.to` code points. */
function textOf(c: { readonly [key: string]: Json }): string {
  const rule = asString(c["rule"]) ?? "";
  const pad = asObject(c["pad"] ?? null);

  if (pad === undefined) return rule;
  const unit = asString(pad["with"]) ?? "";
  const to = Number(pad["to"]);
  let text = rule;

  while ([...text].length < to) text += unit;

  return text;
}

// SAFETY: JSON.parse returns JSON values only.
const file = JSON.parse(readFileSync(new URL("../src/ledger/rule-card.cases.json", import.meta.url), "utf8")) as Json;

const CASES: readonly Case[] = (asArray(asObject(file)?.["cases"] ?? null) ?? []).map((c) => {
  const row = asObject(c) ?? {};

  return { about: asString(row["about"]) ?? "", text: textOf(row), refused: row["ok"] === true ? undefined : asString(row["refused"]) };
});

describe("a rule card's rule, as the fleet repo checks it too", () => {
  test("the shared case file holds cases of each kind", () => {
    expect(new Set(CASES.map((c) => c.refused ?? "ok"))).toEqual(new Set(["ok", "empty", "long", "invisible", "tripwire", "glob", "uncovered", "thin", "unbounded"]));
  });

  for (const c of CASES) {
    test(`${c.refused ?? "ok"}: ${c.about}`, () => {
      expect<string | undefined>(ruleFault(c.text)).toBe(c.refused);
      expect(whyNoRule(c.text) === undefined).toBe(c.refused === undefined);
    });
  }
});
