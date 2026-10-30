/**
 * The rex adapter (src/team/rex.ts). On a fake runner that records each `rex` call and answers as rex does: the
 * session made empty, an agent's window and its command line, a start that is ready, asks, stays silent or
 * ends, a prompt, a look, the bounded settle, end by handle. On real rex, with FLEET_TEST_REX=1: a throwaway
 * session `fleet-team-smoke-<random>` whose tabs run sh, not claude, reporting their state as Claude Code does;
 * every session it made is killed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import * as Option from "effect/Option";

import { asArray, asObject, asString, parseObject, type JsonOut } from "../src/json.ts";
import { parseAgent, type Agent, type Why } from "../src/team/agents.ts";
import type { Look } from "../src/team/launcher.ts";
import { claudeArgv, rexLauncher, rexRunner, type Ran, type RexRunner } from "../src/team/rex.ts";
import { tmp } from "./support.ts";

function agent(text = '{"fleet": {"role": "coordinator"}}', name = "ui"): Agent {
  const parsed = parseAgent(name, text);

  if ("why" in parsed) throw new Error(parsed.why);

  return parsed;
}

const SID = "session:01";

/** A rex in memory, and what it was asked: each call's words and its stdin. */
interface FakeRex {
  readonly run: RexRunner;
  readonly calls: string[];
  readonly inputs: (string | undefined)[];
}

/** The IDs (`key`) of the rows under `list` in rex's JSON answer `stdout` that are labelled `label`. */
function labelled(stdout: string, list: string, key: string, label: string): string[] {
  return (asArray(Option.getOrUndefined(parseObject(stdout))?.[list]) ?? []).flatMap((row) => {
    const id = asString(asObject(row)?.[key]);

    return id !== undefined && asObject(row)?.["label"] === label ? [id] : [];
  });
}

/** A {@link FakeRex}; `answer` gives the reply to a call, by its words, else it answers as rex would. */
function fakeRex(answer: (words: string) => Ran | undefined): FakeRex {
  const calls: string[] = [];
  const inputs: (string | undefined)[] = [];
  const ok = (stdout: JsonOut): Ran => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" });

  const run: RexRunner = (args, input) => {
    const words = args.join(" ");
    calls.push(words);
    inputs.push(input);
    const given = answer(words);

    if (given !== undefined) return given;

    if (words === "ls --json") return ok({ sessions: [{ session_id: SID, label: "skills" }, { session_id: "session:02", label: "other" }] });

    if (words.includes("session.new_window")) return ok({ window_id: "window:1", block_ids: ["block:1"], revision: 1 });

    if (words.includes("block ls")) return ok({ blocks: [{ block_id: "block:1", label: "ui", window_id: "window:1" }] });

    if (words.includes("window ls")) return ok({ windows: [{ window_id: "window:1", label: "ui" }] });

    if (words.endsWith("process")) return ok({ last_exit: null });

    return { code: 0, stdout: "", stderr: "" };
  };

  return { run, calls, inputs };
}

function statusIs(state: string | undefined): (words: string) => Ran | undefined {
  return (words) => (words.endsWith("program_status") ? { code: 0, stdout: JSON.stringify({ records: state === undefined ? [] : [{ state, app: "claude-code" }] }), stderr: "" } : undefined);
}

const FAST = { startMs: 300, settleMs: 300, pollMs: 50 } as const;

describe("rex's calls", () => {
  test("an agent's tab is a window of its own, labelled with it, running a new claude named after it, its system prompt in a file, kept open by a failure within the start's wait", () => {
    const rex = fakeRex(statusIs("idle"));
    const state = tmp("fleet-team-state-");
    const tab = rexLauncher({ state, run: rex.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent('{"system": "Run the UI fleet.", "fleet": {"role": "coordinator"}}') });

    expect(tab).toEqual({ handle: "window:1", label: "ui" });
    const at = rex.calls.findIndex((c) => c.includes("session.new_window"));

    expect(rex.calls[at]).toBe(`api call -s ${SID} session.new_window -`);
    expect(JSON.parse(rex.inputs[at] ?? "")).toEqual({
      window_label: "ui",
      focus: false,
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          label: "ui",
          options: {
            command: ["claude", "--name", "ui", "--model", "opus", "--effort", "low", "--remote-control", "ui", "--append-system-prompt-file", `${state}/ui.system.md`],
            cwd: "/r",
            exit: { quick_exit_threshold_ms: 300 },
          },
        },
      },
    });
    expect(readFileSync(join(state, "ui.system.md"), "utf8")).toBe("Run the UI fleet.");
  });

  test("remote control off and no system prompt leave both out", () => {
    expect(claudeArgv(agent('{"fleet": {"role": "coordinator", "remote_control": false}}'), undefined)).toEqual(["claude", "--name", "ui", "--model", "opus", "--effort", "low"]);
  });

  test("an agent that says it is blocked at its start keeps its tab, for the user to answer", () => {
    const rex = fakeRex(statusIs("blocked"));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent() })).toEqual({ blocked: { handle: "window:1", label: "ui" } });
    expect(rex.calls.filter((c) => c.startsWith("window close"))).toEqual([]);
  });

  test("an agent that says nothing while its program runs is taken as waiting on a prompt in its tab", () => {
    const rex = fakeRex(statusIs(undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent() })).toEqual({ blocked: { handle: "window:1", label: "ui" } });
  });

  test("an agent whose program ends before it is ready has its tab closed, saying what it showed", () => {
    const rex = fakeRex((words) => {
      if (words.endsWith("program_status")) return { code: 0, stdout: '{"records":[]}', stderr: "" };

      if (words.endsWith("process")) return { code: 0, stdout: '{"last_exit":{"exit_code":1,"error":"exit status 1"}}', stderr: "" };

      return words.startsWith("capture") ? { code: 0, stdout: "\nError: unknown option --effort\n\n", stderr: "" } : undefined;
    });

    const tab = rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent() });

    expect(tab).toEqual({ why: "it ended before it was ready (exit status 1): Error: unknown option --effort" });
    expect(rex.calls.at(-1)).toBe(`window close -s ${SID} window:1`);
  });

  test("a rex call that fails while the agent starts is asked again until the start's wait ends, then its tab is closed, saying rex's error", () => {
    let fails = 1;
    const flaky = fakeRex((words) => (words.endsWith("program_status") && fails-- > 0 ? { code: 1, stdout: "", stderr: "Error: connection reset\n" } : statusIs("idle")(words)));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: flaky.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent() })).toEqual({ handle: "window:1", label: "ui" });
    expect(flaky.calls.filter((c) => c.startsWith("window close"))).toEqual([]);

    for (const failing of ["program_status", "process"]) {
      const rex = fakeRex((words) => (words.endsWith(failing) ? { code: 1, stdout: "", stderr: "Error: connection reset\n" } : statusIs(undefined)(words)));

      expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent() })).toEqual({ why: "rex block call: connection reset" });
      expect(rex.calls.at(-1)).toBe(`window close -s ${SID} window:1`);
    }
  });

  test("a prompt is typed into the agent's block, then Enter; one holding a line break is refused", () => {
    const rex = fakeRex(() => undefined);
    const launcher = rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST });

    expect(launcher.prompt("skills", "ui", "/tstack:coordinator Your ledger is /l.")).toBeUndefined();
    expect(rex.calls.slice(-2)).toEqual([`send -s ${SID} -b block:1`, `send-key -s ${SID} -b block:1 enter`]);
    expect(rex.inputs.at(-2)).toBe("/tstack:coordinator Your ledger is /l.");
    expect(launcher.prompt("skills", "ui", "two\nlines")).toEqual({ why: "a prompt holding a line break would be sent in parts" });
  });

  test("a look gives the windows as tabs and each block as an agent, with what its program says, a value rex's schema does not name as idle", () => {
    for (const [state, status] of [["idle", "ready"], ["done", "ready"], ["error", "ready"], ["sleeping", "ready"], ["working", "working"], ["blocked", "asking"]] as const) {
      const rex = fakeRex(statusIs(state));

      expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).look("skills")).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status }] });
    }
  });

  test("a look takes a program that runs and has said nothing as waiting on a prompt, as a start does; one that ended as unknown", () => {
    const look = (exit: string): Look | Why => {
      const rex = fakeRex((words) => statusIs(undefined)(words) ?? (words.endsWith("process") ? { code: 0, stdout: `{"last_exit":${exit}}`, stderr: "" } : undefined));

      return rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).look("skills");
    };

    expect(look("null")).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status: "asking" }] });
    expect(look('{"exit_code":0}')).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status: "unknown" }] });
  });

  test("settle waits a bounded time and says so when it gives up", () => {
    const rex = fakeRex(statusIs("working"));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST, settleMs: 120 }).settle("skills", "ui")).toEqual({ why: "it was not ready within 0.002 min" });
  });

  test("open reuses a session of its name, else makes one empty and hands back its ID; end kills only that one", () => {
    const rex = fakeRex((words) => (words === "api call session.create -" ? { code: 0, stdout: '{"session_id":"session:09"}', stderr: "" } : undefined));
    const launcher = rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST });

    expect(launcher.open("skills")).toEqual({ started: undefined });
    expect(launcher.open("web")).toEqual({ started: "session:09" });
    expect(rex.inputs.at(-1)).toBe('{"label":"web"}');
    expect(launcher.sessions()).toEqual(["skills", "other"]);
    expect(launcher.owns("skills", SID)).toBe(true);
    expect(launcher.owns("skills", "session:02")).toBe(false);
    expect(launcher.end("skills", "session:02")).toEqual({ why: "session skills runs, but not as the session fleet team started; left running" });
    expect(launcher.end("skills", SID)).toBeUndefined();
    expect(rex.calls.at(-1)).toBe(`kill ${SID}`);
  });

  test("two sessions of one label are refused rather than guessed between", () => {
    const rex = fakeRex((words) => (words === "ls --json" ? { code: 0, stdout: '{"sessions":[{"session_id":"session:01","label":"skills"},{"session_id":"session:03","label":"skills"}]}', stderr: "" } : undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).look("skills")).toEqual({ why: "rex has 2 sessions labelled skills (session:01, session:03); kill or rename all but one" });
  });

  test("a failed rex call says what rex said", () => {
    const rex = fakeRex((words) => (words.startsWith("window close") ? { code: 3, stdout: "", stderr: 'Error: window target "window:7" not found\n' } : undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).close("skills", "window:7")).toEqual({ why: 'rex window close: window target "window:7" not found' });
  });

  test("a failed rex call that said nothing says its exit code", () => {
    const rex = fakeRex((words) => (words === "ls --json" ? { code: 4, stdout: "", stderr: "\n" } : undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).sessions()).toEqual({ why: "rex ls --json: exit 4" });
  });
});

/** A command that reports `state` to the terminal as Claude Code does (OSC 7501), then prints its argument and
 * the line it reads. */
function reporting(state: string, word: string): readonly string[] {
  return ["/bin/sh", "-c", `printf '\\033]7501;state=${state}\\033\\\\'; printf 'arg=[%s]\\n' "$0"; read line; echo "got=$line"; sleep 600`, word];
}

describe.skipIf(Bun.which("rex") === null || process.env["FLEET_TEST_REX"] !== "1")("rex", () => {
  test(
    "a throwaway session takes tabs that are ready, ask or end, a prompt, a look, a settle, and is killed",
    () => {
      const session = `fleet-team-smoke-${Math.random().toString(36).slice(2, 10)}`;
      const run = rexRunner();
      let command: readonly string[] = reporting("idle", `it's a "quoted" word`);
      const launcher = rexLauncher({ state: tmp("fleet-team-rex-"), run, command: () => command, pollMs: 100, startMs: 5000, settleMs: 5000 });

      const ids = (): string[] => {
        const ran = run(["ls", "--json"]);

        return "why" in ran ? [] : labelled(ran.stdout, "sessions", "session_id", session);
      };

      try {
        const opened = launcher.open(session);

        if ("why" in opened || opened.started === undefined) throw new Error(`not started: ${JSON.stringify(opened)}`);
        const handle = opened.started;

        expect(launcher.open(session)).toEqual({ started: undefined });
        expect(launcher.owns(session, handle)).toBe(true);

        const ui = launcher.tab(session, { cwd: "/tmp", label: "ui", agent: agent() });

        expect(ui).toMatchObject({ label: "ui" });
        command = reporting("blocked:kind=question", "x");
        const web = launcher.tab(session, { cwd: "/tmp", label: "web", agent: agent('{"fleet": {"role": "coordinator"}}', "web") });

        expect(web).toMatchObject({ blocked: { label: "web" } });
        command = ["/bin/sh", "-c", "echo broken here; exit 3"];

        expect(launcher.tab(session, { cwd: "/tmp", label: "x", agent: agent('{"fleet": {"role": "coordinator"}}', "x") })).toEqual({ why: "it ended before it was ready (exit status 3): broken here" });

        const look = launcher.look(session);

        if ("why" in look || "why" in ui || "blocked" in ui || !("blocked" in web)) throw new Error(`look: ${JSON.stringify(look)}`);
        expect(look.tabs.map((t) => t.label)).toEqual(["ui", "web"]);
        expect(look.agents).toEqual([
          { name: "ui", tab: ui.handle, status: "ready" },
          { name: "web", tab: web.blocked.handle, status: "asking" },
        ]);

        expect(launcher.prompt(session, "ui", "hello there")).toBeUndefined();
        Bun.sleepSync(300);
        const blocks = run(["block", "ls", "-s", handle, "--json"]);
        const [block] = "why" in blocks ? [] : labelled(blocks.stdout, "blocks", "block_id", "ui");
        const shown = run(["capture", "-s", handle, "-b", block ?? "", "--trim"]);

        expect("why" in shown ? shown.why : shown.stdout).toContain(`arg=[it's a "quoted" word]\nhello there\ngot=hello there`);
        expect(launcher.settle(session, "ui")).toBeUndefined();

        expect(launcher.close(session, web.blocked.handle)).toBeUndefined();
        expect(launcher.close(session, ui.handle)).toBeUndefined();
        const empty = launcher.look(session);

        expect("why" in empty ? empty.why : empty.tabs).toEqual([]);
        expect(launcher.end(session, handle)).toBeUndefined();
        expect(launcher.sessions()).not.toContain(session);
        expect(launcher.owns(session, handle)).toBe(false);
      } finally {
        for (const id of ids()) run(["kill", id]);
      }

      expect(ids()).toEqual([]);
    },
    60_000,
  );
});
