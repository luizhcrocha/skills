/**
 * `fleet preview`, its dev server: the environment it inherits, the command it is given (Vite, Vite+, a
 * command with placeholders), its last error as read from its log, the install before it, what `start`
 * says when it dies, the ledger's keys and the page's view. The tests of the pure functions build no
 * fleet; the others call `withFleet()` for throwaway jj repos and a stand-in dev server (stub-dev.ts), as
 * preview.test.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { view } from "../src/page/view.ts";
import { fill, lastError, runSetup } from "../src/preview/devserver.ts";
import { readRecord, type PreviewRecord } from "../src/preview/record.ts";
import { isRunning as alive } from "../src/preview/devserver.ts";
import { SpendReader } from "../src/transcripts.ts";
import { baseEnv, fleet, machine, readJson, SKILL, sleep, spawnFleet, tmp, type Environment } from "./support.ts";

/** The stand-in dev server, told its port and base as a Vite command would be. */
const STUB = `${process.execPath} ${join(import.meta.dir, "stub-dev.ts")} {port} {base}`;

/** jj, a dev server and the updater per test: seconds, not milliseconds. */
setDefaultTimeout(60_000);

let base: string;

let repo: string;

let dir: string;

let env: Environment;

/** Run jj in `at`; its stdout. */
function jj(at: string, ...args: string[]): string {
  const done = Bun.spawnSync(["jj", "-R", at, "--color=never", ...args], { stdout: "pipe", stderr: "pipe" });

  if (done.exitCode !== 0) throw new Error(`jj ${args.join(" ")}: ${done.stderr.toString()}`);

  return done.stdout.toString();
}

function state(...args: string[]): void {
  const ran = fleet(["state", dir, ...args, "--no-render"], env);

  expect(ran.code).toBe(0);
}

function preview(...args: string[]): ReturnType<typeof fleet> {
  return fleet(["preview", dir, ...args], env);
}

function record(): PreviewRecord {
  const got = readRecord(dir);

  if (got === undefined) throw new Error("no preview record");

  return got;
}

/** Wait until `ready` holds (at most `ms`). */
async function until(ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(100);
  }
}

const ws = (name: string): string => join(base, `repo-${name}`);

/** A fleet of two workers, each in a workspace of a throwaway repo, for the tests of the describe that calls it. */
function withFleet(): void {
  beforeEach(() => {
    base = tmp("fleet-preview-");
    repo = join(base, "repo");
    Bun.spawnSync(["jj", "git", "init", repo], { stdout: "ignore", stderr: "ignore" });

    for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), "base\n");
    jj(repo, "describe", "-m", "base");
    jj(repo, "new");
    dir = join(base, "fleet");
    env = baseEnv(join(base, "registry"), { TZ: "UTC", TAILSCALE: join(base, "no-tailscale"), FLEET_PREVIEW_S: "0.2", FLEET_PREVIEW_WAIT_S: "10" });
    state("init", "--project", "shop", "--goal", "g");
    state("milestone", "m1", "--title", "M");
    state("agent", "a1", "--task", "header", "--milestone", "m1", "--lane", "a.txt");
    state("agent", "a2", "--task", "footer", "--milestone", "m1", "--lane", "b.txt");
    expect(fleet(["ws", dir, "add", "a1", "--repo", repo], env).code).toBe(0);
    expect(fleet(["ws", dir, "add", "a2", "--repo", repo], env).code).toBe(0);
    expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
  });

  afterEach(() => {
    if (existsSync(join(dir, "preview.json"))) preview("stop", "--all");
  });
}

/** A range of ports for the public ports, from a free one up. */
function portRange(): readonly [number, number] {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const lo = probe.port ?? 0;
  void probe.stop(true);

  return [lo, lo + 30];
}

describe("the dev servers' environment", () => {
  withFleet();

  test("every dev server the preview starts (combined, per-worker, root mode or not) inherits the environment `start` ran in, unchanged", async () => {
    const cmd = `${process.execPath} ${join(import.meta.dir, "env-dev.ts")} {port} FLEET_TEST_SECRET`;
    const secret = { ...env, FLEET_TEST_SECRET: "from secretspec run", FLEET_PREVIEW_PORTS: portRange().join("-") };
    const valueAt = async (port: number | undefined): Promise<string> => (await fetch(`http://127.0.0.1:${String(port ?? 0)}/`)).text();

    const combined = spawnFleet(["preview", dir, "start", "--cmd", cmd], secret);
    expect([combined.code, combined.stderr]).toEqual([0, ""]);
    expect(await valueAt(record().server?.port)).toBe("from secretspec run");

    const own = spawnFleet(["preview", dir, "start", "--per-worker", "a1", "--root", "--cmd", cmd], secret);
    expect([own.code, own.stderr]).toEqual([0, ""]);
    expect(await valueAt(record().workers.find((w) => w.worker === "a1")?.port)).toBe("from secretspec run");

    expect(spawnFleet(["preview", dir, "stop"], secret).code).toBe(0);
    expect(spawnFleet(["preview", dir, "start", "--root", "--cmd", cmd], secret).code).toBe(0);
    expect(await valueAt(record().server?.port)).toBe("from secretspec run");
  });
});

describe("the dev server", () => {
  const VITE = [
    "  VITE v8.3.2  ready in 154 ms",
    "7:50:38 PM [vite] (client) hmr update /src/Header.tsx",
    "7:51:06 PM [vite] Internal server error: Transform failed with 1 error:",
    "",
    "\u001b[31m[PARSE_ERROR] \u001b[0mEncountered diff marker",
    "   \u001b[38;5;246m╭─[\u001b[0m src/Header.tsx:2:1 ]",
    "  Plugin: vite:oxc",
    "      at transformWithOxc (file:///x/node.js:7581:19)",
    "7:51:06 PM [vite] (client) [console.error] [vite] Failed to reload /src/Header.tsx. (see errors above)",
  ];

  test("its last error is read from the burst's first line, without colours or stack frames, until it reloads a page", () => {
    expect(lastError(VITE.join("\n"))).toBe(
      [
        "7:51:06 PM [vite] Internal server error: Transform failed with 1 error:",
        "[PARSE_ERROR] Encountered diff marker",
        "   ╭─[ src/Header.tsx:2:1 ]",
        "  Plugin: vite:oxc",
        "7:51:06 PM [vite] (client) [console.error] [vite] Failed to reload /src/Header.tsx. (see errors above)",
      ].join("\n"),
    );
    expect(lastError([...VITE, "7:51:12 PM [vite] (client) hmr update /src/Header.tsx"].join("\n"))).toBeNull();
    expect(lastError(VITE.slice(0, 2).join("\n"))).toBeNull();
  });

  test("Vite is told its port, host and base; a command with placeholders gets them; anything else runs as given", () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vite --open" } }));
    expect(fill(repo, "npm run dev", 5173, "/f/shop/preview/")).toEqual({ cmd: "npm run dev -- --port 5173 --strictPort --host 127.0.0.1 --base /f/shop/preview/", base: "/f/shop/preview/" });
    expect(fill(repo, "pnpm run dev", 5173, "/b/")).toEqual({ cmd: "pnpm run dev --port 5173 --strictPort --host 127.0.0.1 --base /b/", base: "/b/" });
    expect(fill(repo, "serve --port {port} --prefix {base}", 9, "/b/")).toEqual({ cmd: "serve --port 9 --prefix /b/", base: "/b/" });
    expect(fill(repo, "next dev -p {port}", 9, "/b/")).toEqual({ cmd: "next dev -p 9", base: "/" });
    expect(fill(repo, "python3 -m http.server", 9, "/b/")).toEqual({ cmd: "python3 -m http.server", base: "/" });
  });

  test("a Vite+ dev server (`vp dev`, `vite-plus dev`, a script or `vp run` task that runs one) is told its port, host and base; its other commands are not", () => {
    const told = (cmd: string): string => `${cmd} --port 9 --strictPort --host 127.0.0.1 --base /b/`;
    const ledger = "env CASOS_DEV=prod pnpm --filter casos exec vp dev";
    expect(fill(repo, ledger, 9, "/b/")).toEqual({ cmd: told(ledger), base: "/b/" });
    expect(fill(repo, "vp dev", 9, "/b/")).toEqual({ cmd: told("vp dev"), base: "/b/" });
    expect(fill(repo, "npx vite-plus dev", 9, "/b/")).toEqual({ cmd: told("npx vite-plus dev"), base: "/b/" });
    expect(fill(repo, "vite", 9, "/b/")).toEqual({ cmd: told("vite"), base: "/b/" });

    for (const other of ["vp build", "vp preview", "vp test", "vp check", "vp", "pnpm --filter casos exec vp build", "vite build", "vite preview", "cf-vite dev", "vp build --config vite.config.ts"]) {
      expect(fill(repo, other, 9, "/b/")).toEqual({ cmd: other, base: "/" });
    }

    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "vp dev --open", build: "vp build", start: "node dev/start.ts" } }));
    expect(fill(repo, "pnpm dev", 9, "/b/")).toEqual({ cmd: told("pnpm dev"), base: "/b/" });
    expect(fill(repo, "vp run dev", 9, "/b/")).toEqual({ cmd: told("vp run dev"), base: "/b/" });
    expect(fill(repo, "vpr dev", 9, "/b/")).toEqual({ cmd: told("vpr dev"), base: "/b/" });
    expect(fill(repo, "pnpm build", 9, "/b/")).toEqual({ cmd: "pnpm build", base: "/" });
    expect(fill(repo, "vpr start", 9, "/b/")).toEqual({ cmd: "vpr start", base: "/" });
  });

  describe("that dies before it answers", () => {
    withFleet();

    test("start says so, with the log's last error, when the dev server dies before it answers", () => {
      const dies = `${process.execPath} -e 'console.error("error when starting dev server:\\nError: Port 24116 is already in use"); process.exit(1)'`;
      const ran = preview("start", "--cmd", dies);
      expect(ran.code).toBe(1);
      expect(ran.stdout).toContain("exited at start");
      expect(ran.stdout).not.toContain("not answering yet");
      expect(ran.stderr).toContain("preview: the dev server exited before it answered on port ");
      expect(ran.stderr).toContain("Error: Port 24116 is already in use");

      const worker = preview("start", "--per-worker", "a1", "--cmd", dies);
      expect(worker.code).toBe(1);
      expect(worker.stderr).toContain("Error: Port 24116 is already in use");
    });
  });
});

describe("the ledger", () => {
  withFleet();

  test("the preview's keys (its workspace row, the dev command) survive a write by the Python oracle", () => {
    expect(preview("set", "--cmd", STUB).code).toBe(0);
    expect(preview("start").code).toBe(0);
    const before = readJson(join(dir, "state.json"));
    const done = Bun.spawnSync(["python3", join(SKILL, "scripts", "state.py"), dir, "set", "--now", "previewing", "--no-render"], { env, stdout: "pipe", stderr: "pipe" });
    expect([done.exitCode, done.stderr.toString()]).toEqual([0, ""]);
    const after = readJson(join(dir, "state.json"));
    expect(after["preview"]).toEqual(before["preview"]);
    expect(after["workspaces"]).toEqual(before["workspaces"]);
    expect(after["now"]).toBe("previewing");
  });
});

describe("the page's view", () => {
  withFleet();

  test("has the preview only when the fleet has one: address, workers, and whom the merge leaves out", async () => {
    const m = machine(env);
    const lookups = { up: (urls: readonly string[]) => urls.map(() => false), discovered: () => [], spend: new SpendReader() };
    const shown = (): JsonObject => view(m, lookups, readJson(join(dir, "state.json")), dir);
    expect("preview" in shown()).toBe(false);

    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    await until(() => record().left.length > 0);
    const p = asObject(shown()["preview"]);

    expect(p).toMatchObject({
      url: "preview/",
      running: true,
      updater: true,
      conflicts: [],
      error: 'a2 is left out of the merge: its edits conflict with a1\'s in "c.txt"',
    });

    expect(p).not.toHaveProperty("left_out");
    expect(String(p?.["address"])).toEndWith("/f/shop/preview/");
    expect(asArray(p?.["workers"])?.map((w) => asObject(w)?.["id"])).toEqual(["a1", "a2"]);
    expect(asObject(asArray(p?.["workers"])?.[0])).toMatchObject({ id: "a1", included: true, status: "running" });
    expect(asObject(asArray(p?.["workers"])?.[1])).toMatchObject({ id: "a2", included: false, status: "running" });
  });
});

describe("the install before a dev server", () => {
  test("ends with its whole tree: what it left running, and what a timeout would have left, die with it", () => {
    const dir = tmp("fleet-setup-");
    const log = join(dir, "logs", "setup.log");
    expect(runSetup(dir, `sleep 300 & echo $! > ${dir}/left; echo installed`, log)).toBeUndefined();
    expect(readFileSync(log, "utf8")).toContain("installed");
    expect(alive(Number(readFileSync(join(dir, "left"), "utf8")))).toBe(false);

    const why = runSetup(dir, `sleep 301 & echo $! > ${dir}/hung; sleep 302`, log, 500);
    expect(why).toContain("ran past 1 s and was killed, with everything it started");
    expect(alive(Number(readFileSync(join(dir, "hung"), "utf8")))).toBe(false);
  });
});

