/**
 * The rex adapter (src/team/rex.ts). On a fake runner that records each `rex` call and answers as rex does: the
 * session made empty, an agent's window and its command line, a start that is ready, asks, stays silent or
 * ends, a prompt, a look, the bounded settle, a program that ended, end by handle. On real rex, with FLEET_TEST_REX=1: a throwaway
 * session `fleet-team-smoke-<random>` whose tabs run sh, not claude, reporting their state as Claude Code does;
 * every session it made is killed.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

  test("a program that reported a state, then ended, has ended: its start fails saying how, and its tab is closed", () => {
    const rex = fakeRex((words) => statusIs("error")(words) ?? (words.endsWith("process") ? { code: 0, stdout: '{"last_exit":{"exit_code":1,"error":"exit status 1"}}', stderr: "" } : undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).tab("skills", { cwd: "/r", label: "ui", agent: agent() })).toEqual({ why: "it ended before it was ready (exit status 1)" });
    expect(rex.calls.at(-1)).toBe(`window close -s ${SID} window:1`);
  });

  test("a program whose block is gone while it starts (rex closes the tab of one that exits 0) fails at once, saying so", () => {
    const gone: Ran = { code: 3, stdout: "", stderr: 'Error: block target "block:1" not found\n' };
    const rex = fakeRex((words) => (words.endsWith("program_status") || words.endsWith("process") ? gone : words.includes("block ls") ? { code: 0, stdout: '{"blocks":[]}', stderr: "" } : undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST, startMs: 2000 }).tab("skills", { cwd: "/r", label: "ui", agent: agent() })).toEqual({
      why: "it ended before it was ready, its tab gone with it (rex closes the tab of a program that exits 0)",
    });
    expect(rex.calls.filter((c) => c.startsWith("block call"))).toHaveLength(1);
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

  test("a prompt holding a line break is refused", () => {
    const rex = fakeRex(() => undefined);

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).prompt("skills", "ui", "two\nlines")).toEqual({ why: "a prompt holding a line break would be sent in parts" });
    expect(rex.calls).toEqual([]);
  });

  test("a look gives the windows as tabs and each block as an agent, with what its program says, a value rex's schema does not name as idle", () => {
    for (const [state, status] of [["idle", "ready"], ["done", "ready"], ["error", "ready"], ["sleeping", "ready"], ["working", "working"], ["blocked", "asking"]] as const) {
      const rex = fakeRex(statusIs(state));

      expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).look("skills")).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status }] });
    }
  });

  test("a look takes a program that runs and has said nothing as waiting on a prompt, as a start does; one that ended as ended, whatever it last said", () => {
    const look = (exit: string, said?: string): Look | Why => {
      const rex = fakeRex((words) => statusIs(said)(words) ?? (words.endsWith("process") ? { code: 0, stdout: `{"last_exit":${exit}}`, stderr: "" } : undefined));

      return rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).look("skills");
    };

    expect(look("null")).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status: "asking" }] });
    expect(look('{"exit_code":1,"error":"exit status 1"}')).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status: "ended", ended: expect.any(Function) }] });
    expect(look('{"exit_code":1,"error":"exit status 1"}', "idle")).toEqual({ tabs: [{ handle: "window:1", label: "ui" }], agents: [{ name: "ui", tab: "window:1", status: "ended", ended: expect.any(Function) }] });
  });

  test("a look says how a program ended and the last lines its block shows, while the tab that holds them is there, reading the block's scrollback only when asked", () => {
    const rex = fakeRex((words) => {
      if (words.endsWith("process")) return { code: 0, stdout: '{"last_exit":{"exit_code":3}}', stderr: "" };

      return words.includes("capture") ? { code: 0, stdout: "one\n\ntwo\nthree\nfour\n", stderr: "" } : undefined;
    });

    const look = rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST }).look("skills");
    const captures = (): string[] => rex.calls.filter((c) => c.startsWith("capture"));

    expect(captures()).toEqual([]);
    expect("why" in look ? look.why : look.agents[0]?.ended?.()).toBe("exit 3: two / three / four");
    expect(captures()).toHaveLength(1);
  });

  test("a block's scrollback past spawnSync's default 1 MiB still comes back, so a long-lived agent's last lines are said", () => {
    const bin = join(tmp("fleet-team-rex-bin-"), "rex");
    writeFileSync(bin, "#!/bin/sh\nhead -c 2097152 /dev/zero | tr '\\0' x\necho\necho 'Error: the last line'\n", { mode: 0o755 });
    const ran = rexRunner(bin)(["capture"]);

    expect("why" in ran ? ran.why : ran.stdout.split("\n").map((l) => l.length)).toEqual([2_097_152, 20, 0]);
  });

  test("owns says why when rex cannot say, and end stops nothing then", () => {
    const rex = fakeRex((words) => (words === "ls --json" ? { code: 1, stdout: "", stderr: "Error: connection reset\n" } : undefined));
    const launcher = rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST });

    expect(launcher.owns("skills", SID)).toEqual({ why: "rex ls --json: connection reset" });
    expect(launcher.end("skills", SID)).toEqual({ why: "rex ls --json: connection reset" });
    expect(rex.calls).not.toContain(`kill ${SID}`);
  });

  test("an exit 0 that prints no JSON is rex not saying, which no read takes for no sessions", () => {
    const rex = fakeRex((words) => (words === "ls --json" ? { code: 0, stdout: "rex: waking the daemon\n", stderr: "" } : undefined));
    const launcher = rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST });
    const said = { why: "rex ls --json: it printed no JSON object" };

    expect(launcher.sessions()).toEqual(said);
    expect(launcher.owns("skills", SID)).toEqual(said);
    expect(launcher.open("skills")).toEqual(said);
    expect(launcher.end("skills", SID)).toEqual(said);
    expect(rex.calls.filter((c) => c !== "ls --json")).toEqual([]);
  });

  test("settle waits a bounded time and says so when it gives up", () => {
    const rex = fakeRex(statusIs("working"));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST, settleMs: 120 }).settle("skills", "ui")).toEqual({ why: "it was not ready within 0.002 min" });
  });

  test("settle says at once when the agent is ready, or its program has ended", () => {
    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: fakeRex(statusIs("idle")).run, ...FAST }).settle("skills", "ui")).toBe("ready");
    const rex = fakeRex((words) => statusIs("working")(words) ?? (words.endsWith("process") ? { code: 0, stdout: '{"last_exit":{"exit_code":1,"error":"exit status 1"}}', stderr: "" } : undefined));

    expect(rexLauncher({ state: tmp("fleet-team-state-"), run: rex.run, ...FAST, settleMs: 600_000 }).settle("skills", "ui")).toBe("ended");
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
 * the line it reads, working on it for a second. */
function reporting(state: string, word: string): readonly string[] {
  const report = (to: string): string => `printf '\\033]7501;state=${to}\\033\\\\'`;

  return ["/bin/sh", "-c", `${report(state)}; printf 'arg=[%s]\\n' "$0"; read line; ${report("working")}; echo "got=$line"; sleep 1; ${report("idle")}; sleep 600`, word];
}

const OPENING = "/tstack:coordinator Your ledger is /l.";

/** How a {@link fakeClaude} behaves. */
interface Claude {
  /** How long typed text is taken as a paste: an Enter in that time lands inside it as a line break. */
  readonly pasteMs?: number;
  /** How many Enters on a settled input are lost before one starts the turn. */
  readonly deaf?: number;
  /** The input shows a paste taken whole as Claude Code's stand-in. */
  readonly marker?: boolean;
  /** The input's width, past which Ink wraps its rows. */
  readonly width?: number;
  /** The turn starts on a permission dialog, which an Enter approves. */
  readonly dialog?: boolean;
  /** The input already holds this text, from an earlier prompt. */
  readonly held?: string;
  /** Typed text never reaches the input. */
  readonly lost?: boolean;
  /** The program exits on Enter, its block gone with it. */
  readonly exits?: boolean;
  /** The program reports its dialog late: done while the dialog shows. */
  readonly lagging?: boolean;
}

/** Claude Code's input in a block, framed by rules as Claude Code draws it, on a clock the test owns. */
function fakeClaude(o: Claude = {}): FakeRex & { readonly launcher: ReturnType<typeof rexLauncher>; readonly started: () => boolean; readonly approved: () => boolean } {
  let clock = 0;
  let input: "empty" | "pasting" | "typed" | "broken" | "working" | "dialog" = o.held === undefined ? "empty" : "typed";
  let settles = 0;
  let deaf = o.deaf ?? 0;
  let text = o.held ?? "";
  let approved = false;
  let gone = false;
  const width = o.width ?? 80;

  const wrapped = (line: string): string[] => {
    const rows: string[] = [];

    for (let at = 0; at < line.length; at += width) rows.push(`${at === 0 ? ">" : " "} ${line.slice(at, at + width)}`);

    return rows;
  };

  const screen = (): string => {
    const rule = "─".repeat(width + 2);
    const boxed = (above: readonly string[], rows: readonly string[]): string => [...above, rule, ...rows, rule, "  ? for shortcuts"].join("\n");

    switch (input) {
      case "empty":
      case "pasting":
        return boxed([], ["> "]);
      case "typed":
        return boxed([], o.marker === true ? ["> [Pasted text #1 +0 lines]"] : wrapped(text));
      case "broken":
        return boxed([], ["> [Pasted text #1 +1 lines]"]);
      case "working":
        return boxed([...wrapped(text), "* Working"], ["> "]);
      case "dialog":
        return [...wrapped(text), "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    }
  };

  const enter = (): void => {
    if (input === "pasting") input = "broken";
    else if (input === "dialog") approved = true;
    else if (deaf > 0) deaf -= 1;
    else if (input === "typed" || input === "broken") input = o.dialog === true ? "dialog" : "working";
  };

  const rex = fakeRex((words) => {
    if (input === "pasting" && clock >= settles) input = "typed";

    if (gone) return words.includes("block ls") ? { code: 0, stdout: '{"blocks":[]}', stderr: "" } : { code: 1, stdout: "", stderr: "Error: block block:1 not found\n" };

    if (words.startsWith("send -s") && o.lost !== true) {
      input = "pasting";
      settles = clock + (o.pasteMs ?? 0);
    }

    if (words.startsWith("send-key")) {
      if (o.exits === true) {
        gone = true;

        return { code: 1, stdout: "", stderr: "Error: block block:1 not found\n" };
      }

      enter();
    }

    if (words.startsWith("capture")) return { code: 0, stdout: `${screen()}\n`, stderr: "" };

    return statusIs(input === "working" ? "working" : input === "dialog" && o.lagging !== true ? "blocked" : "done")(words);
  });

  const run: RexRunner = (args, given) => {
    if (args[0] === "send" && o.lost !== true) text = given ?? "";

    return rex.run(args, given);
  };

  const launcher = rexLauncher({ state: tmp("fleet-team-state-"), run, pollMs: 500, now: () => clock, sleep: (ms) => (clock += ms) });

  return { ...rex, run, launcher, started: () => input === "working", approved: () => approved };
}

const enters = (calls: readonly string[]): number => calls.filter((c) => c.startsWith("send-key")).length;

describe("a prompt", () => {
  test("Enter waits while Claude Code still takes the typed text as a paste, so it does not land inside it", () => {
    const claude = fakeClaude({ pasteMs: 1_500 });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    expect(claude.started()).toBe(true);
    expect(enters(claude.calls)).toBe(1);
  });

  test("Enter waits for Claude Code's stand-in for a paste it took whole", () => {
    const claude = fakeClaude({ pasteMs: 1_000, marker: true });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    expect(claude.started()).toBe(true);
  });

  test("is typed into the agent's block, read back from its input, then Enter once, when the first Enter starts it", () => {
    const claude = fakeClaude();

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    const at = claude.calls.indexOf(`send -s ${SID} -b block:1`);

    expect(claude.inputs[at]).toBe(OPENING);
    expect(claude.calls.slice(at + 1, at + 3)).toEqual([`capture -s ${SID} -b block:1 --trim --unwrap`, `send-key -s ${SID} -b block:1 enter`]);
    expect(claude.calls.filter((c) => c.startsWith("send"))).toHaveLength(2);
  });

  test("an Enter that did not start the agent is pressed once more", () => {
    const claude = fakeClaude({ deaf: 1 });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    expect(claude.started()).toBe(true);
    expect(enters(claude.calls)).toBe(2);
  });

  test("an agent two Enters did not start fails the prompt, saying so, after a bounded wait", () => {
    const claude = fakeClaude({ deaf: 2 });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toEqual({ why: "Enter, pressed twice, did not start it: its opening still sits in its input" });
    expect(enters(claude.calls)).toBe(2);
  });

  test("an input Ink wraps across rows is read as one, so a text still sitting in it is not taken as sent", () => {
    const claude = fakeClaude({ width: 12, deaf: 2 });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toEqual({ why: "Enter, pressed twice, did not start it: its opening still sits in its input" });
  });

  test("an input Ink wraps across rows, once it holds the text, takes Enter", () => {
    const claude = fakeClaude({ width: 12, pasteMs: 1_000 });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    expect(claude.started()).toBe(true);
  });

  test("a text that never shows in the input fails the prompt, Enter never pressed", () => {
    const claude = fakeClaude({ lost: true });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toEqual({ why: "its opening did not show in its input within 5 s, so Enter was not pressed" });
    expect(enters(claude.calls)).toBe(0);
  });

  test("an Enter that opened a permission dialog started the turn: no second Enter approves it", () => {
    const claude = fakeClaude({ dialog: true });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    expect(enters(claude.calls)).toBe(1);
    expect(claude.approved()).toBe(false);
  });

  test("a dialog whose state lags, its screen drawing no input, gets no second Enter: the prompt fails, saying so", () => {
    const claude = fakeClaude({ dialog: true, lagging: true });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toEqual({ why: "Enter did not start it, and its screen shows no input to read, so no second Enter was pressed (it could answer a dialog)" });
    expect(enters(claude.calls)).toBe(1);
    expect(claude.approved()).toBe(false);
  });

  test("an input still holding the text from an earlier prompt takes Enter only, the text not typed again", () => {
    const claude = fakeClaude({ held: OPENING });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toBeUndefined();
    expect(claude.calls.filter((c) => c.startsWith("send -s"))).toEqual([]);
    expect(claude.started()).toBe(true);
  });

  test("a program that exits on Enter, its block gone, fails the prompt saying it ended, not rex's error", () => {
    const claude = fakeClaude({ exits: true });

    expect(claude.launcher.prompt("skills", "ui", OPENING)).toEqual({ why: "its program ended before it took its opening, its tab gone with it" });
  });
});

describe.skipIf(Bun.which("rex") === null || process.env["FLEET_TEST_REX"] !== "1")("rex", () => {
  test(
    "a throwaway session takes tabs that are ready, ask, end, or fail after they were ready, a prompt, a look, a settle, and is killed",
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

        command = ["/bin/sh", "-c", "printf '\\033]7501;state=idle\\033\\\\'; sleep 1; exit 4"];
        const dying = launcher.tab(session, { cwd: "/tmp", label: "dying", agent: agent('{"fleet": {"role": "coordinator"}}', "dying") });

        expect(dying).toMatchObject({ label: "dying" });
        Bun.sleepSync(1500);
        const look = launcher.look(session);

        if ("why" in look || "why" in ui || "blocked" in ui || !("blocked" in web) || "why" in dying || "blocked" in dying) throw new Error(`look: ${JSON.stringify(look)}`);
        expect(look.tabs.map((t) => t.label)).toEqual(["ui", "web", "dying"]);
        expect(look.agents).toEqual([
          { name: "ui", tab: ui.handle, status: "ready" },
          { name: "web", tab: web.blocked.handle, status: "asking" },
          { name: "dying", tab: dying.handle, status: "ended", ended: expect.any(Function) },
        ]);
        expect(look.agents[2]?.ended?.()).toContain("exit status 4");
        expect(launcher.settle(session, "dying")).toBe("ended");
        expect(launcher.close(session, dying.handle)).toBeUndefined();

        expect(launcher.prompt(session, "ui", "hello there")).toBeUndefined();
        Bun.sleepSync(300);
        const blocks = run(["block", "ls", "-s", handle, "--json"]);
        const [block] = "why" in blocks ? [] : labelled(blocks.stdout, "blocks", "block_id", "ui");
        const shown = run(["capture", "-s", handle, "-b", block ?? "", "--trim"]);

        expect("why" in shown ? shown.why : shown.stdout).toContain(`arg=[it's a "quoted" word]\nhello there\ngot=hello there`);
        expect(launcher.settle(session, "ui")).toBe("ready");

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
