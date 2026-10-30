/**
 * `fleet team {start,stop,attach,list} [--force] [--trust] [NAME ...|all]`: the repo's standing agents
 * (`.fleet/agents/<name>.json`, team/agents.ts) as tabs of one rex session (team/team.ts). The repo is the
 * nearest folder up from here holding `.fleet/agents`. No NAME is every agent, for start and list; stop names
 * them, or `all`. attach takes none. start first makes sure Claude Code trusts the repo (team/trust.ts), asking
 * on the terminal unless `--trust`. TypeScript only.
 */
import { readSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal, UsageError } from "../errors.ts";
import { isDir } from "../files.ts";
import { Out } from "../io.ts";
import { readTeam, type Agent, type Team, type Why } from "../team/agents.ts";
import type { Launcher } from "../team/launcher.ts";
import { rexLauncher } from "../team/rex.ts";
import { listTeam, startTeam, stopTeam, type BeforeStart, type Ground, type Said } from "../team/team.ts";
import { claudeConfigOf, ensureTrusted, trustRootOf, type Asker, type Consent } from "../team/trust.ts";
import { World, type Machine } from "../world.ts";
import { exitOf, printUsage } from "./exit.ts";

const USAGE = "usage: fleet team [-h] {start,stop,attach,list} [--force] [--trust] [NAME ...|all]\n";

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

function run(machine: Machine, argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string, ask: Asker | undefined): Effect.Effect<number, Refusal | UsageError, Out> {
  return Effect.gen(function* () {
    if (argv.includes("-h") || argv.includes("--help")) return yield* printUsage(HELP);
    const [first, ...rest] = argv;
    const command: Command | undefined = COMMANDS.find((c) => c === first);

    if (first === undefined) return yield* usage("the following arguments are required: cmd");

    if (command === undefined) return yield* usage(`argument cmd: invalid choice: '${first}' (choose from ${COMMANDS.map((c) => `'${c}'`).join(", ")})`);
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

    if (command === "start") {
      const consent: Consent = trust ? { _tag: "Given" } : ask === undefined ? { _tag: "None" } : { _tag: "Ask", ask };

      const before: BeforeStart = () => {
        const trusted = ensureTrusted({ root: trustRootOf(team.repo), config: claudeConfigOf(machine.env, home), home, consent });

        return "why" in trusted ? trusted : { line: trusted._tag === "Written" ? trusted.line : undefined };
      };

      return yield* said(startTeam(ground, agents, before));
    }

    if (command === "stop") return yield* said(stopTeam(ground, agents, force));

    return yield* said(listTeam(ground, agents));
  });
}

/** `fleet team` with `argv` (after `team`) over the launcher `launcherAt` builds for the team's folder, the repo
 * found from `cwd`; `ask` puts start's trust question to the owner, undefined when there is no terminal. The exit
 * code. */
export function teamWith(argv: readonly string[], launcherAt: (state: string) => Launcher, cwd: string, ask: Asker | undefined): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv, launcherAt, cwd, ask).pipe(Effect.catch(exitOf));
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
