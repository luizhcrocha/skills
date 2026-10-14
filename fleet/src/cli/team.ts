/**
 * `fleet team {start,stop,attach,list} [--force] [NAME ...|all]`: the repo's standing agents
 * (`.fleet/agents/<name>.json`, team/agents.ts) as tabs of one herdr session (team/team.ts). The repo is the
 * nearest folder up from here holding `.fleet/agents`. No NAME is every agent, for start and list; stop names
 * them, or `all`. attach takes none. TypeScript only.
 */
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal, UsageError } from "../errors.ts";
import { isDir } from "../files.ts";
import { Out } from "../io.ts";
import { readTeam, type Agent, type Team, type Why } from "../team/agents.ts";
import { herdrLauncher } from "../team/herdr.ts";
import type { Launcher } from "../team/launcher.ts";
import { listTeam, startTeam, stopTeam, type Ground, type Said } from "../team/team.ts";
import { World, type Machine } from "../world.ts";
import { exitOf, printUsage } from "./exit.ts";

const USAGE = "usage: fleet team [-h] {start,stop,attach,list} [--force] [NAME ...|all]\n";

const HELP = `${USAGE}
A repo's standing agents (.fleet/agents/<name>.json) as tabs of one herdr session, named after the repo's
folder or .fleet/team.json's "session". Run it in the repo or below it.
    start [NAME ...]       a tab per agent running a new claude, then its opening naming its ledger; one
                           already running here is left, one running elsewhere is refused, saying where
    stop NAME ...|all [--force]
                           close the agent's tab once it is ready, waiting at most 10 min (--force: at
                           once); only tabs fleet team started that still run their agent
    list [NAME ...]        each agent: running here, elsewhere (where), or not running
    attach                 herdr session attach to the team's session
No NAME is every agent, for start and list.`;

const COMMANDS = ["start", "stop", "attach", "list"] as const;

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

function run(machine: Machine, argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string): Effect.Effect<number, Refusal | UsageError, Out> {
  return Effect.gen(function* () {
    if (argv.includes("-h") || argv.includes("--help")) return yield* printUsage(HELP);
    const [first, ...rest] = argv;
    const command: Command | undefined = COMMANDS.find((c) => c === first);

    if (first === undefined) return yield* usage("the following arguments are required: cmd");

    if (command === undefined) return yield* usage(`argument cmd: invalid choice: '${first}' (choose from ${COMMANDS.map((c) => `'${c}'`).join(", ")})`);
    const force = rest.includes("--force");
    const names = rest.filter((a) => a !== "--force");
    const option = names.find((a) => a.startsWith("-"));

    if (option !== undefined) return yield* usage(`unrecognized arguments: ${option}`);

    if (force && command !== "stop") return yield* usage("unrecognized arguments: --force");

    if (command === "stop" && names.length === 0) return yield* usage("stop names the agents to stop, or all");

    if (command === "attach" && names.length > 0) return yield* usage(`unrecognized arguments: ${names.join(" ")}`);
    const home = machine.env("HOME");

    if (home === undefined || home === "") return yield* refuse("HOME is not set, and the ledgers' fixed homes are under it (~/.local/state/fleet)");
    const team = readTeam(repoOf(cwd), home);

    if ("why" in team) return yield* refuse(team.why);

    const state = join(machine.registry.place.home, "team", team.session);
    const launcher = launcherAt(state);

    if (command === "attach") return launcher.attach(team.session);
    const agents = picked(team, names);

    if ("why" in agents) return yield* refuse(agents.why);

    const ground: Ground = {
      team,
      launcher,
      state,
      live: () => machine.registry.live(),
      known: () => machine.registry.known(),
      home,
    };

    if (command === "start") return yield* said(startTeam(ground, agents));

    if (command === "stop") return yield* said(stopTeam(ground, agents, force));

    return yield* said(listTeam(ground, agents));
  });
}

/** `fleet team` with `argv` (after `team`) over the launcher `launcherAt` builds for the team's folder, the repo
 * found from `cwd`; the exit code. */
export function teamWith(argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv, launcherAt, cwd).pipe(Effect.catch(exitOf));
  });
}

/** `fleet team` with `argv` (after `team`), over herdr, from the process's directory. */
export function teamCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return teamWith(argv, (state) => herdrLauncher({ state }), process.cwd());
}
