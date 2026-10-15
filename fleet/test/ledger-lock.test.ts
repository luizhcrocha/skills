/**
 * The ledger's lock (src/ledger/store.ts) is the flock of DIR/state.json. `fleet ws` and `fleet render` write
 * state.json under it: while another writer holds it, they wait, and the ledger is left as that writer left it.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { lockLedger } from "../src/ledger/store.ts";
import { baseEnv, FLEET, fleet, RACES_SEEN, sleep, tmp, untilOpens, type Environment } from "./support.ts";

const WS = fileURLToPath(new URL("../src/cli/ws.ts", import.meta.url));

const WORLD = fileURLToPath(new URL("../src/world.ts", import.meta.url));

test.skipIf(!RACES_SEEN)("a race whose open is never seen fails rather than runs without the race", () => {
  const sleeper = Bun.spawn(["sleep", "5"]);

  try {
    expect(() => untilOpens(sleeper.pid, join(tmp("fleet-ledger-lock-"), "state.json"), 200)).toThrow("never opened");
  } finally {
    sleeper.kill();
  }
});

/** A fresh ledger made by `fleet state init`, and the environment its commands run in. */
interface Fresh {
  readonly root: string;
  readonly env: Environment;
}

/** Make a {@link Fresh} ledger. */
function fresh(): Fresh {
  const home = tmp("fleet-ledger-lock-");
  const root = join(home, "fleet");
  const env = baseEnv(home);
  mkdirSync(root);
  expect(fleet(["state", root, "init", "--project", "p", "--goal", "g", "--no-render"], env).code).toBe(0);

  return { root, env };
}

/** Start `writer` while the test holds the ledger's lock of `root`: once it has state.json open, it must still be
 * waiting a while later, the ledger unchanged; once the lock is let go it writes. Returns the ledger it wrote. */
async function waitsForTheLock(root: string, writer: () => Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<string> {
  const before = readFileSync(join(root, "state.json"), "utf8");
  const release = lockLedger(root);
  const waiting = writer();
  // The writer must have started and opened state.json before the wait is timed: a slow start is no proof.
  untilOpens(waiting.pid, join(root, "state.json"));
  const early = await Promise.race([waiting.exited.then((code) => `exited ${String(code)} with the lock held`), sleep(1500).then(() => "waiting")]);
  const during = readFileSync(join(root, "state.json"), "utf8");
  release?.();

  expect(early).toBe("waiting");
  expect(during).toBe(before);
  expect(await waiting.exited).toBe(0);

  return readFileSync(join(root, "state.json"), "utf8");
}

test.skipIf(!RACES_SEEN)("a `fleet ws` write of the ledger waits for its lock", async () => {
  const { root, env } = fresh();

  const code = [
    `import { readFileSync } from "node:fs";`,
    `import { save } from ${JSON.stringify(WS)};`,
    `import { machineOf } from ${JSON.stringify(WORLD)};`,
    `const machine = machineOf(() => new Date("2026-10-14T12:00:00Z"), (name) => process.env[name]);`,
    `const raw = JSON.parse(readFileSync(${JSON.stringify(join(root, "state.json"))}, "utf8"));`,
    `const fault = save(machine, ${JSON.stringify(root)}, raw, undefined, [{ at: "2026-10-14T12:00:00Z", agent: null, kind: "note", text: "saved by ws" }]);`,
    `if (fault !== undefined) { console.error(fault.reason); process.exit(1); }`,
  ].join("\n");

  const written = await waitsForTheLock(root, () => Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "inherit" }));

  expect(written).toContain("saved by ws");
});

test.skipIf(!RACES_SEEN)("`fleet render` reads, stamps and writes the ledger under its lock", async () => {
  const { root, env } = fresh();

  const written = await waitsForTheLock(root, () =>
    Bun.spawn([FLEET, "render", join(root, "state.json"), join(root, "out.html")], { env: { ...env, FLEET_NOW: "2026-01-02T12:00:00Z" }, stdout: "pipe", stderr: "inherit" }),
  );

  expect(JSON.parse(written).updated).toStartWith("2026-01-02T");
});
