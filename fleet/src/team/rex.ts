/**
 * The {@link Launcher} over Superlogical rex's CLI. A team's session is a rex session labelled with its name,
 * made empty (`rex api call session.create`); each agent runs in a window of its own (`session.new_window`),
 * window and block labelled with the agent's name, the block running the agent's command line as given, with
 * no shell quoting in between (the terminal block's `command`). Handles are rex's IDs, which rex never reuses:
 * the session's for a session, the window's for a tab. A program that fails within the start's wait keeps its
 * block, ended, for the start, a look and a settle to see; one that exits 0, or later, takes its block with it,
 * as rex does by default. Claude Code reports its state to the terminal (the program status protocol, OSC 7501),
 * which `program_status` reads back, its last report kept after the program ends: idle or done is ready, working
 * is working, blocked is asking ({@link statusOf}); a program that ended has ended, whatever it last reported.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Option from "effect/Option";

import { strerror, writeOrWhy } from "../files.ts";
import { asArray, asNumber, asObject, asString, parseObject, type JsonObject } from "../json.ts";
import type { Agent, Why } from "./agents.ts";
import type { Handle, Launcher, Look, Seen, Status, Tab } from "./launcher.ts";

/** How long a start waits for Claude Code to say it is ready for its first prompt. */
const START_MS = 120_000;

/** How long `settle` waits for an agent to finish its turn before it gives up. */
const SETTLE_MS = 600_000;

/** How often a wait asks rex again. */
const POLL_MS = 500;

/** How long a prompt waits for its text to show in the agent's input before it presses Enter. */
const TYPED_MS = 5_000;

/** How long a prompt waits for an Enter to start the agent's turn. */
const STARTED_MS = 5_000;

/** How many of a block's last lines are read as Claude Code's input when no rules frame it. */
const SCREEN_LINES = 30;

/** How much of a prompt's start, its spaces dropped, must show for it to be in the input. */
const SHOWN_CHARS = 40;

/** A rule framing Claude Code's input, plain or boxed. */
const RULE = /^[\s─╭╮╰╯]*─{3,}[\s─╭╮╰╯]*$/u;

/** What the input's rows hold besides the text: Ink's wrap, the prompt glyph, the box's sides. */
const FRAMING = /[\s│>❯]/gu;

/** Claude Code's stand-in for a paste it took whole. */
const PASTED = /\[Pasted text #\d+/;

/** The terminal block's flavor. */
const TERMINAL = "com.superlogical.terminal.shell";

/** The most one `rex` run may print: `rex capture` prints a block's whole scrollback, up to 64 MiB, and over
 * spawnSync's default of 1 MiB a run fails with nothing to show. */
const PRINTED_MAX = 128 * 1024 * 1024;

/** What one `rex` run printed, and its exit code. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How the adapter runs rex: its arguments, and its stdin when given. */
export type RexRunner = (args: readonly string[], input?: string) => Ran | Why;

/** The installed `rex`, run to its end. */
export function rexRunner(bin = "rex"): RexRunner {
  return (args, input) => {
    const options = { encoding: "utf8", maxBuffer: PRINTED_MAX } as const;
    const done = input === undefined ? spawnSync(bin, args, options) : spawnSync(bin, args, { ...options, input });

    return done.error === undefined ? { code: done.status ?? 1, stdout: done.stdout, stderr: done.stderr } : { why: `rex could not run: ${strerror(done.error)}` };
  };
}

/** How the rex adapter is built. */
export interface RexOptions {
  /** The team's folder, where an agent's system prompt is written for `--append-system-prompt-file`. */
  readonly state: string;
  readonly run?: RexRunner;
  /** For tests: what a tab runs in place of Claude Code. */
  readonly command?: (agent: Agent) => readonly string[];
  readonly startMs?: number;
  readonly settleMs?: number;
  readonly pollMs?: number;
  /** For tests: the clock in ms, and how a wait sleeps. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
}

/** The command line of an agent's tab: a new Claude Code conversation (never a resume) named after it, its
 * `system` in `systemFile`. */
export function claudeArgv(agent: Agent, systemFile: string | undefined): string[] {
  return [
    "claude",
    "--name",
    agent.name,
    "--model",
    agent.model.id,
    "--effort",
    agent.model.effort,
    ...(agent.fleet.remote_control ? ["--remote-control", agent.name] : []),
    ...(systemFile === undefined ? [] : ["--append-system-prompt-file", systemFile]),
  ];
}

/** A running program's state in `fleet team`'s words, from the state it last reported (undefined: none). Claude
 * Code reports nothing before its prompt is up, so one that has said nothing waits on a prompt in its tab (trust,
 * an MCP server's approval). An error ended its turn, and it takes the next prompt; a state rex's schema does not
 * name is idle, as the schema says. */
export function statusOf(state: string | undefined): Status {
  switch (state) {
    case undefined:
      return "asking";
    case "working":
      return "working";
    case "blocked":
      return "asking";
    default:
      return "ready";
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rowsOf(object: JsonObject, key: string): JsonObject[] {
  return (asArray(object[key]) ?? []).flatMap((row) => {
    const value = asObject(row);

    return value === undefined ? [] : [value];
  });
}

/** One block of a session: the agent it is labelled with, and its window. */
interface Block {
  readonly id: string;
  readonly label: string;
  readonly window: string;
}

/** The {@link Launcher} over rex on this machine. */
export function rexLauncher(options: RexOptions): Launcher {
  const run = options.run ?? rexRunner();
  const startMs = options.startMs ?? START_MS;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepMs;

  /** What `probe` finds before `ms` pass, asked every poll; undefined when it found nothing. */
  const until = <T>(ms: number, probe: () => T | undefined): T | undefined => {
    for (const deadline = now() + ms; ; sleep(pollMs)) {
      const found = probe();

      if (found !== undefined) return found;

      if (now() >= deadline) return undefined;
    }
  };

  /** What rex printed for `args`, or why it failed. */
  const printed = (args: readonly string[], input?: string): { readonly stdout: string } | Why => {
    const ran = run(args, input);

    if ("why" in ran) return ran;

    if (ran.code !== 0) {
      const said = ran.stderr.trim().split("\n")[0]?.replace(/^Error: /, "") ?? "";

      return { why: `rex ${args.slice(0, 2).join(" ")}: ${said === "" ? `exit ${String(ran.code)}` : said}` };
    }

    return { stdout: ran.stdout };
  };

  const rex = (args: readonly string[], input?: string): { readonly result: JsonObject } | Why => {
    const out = printed(args, input);

    return "why" in out ? out : { result: Option.getOrUndefined(parseObject(out.stdout)) ?? {} };
  };

  /** The sessions rex runs; why when it fails, or prints what no list can be read from, which is never no sessions. */
  const listed = (): readonly { readonly id: string; readonly label: string }[] | Why => {
    const out = printed(["ls", "--json"]);

    if ("why" in out) return out;
    const answer = Option.getOrUndefined(parseObject(out.stdout));

    if (answer === undefined) return { why: "rex ls --json: it printed no JSON object" };

    return rowsOf(answer, "sessions").flatMap((s) => {
      const id = asString(s["session_id"]);
      const label = asString(s["label"]);

      return id === undefined || label === undefined ? [] : [{ id, label }];
    });
  };

  /** The ID of the one session labelled `name`. */
  const idOf = (name: string): { readonly sid: string } | Why => {
    const sessions = listed();

    if ("why" in sessions) return sessions;
    const ids = sessions.filter((s) => s.label === name).map((s) => s.id);
    const [sid] = ids;

    if (ids.length > 1) return { why: `rex has ${String(ids.length)} sessions labelled ${name} (${ids.join(", ")}); kill or rename all but one` };

    return sid === undefined ? { why: `rex has no session labelled ${name}` } : { sid };
  };

  const blocksOf = (sid: string): readonly Block[] | Why => {
    const answer = rex(["block", "ls", "-s", sid, "--json"]);

    return "why" in answer
      ? answer
      : rowsOf(answer.result, "blocks").flatMap((b) => {
          const id = asString(b["block_id"]);
          const label = asString(b["label"]);
          const window = asString(b["window_id"]);

          return id === undefined || label === undefined || window === undefined ? [] : [{ id, label, window }];
        });
  };

  /** The block of agent `agent` in the session labelled `session`, and the session's ID. */
  const blockFor = (session: string, agent: string): { readonly sid: string; readonly block: Block } | Why => {
    const found = idOf(session);

    if ("why" in found) return found;
    const blocks = blocksOf(found.sid);

    if ("why" in blocks) return blocks;
    const mine = blocks.filter((b) => b.label === agent);
    const [block] = mine;

    if (mine.length > 1) return { why: `${String(mine.length)} blocks are labelled ${agent}` };

    return block === undefined ? { why: `no block is labelled ${agent}` } : { sid: found.sid, block };
  };

  /** The state the block's program last said it is in (its root record's); undefined when it said nothing. */
  const reported = (sid: string, block: string): { readonly state: string | undefined } | Why => {
    const answer = rex(["block", "call", "-s", sid, "-b", block, "program_status"]);

    return "why" in answer ? answer : { state: asString(rowsOf(answer.result, "records").find((r) => r["id"] === undefined)?.["state"]) };
  };

  /** How the block's program exited, in a phrase; undefined while it runs. */
  const exited = (sid: string, block: string): { readonly ended: string | undefined } | Why => {
    const answer = rex(["block", "call", "-s", sid, "-b", block, "process"]);

    if ("why" in answer) return answer;
    const last = asObject(answer.result["last_exit"]);

    return { ended: last === undefined ? undefined : (asString(last["error"]) ?? `exit ${String(asNumber(last["exit_code"]) ?? "unknown")}`) };
  };

  /** The block's program now: how it ended, else the state it last reported (undefined: none). */
  const programOf = (sid: string, block: string): { readonly state: string | undefined } | { readonly ended: string } | Why => {
    const end = exited(sid, block);

    if ("why" in end) return end;

    return end.ended === undefined ? reported(sid, block) : { ended: end.ended };
  };

  /** Whether rex lists the session's blocks and `block` is not among them. */
  const gone = (sid: string, block: string): boolean => {
    const blocks = blocksOf(sid);

    return !("why" in blocks) && !blocks.some((b) => b.id === block);
  };

  /** The last lines the block shows, for a program that ended. */
  const tail = (sid: string, block: string): string => {
    const ran = run(["capture", "-s", sid, "-b", block, "--trim"]);

    return "why" in ran ? "" : ran.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-3).join(" / ");
  };

  /** Block `b`'s agent now, how its program ended when it did, read when asked; unknown when rex cannot say. */
  const seenOf = (sid: string, b: Block): Seen => {
    const seen = { name: b.label, tab: b.window };
    const program = programOf(sid, b.id);

    if ("why" in program) return { ...seen, status: "unknown" };

    if (!("ended" in program)) return { ...seen, status: statusOf(program.state) };

    const ended = (): string => {
      const shown = tail(sid, b.id);

      return shown === "" ? program.ended : `${program.ended}: ${shown}`;
    };

    return { ...seen, status: "ended", ended };
  };

  /** Whether Claude Code's input in the block holds `text`, its rows joined across Ink's wrap, or a paste taken
   * whole; undefined when rex cannot say, or, when `framed`, when no rules frame an input. */
  const holding = (sid: string, block: string, text: string, framed = false): boolean | undefined => {
    const out = printed(["capture", "-s", sid, "-b", block, "--trim", "--unwrap"]);

    if ("why" in out) return undefined;
    const lines = out.stdout.split("\n");
    const rules = lines.flatMap((line, at) => (RULE.test(line) ? [at] : []));
    const [top, bottom] = rules.slice(-2);

    if (framed && bottom === undefined) return undefined;
    const input = (top === undefined || bottom === undefined ? lines.slice(-SCREEN_LINES) : lines.slice(top + 1, bottom)).join("\n");

    return input.replace(FRAMING, "").includes(text.replace(FRAMING, "").slice(0, SHOWN_CHARS)) || PASTED.test(input);
  };

  /** Why the block's program cannot take a prompt: it ended, or its block is gone with it. */
  const endedWhy = (sid: string, block: string): Why | undefined => {
    const end = exited(sid, block);

    if (!("why" in end) && end.ended !== undefined) return { why: `its program ended before it took its opening (${end.ended})` };

    return gone(sid, block) ? { why: "its program ended before it took its opening, its tab gone with it" } : undefined;
  };

  /** What an Enter on `text` did: started the agent's turn (it left ready, or its input no longer holds the text it
   * held), its program ended, or nothing yet. */
  const afterEnter = (sid: string, block: string, text: string): "started" | Why | undefined => {
    const program = programOf(sid, block);

    if ("why" in program) return endedWhy(sid, block);

    if ("ended" in program) return { why: `its program ended before it took its opening (${program.ended})` };

    return statusOf(program.state) !== "ready" || holding(sid, block, text, true) === false ? "started" : undefined;
  };

  const argvOf = (agent: Agent): readonly string[] | Why => {
    if (options.command !== undefined) return options.command(agent);

    if (agent.system === undefined) return claudeArgv(agent, undefined);
    const file = join(options.state, `${agent.name}.system.md`);

    return writeOrWhy(file, agent.system) ?? claudeArgv(agent, file);
  };

  const owns = (name: string, handle: Handle): boolean | Why => {
    const sessions = listed();

    return "why" in sessions ? sessions : sessions.some((s) => s.id === handle && s.label === name);
  };

  return {
    sessions() {
      const sessions = listed();

      return "why" in sessions ? sessions : sessions.map((s) => s.label);
    },

    owns,

    open(name) {
      const sessions = listed();

      if ("why" in sessions) return sessions;

      if (sessions.some((s) => s.label === name)) return { started: undefined };
      const made = rex(["api", "call", "session.create", "-"], JSON.stringify({ label: name }));

      if ("why" in made) return { why: made.why };
      const id = asString(made.result["session_id"]);

      return id === undefined ? { why: `rex made session ${name} but did not say its ID` } : { started: id };
    },

    tab(session, launch) {
      const argv = argvOf(launch.agent);

      if ("why" in argv) return argv;
      const found = idOf(session);

      if ("why" in found) return found;
      const { sid } = found;
      const exit = { quick_exit_threshold_ms: startMs };
      const layout = { block: { flavor: TERMINAL, label: launch.agent.name, options: { command: argv, cwd: launch.cwd, exit } } };
      const made = rex(["api", "call", "-s", sid, "session.new_window", "-"], JSON.stringify({ window_label: launch.label, focus: false, layout }));

      if ("why" in made) return { why: made.why };
      const window = asString(made.result["window_id"]);
      const block = asString(asArray(made.result["block_ids"])?.[0]);

      if (window === undefined || block === undefined) return { why: "rex made a window but did not say its ID or its block's" };
      const tab: Tab = { handle: window, label: launch.label };

      let failed: Why | undefined;

      for (const deadline = now() + startMs; now() < deadline; sleep(pollMs)) {
        const program = programOf(sid, block);

        if ("why" in program) {
          if (gone(sid, block)) return { why: "it ended before it was ready, its tab gone with it (rex closes the tab of a program that exits 0)" };
          failed = program;
          continue;
        }

        failed = undefined;

        if ("ended" in program) {
          const shown = tail(sid, block);
          rex(["window", "close", "-s", sid, window]);

          return { why: `it ended before it was ready (${program.ended})${shown === "" ? "" : `: ${shown}`}` };
        }

        const status = program.state === undefined ? undefined : statusOf(program.state);

        if (status === "ready") return tab;

        if (status === "asking") return { blocked: tab };
      }

      if (failed === undefined) return { blocked: tab };
      rex(["window", "close", "-s", sid, window]);

      return failed;
    },

    prompt(session, agent, text) {
      if (/[\r\n]/.test(text)) return { why: "a prompt holding a line break would be sent in parts" };
      const found = blockFor(session, agent);

      if ("why" in found) return found;
      const { sid, block } = found;
      const holds = (): true | undefined => holding(sid, block.id, text) || undefined;

      if (holds() === undefined) {
        const typed = rex(["send", "-s", sid, "-b", block.id], text);

        if ("why" in typed) return { why: typed.why };

        if (until(TYPED_MS, holds) === undefined) return { why: `its opening did not show in its input within ${String(TYPED_MS / 1000)} s, so Enter was not pressed` };
      }

      for (let pressed = 0; pressed < 2; pressed += 1) {
        const sent = rex(["send-key", "-s", sid, "-b", block.id, "enter"]);

        if ("why" in sent) return endedWhy(sid, block.id) ?? { why: sent.why };
        const took = until(STARTED_MS, () => afterEnter(sid, block.id, text));

        if (took === "started") return undefined;

        if (took !== undefined) return took;

        if (holding(sid, block.id, text, true) === undefined) return { why: "Enter did not start it, and its screen shows no input to read, so no second Enter was pressed (it could answer a dialog)" };
      }

      return { why: "Enter, pressed twice, did not start it: its opening still sits in its input" };
    },

    look(session) {
      const found = idOf(session);

      if ("why" in found) return found;
      const { sid } = found;
      const windows = rex(["window", "ls", "-s", sid, "--json"]);

      if ("why" in windows) return { why: windows.why };
      const blocks = blocksOf(sid);

      if ("why" in blocks) return blocks;

      const tabs = rowsOf(windows.result, "windows").flatMap((w): Tab[] => {
        const handle = asString(w["window_id"]);
        const label = asString(w["label"]);

        return handle === undefined || label === undefined ? [] : [{ handle, label }];
      });

      const agents = blocks.map((b) => seenOf(sid, b));

      return { tabs, agents } satisfies Look;
    },

    settle(session, agent) {
      const found = blockFor(session, agent);

      if ("why" in found) return found;
      const { sid, block } = found;

      for (const deadline = now() + settleMs; now() < deadline; sleep(pollMs)) {
        const program = programOf(sid, block.id);

        if ("why" in program) return program;

        if ("ended" in program) return "ended";

        if (program.state !== undefined && statusOf(program.state) === "ready") return "ready";
      }

      return { why: `it was not ready within ${String(settleMs / 60_000)} min` };
    },

    close(session, tab) {
      const found = idOf(session);

      if ("why" in found) return found;
      const { sid } = found;
      const closed = rex(["window", "close", "-s", sid, tab]);

      return "why" in closed ? { why: closed.why } : undefined;
    },

    end(name, handle) {
      const owned = owns(name, handle);

      if (owned === false) return { why: `session ${name} runs, but not as the session fleet team started; left running` };

      if (owned !== true) return owned;
      const killed = rex(["kill", handle]);

      return "why" in killed ? { why: killed.why } : undefined;
    },

    attach(name) {
      const found = idOf(name);

      if ("why" in found) {
        process.stderr.write(`team: ${found.why}\n`);

        return 1;
      }

      const shown = run(["do", "session.select", `session_id=${found.sid}`]);

      if ("why" in shown || shown.code !== 0) process.stderr.write(`team: rex could not show session ${name} in the Rex app: ${"why" in shown ? shown.why : shown.stderr.trim()}\n`);

      return "why" in shown ? 1 : shown.code;
    },
  };
}
