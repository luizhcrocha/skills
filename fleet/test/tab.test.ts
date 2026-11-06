/**
 * `fleet tab` (src/cli/tab.ts) on a fake rex that keeps a session's tabs, panes and their layout in memory: a new
 * tab beside the caller's, named for the caller and the worker, in the caller's cwd; a second run adding a pane to
 * the worker's own tab, splitting its largest pane, replacing an ended pane of the same label, and refusing a fifth;
 * two workers of one coordinator with the same purpose getting a tab each, each closing only its own; a wait that
 * reports the exit code rex's process state or rex wait gives, before the screen; the refusal outside Rex. On real
 * rex, with FLEET_TEST_REX=1: a throwaway session with one tab of two panes, `sleep 2; echo done` with an argument
 * holding spaces and quotes, and `exit 3`, waited to 0 and 3; the session is killed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { tabWith } from "../src/cli/tab.ts";
import { Registry } from "../src/registry.ts";
import { recordingOut } from "../src/io.ts";
import { asArray, asObject, asString, parseObject, type JsonOut } from "../src/json.ts";
import { rexRunner, type Ran, type RexRunner } from "../src/team/rex.ts";
import { machineOf, World } from "../src/world.ts";

const SID = "session:01";

type Rect = readonly [number, number, number, number];

/** How a fake pane's command goes: its exit code once it ends (none while it runs), what its screen shows. */
interface Outcome {
  readonly exit?: number;
  readonly shows?: string;
}

interface Pane extends Outcome {
  readonly id: string;
  label: string;
  readonly window: string;
  readonly argv: readonly string[];
  readonly flags: readonly string[];
  rect: Rect;
}

interface Win {
  readonly id: string;
  label: string;
}

/** A rex session in memory: its tabs in order, its panes with their place in their tab, and every call it was asked.
 * A pane's command has ended when its outcome has an exit code; `rex wait` answers as rex does, `Error: exit status N`. */
class FakeRex {
  readonly calls: string[] = [];
  readonly windows: Win[] = [];
  readonly panes: Pane[] = [];
  private next = 0;
  private readonly outcomes: readonly Outcome[];
  broken: readonly string[] = [];

  constructor(windows: readonly (readonly [string, string])[], outcomes: readonly Outcome[] = []) {
    this.outcomes = outcomes;

    for (const [id, label] of windows) {
      this.windows.push({ id, label });
      this.panes.push({ id: `block:${id}`, label: "shell", window: id, argv: [], flags: [], rect: [0, 0, 1, 1] });
    }
  }

  private pane(window: string, label: string, args: readonly string[], rect: Rect): Pane {
    const cut = args.indexOf("--");
    const outcome = this.outcomes[this.next] ?? { exit: 0, shows: "" };
    this.next += 1;
    const pane: Pane = { id: `block:new-${String(this.next)}`, label, window, argv: args.slice(cut + 1), flags: args.slice(0, cut), rect, ...outcome };
    this.panes.push(pane);

    return pane;
  }

  /** The labels of the panes in the tab labelled `label`. */
  inTab(label: string): string[] {
    const id = this.windows.find((w) => w.label === label)?.id;

    return this.panes.filter((p) => p.window === id).map((p) => p.label);
  }

  readonly run: RexRunner = (args) => {
    this.calls.push(args.join(" "));
    const said = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });
    const ok = (value: JsonOut): Ran => said(JSON.stringify(value));
    const value = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    const [verb, sub] = args;

    if (this.broken.some((b) => args.join(" ").startsWith(b))) return { code: 4, stdout: "", stderr: "Error: connecting to Rex server: dial tcp: connection refused" };

    if (value("-s") !== SID) return { code: 1, stdout: "", stderr: "Error: no such session" };

    if (verb === "block" && sub === "ls") return ok({ blocks: this.panes.map((p) => ({ block_id: p.id, label: p.label, window_id: p.window })) });

    if (verb === "window" && sub === "ls") return ok({ session_id: SID, label: "work", windows: this.windows.map((w) => ({ window_id: w.id, label: w.label })) });

    if (verb === "window" && sub === "inspect") {
      const leaves = this.panes.filter((p) => p.window === args[4]).map((p) => ({ rect: p.rect, block_id: p.id }));
      const [first, ...others] = leaves;
      const layout = others.reduceRight<JsonOut>((after, before) => ({ split: { before, after } }), first ?? null);

      return ok({ window_id: args[4] ?? "", layers: [{ kind: "tiled", layout }] });
    }

    if (verb === "window" && sub === "new") {
      const id = `window:new-${String(this.windows.length)}`;
      this.windows.push({ id, label: args[4] ?? "" });

      return ok({ window_id: id, block_ids: [this.pane(id, "shell", args, [0, 0, 1, 1]).id] });
    }

    if (verb === "block" && sub === "rename") {
      const cut = args.indexOf("--");
      const pane = cut === -1 ? undefined : this.panes.find((p) => p.id === args[cut + 1]);

      if (pane === undefined) return { code: 1, stdout: "", stderr: "Error: no such block" };
      pane.label = args[cut + 2] ?? "";

      return said("");
    }

    if (verb === "block" && sub === "close") {
      const at = this.panes.findIndex((p) => p.id === args[4]);

      if (at === -1) return { code: 1, stdout: "", stderr: "Error: no such block" };
      const [closed] = this.panes.splice(at, 1);

      if (!this.panes.some((p) => p.window === closed?.window)) this.windows.splice(this.windows.findIndex((w) => w.id === closed?.window), 1);

      return said("");
    }

    if (verb === "window" && sub === "move") {
      const at = this.windows.findIndex((w) => w.id === args[4]);
      const [moved] = this.windows.splice(at, 1);
      const after = this.windows.findIndex((w) => w.id === value("--after"));

      if (moved !== undefined) this.windows.splice(after + 1, 0, moved);

      return said("");
    }

    if (verb === "split") {
      const anchor = this.panes.find((p) => p.id === value("-b"));

      if (anchor === undefined) return { code: 1, stdout: "", stderr: "Error: no such block" };
      const [x, y, w, h] = anchor.rect;
      const below = args.includes("--split=below");
      anchor.rect = below ? [x, y, w, h / 2] : [x, y, w / 2, h];
      const rect: Rect = below ? [x, y + h / 2, w, h / 2] : [x + w / 2, y, w / 2, h];

      return ok({ anchor_id: anchor.id, block_ids: [this.pane(anchor.window, value("--label") ?? "shell", args, rect).id] });
    }

    const block = this.panes.find((p) => p.id === (verb === "wait" ? args[3] : value("-b")));

    if (verb === "wait") {
      if (block === undefined) return { code: 1, stdout: "", stderr: "Error: no such block" };
      const code = block.exit ?? 0;

      return { code, stdout: "", stderr: code === 0 ? "" : `Error: exit status ${String(code)}\n\nUsage:\n  rex wait TARGET [flags]\n` };
    }

    if (verb === "block" && sub === "call") return block === undefined ? { code: 1, stdout: "", stderr: "Error: no such block" } : ok({ last_exit: block.exit === undefined ? null : { exit_code: block.exit } });

    if (verb === "capture") return said(`${block?.shows ?? ""}\n`);

    if (verb === "window" && sub === "close") {
      const at = this.windows.findIndex((w) => w.id === args[4]);
      this.windows.splice(at, 1);

      return said("");
    }

    return { code: 1, stdout: "", stderr: `Error: the fake does not know ${args.join(" ")}` };
  };
}

const HERE = "/work/checkout";

/** The caller's environment: in Rex, in tab "ui", with a state dir of its own. */
function inRex() {
  return { REX_SESSION: SID, REX_BLOCK: "block:window:ui", FLEET_HOME: mkdtempSync(join(tmpdir(), "fleet-tab-")) };
}

function tab(rex: { readonly run: RexRunner }, argv: readonly string[], env: Readonly<Record<string, string>>) {
  const { layer, recorded } = recordingOut();
  const world = Layer.succeed(World, machineOf(() => new Date(0), (name) => env[name]));
  const code = Effect.runSync(tabWith(argv, rex.run, HERE).pipe(Effect.provide(Layer.mergeAll(world, layer))));

  return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
}

describe("fleet tab", () => {
  test("run opens a tab named first, then the worker and the caller's tab, right beside the caller's, its pane labelled and kept open", () => {
    const rex = new FakeRex([
      ["window:ui", "ui"],
      ["window:ux", "ux"],
    ]);

    const ran = tab(rex, ["run", "--as", "w1", "--tab", "deploy", "--cwd", "/repo", "--", "sh", "-c", "make deploy"], inRex());

    expect(ran).toMatchObject({ code: 0, stdout: "block:new-1\n" });
    expect(rex.windows.map((w) => w.label)).toEqual(["ui", "deploy w1 ui", "ux"]);
    const pane = rex.panes.find((p) => p.id === "block:new-1");
    expect(pane).toMatchObject({ label: "sh", argv: ["sh", "-c", "make deploy"] });
    expect(pane?.flags).toEqual(expect.arrayContaining(["--keep-open", "--focus=false", "-c", "/repo"]));
    expect(rex.calls).toContain(`block rename -s ${SID} -- block:new-1 sh`);
  });

  test("with no --cwd the pane starts in the caller's cwd", () => {
    const rex = new FakeRex([["window:ui", "ui"]]);
    const env = inRex();
    tab(rex, ["run", "--as", "w1", "--tab", "dev", "--", "make", "dev"], env);
    tab(rex, ["run", "--as", "w1", "--tab", "dev", "--label", "watch", "--", "make", "watch"], env);

    for (const id of ["block:new-1", "block:new-2"]) expect(rex.panes.find((p) => p.id === id)?.flags).toEqual(expect.arrayContaining(["-c", HERE]));
  });

  test("run takes --as, the worker the tab is for", () => {
    const rex = new FakeRex([["window:ui", "ui"]]);

    expect(tab(rex, ["run", "--tab", "dev", "--", "make", "dev"], inRex()).code).toBe(2);
    expect(tab(rex, ["close", "dev"], inRex()).code).toBe(2);
    expect(rex.calls).toEqual([]);
  });

  test("a second run with the same tab adds a labelled pane to it, splitting its largest pane", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{}, {}, {}]);
    const env = inRex();

    expect(tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "deploy", "--", "make", "deploy"], env).stdout).toBe("block:new-1\n");
    expect(tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "backfill", "--", "make", "backfill"], env).stdout).toBe("block:new-2\n");
    expect(tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "logs", "--", "tail", "-f", "log"], env).stdout).toBe("block:new-3\n");

    expect(rex.windows.map((w) => w.label)).toEqual(["ui", "ops w1 ui"]);
    expect(rex.inTab("ops w1 ui")).toEqual(["deploy", "backfill", "logs"]);
    expect(rex.panes.find((p) => p.id === "block:new-2")?.flags).toEqual(expect.arrayContaining(["--keep-open", "--focus=false", "-b", "block:new-1", "--split=below"]));
    expect(rex.panes.find((p) => p.id === "block:new-3")?.flags).toEqual(expect.arrayContaining(["-b", "block:new-1", "--split=right"]));
  });

  test("the record outlives the registry forgetting dead fleets, so a second run still splits the tab", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{}]);
    const env = inRex();

    tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "deploy", "--", "make", "deploy"], env);
    new Registry({ home: env.FLEET_HOME, config: env.FLEET_HOME }).live();
    tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "backfill", "--", "make", "backfill"], env);

    expect(rex.windows.map((w) => w.label)).toEqual(["ui", "ops w1 ui"]);
    expect(rex.inTab("ops w1 ui")).toEqual(["deploy", "backfill"]);
  });

  test("a pane of the same label whose command ended is closed before the new one is added; one still running is kept", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{ exit: 1 }, {}, {}]);
    const env = inRex();
    tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "deploy", "--", "make", "deploy"], env);
    tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "deploy", "--", "make", "deploy"], env);

    expect(rex.panes.map((p) => p.id)).toEqual(["block:window:ui", "block:new-2"]);
    expect(rex.inTab("ops w1 ui")).toEqual(["deploy"]);

    tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "deploy", "--", "make", "deploy"], env);
    expect(rex.inTab("ops w1 ui")).toEqual(["deploy", "deploy"]);
  });

  test("a tab holds at most 4 panes: a fifth is refused with what to do instead", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{}, {}, {}, {}, {}]);
    const env = inRex();

    for (const n of ["a", "b", "c", "d"]) expect(tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", n, "--", "sleep", "60"], env).code).toBe(0);
    const fifth = tab(rex, ["run", "--as", "w1", "--tab", "ops", "--label", "e", "--", "sleep", "60"], env);

    expect(fifth.code).toBe(1);
    expect(fifth.stderr).toContain("close the tab");
    expect(rex.inTab("ops w1 ui")).toEqual(["a", "b", "c", "d"]);
  });

  test("two workers of one coordinator with the same purpose get a tab each, and one's close leaves the other's", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{}, {}]);
    const env = inRex();

    expect(tab(rex, ["run", "--as", "w1", "--tab", "dev", "--", "bun", "dev"], env).code).toBe(0);
    expect(tab(rex, ["run", "--as", "w2", "--tab", "dev", "--", "bun", "dev"], env).code).toBe(0);
    expect(rex.windows.map((w) => w.label).toSorted()).toEqual(["dev w1 ui", "dev w2 ui", "ui"]);

    expect(tab(rex, ["close", "--as", "w1", "dev"], env).code).toBe(0);
    expect(rex.windows.map((w) => w.label)).toEqual(["ui", "dev w2 ui"]);
    expect(rex.inTab("dev w2 ui")).toEqual(["bun"]);
    expect(tab(rex, ["close", "--as", "w1", "dev"], env).code).toBe(1);
  });

  test("close closes only a tab its run recorded, never one that only bears the label", () => {
    const rex = new FakeRex([
      ["window:ui", "ui"],
      ["window:look-alike", "deploy w1 ui"],
      ["window:ux-deploy", "deploy w1 ux"],
    ]);

    const closed = tab(rex, ["close", "--as", "w1", "deploy"], inRex());

    expect(closed.code).toBe(1);
    expect(rex.windows.map((w) => w.label)).toEqual(["ui", "deploy w1 ui", "deploy w1 ux"]);
    expect(tab(rex, ["close", "--as", "w1", "cmd"], inRex()).code).toBe(2);
    expect(tab(rex, ["run", "--as", "w1", "--tab", "cmd", "--", "true"], inRex()).code).toBe(2);
  });

  test("wait takes the exit code from rex's process state, prints it, then the pane's last lines", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{ exit: 3, shows: "step 1\nstep 2\nfailed: no disk" }]);
    const env = inRex();
    tab(rex, ["run", "--as", "w1", "--tab", "jobs", "--", "sh", "-c", "exit 3"], env);
    const waited = tab(rex, ["wait", "block:new-1"], env);

    expect(waited.code).toBe(3);
    expect(waited.stdout).toStartWith("exit 3\n");
    expect(waited.stdout).toContain("failed: no disk");
    expect(tab(rex, ["read", "block:new-1", "--lines", "1"], env).stdout).toBe("failed: no disk\n");
  });

  test("wait takes the exit code from rex wait when the process state says none", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{ exit: 5, shows: "boom" }]);
    const env = inRex();
    tab(rex, ["run", "--as", "w1", "--tab", "jobs", "--", "sh", "-c", "exit 5"], env);
    rex.broken = [`block call -s ${SID} -b block:new-1 process`];
    const waited = tab(rex, ["wait", "block:new-1"], env);

    expect(waited.code).toBe(5);
    expect(waited.stdout).toBe("exit 5\nboom\n");
  });

  test("wait prints the exit code even when the capture fails, with a note on stderr", () => {
    const rex = new FakeRex([["window:ui", "ui"]], [{ exit: 2, shows: "x" }]);
    const env = inRex();
    tab(rex, ["run", "--as", "w1", "--tab", "jobs", "--", "false"], env);
    rex.broken = ["capture"];
    const waited = tab(rex, ["wait", "block:new-1"], env);

    expect(waited.code).toBe(2);
    expect(waited.stdout).toBe("exit 2\n");
    expect(waited.stderr).toContain("could not capture");
  });

  test("wait says on stderr when rex is unreachable", () => {
    const rex = new FakeRex([["window:ui", "ui"]]);
    rex.broken = ["wait", "block call"];
    const waited = tab(rex, ["wait", "block:new-1"], inRex());

    expect(waited.code).toBe(1);
    expect(waited.stderr).toContain("unreachable");
  });

  test("outside Rex it refuses before calling rex, so the caller falls back to a background Bash call", () => {
    const rex = new FakeRex([["window:ui", "ui"]]);

    for (const argv of [["run", "--as", "w1", "--tab", "x", "--", "true"], ["wait", "block:1"], ["read", "block:1"], ["close", "--as", "w1", "x"]]) {
      const ran = tab(rex, argv, {});
      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain("REX_SESSION");
    }

    expect(rex.calls).toEqual([]);
  });
});

describe.if(process.env["FLEET_TEST_REX"] === "1")("fleet tab on real rex", () => {
  test("one tab, two panes, argv kept whole through the login shell, waited to 0 and 3", () => {
    const run = rexRunner();
    const made = run(["new", `fleet-tab-smoke-${String(process.pid)}`, "--json"]);

    if ("why" in made || made.code !== 0) throw new Error(`rex new: ${"why" in made ? made.why : made.stderr}`);
    const created = Option.getOrUndefined(parseObject(made.stdout));
    const sid = asString(created?.["session_id"]) ?? "";
    const first = asString(asArray(asObject(asArray(created?.["initial_windows"])?.[0])?.["block_ids"])?.[0]) ?? "";

    try {
      const env = { REX_SESSION: sid, REX_BLOCK: first, FLEET_HOME: mkdtempSync(join(tmpdir(), "fleet-tab-")) };
      const rex = { run };
      const tricky = `it's "quoted"  twice; $HOME`;
      const done = tab(rex, ["run", "--as", "smoke", "--tab", "smoke", "--label", "done", "--", "sh", "-c", 'sleep 2; printf "<%s>\\n" "$1"; echo done', "sh", tricky], env);
      const three = tab(rex, ["run", "--as", "smoke", "--tab", "smoke", "--label", "three", "--", "sh", "-c", "exit 3"], env);
      expect([done.code, three.code]).toEqual([0, 0]);

      const listed = run(["block", "ls", "-s", sid, "--json"]);
      const blocks = "why" in listed ? [] : (asArray(Option.getOrUndefined(parseObject(listed.stdout))?.["blocks"]) ?? []).map(asObject);
      const windowOf = (id: string): string | undefined => asString(blocks.find((b) => b?.["block_id"] === id)?.["window_id"]);
      expect(windowOf(done.stdout.trim())).toBeDefined();
      expect(windowOf(three.stdout.trim())).toBe(windowOf(done.stdout.trim()));

      const zero = tab(rex, ["wait", done.stdout.trim()], env);
      const exit3 = tab(rex, ["wait", three.stdout.trim()], env);
      expect([zero.code, exit3.code]).toEqual([0, 3]);
      expect(zero.stdout).toContain(`<${tricky}>`);
      expect(zero.stdout).toContain("done");
      expect(tab(rex, ["close", "--as", "smoke", "smoke"], env).code).toBe(0);
    } finally {
      run(["kill", sid]);
    }
  }, 60_000);
});
