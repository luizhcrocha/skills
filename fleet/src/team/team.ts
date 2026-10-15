/**
 * A repo's standing agents run as tabs of one session (`fleet team`), through a {@link Launcher}. `start` opens or
 * reuses the session and gives each agent a tab running it, then its opening prompt naming its ledger; `stop`
 * closes a tab once its agent is ready; `list` says where each agent runs. What `fleet team` started is marked in
 * `<state>/marks.json` by the launcher's handles: the session when it started it, and each agent's tab. A mark is
 * trusted only while it still holds: a tab still labelled with the agent's name and running an agent of that
 * name, a session the launcher says is still the instance it started. It closes only what is marked and holds:
 * a tab or session someone else opened (or a shell tab restored in place of the agent's) is never closed. `start`
 * and `stop` hold `<state>/team.lock` throughout, so two of them never drive the session at once.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { makeDirs, readText, strerror, writeOrWhy } from "../files.ts";
import { asObject, asString, parseObject } from "../json.ts";
import { withLockAt } from "../lock.ts";
import type { Entry } from "../registry.ts";
import { openingOf, type Agent, type Team, type Why } from "./agents.ts";
import type { Handle, Launcher, Look, Tab } from "./launcher.ts";
import { fixedHomes, isAgentsEntry, ledgerOf } from "./ledger.ts";

/** What the commands work on. */
export interface Ground {
  readonly team: Team;
  readonly launcher: Launcher;
  /** The team's own folder: its marks and its lock. */
  readonly state: string;
  /** The registry's fleets being served. */
  readonly live: () => readonly Entry[];
  /** The registry's fleets, served or not. */
  readonly known: () => readonly Entry[];
  /** The user's home, where the ledgers' fixed homes are. */
  readonly home: string;
}

/** What a command says: its lines, and the refusals that make it exit 1. */
export interface Said {
  readonly lines: readonly string[];
  readonly refused: readonly string[];
}

/** What `fleet team` started: the session's handle when it started it, each agent's tab, and the agents whose
 * opening is not sent yet (their start blocked on a prompt in their tab). */
interface Marks {
  readonly session: Handle | undefined;
  readonly agents: Readonly<Record<string, Handle>>;
  readonly unsent: readonly string[];
}

function marksPath(ground: Ground): string {
  return join(ground.state, "marks.json");
}

function readMarks(ground: Ground): Marks {
  const raw = Option.getOrUndefined(parseObject(readText(marksPath(ground)) ?? ""));
  const agents: Record<string, Handle> = {};
  const unsent: string[] = [];

  for (const [name, value] of Object.entries(asObject(raw?.["agents"]) ?? {})) {
    const tab = asString(asObject(value)?.["tab"]);

    if (tab !== undefined && asObject(value)?.["opening"] === "unsent") unsent.push(name);

    if (tab !== undefined) agents[name] = tab;
  }

  return { session: asString(raw?.["session"]), agents, unsent };
}

function writeMarks(ground: Ground, marks: Marks): Why | undefined {
  const agents = Object.fromEntries(Object.entries(marks.agents).map(([name, tab]) => [name, marks.unsent.includes(name) ? { tab, opening: "unsent" } : { tab }]));

  return writeOrWhy(marksPath(ground), `${JSON.stringify({ session: marks.session, agents }, null, 2)}\n`);
}

function withoutAgent(marks: Marks, name: string): Marks {
  const { [name]: _gone, ...agents } = marks.agents;

  return { ...marks, agents, unsent: marks.unsent.filter((n) => n !== name) };
}

/** The agent's tab in `look` when `fleet team` started it and it still runs it: the marked tab, still labelled
 * with its name, running an agent of its name. */
function ourTab(marks: Marks, look: Look | undefined, name: string): Tab | undefined {
  const mark = marks.agents[name];
  const tab = mark === undefined ? undefined : look?.tabs.find((t) => t.handle === mark && t.label === name);

  return tab !== undefined && look?.agents.some((a) => a.name === name && a.tab === tab.handle) === true ? tab : undefined;
}

/** Run `body` holding the team's lock, `<state>/team.lock`; a refusal when it cannot be taken. */
function withTeamLock(ground: Ground, body: () => Said): Said {
  const path = join(ground.state, "team.lock");

  try {
    makeDirs(ground.state);

    return withLockAt(path, "a", body);
  } catch (cause: unknown) {
    return { lines: [], refused: [`the team's lock ${path} could not be taken: ${strerror(cause)}`] };
  }
}

function lookOf(ground: Ground, session: string): Look | undefined {
  const look = ground.launcher.look(session);

  return "why" in look ? undefined : look;
}

function realOf(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

/** Where `look` runs an agent of `agent`'s name, or a tab labelled with it, in a phrase; undefined when nowhere. */
function runsIn(look: Look, agent: Agent): string | undefined {
  if (look.agents.some((a) => a.name === agent.name)) return `runs an agent named ${agent.name}`;
  const tab = look.tabs.find((t) => t.label === agent.name);

  return tab === undefined ? undefined : `has a tab labelled ${agent.name} (${tab.handle})`;
}

/** Where `agent` runs outside the team's session, in a phrase; undefined when nowhere. */
function elsewhere(ground: Ground, agent: Agent): string | undefined {
  const sessions = ground.launcher.sessions();

  for (const name of "why" in sessions ? [] : sessions.filter((n) => n !== ground.team.session)) {
    const look = lookOf(ground, name);
    const where = look === undefined ? undefined : runsIn(look, agent);

    if (where !== undefined) return `session ${name} ${where}`;
  }

  const ledger = realOf(agent.fleet.ledger ?? join(fixedHomes(ground.home), agent.name));
  const fleet = ground.live().find((e) => isAgentsEntry(e, agent.name) || realOf(e.dir) === ledger);

  return fleet === undefined ? undefined : `the registry serves fleet ${fleet.id} from ${fleet.dir}`;
}

/** What `look` of the team's session says of `agent` before it starts: the line to say when it runs there. */
function runningHere(ground: Ground, marks: Marks, here: Look | undefined, agent: Agent): string | undefined {
  const session = ground.team.session;
  const tab = ourTab(marks, here, agent.name);

  if (tab !== undefined) return `${agent.name}: already running in session ${session}, tab ${tab.handle}; left as it is`;
  const stranger = here === undefined ? undefined : runsIn(here, agent);

  return stranger === undefined ? undefined : `${agent.name}: already running: session ${session} ${stranger}, not started by fleet team; left as it is`;
}

/** What must hold before the first agent starts (Claude Code trusting the repo): a line to say, or why not. */
export type BeforeStart = () => { readonly line: string | undefined } | Why;

/** Start `agents`: each in a tab of the team's session, unless it runs already. `before` runs once, when the
 * first agent is about to start; its refusal starts none. */
export function startTeam(ground: Ground, agents: readonly Agent[], before: BeforeStart): Said {
  return withTeamLock(ground, () => startLocked(ground, agents, before));
}

function startLocked(ground: Ground, agents: readonly Agent[], before: BeforeStart): Said {
  const session = ground.team.session;
  const lines: string[] = [];
  const refused: string[] = [];
  let marks = readMarks(ground);
  let opened = false;

  const save = (next: Marks): void => {
    marks = next;
    const failed = writeMarks(ground, next);

    if (failed !== undefined) refused.push(`its marks were not saved: ${failed.why}`);
  };

  for (const agent of agents) {
    if (agent.fleet.machine !== "local") {
      refused.push(`${agent.name}: runs on machine '${agent.fleet.machine}'; an agent away from this machine needs a launcher on that machine, which is not built; only local agents start`);
      continue;
    }

    const here = lookOf(ground, session);
    const waiting = marks.unsent.includes(agent.name) ? ourTab(marks, here, agent.name) : undefined;

    if (waiting !== undefined) {
      const status = here?.agents.find((a) => a.name === agent.name)?.status;

      if (status === "asking") {
        refused.push(`${agent.name}: still waits on a prompt in its tab ${waiting.handle}: run \`fleet team attach\`, answer it, then \`fleet team start ${agent.name}\` again`);
        continue;
      }

      const ready = ground.launcher.settle(session, agent.name);

      if (ready !== undefined) {
        refused.push(`${agent.name}: its opening was not sent: ${ready.why}`);
        continue;
      }

      const ledger = ledgerOf(agent, ground.known(), ground.home);

      if ("why" in ledger) {
        refused.push(ledger.why);
        continue;
      }

      const said = sendOpening(ground, agent, waiting.handle, ledger.ledger);

      if ("refused" in said) refused.push(said.refused);
      else {
        lines.push(said.line);
        save({ ...marks, unsent: marks.unsent.filter((n) => n !== agent.name) });
      }

      continue;
    }

    const already = runningHere(ground, marks, here, agent);

    if (already !== undefined) {
      lines.push(already);
      continue;
    }

    const where = elsewhere(ground, agent);

    if (where !== undefined) {
      refused.push(`${agent.name}: already running elsewhere: ${where}; stop it there first`);
      continue;
    }

    const found = ledgerOf(agent, ground.known(), ground.home);

    if ("why" in found) {
      refused.push(found.why);
      continue;
    }

    if (!opened) {
      const ready = before();

      if ("why" in ready) return { lines, refused: [...refused, ready.why] };

      if (ready.line !== undefined) lines.push(ready.line);
      const open = ground.launcher.open(session, ground.team.repo);

      if ("why" in open) return { lines, refused: [...refused, open.why] };
      opened = true;

      if (open.started !== undefined) {
        lines.push(`started session ${session}`);
        save({ session: open.started, agents: {}, unsent: [] });
        const restored = runningHere(ground, marks, lookOf(ground, session), agent);

        if (restored !== undefined) {
          lines.push(restored);
          continue;
        }
      } else if (marks.session !== undefined && !ground.launcher.owns(session, marks.session)) save({ ...marks, session: undefined });
    }

    const made = ground.launcher.tab(session, { cwd: ground.team.repo, label: agent.name, agent });

    if ("why" in made) {
      refused.push(`${agent.name}: ${made.why}`);
      continue;
    }

    if ("blocked" in made) {
      save({ ...marks, agents: { ...marks.agents, [agent.name]: made.blocked.handle }, unsent: [...marks.unsent.filter((n) => n !== agent.name), agent.name] });
      refused.push(
        `${agent.name}: waits on a prompt in its tab ${made.blocked.handle} before it is ready, the tab kept open (a startup prompt: trust, an MCP server's approval, ...): ` +
          `run \`fleet team attach\`, answer it, then \`fleet team start ${agent.name}\` again, which sends its opening and leaves the running agent as it is`,
      );
      continue;
    }

    save({ ...marks, agents: { ...marks.agents, [agent.name]: made.handle }, unsent: marks.unsent.filter((n) => n !== agent.name) });
    const said = sendOpening(ground, agent, made.handle, found.ledger);

    if ("refused" in said) refused.push(said.refused);
    else lines.push(said.line);
  }

  return { lines, refused };
}

/** Send `agent`, running in tab `tab`, its opening naming `ledger`: the line saying it started, or the refusal. */
function sendOpening(ground: Ground, agent: Agent, tab: Handle, ledger: string): { readonly line: string } | { readonly refused: string } {
  const session = ground.team.session;
  const sent = ground.launcher.prompt(session, agent.name, openingOf(agent, ledger));

  return sent === undefined
    ? { line: `${agent.name}: started in session ${session}, tab ${tab}; its ledger is ${ledger}` }
    : { refused: `${agent.name}: started in tab ${tab}, but its opening was not sent: ${sent.why}` };
}

/** Stop `agents` that `fleet team` started: once each is ready (at once with `force`), its tab is closed. */
export function stopTeam(ground: Ground, agents: readonly Agent[], force: boolean): Said {
  return withTeamLock(ground, () => stopLocked(ground, agents, force));
}

function stopLocked(ground: Ground, agents: readonly Agent[], force: boolean): Said {
  const session = ground.team.session;
  const lines: string[] = [];
  const refused: string[] = [];
  let marks = readMarks(ground);

  const save = (next: Marks): void => {
    marks = next;
    const failed = writeMarks(ground, next);

    if (failed !== undefined) refused.push(`its marks were not saved: ${failed.why}`);
  };

  for (const agent of agents) {
    const mark = marks.agents[agent.name];

    if (mark === undefined) {
      refused.push(`${agent.name}: fleet team did not start it in session ${session}; left as it is`);
      continue;
    }

    const look = ground.launcher.look(session);

    if ("why" in look) {
      refused.push(`${agent.name}: session ${session} could not be read (${look.why}); its tab ${mark} is left, and so is its mark`);
      continue;
    }

    const tab = ourTab(marks, look, agent.name);

    if (tab === undefined) {
      lines.push(`${agent.name}: not running: its tab ${mark} no longer runs it; its mark is dropped`);
      save(withoutAgent(marks, agent.name));
      continue;
    }

    const blocked = marks.unsent.includes(agent.name) && look.agents.some((a) => a.tab === tab.handle && a.status === "asking");
    const settled = force || blocked ? undefined : ground.launcher.settle(session, agent.name);

    if (settled !== undefined) {
      refused.push(`${agent.name}: did not become ready: ${settled.why}; --force closes it at once`);
      continue;
    }

    const closed = ground.launcher.close(session, tab.handle);

    if (closed !== undefined) {
      refused.push(`${agent.name}: ${closed.why}`);
      continue;
    }

    save(withoutAgent(marks, agent.name));
    lines.push(`${agent.name}: stopped: tab ${tab.handle} closed${force ? "" : blocked ? " at once: it waited on a prompt" : " once it was ready"}`);
  }

  if (marks.session !== undefined && Object.keys(marks.agents).length === 0 && lookOf(ground, session)?.tabs.length === 0) {
    if (!ground.launcher.owns(session, marks.session)) save({ ...marks, session: undefined });
    else {
      const ended = ground.launcher.end(session, marks.session);

      if (ended === undefined) {
        lines.push(`session ${session} stopped: fleet team started it and nothing is left in it`);
        save({ session: undefined, agents: {}, unsent: [] });
      } else refused.push(ended.why);
    }
  }

  return { lines, refused };
}

/** Where each of `agents` runs: here, elsewhere (where), or not at all. */
export function listTeam(ground: Ground, agents: readonly Agent[]): Said {
  const session = ground.team.session;
  const marks = readMarks(ground);
  const here = lookOf(ground, session);

  const lines = agents.map((agent) => {
    const tab = ourTab(marks, here, agent.name);

    if (tab !== undefined) {
      const status = here?.agents.find((a) => a.name === agent.name && a.tab === tab.handle)?.status ?? "unknown";

      return `${agent.name}  running here: session ${session}, tab ${tab.handle}, ${status}`;
    }

    const stranger = here === undefined ? undefined : runsIn(here, agent);

    if (stranger !== undefined) return `${agent.name}  running here, not started by fleet team: session ${session} ${stranger}`;
    const where = elsewhere(ground, agent);

    return where === undefined ? `${agent.name}  not running` : `${agent.name}  running elsewhere: ${where}`;
  });

  return { lines, refused: [] };
}
