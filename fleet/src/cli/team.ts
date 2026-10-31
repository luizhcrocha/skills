/**
 * `fleet team {start,stop,attach,list} [--force] [--trust] [NAME ...|all]`: the repo's standing agents
 * (`.fleet/agents/<name>.json`, team/agents.ts) as tabs of one rex session (team/team.ts). The repo is the
 * nearest folder up from here holding `.fleet/agents`. No NAME is every agent, for start and list; stop names
 * them, or `all`. attach takes none. `add NAME --project ID --mission TEXT` writes an agent's file and starts it as
 * start does; a start that gives it no tab removes the file again, and the same add over the file as it writes it
 * (a run killed midway) starts it rather than refusing. start first makes sure Claude Code trusts the repo (team/trust.ts), asking
 * on the terminal unless `--trust`, and joins an agent of a project (`fleet.project`) whose ledger is not cut over to
 * the cloud yet, through the host service (cli/project.ts), the trust and the session's owner settled before any
 * team is made in the cloud. TypeScript only.
 */
import { readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { Refusal, UsageError } from "../errors.ts";
import { exists, isDir, isMoved, makeDirs, readText, remove, removeEmptyDir, strerror } from "../files.ts";
import { Out } from "../io.ts";
import { parseAgent, readTeam, type Agent, type Role, type Team, type Why } from "../team/agents.ts";
import type { Launcher } from "../team/launcher.ts";
import { ledgerOf } from "../team/ledger.ts";
import { rexLauncher } from "../team/rex.ts";
import { heldElsewhere, listTeam, startTeam, stopTeam, type BeforeStart, type Ground, type Said } from "../team/team.ts";
import { atOrAboveHome, claudeConfigOf, ensureTrusted, trustRootOf, type Asker, type Consent } from "../team/trust.ts";
import { World, type Machine } from "../world.ts";
import { opt, parseArgs, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";
import { awaitMoved, joinProject, JOIN_WAIT_MS, repoAt } from "./project.ts";

const USAGE = "usage: fleet team [-h] {start,stop,attach,list,add} [--force] [--trust] [NAME ...|all]\n";

const HELP = `${USAGE}
A repo's standing agents (.fleet/agents/<name>.json) as tabs of one rex session, named after the repo's
folder or .fleet/team.json's "session". Run it in the repo or below it.
    start [NAME ...] [--trust]
                           a tab per agent running a new claude, then its opening naming its ledger; one
                           already running here is left, one running elsewhere is refused, saying where.
                           A repo Claude Code does not trust yet is asked about first, then trusted in its
                           .claude.json (--trust: without asking; no terminal and no --trust: refused)
    stop NAME ...|all [--force]
                           close the agent's tab once it is ready, waiting at most 10 min (--force: at
                           once); only tabs fleet team started that still run their agent
    list [NAME ...]        each agent: running here, elsewhere (where), or not running
    attach                 show the team's session in the Rex app (rex do session.select)
    add NAME --project ID --mission TEXT [--role {coordinator,manager}] [--no-start] [--trust]
                           write .fleet/agents/NAME.json (at the repo's root when it has none yet;
                           never in / or the home folder): a coordinator unless --role, of project ID,
                           its opening carrying TEXT (one line of plain text, at most 2000 characters);
                           then start NAME alone, as start does (--no-start: only the file). A start that
                           gives it no tab removes the file and the folders add made, so add runs again
                           once fixed; the same add again over a file it wrote that has no tab (a run
                           killed midway) starts it. The join waits up to 30 s and the start up to 2 min
No NAME is every agent, for start and list.`;

const COMMANDS = ["start", "stop", "attach", "list", "add"] as const;

/** `add`'s arguments, after `add`. */
const ADD: CommandSpec = {
  name: "add",
  positionals: [{ dest: "name" }],
  options: [
    opt.value("--project", { metavar: "ID", required: true }),
    opt.value("--mission", { metavar: "TEXT", required: true }),
    opt.value("--role", { choices: ["coordinator", "manager"] }),
    opt.flag("--no-start"),
    opt.flag("--trust"),
  ],
};

type Command = (typeof COMMANDS)[number];

function usage(reason: string): Effect.Effect<never, UsageError> {
  return Effect.fail(new UsageError({ prog: "fleet team", usage: USAGE, reason }));
}

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "team", reason }));
}

/** The nearest folder from `cwd` up that holds `.fleet/agents`; `cwd` when none does. */
export function repoOf(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (isDir(join(dir, ".fleet", "agents"))) return dir;

    if (dirname(dir) === dir) return cwd;
  }
}

function picked(team: Team, names: readonly string[]): Agent[] | Why {
  if (names.length === 0 || (names.length === 1 && names[0] === "all")) return [...team.agents];
  const unknown = names.find((n) => !team.agents.some((a) => a.name === n));

  if (unknown !== undefined) return { why: `no agent ${unknown} in ${team.repo}/.fleet/agents (defined: ${team.agents.map((a) => a.name).join(", ")})` };

  return team.agents.filter((a) => names.includes(a.name));
}

function said(result: Said): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    for (const line of result.lines) out.out(`${line}\n`);

    for (const why of result.refused) out.err(`team: ${why}\n`);

    return result.refused.length > 0 ? 1 : 0;
  });
}

/** What joining the projects of the agents about to start came to: what it says, and the agents that may start. */
interface Joins extends Said {
  readonly ready: readonly Agent[];
}

/** The project `agent` joins before it starts and its ledger, when it is a local agent of a project whose ledger
 * holds no cloud.json; else undefined. */
function toJoin(machine: Machine, agent: Agent, home: string): { readonly project: string; readonly ledger: string } | undefined {
  const project = agent.fleet.project;
  const ledger = ledgerOf(agent, machine.registry.known(), home);

  return project === undefined || agent.fleet.machine !== "local" || "why" in ledger || isMoved(ledger.ledger) ? undefined : { project, ledger: ledger.ledger };
}

/**
 * Each agent {@link toJoin} names joins its project first, as its role, under its own name as the team's id, so
 * its ledger is the one {@link ledgerOf} finds, which the host makes and cuts over; the start waits at most
 * `waitMs` for that. An agent whose join is refused, that the registry gives another team, whose folder the host
 * named elsewhere, or whose file names its own ledger, does not start.
 */
function joinFirst(machine: Machine, team: Team, agents: readonly Agent[], home: string, waitMs: number): Effect.Effect<Joins> {
  return Effect.gen(function* () {
    const lines: string[] = [];
    const refused: string[] = [];
    const ready: Agent[] = [];

    for (const agent of agents) {
      const joining = toJoin(machine, agent, home);

      if (joining === undefined) {
        ready.push(agent);
        continue;
      }

      const { project, ledger } = joining;

      if (agent.fleet.ledger !== undefined) {
        refused.push(
          `${agent.name}: names both fleet.ledger (${ledger}, not cut over to the cloud) and fleet.project, and the join makes the team's folder itself: ` +
            `drop fleet.ledger, or set it to the joined team's folder once \`fleet project ${agent.fleet.role === "manager" ? "manage" : "join"} ${project}\` has printed it`,
        );
        continue;
      }

      const repo = repoAt(team.repo, home);

      if ("why" in repo) {
        refused.push(`${agent.name}: ${repo.why}`);
        continue;
      }

      const taken = `rename the agent's file, ${join(team.repo, ".fleet", "agents", `${agent.name}.json`)}, as its name is the team's id`;
      const joined = yield* Effect.result(joinProject(machine, { project, role: agent.fleet.role, team: agent.name, repo, taken }));

      if (Result.isFailure(joined)) {
        refused.push(`${agent.name}: ${joined.failure.why}`);
        continue;
      }

      if (joined.success.team !== agent.name) {
        refused.push(`${agent.name}: project ${project}'s ${agent.fleet.role} on this machine is the team ${joined.success.team}, not ${agent.name}: set fleet.ledger in ${agent.name}.json to its folder (\`fleet project ${agent.fleet.role === "manager" ? "manage" : "join"} ${project}\` prints it)`);
        continue;
      }

      lines.push(`${agent.name}: ${joined.success.line}`);
      const dir = joined.success.dir ?? ledger;

      if (dir !== ledger) {
        refused.push(`${agent.name}: the host made team ${agent.name}'s folder at ${dir}, not ${ledger}: set fleet.ledger in ${agent.name}.json to ${dir}`);
        continue;
      }

      if (!(yield* awaitMoved(ledger, waitMs))) {
        refused.push(`${agent.name}: the host has not cut ${ledger} over to the cloud yet (no cloud.json after ${waitMs / 1000} s): \`fleet team start ${agent.name}\` again waits for it`);
        continue;
      }

      ready.push(agent);
    }

    return { lines, refused, ready };
  });
}

/** Start `agents` of `ground`'s team: Claude Code's trust under `consent`, each agent's project joined first, then a
 * tab each. A refusal that stops every start is a failure; one agent's is said with the rest. */
function startAgents(machine: Machine, ground: Ground, agents: readonly Agent[], consent: Consent, waitMs: number): Effect.Effect<Said, Refusal> {
  return Effect.gen(function* () {
    const { team, home } = ground;

    const before: BeforeStart = () => {
      const trusted = ensureTrusted({ root: trustRootOf(team.repo), config: claudeConfigOf(machine.env, home), home, consent });

      return "why" in trusted ? trusted : { line: trusted._tag === "Written" ? trusted.line : undefined };
    };

    const early: string[] = [];
    let gate = before;

    if (agents.some((agent) => toJoin(machine, agent, home) !== undefined)) {
      const other = heldElsewhere(ground);

      if (other !== undefined) return yield* refuse(other.why);
      const ready = before();

      if ("why" in ready) return yield* refuse(ready.why);

      if (ready.line !== undefined) early.push(ready.line);
      gate = () => ({ line: undefined });
    }

    const joins = yield* joinFirst(machine, team, agents, home, waitMs);
    const started = startTeam(ground, joins.ready, gate);

    return { lines: [...early, ...joins.lines, ...started.lines], refused: [...joins.refused, ...started.refused] };
  });
}

/** The repo `add` writes in, from `cwd`: the nearest folder up holding `.fleet/agents`, else the nearest holding
 * `.jj` or `.git`; or why there is none. */
function addRepoOf(cwd: string): { readonly repo: string } | Why {
  const found = repoOf(cwd);

  if (isDir(join(found, ".fleet", "agents"))) return { repo: found };

  for (let dir = cwd; ; dir = dirname(dir)) {
    if (exists(join(dir, ".jj")) || exists(join(dir, ".git"))) return { repo: dir };

    if (dirname(dir) === dir) return { why: `${cwd} is in no repo (no .fleet/agents, .jj or .git from it up): run it in the repo the agent works in` };
  }
}

/** The ground of `team`: its launcher from `launcherAt`, its folder under the registry's. */
function groundOf(machine: Machine, team: Team, launcherAt: (state: string) => Launcher, home: string): Ground {
  const state = join(machine.registry.place.home, "team", team.session);

  return { team, launcher: launcherAt(state), state, live: () => machine.registry.live(), known: () => machine.registry.known(), home };
}

/** Whether `name` has a tab in the team's session, or the launcher cannot say (undefined). */
function hasTab(ground: Ground, name: string): boolean | undefined {
  const sessions = ground.launcher.sessions();

  if ("why" in sessions) return undefined;

  if (!sessions.includes(ground.team.session)) return false;
  const look = ground.launcher.look(ground.team.session);

  return "why" in look ? undefined : look.tabs.some((t) => t.label === name);
}

/** `fleet team add` with `argv` (after `add`): write the agent's file, then start it alone, as start does. */
function add(machine: Machine, argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string, ask: Asker | undefined, waitMs: number): Effect.Effect<number, Refusal | UsageError, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const parsed = parseArgs("fleet team add", ADD, argv, usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined));

    if (parsed === "help") return yield* printUsage(HELP);

    if (parsed instanceof UsageError) return yield* Effect.fail(parsed);

    if (parsed.extras.length > 0) return yield* Effect.fail(new UsageError({ prog: "fleet team add", usage: USAGE, reason: `unrecognized arguments: ${parsed.extras.join(" ")}` }));
    const { args } = parsed;
    const name = args.str("name") ?? "";
    const role: Role = args.str("role") === "manager" ? "manager" : "coordinator";
    const home = machine.env("HOME");

    if (home === undefined || home === "") return yield* refuse("HOME is not set, and the ledgers' fixed homes are under it (~/.local/state/fleet)");
    const found = addRepoOf(cwd);

    if ("why" in found) return yield* refuse(found.why);
    const { repo } = found;

    if (atOrAboveHome(repo, home)) return yield* refuse(`${repo} is / or the home folder, or a folder above it: an agent's file goes in the repository it works in; run add in one below the home folder`);
    const fleetDir = join(repo, ".fleet");
    const dir = join(fleetDir, "agents");
    const file = join(dir, `${name}.json`);
    const text = `${JSON.stringify({ fleet: { role, project: args.str("project"), mission: args.str("mission") } }, null, 2)}\n`;
    const agent = parseAgent(name, text, home);

    if ("why" in agent) return yield* refuse(agent.why);
    const resumed = exists(file) && readText(file) === text;

    if (exists(file) && !resumed) return yield* refuse(`${name}: ${file} exists already: \`fleet team start ${name}\` starts it, or name another`);
    const made = [dir, fleetDir].filter((d) => !exists(d));

    const unmake = (): void => {
      for (const d of made) removeEmptyDir(d);
    };

    const undo = (): void => {
      if (!resumed) remove(file);
      unmake();
    };

    if (!resumed) {
      try {
        makeDirs(dir);
        writeFileSync(file, text, { flag: "wx" });
      } catch (cause: unknown) {
        unmake();

        return yield* refuse(`${name}: ${file} could not be written: ${strerror(cause)}`);
      }
    }

    const team = readTeam(repo, home);

    if ("why" in team) {
      undo();

      return yield* refuse(`${team.why}; ${file} is removed again`);
    }

    const what = resumed ? `${file} is there already, as add writes it` : `wrote ${file}`;

    if (args.flag("no_start")) {
      out.out(`${name}: ${what}; \`fleet team start ${name}\` starts it\n`);

      return 0;
    }

    out.out(`${name}: ${what}${resumed ? "; starting it" : ""}\n`);
    const ground = groundOf(machine, team, launcherAt, home);
    const consent: Consent = args.flag("trust") ? { _tag: "Given" } : ask === undefined ? { _tag: "None", again: "`fleet team add` again with --trust" } : { _tag: "Ask", ask };
    const started = yield* Effect.result(startAgents(machine, ground, team.agents.filter((a) => a.name === name), consent, waitMs));
    const result: Said = Result.isFailure(started) ? { lines: [], refused: [started.failure.reason] } : started.success;

    if (hasTab(ground, name) !== false) return yield* said(result);
    undo();

    const kept = `${name}: not started; ${file} was there before this add, so it stays`;
    const removed = `${name}: not started, so ${file} is removed: \`fleet team add\` again once that is fixed`;

    return yield* said({ lines: result.lines, refused: [...result.refused, resumed ? kept : removed] });
  });
}

function run(machine: Machine, argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string, ask: Asker | undefined, waitMs: number): Effect.Effect<number, Refusal | UsageError, Out> {
  return Effect.gen(function* () {
    if (argv.includes("-h") || argv.includes("--help")) return yield* printUsage(HELP);
    const [first, ...rest] = argv;
    const command: Command | undefined = COMMANDS.find((c) => c === first);

    if (first === undefined) return yield* usage("the following arguments are required: cmd");

    if (command === undefined) return yield* usage(`argument cmd: invalid choice: '${first}' (choose from ${COMMANDS.map((c) => `'${c}'`).join(", ")})`);

    if (command === "add") return yield* add(machine, rest, launcherAt, cwd, ask, waitMs);
    const force = rest.includes("--force");
    const trust = rest.includes("--trust");
    const names = rest.filter((a) => a !== "--force" && a !== "--trust");
    const option = names.find((a) => a.startsWith("-"));

    if (option !== undefined) return yield* usage(`unrecognized arguments: ${option}`);

    if (force && command !== "stop") return yield* usage("unrecognized arguments: --force");

    if (trust && command !== "start") return yield* usage("unrecognized arguments: --trust");

    if (command === "stop" && names.length === 0) return yield* usage("stop names the agents to stop, or all");

    if (command === "attach" && names.length > 0) return yield* usage(`unrecognized arguments: ${names.join(" ")}`);
    const home = machine.env("HOME");

    if (home === undefined || home === "") return yield* refuse("HOME is not set, and the ledgers' fixed homes are under it (~/.local/state/fleet)");
    const team = readTeam(repoOf(cwd), home);

    if ("why" in team) return yield* refuse(team.why);

    const ground = groundOf(machine, team, launcherAt, home);
    const { launcher } = ground;

    if (command === "attach") {
      const other = heldElsewhere(ground);

      return other === undefined ? launcher.attach(team.session) : yield* refuse(other.why);
    }

    const agents = picked(team, names);

    if ("why" in agents) return yield* refuse(agents.why);

    if (command === "start") {
      const consent: Consent = trust ? { _tag: "Given" } : ask === undefined ? { _tag: "None", again: "`fleet team start --trust`" } : { _tag: "Ask", ask };

      return yield* said(yield* startAgents(machine, ground, agents, consent, waitMs));
    }

    if (command === "stop") return yield* said(stopTeam(ground, agents, force));

    return yield* said(listTeam(ground, agents));
  });
}

/** `fleet team` with `argv` (after `team`) over the launcher `launcherAt` builds for the team's folder, the repo
 * found from `cwd`; `ask` puts start's trust question to the owner, undefined when there is no terminal; a start
 * waits at most `waitMs` for a joined project's ledger to be cut over. The exit code. */
export function teamWith(argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string, ask: Asker | undefined, waitMs = JOIN_WAIT_MS): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv, launcherAt, cwd, ask, waitMs).pipe(Effect.catch(exitOf));
  });
}

/** An {@link Asker} that writes its question with `write` and reads one line of answer a byte at a time with
 * `read` (the bytes it read): true for y or yes; a read that fails (EAGAIN on a non-blocking terminal) is a no. */
export function askerOn(write: (text: string) => void, read: (byte: Buffer) => number): Asker {
  return (question) => {
    write(question);
    const byte = Buffer.alloc(1);
    let line = "";

    try {
      while (read(byte) === 1 && byte[0] !== 0x0a) line += byte.toString("utf8");
    } catch {
      return false;
    }

    return /^\s*y(es)?\s*$/i.test(line);
  };
}

/** The owner's terminal: the question on stderr, the answer from stdin. */
const askOnTerminal = askerOn(
  (text) => process.stderr.write(text),
  (byte) => readSync(0, byte, 0, 1, null),
);

/** `fleet team` with `argv` (after `team`), over rex, from the process's directory, asking on its terminal. */
export function teamCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return teamWith(argv, (state) => rexLauncher({ state }), process.cwd(), process.stdin.isTTY ? askOnTerminal : undefined);
}
