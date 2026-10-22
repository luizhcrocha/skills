/**
 * `fleet preview`, the merge that is never served conflicted: a worker whose workspace would conflict the
 * combined preview's merge is left out, with the files and the workers it meets, while the last good merge
 * keeps being served; a copy of a change the merge has is taken in; `fleet ws add --no-preview` adds a
 * workspace out of the preview; and `status` says the updater runs while it runs. Against throwaway jj
 * repos and a stand-in dev server (stub-dev.ts), as preview.test.ts. What one look does when a worker's
 * own jj command lands inside it is in preview-look.test.ts.
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { readChat } from "../src/chat/store.ts";
import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { view } from "../src/page/view.ts";
import { readRecord, updateRecord, type PreviewRecord } from "../src/preview/record.ts";
import { isRunning as alive } from "../src/preview/devserver.ts";
import { freshMemory, lookOnce } from "../src/preview/updater.ts";
import { SpendReader } from "../src/transcripts.ts";
import { machineOf } from "../src/world.ts";
import { baseEnv, fleet, machine, readJson, sleep, tmp, type Environment } from "./support.ts";

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

function workspaceRows(): JsonObject[] {
  return (asArray(readJson(join(dir, "state.json"))["workspaces"]) ?? []).flatMap((w) => {
    const o = asObject(w);

    return o === undefined ? [] : [o];
  });
}

/** Wait until `ready` holds (at most `ms`). */
async function until(ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(100);
  }
}

/** What a test writes as the record's error, for the updater to write over. */
const MARK = "a test's mark";

/** Two whole looks of the updater, the second begun after this call: each writes over the mark. */
async function looked(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, error: MARK }));
    await until(() => record().error !== MARK);
  }
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

const ws = (name: string): string => join(base, `repo-${name}`);

/** The commit `revset` names in the test repo, read without a snapshot. */
const commitOf = (revset: string): string => jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", revset, "-T", "commit_id").trim();

function at(root: string): void {
  base = root;
  repo = join(base, "repo");
  dir = join(base, "fleet");
  env = baseEnv(join(base, "registry"), { TZ: "UTC", TAILSCALE: join(base, "no-tailscale"), FLEET_PREVIEW_S: "0.2", FLEET_PREVIEW_WAIT_S: "10" });
}

/** The repo, a1's and a2's workspaces and the fleet each test starts from, made once. jj records its workspaces'
 * paths relative to the repo, so a copy is a repo of its own; the fleet's files name the template's folder, rewritten to the copy's. */
let template: string;

beforeAll(() => {
  at(tmp("fleet-preview-template-"));
  template = base;
  Bun.spawnSync(["jj", "git", "init", repo], { stdout: "ignore", stderr: "ignore" });

  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), "base\n");
  jj(repo, "describe", "-m", "base");
  jj(repo, "new");
  state("init", "--project", "shop", "--goal", "g");
  state("milestone", "m1", "--title", "M");
  state("agent", "a1", "--task", "header", "--milestone", "m1", "--lane", "a.txt");
  state("agent", "a2", "--task", "footer", "--milestone", "m1", "--lane", "b.txt");
  expect(fleet(["ws", dir, "add", "a1", "--repo", repo], env).code).toBe(0);
  expect(fleet(["ws", dir, "add", "a2", "--repo", repo], env).code).toBe(0);
});

beforeEach(() => {
  at(tmp("fleet-preview-"));
  cpSync(template, base, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(template, base));
  }

  expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
});

afterEach(() => {
  if (existsSync(join(dir, "preview.json"))) preview("stop", "--all");
});

describe("the updater", () => {
  test("leaves out the worker whose later edit would conflict the merge, keeps serving the last good merge, says why once, and takes it back", async () => {
    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    writeFileSync(join(ws("a2"), "b.txt"), "footer by a2\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(record().merged.map((m) => m.id)).toEqual(["a1", "a2"]);
    const served = async (file: string): Promise<string> => (await fetch(`http://127.0.0.1:${record().server?.port ?? 0}/f/shop/preview/${file}`)).text();

    // a2 edits the file a1 edited: the merge of both would conflict. What the preview's c.txt holds is sampled throughout.
    const seen = new Set<string>();
    const watching = setInterval(() => seen.add(read(join(ws("preview"), "c.txt"))), 20);
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
    await until(() => record().left.length > 0);

    expect(record().left).toEqual([{ id: "a2", workspace: "a2", commit: commitOf("a2@"), own: false, conflicts: [{ path: "c.txt", workers: ["a1"] }] }]);
    expect(record().merged.map((m) => m.id)).toEqual(["a1"]);
    expect(record().conflicts).toEqual([]);
    expect(await served("c.txt")).toBe("c by a1\n");
    const status = preview("status").stdout;
    expect(status).toContain("[x] a1 (running) at ");
    expect(status).toContain("[ ] a2 (left out: its edits conflict with a1's in \"c.txt\")\n");
    expect(status).not.toContain("(conflicted)");

    // The others' edits still reach the preview, and a2 is tried again at each: still out, told once.
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    await until(() => read(join(ws("preview"), "a.txt")) === "header by a1\n");
    const tried = record().left[0]?.commit;
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2, again\n");
    await until(() => record().left[0]?.commit !== tried);
    expect(record().left.map((l) => [l.id, l.commit])).toEqual([["a2", commitOf("a2@")]]);
    expect(await served("c.txt")).toBe("c by a1\n");
    const told = readChat(dir).filter((m) => m.from === "fleet-hub");
    expect(told.map((m) => m.text)).toEqual([expect.stringContaining("[hub] The preview left a2 out of its merge: its edits conflict with a1's in \"c.txt\". It keeps serving the merge without a2")]);
    expect(told[0]?.to).toEqual(["coordinator"]);

    // a2 takes its edit back: it merges clean and is in again.
    writeFileSync(join(ws("a2"), "c.txt"), "base\n");
    await until(() => record().left.length === 0 && record().merged.length === 2);
    clearInterval(watching);
    expect([...seen].filter((text) => text !== "c by a1\n")).toEqual([]);
    expect(read(join(ws("preview"), "b.txt"))).toBe("footer by a2\n");
    expect(preview("status").stdout).toContain("[x] a2 (running) at ");
  });

  test("a workspace added while the preview runs is taken in when it is a copy of a change the merge has, and left out when it conflicts", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    jj(ws("a1"), "util", "snapshot");

    // A landing worker copies a1's change onto the stack, as `jj duplicate` does: the same content, another change.
    state("agent", "l1", "--task", "land a1", "--milestone", "m1", "--lane", "a.txt");
    expect(fleet(["ws", dir, "add", "l1", "--repo", repo], env).code).toBe(0);
    jj(ws("l1"), "duplicate", "a1@", "--onto", "default@-");
    jj(ws("l1"), "edit", "heads(default@-+ ~ working_copies())");
    await until(() => record().merged.some((m) => m.id === "l1" && m.commit === commitOf("l1@")));
    expect(record().merged.map((m) => m.id)).toEqual(["a1", "a2", "l1"]);
    expect(commitOf("l1@")).not.toBe(commitOf("a1@"));
    expect(jj(repo, "diff", "--ignore-working-copy", "--from", "a1@", "--to", "l1@", "--summary")).toBe("");
    expect([record().left, record().conflicts, record().error]).toEqual([[], [], null]);
    expect(read(join(ws("preview"), "a.txt"))).toBe("header by a1\n");

    // Another edits the same line otherwise: left out from its first look, and the merge it met stands.
    state("agent", "l2", "--task", "land a1, changed", "--milestone", "m1", "--lane", "a.txt");
    expect(fleet(["ws", dir, "add", "l2", "--repo", repo], env).code).toBe(0);
    writeFileSync(join(ws("l2"), "a.txt"), "header by l2\n");
    await until(() => record().left.length > 0);
    expect(record().left.map((l) => [l.id, l.own, l.conflicts])).toEqual([["l2", false, [{ path: "a.txt", workers: ["a1", "l1"] }]]]);
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "preview@", "-T", "conflict")).toBe("false");
    const parents = jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "preview@-", "-T", 'commit_id ++ "\\n"').split("\n").filter(Boolean).sort();
    expect(parents).toEqual(["a1@", "a2@", "l1@"].map(commitOf).sort());
    expect(read(join(ws("preview"), "a.txt"))).toBe("header by a1\n");
    expect(preview("status").stdout).toContain("[ ] l2 (left out: its edits conflict with a1's and l1's in \"a.txt\")\n");

    // Taken out by hand, it is no longer tried, nor called left out.
    expect(preview("exclude", "l2").code).toBe(0);
    expect(record().left).toEqual([]);
    expect(preview("status").stdout).toContain("[ ] l2 (taken out)\n");
  });

  test("a worker whose own @ is conflicted (a rebase it has not resolved) is left out untried, and taken in once it resolves it", async () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);

    // a2 rebases its change onto one that changed the same file: its @ is conflicted.
    writeFileSync(join(ws("a2"), "b.txt"), "footer by a2\n");
    jj(ws("a2"), "describe", "-m", "a footer");
    jj(ws("a2"), "new", "default@-", "-m", "another footer");
    writeFileSync(join(ws("a2"), "b.txt"), "another footer\n");
    jj(ws("a2"), "rebase", "-r", "@", "-d", 'description(exact:"a footer\n")');
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "a2@", "-T", "conflict")).toBe("true");
    await until(() => record().left.length > 0);
    expect(record().left.map((l) => [l.id, l.own, l.conflicts])).toEqual([["a2", true, [{ path: "b.txt", workers: [] }]]]);
    expect(read(join(ws("preview"), "b.txt"))).toBe("base\n");
    expect(preview("status").stdout).toContain("[ ] a2 (left out: its own @ is conflicted in \"b.txt\")\n");

    writeFileSync(join(ws("a2"), "b.txt"), "both footers\n");
    await until(() => record().left.length === 0 && read(join(ws("preview"), "b.txt")) === "both footers\n");
    expect(record().merged.map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  test("of two workers the merge held, the one whose edit brought the conflict is left out, whatever the ledger's order", async () => {
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    await until(() => record().left.length > 0);
    expect(record().left.map((l) => [l.id, l.conflicts])).toEqual([["a1", [{ path: "c.txt", workers: ["a2"] }]]]);
    expect(read(join(ws("preview"), "c.txt"))).toBe("c by a2\n");

    // A new updater knows from the record whom the last one left out, and keeps a2.
    expect(preview("stop").code).toBe(0);
    const again = preview("start", "--cmd", STUB);
    expect(again.stderr).toContain("preview: a1 is left out of the merge: its edits conflict with a2's in \"c.txt\"");
    expect(read(join(ws("preview"), "c.txt"))).toBe("c by a2\n");
  });

  test("start says whom its first merge leaves out: of two workers that meet, the later in the ledger", () => {
    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
    const ran = preview("start", "--cmd", STUB);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("merged: a1\n");
    expect(ran.stderr).toBe(`preview: a2 is left out of the merge: its edits conflict with a1's in "c.txt"; the preview serves the merge without it (\`fleet preview ${dir} status\`)\n`);
    expect(read(join(ws("preview"), "c.txt"))).toBe("c by a1\n");
  });

  test("a stack that is itself conflicted fails the look, and the last good merge stands", async () => {
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    jj(repo, "bookmark", "create", "main", "-r", "default@-");
    expect(preview("set", "--stack", "main").code).toBe(0);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const good = record();

    // The stack moves to a merge of two commits that changed c.txt each its own way.
    jj(repo, "workspace", "add", ws("side"), "--name", "side", "-r", "default@-");
    writeFileSync(join(ws("side"), "c.txt"), "one\n");
    jj(ws("side"), "describe", "-m", "one side");
    jj(ws("side"), "new", "default@-", "-m", "the other");
    writeFileSync(join(ws("side"), "c.txt"), "other\n");
    jj(ws("side"), "new", 'description(exact:"one side\n")', 'description(exact:"the other\n")', "-m", "both");
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "side@", "-T", "conflict")).toBe("true");
    jj(repo, "bookmark", "set", "main", "-r", "side@");
    await until(() => record().error !== null);

    expect(record().error).toContain("is itself conflicted in \"c.txt\": nothing merges clean on it, so the last good merge stands");
    expect([record().commit, record().stack]).toEqual([good.commit, good.stack]);
    expect(preview("status").stdout).toContain("updater's last error: the stack (");
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1, again\n");
    await looked();
    expect([read(join(ws("preview"), "a.txt")), read(join(ws("preview"), "c.txt"))]).toEqual(["header by a1\n", "base\n"]);

    // Resolved, the merge follows again.
    writeFileSync(join(ws("side"), "c.txt"), "settled\n");
    jj(ws("side"), "util", "snapshot");
    jj(repo, "bookmark", "set", "main", "-r", "side@");
    await until(() => record().error === null && read(join(ws("preview"), "a.txt")) === "header by a1, again\n");
    expect(read(join(ws("preview"), "c.txt"))).toBe("settled\n");
  });
});

describe("fleet preview status", () => {
  const updaterLine = (): string =>
    preview("status")
      .stdout.split("\n")
      .find((l) => l.startsWith("  updater: ")) ?? "";

  test("says the updater runs while it runs, also for a record from before start times were kept, and not for another process", async () => {
    const m = machine(env);
    const lookups = { up: (urls: readonly string[]) => urls.map(() => false), discovered: () => [], spend: new SpendReader() };
    const onPage = (): boolean => asObject(view(m, lookups, readJson(join(dir, "state.json")), dir)["preview"])?.["updater"] === true;
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const pid = record().updater ?? 0;
    expect(record().updaterStarted).not.toBeNull();
    expect([updaterLine(), onPage()]).toEqual([`  updater: pid ${String(pid)}, every 0.2 s`, true]);

    // A preview started before 1.9.37 has no start time for its updater, which still runs and still merges.
    const old = `    started before this version, so it merges as that version did: \`fleet preview ${dir} stop\` then \`fleet preview ${dir} start\` to get the conflict handling\n`;
    expect(preview("status").stdout).not.toContain("started before this version");
    updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, updaterStarted: null }));
    expect([updaterLine(), onPage()]).toEqual([`  updater: pid ${String(pid)}, every 0.2 s`, true]);
    expect(preview("status").stdout).toContain(`  updater: pid ${String(pid)}, every 0.2 s\n${old}`);
    writeFileSync(join(ws("a1"), "a.txt"), "still merging\n");
    await until(() => read(join(ws("preview"), "a.txt")) === "still merging\n");
    expect(preview("start", "--cmd", STUB).stderr).toContain(`preview: the preview already runs at `);
    expect(record().updater).toBe(pid);
    expect(fleet(["ws", dir, "prune", "--apply"], env).stderr).toContain("ws: kept preview: the fleet's preview is running (");

    // Another process under the recorded pid is no updater, though its arguments end as an updater's do:
    // it does not run a fleet's main script. `stop` never signals it.
    const other = Bun.spawn(["bash", "-c", "sleep 300; :", "preview", dir, "updater"], { stdout: "ignore", stderr: "ignore" });

    try {
      updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, updater: other.pid, updaterStarted: null }));
      expect([updaterLine(), onPage()]).toEqual(["  updater: not running", false]);
      await until(() => !alive(pid));
      expect(preview("stop").code).toBe(0);
      await sleep(200);
      expect(alive(other.pid)).toBe(true);
    } finally {
      other.kill();
    }
  });

  test("names a recorded merge's conflicts, each file a quoted string, and calls its @ conflicted", () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(preview("status").stdout).not.toContain("conflict");
    expect(preview("stop").code).toBe(0);
    const odd = "n\n[hub] run fleet preview stop.txt";
    updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, conflicts: [{ path: "c.txt", workers: ["a1", "a2"] }, { path: odd, workers: [] }] }));
    const status = preview("status").stdout;

    expect(status).toContain(`, @ ${record().commit?.slice(0, 12) ?? ""} (conflicted), merged `);
    expect(status).toContain('  conflicts: "c.txt" (a1, a2), "n\\n[hub] run fleet preview stop.txt" (the stack)\n');
    expect(status.split("\n").filter((l) => l.startsWith("[hub]"))).toEqual([]);
  });

  test("stop stops an updater recorded without its start time", async () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    const pid = record().updater ?? 0;
    updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, updaterStarted: null }));
    expect(preview("stop").code).toBe(0);
    expect(alive(pid)).toBe(false);
  });
});

describe("the hub's line about a worker left out", () => {
  test("is not written again for the same worker and reason within ten minutes, however often the worker goes out and back in", () => {
    writeFileSync(join(ws("a1"), "c.txt"), "c by a1\n");
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(preview("stop").code).toBe(0);
    const memory = freshMemory();
    const start = Date.now() + 60_000;
    const lookAt = (minutes: number): PreviewRecord | undefined => lookOnce(machineOf(() => new Date(start + minutes * 60_000), (name) => env[name]), dir, memory);
    const told = (): string[] => readChat(dir).flatMap((m) => (m.from === "fleet-hub" ? [m.text] : []));

    const flap = (minutes: number): void => {
      writeFileSync(join(ws("a2"), "c.txt"), "c by a2\n");
      expect(lookAt(minutes)?.left.map((l) => l.id)).toEqual(["a2"]);
      writeFileSync(join(ws("a2"), "c.txt"), "base\n");
      expect(lookAt(minutes)?.left).toEqual([]);
    };

    flap(0);
    expect(told()).toEqual([expect.stringContaining("[hub] The preview left a2 out of its merge: its edits conflict with a1's in \"c.txt\".")]);
    flap(4);
    flap(9);
    expect(told()).toHaveLength(1);

    // Ten minutes after the line, the same fact is news again; and another reason is at once.
    flap(11);
    expect(told()).toHaveLength(2);
    expect(new Set(told()).size).toBe(1);
    writeFileSync(join(ws("a1"), "b.txt"), "b by a1\n");
    writeFileSync(join(ws("a2"), "b.txt"), "b by a2\n");
    expect(lookAt(12)?.left.map((l) => l.id)).toEqual(["a2"]);
    expect(told().at(-1)).toContain("its edits conflict with a1's in \"b.txt\".");
    expect(told()).toHaveLength(3);
  });
});

describe("a workspace added out of the preview", () => {
  const add = (...args: string[]): ReturnType<typeof fleet> => fleet(["ws", dir, "add", ...args], env);

  test("taking it in lasts as long as the workspace: prune, and a new add --no-preview, take the worker out of the record's include", async () => {
    state("agent", "l1", "--task", "land a1", "--milestone", "m1", "--lane", "c.txt");
    expect(add("l1", "--repo", repo, "--no-preview").code).toBe(0);
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    expect(preview("include", "l1").code).toBe(0);
    expect(record().include).toEqual(["l1"]);

    // Its work is done and its workspace pruned: the choice made for that workspace goes with it.
    state("agent", "l1", "--status", "done");
    const pruned = fleet(["ws", dir, "prune", "--apply"], env);
    expect(pruned.stdout).toContain("pruned l1");
    expect(record().include).toEqual([]);

    // A new workspace of that name, added out of the preview, is out of it.
    state("agent", "l1", "--status", "running");
    expect(add("l1", "--repo", repo, "--no-preview").code).toBe(0);
    writeFileSync(join(ws("l1"), "c.txt"), "c by l1\n");
    await looked();
    expect([read(join(ws("preview"), "c.txt")), record().merged.map((m) => m.id)]).toEqual(["base\n", ["a1", "a2"]]);
    expect(preview("status").stdout).toContain("[ ] l1 (added out of the preview)\n");

    // And an add --no-preview alone drops a choice the record still held.
    expect(preview("include", "l1").code).toBe(0);
    state("agent", "l1", "--status", "done");
    state("agent", "l2", "--task", "land a2", "--milestone", "m1", "--lane", "c.txt");
    updateRecord(dir, (now) => (now === undefined ? undefined : { ...now, include: [...now.include, "l2"] }));
    expect(add("l2", "--reuse", "l1", "--no-preview").code).toBe(0);
    expect(record().include).toEqual(["l1"]);
    expect(preview("status").stdout).toContain("[ ] l2 (added out of the preview)\n");
  });

  test("ws add --no-preview keeps a running worker's workspace out of the merge until it is taken in, and a reuse keeps it out", async () => {
    state("agent", "l1", "--task", "land a1", "--milestone", "m1", "--lane", "a.txt");
    const added = add("l1", "--repo", repo, "--no-preview");
    expect([added.code, added.stderr]).toEqual([0, ""]);
    expect(added.stdout).toContain(`preview: l1's workspace is out of the fleet's combined preview (--no-preview); \`fleet preview ${dir} include l1\` takes it in\n`);
    expect(workspaceRows().map((w) => [w["id"], w["preview"]])).toEqual([["a1", undefined], ["a2", undefined], ["l1", "out"]]);

    // It edits the file a1 edits: in the merge it would conflict. It never is, from the first look.
    writeFileSync(join(ws("a1"), "a.txt"), "header by a1\n");
    writeFileSync(join(ws("l1"), "a.txt"), "header by l1\n");
    const ran = preview("start", "--cmd", STUB);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toContain("merged: a1, a2\n");
    expect(record().left).toEqual([]);
    expect(preview("status").stdout).toContain("[ ] l1 (added out of the preview)\n");
    writeFileSync(join(ws("l1"), "b.txt"), "footer by l1\n");
    await looked();
    expect([read(join(ws("preview"), "a.txt")), read(join(ws("preview"), "b.txt"))]).toEqual(["header by a1\n", "base\n"]);
    expect(jj(repo, "log", "--no-graph", "--ignore-working-copy", "-r", "l1@", "-T", "empty")).toBe("true");

    // Taken in by hand, it is in the merge as any worker (here it conflicts, so it is left out and said so).
    expect(preview("include", "l1").code).toBe(0);
    await until(() => record().left.length > 0);
    expect(preview("status").stdout).toContain("[ ] l1 (left out: its edits conflict with a1's in \"a.txt\")\n");
    expect(preview("exclude", "l1").code).toBe(0);
    expect(preview("status").stdout).toContain("[ ] l1 (taken out)\n");

    // The lane's next worker reuses the workspace: still out of the preview.
    state("agent", "l1", "--status", "done");
    state("agent", "l2", "--task", "land a2", "--milestone", "m1", "--lane", "a.txt");
    const handed = add("l2", "--reuse", "l1");
    expect(handed.code).toBe(0);
    expect(handed.stdout).toContain(`preview: l2's workspace is out of the fleet's combined preview (as l1 had it); \`fleet preview ${dir} include l2\` takes it in\n`);
    expect(workspaceRows().find((w) => w["id"] === "l1")).toMatchObject({ agent: "l2", preview: "out" });
    expect(preview("status").stdout).toContain("[ ] l2 (added out of the preview)\n");
  });

  test("a workspace added without it is in the merge, and --reuse --no-preview takes a handed one out", async () => {
    expect(preview("start", "--cmd", STUB).code).toBe(0);
    state("agent", "a3", "--task", "more", "--milestone", "m1", "--lane", "c.txt");
    const added = add("a3", "--repo", repo);
    expect(added.stdout).not.toContain("out of the fleet's combined preview");
    writeFileSync(join(ws("a3"), "c.txt"), "c by a3\n");
    // The files are written before the look records what it merged.
    await until(() => read(join(ws("preview"), "c.txt")) === "c by a3\n" && record().merged.some((m) => m.id === "a3"));
    expect(preview("status").stdout).toContain("[x] a3 (running) at ");

    state("agent", "a3", "--status", "done");
    state("agent", "l1", "--task", "land a3", "--milestone", "m1", "--lane", "c.txt");
    expect(add("l1", "--reuse", "a3", "--no-preview").stdout).toContain("l1's workspace is out of the fleet's combined preview (--no-preview)");
    expect(workspaceRows().find((w) => w["id"] === "a3")).toMatchObject({ agent: "l1", preview: "out" });
    expect(preview("status").stdout).toContain("[ ] l1 (added out of the preview)\n");
  });
});
