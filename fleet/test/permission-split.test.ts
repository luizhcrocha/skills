/**
 * The Bash split a permission's binding rests on, against the cases every port shares
 * (src/ledger/permission-split.cases.json). The hook's unittest (scripts/tests/test_tstack_hook.py) runs the same
 * file on its port; the fleet repo copies this file into packages/ledger/src/ and pins it by sha256, so a change
 * here is red there until every port agrees.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { asArray, asObject, asString, type Json } from "../src/json.ts";
import { runsOf, scriptsOf, simpleCommands, whyNoAsks } from "../src/ledger/permission.ts";
import { tmp } from "./support.ts";

const FIXTURE = tmp("permission-split-");

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

const at = (text: string): string => text.replaceAll("$FIXTURE", FIXTURE);

const strings = (value: Json | undefined): string[] => (asArray(value) ?? []).map((v) => at(asString(v) ?? ""));

// SAFETY: JSON.parse returns JSON values only.
const file = asObject(JSON.parse(readFileSync(new URL("../src/ledger/permission-split.cases.json", import.meta.url), "utf8")) as Json) ?? {};

for (const [name, text] of Object.entries(asObject(file["fixtures"]) ?? {})) writeFileSync(join(FIXTURE, name), asString(text) ?? "");

const CASES = (asArray(file["cases"]) ?? []).map((c) => asObject(c) ?? {});

describe("the permission split every port shares", () => {
  test("the case file covers each refusal and the closed holes", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CASES.map((c) => asString(c["since"])).filter((s) => s !== undefined))).toEqual(new Set(["F3", "F11"]));
  });

  for (const c of CASES) {
    const call = at(asString(c["call"]) ?? "");
    const calls = [call, ...strings(c["more"])];

    test(`${asString(c["since"]) ?? "split"}: ${asString(c["name"]) ?? ""}`, () => {
      expect(simpleCommands(call)).toEqual((asArray(c["commands"]) ?? []).map(strings));
      expect(scriptsOf(call)).toEqual(strings(c["scripts"]));
      const refused = asString(c["whyNoAsk"]);
      const why = whyNoAsks(calls);

      if (refused === undefined) expect(why).toBeUndefined();
      else expect(why ?? "").toContain(refused);
      expect(runsOf(calls)).toEqual(strings(c["runs"]));
    });
  }
});
