/**
 * `fleet onepw` and `fleet onepw unlocked [--note TEXT]`: the machine's 1Password lock (onepw.ts) from a
 * terminal or a session. With no command it prints the state, anywhere, and changes nothing. `unlocked` is
 * the user's own word, for a terminal outside Claude Code: it clears every locked kind as the user and
 * settles at once, so each held fleet is told with no hub running.
 *
 * `unlocked` is refused inside a Claude Code session: `CLAUDECODE` or `CLAUDE_CODE_SESSION_ID` in the
 * environment (as `fleet tell`), or a Claude Code process among the caller's ancestors, which unsetting the
 * two does not hide ({@link claudeAbove}). An agent does not say for the user that 1Password is unlocked:
 * there, only the button on the card clears the lock. The refusal stops an honest agent only: a command that
 * also leaves its session (`setsid --fork`) has no such ancestor, and everything here runs as one Unix user.
 */
import * as Effect from "effect/Effect";

import { UsageError } from "../errors.ts";
import { strerror } from "../files.ts";
import { PROBE, type Probe } from "../host.ts";
import { Out } from "../io.ts";
import { clear, owedLine, settle, statusLine, type Settled } from "../onepw.ts";
import { ancestry, runningOf } from "../procs.ts";
import { deliver, socksDir, type Send } from "../wake.ts";
import { World, type Machine } from "../world.ts";
import { formatUsage, opt, parseArgs, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";

const PROG = "fleet onepw";

const UNLOCKED: CommandSpec = { name: "unlocked", positionals: [], options: [opt.value("--note", { metavar: "TEXT" })] };

const HELP = `usage: ${PROG} [-h] [unlocked [--note TEXT]]

The machine's 1Password lock: a command of a fleet that needs 1Password failed because the app is locked, the
user was asked once (the card "Unlock 1Password" on every fleet's page), and the plugin's hook holds every
fleet's commands of that kind (ssh-agent: SSH through the 1Password agent; op-desktop: secrets read through
the 1Password app) until it is unlocked.

    (no command)                the state: not known to be locked, or each locked kind, since when and why, and
                                who waits for what. Runs anywhere and changes nothing
    unlocked [--note TEXT]      the user says 1Password is unlocked, in a terminal outside Claude Code: clear
                                every locked kind and tell each held fleet, now, with or without a hub; prints
                                what it told. Refused inside a Claude Code session: there only the button on
                                the card ("1Password is unlocked") clears the lock

A kind also clears when a command of that kind succeeds in any session, and lapses after 2 h
(FLEET_ONEPW_LAPSE_S). Every 15 min the hook lets one held command of a locked kind through, to test the
lock. A fleet is told at most once in 30 min.`;

/** What `unlocked` says to a Claude Code session. */
const REFUSED = 'onepw: only the button on the card clears the lock ("1Password is unlocked", on any fleet\'s page); an agent does not say for the user that 1Password is unlocked. `fleet onepw` prints the state.\n';

/** What `fleet onepw unlocked` asks of the machine it runs on. The process's own are {@link HERE}; a test
 * gives its own, since the tests themselves run under a Claude Code session and write to no socket. */
export interface Seams {
  /** Whether a Claude Code process is among this process's ancestors. */
  readonly claudeAbove: () => boolean;
  /** How a notice is written to a session's socket (wake.ts `deliver`). */
  readonly send: Send;
  /** What is asked of the machine about a session's process before that write (host.ts `PROBE`). */
  readonly probe: Probe;
}

/** Whether a Claude Code process is among this process's ancestors (procs.ts `ancestry`, `runningOf`). An
 * ancestor the machine could not be asked about counts as one: what cannot be shown to be a terminal outside
 * Claude Code does not speak for the user. */
export function claudeAbove(): boolean {
  return ancestry(process.ppid).some((pid) => {
    const running = runningOf(pid);

    return running === "unknown" || (running !== "gone" && running.claude);
  });
}

/** This machine. */
export const HERE: Seams = { claudeAbove, send: deliver, probe: PROBE };

/** Whether this is a Claude Code session: its environment says so, or a Claude Code process is above it. */
function inClaude(machine: Machine, seams: Seams): boolean {
  return (machine.env("CLAUDECODE") ?? "") !== "" || (machine.env("CLAUDE_CODE_SESSION_ID") ?? "") !== "" || seams.claudeAbove();
}

function run(machine: Machine, argv: readonly string[], seams: Seams): Effect.Effect<number, UsageError | "help", Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const width = usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined);
    const top = (reason: string): UsageError => new UsageError({ prog: PROG, usage: formatUsage(PROG, ["[-h]"], ["[unlocked]"], width), reason });
    const [cmd, ...rest] = argv;

    if (cmd === "-h" || cmd === "--help") return yield* Effect.fail("help" as const);

    if (cmd === undefined) {
      out.out(`${statusLine(machine)}\n`);

      return 0;
    }

    if (cmd !== UNLOCKED.name) return yield* Effect.fail(top(`unrecognized arguments: ${argv.join(" ")}`));
    const parsed = parseArgs(`${PROG} ${cmd}`, UNLOCKED, rest, width);

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);

    if (parsed.extras.length > 0) return yield* Effect.fail(top(`unrecognized arguments: ${parsed.extras.join(" ")}`));

    if (inClaude(machine, seams)) {
      out.err(REFUSED);

      return 1;
    }

    const cleared = clear(machine, "user", parsed.args.str("note") ?? "fleet onepw unlocked");
    const settled = yield* Effect.promise(() => settle(machine, { socks: socksDir(machine.env), send: seams.send, probe: seams.probe }).catch((cause: unknown): Settled | Error => new Error(strerror(cause))));

    if (settled instanceof Error) {
      out.err(`onepw: ${cleared === undefined ? "nothing was locked" : "unlocked"}, and the fleets could not be told: ${settled.message}\n`);

      return 1;
    }

    for (const t of settled?.told ?? []) out.out(t.via === "session" ? `told ${t.fleet} (its session): ${t.text}\n` : `told ${t.fleet} (${t.to}, #${String(t.id)}): ${t.text}\n`);

    if ((settled?.told ?? []).length === 0) out.out(cleared === undefined ? "1Password: nothing was locked\n" : "1Password: unlocked; no fleet was told now\n");
    const untold = owedLine(machine);

    if (untold !== undefined) out.out(`${untold}\n`);

    return 0;
  });
}

/** Run `fleet onepw` with `argv` (after `onepw`); the exit code. `seams` are the machine's unless a test says. */
export function onepwCli(argv: readonly string[], seams: Seams = HERE): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv, seams).pipe(Effect.catch((failure) => (failure === "help" ? printUsage(HELP) : exitOf(failure))));
  });
}
