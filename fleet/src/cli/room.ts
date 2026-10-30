/**
 * `fleet room PROJECT since|say|forwarded …`: the project room from a team folder (room design, slice 5). `since`
 * reads the folder's `room.jsonl`; `say` and `forwarded` write through the team's one program command, fleet-run,
 * as the cloud takes a room line only from a program of the team (`from` is the program's fleet).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal, UsageError } from "../errors.ts";
import { Out } from "../io.ts";
import { pyStr } from "../json.ts";
import { cursorOf, membersOf, readRoom, recordEvent, roomAt, sinceLine, writeCursor, type Room } from "../room/room.ts";
import { World, type Machine } from "../world.ts";
import { formatUsage, opt, parseArgs, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";

const PROG = "fleet room";

const AS = opt.value("--as", { metavar: "TEAM" });

/** Each room command and what it takes. */
export const ROOM_COMMANDS: readonly CommandSpec[] = [
  { name: "since", positionals: [{ dest: "k" }], options: [AS] },
  { name: "say", positionals: [{ dest: "text" }], options: [AS, opt.value("--re", { int: true, metavar: "K" })], optionsFirst: true },
  { name: "answer", positionals: [{ dest: "k" }, { dest: "text" }], options: [AS] },
  { name: "forwarded", positionals: [{ dest: "k" }], options: [AS, opt.value("--to", { required: true, metavar: "AGENT" })] },
];

const HELP = `usage: ${PROG} PROJECT {since,say,answer,forwarded} ...

The project's room as this machine's team folders hold it (DIR/room.jsonl, written by the host's export).

    since K [--as TEAM]                  the lines after #K, one each (\`↳#J\` is its re); moves the team's cursor
    say [--as TEAM] [--re K] TEXT        post TEXT to the room as TEAM, one program through fleet-run
    answer K [--as TEAM] TEXT            post a worker's answer to line #K back to the room, as a reply to it
    forwarded K --to AGENT [--as TEAM]   you forwarded line #K to AGENT verbatim: ack it, so it is not told again

TEAM is the team folder the command reads and writes as: --as, else the one team folder here whose room.json
names PROJECT. A room line wakes nobody but the teams it tags (and the manager, for the user's untagged line):
read the rest with \`since\` only when a line needs it.`;

function refuse(reason: string): Refusal {
  return new Refusal({ speaker: "room", reason });
}

/** The room of PROJECT seen from team `as`, else from the one team folder here in that project. */
function roomOf(machine: Machine, project: string, as: string | undefined): Room | Refusal {
  const entries = machine.registry.shown();

  if (as !== undefined) {
    const entry = entries.find((e) => e.id === as || e.aliases.includes(as));

    if (entry === undefined) return refuse(`no team ${pyStr(as)} on this machine`);
    const room = roomAt(entry.dir);

    if (room === undefined || room.members.project !== project) return refuse(`${entry.dir} holds no room of project ${project}: its export writes room.json once the team is in one`);

    return room;
  }

  const inProject = entries.filter((e) => membersOf(e.dir)?.project === project);
  const [only] = inProject;

  if (only === undefined) return refuse(`no team folder on this machine is in project ${project}`);

  if (inProject.length > 1) return refuse(`project ${project} has team folders here for ${inProject.map((e) => e.id).sort().join(", ")}: give --as TEAM`);
  const room = roomAt(only.dir);

  return room ?? refuse(`${only.dir} names project ${project} but has no cloud.json: only a team moved to the cloud has a room`);
}

function lineNumber(given: string | undefined): number | Refusal {
  const n = Number(given);

  return given !== undefined && /^[0-9]+$/u.test(given) && Number.isSafeInteger(n) ? n : refuse(`K is a line number, as 41, and ${pyStr(given ?? "")} is not`);
}

/** Send `program` to the team at `root` through fleet-run, relaying what it prints; its exit code. */
function sendProgram(machine: Machine, root: string, program: string): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const bin = machine.env("TSTACK_FLEET_RUN") ?? join(import.meta.dir, "..", "..", "bin", "fleet-run");
    const done = spawnSync(bin, [], { input: program, encoding: "utf8", env: { ...process.env, FLEET_DIR: root } });

    if (done.error !== undefined) {
      out.err(`room: cannot run ${bin}: ${done.error.message}\n`);

      return 127;
    }

    if (done.stdout !== "") out.out(done.stdout);

    if (done.stderr !== "") out.err(done.stderr);

    return done.status ?? 1;
  });
}

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal | UsageError | "help", Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const width = usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined);
    const names = ROOM_COMMANDS.map((c) => c.name);
    const top = (reason: string): UsageError => new UsageError({ prog: PROG, usage: formatUsage(PROG, ["[-h]"], ["project", `{${names.join(",")}} ...`], width), reason });
    const [project, cmd, ...rest] = argv;

    if (project === "-h" || project === "--help" || cmd === "-h" || cmd === "--help") return yield* Effect.fail("help" as const);

    if (project === undefined || cmd === undefined) return yield* Effect.fail(top(`the following arguments are required: ${project === undefined ? "project, cmd" : "cmd"}`));
    const spec = ROOM_COMMANDS.find((c) => c.name === cmd);

    if (spec === undefined) return yield* Effect.fail(top(`argument cmd: invalid choice: ${pyStr(cmd)} (choose from ${names.map((n) => pyStr(n)).join(", ")})`));
    const parsed = parseArgs(`${PROG} project ${cmd}`, spec, rest, width);

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);

    if (parsed.extras.length > 0) return yield* Effect.fail(top(`unrecognized arguments: ${parsed.extras.join(" ")}`));
    const { args } = parsed;
    const room = roomOf(machine, project, args.str("as"));

    if (room instanceof Refusal) return yield* Effect.fail(room);

    if (cmd === "say") {
      const re = args.int("re");
      const text = JSON.stringify(args.str("text") ?? "");

      return yield* sendProgram(machine, room.root, `return await room(${text}${re === undefined ? "" : `, { re: ${re} }`});\n`);
    }

    const k = lineNumber(args.str("k"));

    if (k instanceof Refusal) return yield* Effect.fail(k);

    if (cmd === "answer") return yield* sendProgram(machine, room.root, `return await room.answer(${k}, ${JSON.stringify(args.str("text") ?? "")});\n`);

    if (cmd === "forwarded") {
      const agent = args.str("to") ?? "";

      if (!room.lines.some((l) => l.id === k)) return yield* Effect.fail(refuse(`no line #${k} in the room of ${project} that ${room.root} holds`));
      const code = yield* sendProgram(machine, room.root, `return await room.forwarded(${k}, ${JSON.stringify(agent)});\n`);

      if (code === 0) recordEvent(machine, room.root, { kind: "forwarded", team: room.team, line: k, agent });

      return code;
    }

    const after = readRoom(room.root).filter((l) => l.id > k);

    for (const line of after) out.out(`${sinceLine(line, room.team, room.members.manager)}\n`);
    const last = after.at(-1)?.id;

    if (last !== undefined && last > cursorOf(room.root)) writeCursor(room.root, last);
    recordEvent(machine, room.root, { kind: "pull", team: room.team, since: k, lines: after.length });

    return 0;
  });
}

/** Run `fleet room` with `argv` (after `room`); the exit code. */
export function roomCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv).pipe(Effect.catch((failure) => (failure === "help" ? printUsage(HELP) : exitOf(failure))));
  });
}
