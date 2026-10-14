/**
 * The {@link Launcher} over herdr's CLI (0.9.3 and 0.9.5 both): `herdr --session <name> <command>` with JSON
 * answers, errors as JSON on stderr. A session that does not run is started headless (`herdr --session <name>
 * server`, detached); herdr has no `session create`. Its handle is that server's pid and start time, so a later
 * server of the same name (after a reboot, say) is never taken for it. A tab's handle is herdr's tab id. An agent
 * runs as a new Claude Code conversation that `herdr agent start --kind claude` names after it. A pane's input is
 * read by the login shell, nushell, so an argument holding a quote or a line break is refused rather than misread
 * (`agent start` quotes its arguments for sh, which nushell reads alike only without `'`).
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Option from "effect/Option";

import { strerror, writeOrWhy } from "../files.ts";
import { asArray, asObject, asString, parseObject, type JsonObject } from "../json.ts";
import { commandOf, startedOf } from "../procs.ts";
import type { Agent, Why } from "./agents.ts";
import type { Handle, Launch, Launcher, Look, Seen, Status, Tab } from "./launcher.ts";

/** How long `agent start` waits for Claude Code to be ready for its first prompt. */
const START_TIMEOUT_MS = 120_000;

/** How long `settle` waits for an agent to finish its turn before it gives up. */
const SETTLE_TIMEOUT_MS = 600_000;

/** How long a headless server is given to answer after it is started. */
const SERVER_WAIT_MS = 10_000;

/** herdr's agent state, in `fleet team`'s words. */
function statusOf(value: string | undefined): Status {
  switch (value) {
    case "idle":
    case "done":
      return "ready";
    case "working":
      return "working";
    case "blocked":
      return "asking";
    default:
      return "unknown";
  }
}

/** How the herdr adapter is built. */
export interface HerdrOptions {
  /** The team's folder, where an agent's system prompt is written for `--append-system-prompt-file`. */
  readonly state: string;
  /** The herdr binary. */
  readonly bin?: string;
  /** How long a headless server is given to answer, in ms. */
  readonly serverWaitMs?: number;
  /** For tests: a plain command typed into the tab in place of Claude Code; no agent is started. */
  readonly command?: (agent: Agent) => readonly string[];
}

/** A herdr command's answer: its `result`, or why it failed. */
type Answer = { readonly result: JsonObject } | Why;

/** A new tab, and its first pane, where its agent starts. */
type Made = Tab & { readonly pane: string };

/**
 * The command line of an agent's tab: a new Claude Code conversation (never a resume) named after it. Its
 * `system` goes in `systemFile` (`--append-system-prompt-file`), not on the line: herdr types the line into the
 * pane's shell, quoted for sh, and nushell does not read sh's `'\''`.
 */
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

/** The environment of a server this starts: the caller's, less a Claude Code session's and a herdr pane's own,
 * which would make every agent in it a child of the caller's session or pane. */
function serverEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_") && !key.startsWith("HERDR_")));
}

/** `word` as nushell reads it: bare when it is plain, else in single quotes. */
function nuWord(word: string): string {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(word) ? word : `'${word}'`;
}

function unsafe(argv: readonly string[]): string | undefined {
  return argv.find((a) => /['\r\n]/.test(a));
}

function madeOf(answer: Answer): Made | Why {
  if ("why" in answer) return answer;
  const result = answer.result;
  const tab = asObject(result["tab"]);
  const handle = asString(tab?.["tab_id"]);
  const label = asString(tab?.["label"]);
  const pane = asString(asObject(result["root_pane"])?.["pane_id"]);

  return handle === undefined || label === undefined || pane === undefined ? { why: "herdr answered a new tab without its id, label or pane" } : { handle, label, pane };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The pid in a session's handle, and the start time it had. */
function serverOf(handle: Handle): { readonly pid: number; readonly started: string } | undefined {
  const at = handle.indexOf("@");
  const pid = Number(handle.slice(0, at));

  return at > 0 && Number.isInteger(pid) && pid > 0 ? { pid, started: handle.slice(at + 1) } : undefined;
}

/** The one real {@link Launcher}: herdr on this machine. */
export function herdrLauncher(options: HerdrOptions): Launcher {
  const bin = options.bin ?? "herdr";
  const serverWaitMs = options.serverWaitMs ?? SERVER_WAIT_MS;

  const herdr = (session: string | undefined, args: readonly string[]): Answer => {
    const argv = session === undefined ? [...args] : ["--session", session, ...args];
    const done = spawnSync(bin, argv, { encoding: "utf8" });

    if (done.error !== undefined) return { why: `herdr could not run: ${strerror(done.error)}` };
    const err = Option.getOrUndefined(parseObject(done.stderr));

    if (done.status !== 0) return { why: `herdr ${args.slice(0, 2).join(" ")}: ${asString(asObject(err?.["error"])?.["message"]) ?? done.stderr.trim()}` };

    return { result: asObject(Option.getOrUndefined(parseObject(done.stdout))?.["result"]) ?? {} };
  };

  const sessions = (): readonly string[] | Why => {
    const done = spawnSync(bin, ["session", "list", "--json"], { encoding: "utf8" });

    if (done.error !== undefined || done.status !== 0) return { why: `herdr session list: ${done.error === undefined ? done.stderr.trim() : strerror(done.error)}` };
    const list = asArray(Option.getOrUndefined(parseObject(done.stdout))?.["sessions"]) ?? [];

    return list.flatMap((s) => {
      const session = asObject(s);
      const name = asString(session?.["name"]);

      return name !== undefined && session?.["running"] === true ? [name] : [];
    });
  };

  const owns = (name: string, handle: Handle): boolean => {
    const server = serverOf(handle);

    return server !== undefined && startedOf(server.pid) === server.started && commandOf(server.pid) === `${bin} --session ${name} server`;
  };

  const newTab = (session: string, launch: Launch): Made | Why => {
    const listed = herdr(session, ["workspace", "list"]);

    if ("why" in listed) return listed;
    const workspace = asString(asObject((asArray(listed.result["workspaces"]) ?? [])[0])?.["workspace_id"]);

    if (workspace !== undefined) return madeOf(herdr(session, ["tab", "create", "--workspace", workspace, "--cwd", launch.cwd, "--label", launch.label, "--no-focus"]));
    const tab = madeOf(herdr(session, ["workspace", "create", "--cwd", launch.cwd, "--label", session, "--no-focus"]));

    if ("why" in tab) return tab;
    const renamed = herdr(session, ["tab", "rename", tab.handle, launch.label]);

    return "why" in renamed ? { why: renamed.why } : { ...tab, label: launch.label };
  };

  /** What runs in a new tab for `agent`: a plain command, or Claude Code with its system prompt file. */
  const argvOf = (agent: Agent): readonly string[] | Why => {
    if (options.command !== undefined) return options.command(agent);

    if (agent.system === undefined) return claudeArgv(agent, undefined);
    const file = join(options.state, `${agent.name}.system.md`);
    const written = writeOrWhy(file, agent.system);

    return written ?? claudeArgv(agent, file);
  };

  return {
    sessions,
    owns,

    open(name, cwd) {
      const running = sessions();

      if ("why" in running) return running;

      if (running.includes(name)) return { started: undefined };
      const server = spawn(bin, ["--session", name, "server"], { cwd, env: serverEnv(), detached: true, stdio: "ignore" });
      server.on("error", () => undefined);
      server.unref();
      const pid = server.pid;

      if (pid === undefined) return { why: `herdr session ${name} could not be started: ${bin} did not run` };

      for (let waited = 0; waited < serverWaitMs; waited += 200) {
        if (!("why" in herdr(name, ["workspace", "list"]))) return { started: `${pid}@${startedOf(pid) ?? ""}` };
        sleepMs(200);
      }

      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Its group is gone already.
      }

      return { why: `herdr session ${name} did not answer within ${serverWaitMs / 1000} s of starting; its server was stopped` };
    },

    tab(session, launch) {
      const argv = argvOf(launch.agent);

      if ("why" in argv) return argv;
      const bad = unsafe(argv);

      if (bad !== undefined) return { why: `the tab's command holds a quote or a line break (${JSON.stringify(bad)}), which the pane's shell would misread` };
      const tab = newTab(session, launch);

      if ("why" in tab) return tab;

      const ran =
        options.command !== undefined
          ? herdr(session, ["pane", "run", tab.pane, argv.map(nuWord).join(" ")])
          : herdr(session, ["agent", "start", launch.agent.name, "--kind", "claude", "--pane", tab.pane, "--timeout", String(START_TIMEOUT_MS), "--", ...argv.slice(1)]);

      if (!("why" in ran)) return { handle: tab.handle, label: tab.label };

      // herdr's "agent X is blocked during startup": claude waits on a prompt in its pane (a new folder's trust
      // question). The user answers it, never this; closing the tab would hide it from them.
      if (/\bis blocked during startup\b/.test(ran.why)) return { blocked: { handle: tab.handle, label: tab.label } };
      herdr(session, ["tab", "close", tab.handle]);

      return { why: ran.why };
    },

    prompt(session, agent, text) {
      const sent = herdr(session, ["agent", "prompt", agent, text]);

      return "why" in sent ? { why: sent.why } : undefined;
    },

    look(session) {
      const tabs = herdr(session, ["tab", "list"]);
      const panes = herdr(session, ["pane", "list"]);
      const agents = herdr(session, ["agent", "list"]);

      if ("why" in tabs) return tabs;

      if ("why" in panes) return panes;

      if ("why" in agents) return agents;
      const paneRows = (asArray(panes.result["panes"]) ?? []).map((p) => asObject(p) ?? {});

      const tabRows = (asArray(tabs.result["tabs"]) ?? []).flatMap((t): Tab[] => {
        const handle = asString(asObject(t)?.["tab_id"]);
        const label = asString(asObject(t)?.["label"]);

        return handle === undefined || label === undefined ? [] : [{ handle, label }];
      });

      const seen = (asArray(agents.result["agents"]) ?? []).flatMap((a): Seen[] => {
        const row = asObject(a);
        const name = asString(row?.["name"]);
        const pane = asString(row?.["pane_id"]);
        const tab = asString(paneRows.find((p) => p["pane_id"] === pane)?.["tab_id"]);

        return name === undefined || tab === undefined ? [] : [{ name, tab, status: statusOf(asString(row?.["agent_status"])) }];
      });

      return { tabs: tabRows, agents: seen } satisfies Look;
    },

    settle(session, agent) {
      const waited = herdr(session, ["agent", "wait", agent, "--until", "idle", "--until", "done", "--timeout", String(SETTLE_TIMEOUT_MS)]);

      return "why" in waited ? { why: `it was not ready within ${SETTLE_TIMEOUT_MS / 60_000} min (${waited.why})` } : undefined;
    },

    close(session, tab) {
      const closed = herdr(session, ["tab", "close", tab]);

      return "why" in closed ? { why: closed.why } : undefined;
    },

    end(name, handle) {
      if (!owns(name, handle)) return { why: `session ${name} runs, but not as the server fleet team started; left running` };
      const done = spawnSync(bin, ["session", "stop", name], { encoding: "utf8" });

      if (done.status !== 0) return { why: `herdr session stop ${name}: ${done.stderr.trim()}` };

      for (let waited = 0; waited < SERVER_WAIT_MS; waited += 100) {
        const running = sessions();

        if ("why" in running || !running.includes(name)) return undefined;
        sleepMs(100);
      }

      return { why: `session ${name} still runs ${SERVER_WAIT_MS / 1000} s after it was stopped` };
    },

    attach(name) {
      return spawnSync(bin, ["session", "attach", name], { stdio: "inherit" }).status ?? 1;
    },
  };
}
