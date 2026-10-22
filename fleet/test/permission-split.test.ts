/**
 * The Bash split a permission's binding rests on, against the cases every port shares
 * (src/ledger/permission-split.cases.json). The hook's unittest (scripts/tests/test_tstack_hook.py) runs the same
 * file on its port; the fleet repo copies this file into packages/ledger/src/ and pins it by sha256, so a change
 * here is red there until every port agrees.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { FLEET_BIN } from "../src/files.ts";
import { asArray, asObject, asString, type Json } from "../src/json.ts";
import { runsOf, scriptsOf, simpleCommands, whyNoAsks, whyRunsMoved } from "../src/ledger/permission.ts";
import { tmp } from "./support.ts";

const FIXTURE = tmp("permission-split-");

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

/** The plugin's own CLI, an install path isFleetCli holds, and its sha256. */
const FLEET_SHA = createHash("sha256").update(readFileSync(FLEET_BIN)).digest("hex");

const at = (text: string): string => text.replaceAll("$FIXTURE", FIXTURE).replaceAll("$FLEET_CLI", FLEET_BIN).replaceAll("$FLEET_SHA", FLEET_SHA);

const strings = (value: Json | undefined): string[] => (asArray(value) ?? []).map((v) => at(asString(v) ?? ""));

/** The case file's sha256, the value the hook's PermissionSplitTest and the fleet repo's SPLIT_SHA256
 * (packages/ledger/src/permission.test.ts) pin too: a copy that drifts by a byte is red. Change all three with it. */
const SPLIT_SHA256 = "d63a896d2623ad9ddac86190f25b004778a732f1d04547805b3d0539a3d9f6b3";

const SPLIT_BYTES = readFileSync(new URL("../src/ledger/permission-split.cases.json", import.meta.url));

// SAFETY: JSON.parse returns JSON values only.
const file = asObject(JSON.parse(SPLIT_BYTES.toString("utf8")) as Json) ?? {};

for (const [name, text] of Object.entries(asObject(file["fixtures"]) ?? {})) {
  mkdirSync(dirname(join(FIXTURE, name)), { recursive: true });
  writeFileSync(join(FIXTURE, name), at(asString(text) ?? ""));
}

const CASES = (asArray(file["cases"]) ?? []).map((c) => asObject(c) ?? {});

/** Root reads a file of mode 000 anyway, so a case with `unreadable` is skipped when the suite runs as root. */
const ROOT = process.getuid?.() === 0;

describe("the permission split every port shares", () => {
  test("the case file is the bytes every port pins", () => {
    expect(createHash("sha256").update(SPLIT_BYTES).digest("hex")).toBe(SPLIT_SHA256);
  });

  test("the case file covers each refusal and the closed holes", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CASES.map((c) => asString(c["since"])).filter((s) => s !== undefined))).toEqual(new Set(["F3", "F11", "R6"]));
  });

  for (const c of CASES) {
    const call = at(asString(c["call"]) ?? "");
    const calls = [call, ...strings(c["more"])];
    const unreadable = (asArray(c["unreadable"]) ?? []).map((name) => join(FIXTURE, asString(name) ?? ""));

    test.skipIf(ROOT && unreadable.length > 0)(`${asString(c["since"]) ?? "split"}: ${asString(c["name"]) ?? ""}`, () => {
      for (const path of unreadable) chmodSync(path, 0o000);

      try {
        check(c, call, calls);
      } finally {
        for (const path of unreadable) chmodSync(path, 0o644);
      }
    });
  }

  test("an absence entry claimed for a script names the script, not a ws hook", () => {
    const script = join(FIXTURE, "deploy.sh");
    const forged = [`1 ${"0".repeat(64)} ${script}`];

    expect(whyRunsMoved(forged, runsOf([`bash ${script}`]))).toContain(`the card binds the script ${script} by the absence entry`);
  });
});

/** One shared case on this port: the split, the scripts, the refusal, the runs and the check at the yes. */
function check(c: Record<string, Json>, call: string, calls: readonly string[]): void {
  expect(simpleCommands(call)).toEqual((asArray(c["commands"]) ?? []).map(strings));
  expect(scriptsOf(call)).toEqual(strings(c["scripts"]));
  const refused = asString(c["whyNoAsk"]);
  const why = whyNoAsks(calls);

  if (refused === undefined) expect(why).toBeUndefined();
  else expect(why ?? "").toContain(refused);
  const asked = runsOf(calls);

  expect(asked).toEqual(strings(c["runs"]));
  const appears = Object.entries(asObject(c["appears"]) ?? {});

  if (appears.length === 0) {
    expect(whyRunsMoved(asked, runsOf(calls))).toBeUndefined();

    return;
  }

  try {
    for (const [name, text] of appears) {
      mkdirSync(dirname(join(FIXTURE, name)), { recursive: true });
      writeFileSync(join(FIXTURE, name), at(asString(text) ?? ""));
    }

    expect(whyRunsMoved(asked, runsOf(calls)) ?? "").toContain(asString(c["appeared"]) ?? "an appeared refusal");
  } finally {
    for (const [name] of appears) rmSync(join(FIXTURE, name), { force: true });
  }
}
