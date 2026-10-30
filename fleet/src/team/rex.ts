/**
 * The {@link Launcher} over Superlogical rex's CLI. A team's session is a rex session labelled with its name,
 * made empty (`rex api call session.create`); each agent runs in a window of its own (`session.new_window`),
 * window and block labelled with the agent's name, the block running the agent's command line as given, with
 * no shell quoting in between (the terminal block's `command`). Handles are rex's IDs, which rex never reuses:
 * the session's for a session, the window's for a tab. Claude Code reports its state to the terminal (the
 * program status protocol, OSC 7501), which `program_status` reads back: idle or done is ready, working is
 * working, blocked is asking ({@link statusOf}).
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

/** The terminal block's flavor. */
const TERMINAL = "com.superlogical.terminal.shell";

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
    const done = input === undefined ? spawnSync(bin, args, { encoding: "utf8" }) : spawnSync(bin, args, { encoding: "utf8", input });

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

/** A program's state in `fleet team`'s words, from the state it last reported (undefined: none) and whether it
 * still runs. Claude Code reports nothing before its prompt is up, so one that runs and has said nothing waits on
 * a prompt in its tab (trust, an MCP server's approval). An error ended its turn, and it takes the next prompt;
 * a state rex's schema does not name is idle, as the schema says. */
export function statusOf(state: string | undefined, running: boolean): Status {
  switch (state) {
    case undefined:
      return running ? "asking" : "unknown";
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

  const rex = (args: readonly string[], input?: string): { readonly result: JsonObject } | Why => {
    const ran = run(args, input);

    if ("why" in ran) return ran;

    if (ran.code !== 0) return { why: `rex ${args.slice(0, 2).join(" ")}: ${ran.stderr.trim().split("\n")[0]?.replace(/^Error: /, "") ?? `exit ${String(ran.code)}`}` };

    return { result: Option.getOrUndefined(parseObject(ran.stdout)) ?? {} };
  };

  const listed = (): readonly { readonly id: string; readonly label: string }[] | Why => {
    const answer = rex(["ls", "--json"]);

    return "why" in answer
      ? answer
      : rowsOf(answer.result, "sessions").flatMap((s) => {
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

  /** The block of agent `agent` in session `sid`. */
  const blockOf = (sid: string, agent: string): Block | Why => {
    const blocks = blocksOf(sid);

    if ("why" in blocks) return blocks;
    const mine = blocks.filter((b) => b.label === agent);

    if (mine.length > 1) return { why: `${String(mine.length)} blocks are labelled ${agent}` };

    return mine[0] ?? { why: `no block is labelled ${agent}` };
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

  /** The block's program's state now; unknown when rex cannot say. */
  const statusNow = (sid: string, block: string): Status => {
    const said = reported(sid, block);

    if ("why" in said) return "unknown";

    if (said.state !== undefined) return statusOf(said.state, true);
    const end = exited(sid, block);

    return "why" in end ? "unknown" : statusOf(undefined, end.ended === undefined);
  };

  /** The last lines the block shows, for a start that failed. */
  const tail = (sid: string, block: string): string => {
    const ran = run(["capture", "-s", sid, "-b", block, "--trim"]);

    return "why" in ran ? "" : ran.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-3).join(" / ");
  };

  const argvOf = (agent: Agent): readonly string[] | Why => {
    if (options.command !== undefined) return options.command(agent);

    if (agent.system === undefined) return claudeArgv(agent, undefined);
    const file = join(options.state, `${agent.name}.system.md`);

    return writeOrWhy(file, agent.system) ?? claudeArgv(agent, file);
  };

  const owns = (name: string, handle: Handle): boolean => {
    const sessions = listed();

    return !("why" in sessions) && sessions.some((s) => s.id === handle && s.label === name);
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
      const layout = { block: { flavor: TERMINAL, label: launch.agent.name, options: { command: argv, cwd: launch.cwd } } };
      const made = rex(["api", "call", "-s", sid, "session.new_window", "-"], JSON.stringify({ window_label: launch.label, focus: false, layout }));

      if ("why" in made) return { why: made.why };
      const window = asString(made.result["window_id"]);
      const block = asString(asArray(made.result["block_ids"])?.[0]);

      if (window === undefined || block === undefined) return { why: "rex made a window but did not say its ID or its block's" };
      const tab: Tab = { handle: window, label: launch.label };

      for (const deadline = Date.now() + startMs; Date.now() < deadline; sleepMs(pollMs)) {
        const said = reported(sid, block);
        const status = "why" in said || said.state === undefined ? undefined : statusOf(said.state, true);

        if (status === "ready") return tab;

        if (status === "asking") return { blocked: tab };
        const end = "why" in said ? { ended: said.why } : exited(sid, block);

        if ("why" in end) return end;

        if (end.ended !== undefined) {
          const shown = tail(sid, block);
          rex(["window", "close", "-s", sid, window]);

          return { why: `it ended before it was ready (${end.ended})${shown === "" ? "" : `: ${shown}`}` };
        }
      }

      return { blocked: tab };
    },

    prompt(session, agent, text) {
      if (/[\r\n]/.test(text)) return { why: "a prompt holding a line break would be sent in parts" };
      const found = idOf(session);

      if ("why" in found) return found;
      const { sid } = found;
      const block = blockOf(sid, agent);

      if ("why" in block) return block;
      const typed = rex(["send", "-s", sid, "-b", block.id], text);

      if ("why" in typed) return { why: typed.why };
      const sent = rex(["send-key", "-s", sid, "-b", block.id, "enter"]);

      return "why" in sent ? { why: sent.why } : undefined;
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

      const agents = blocks.map((b): Seen => ({ name: b.label, tab: b.window, status: statusNow(sid, b.id) }));

      return { tabs, agents } satisfies Look;
    },

    settle(session, agent) {
      const found = idOf(session);

      if ("why" in found) return found;
      const { sid } = found;
      const block = blockOf(sid, agent);

      if ("why" in block) return block;

      for (const deadline = Date.now() + settleMs; Date.now() < deadline; sleepMs(pollMs)) {
        const said = reported(sid, block.id);

        if ("why" in said) return said;

        if (said.state !== undefined && statusOf(said.state, true) === "ready") return undefined;
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
      if (!owns(name, handle)) return { why: `session ${name} runs, but not as the session fleet team started; left running` };
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
