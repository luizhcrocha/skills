/**
 * Where a permission row's root is placed (ledger/placement.ts): the fleet's registered session, read from the
 * OS, and a root that is that session's working directory.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { placeRoot, registeredSession } from "../src/ledger/placement.ts";
import { tmp } from "./support.ts";

describe("registeredSession", () => {
  test("a live pid names its process and working directory", () => {
    expect(registeredSession(process.pid)).toEqual({ pid: process.pid, cwd: process.cwd() });
  });

  test("a pid that has died, pid 1 or none names no session", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    expect([registeredSession(dead.pid), registeredSession(1), registeredSession(0), registeredSession(undefined)]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("placeRoot", () => {
  test("the registered session's working directory is a session root; with no live session, a folder is outside", () => {
    const dir = tmp("placement-");
    const at = realpathSync(process.cwd());
    mkdirSync(join(dir, "elsewhere"));
    expect(placeRoot(dir, at, () => registeredSession(process.pid))).toEqual({ kind: "session" });
    expect(placeRoot(dir, join(dir, "elsewhere"), () => undefined)).toEqual({
      kind: "outside",
      why: "no heartbeat names it, and no live session is registered for this fleet",
      roots: [],
    });
  });
});
