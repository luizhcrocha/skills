/**
 * `fleet tab {run,wait,read,close}`: a long command (a dev server, a watcher, a deploy, a backfill) in a Rex tab
 * right beside the caller's own, where the user sees it, in place of a background job no one sees. The caller is
 * the pane REX_SESSION and REX_BLOCK name, and `--as` the worker it runs for: Agent-tool workers share their
 * coordinator's pane, so the worker's name keeps their tabs apart. A tab is labelled `<name> <as> <caller's tab>`,
 * its name first, where a narrow tab bar still shows it, and `run` records each tab it opens, with its worker and name, in `tabs.json` in the fleets' state dir: a second
 * run adds a pane to that tab, and close closes only a tab so recorded, never one that only bears the label. A tab
 * holds at most {@link MAX_PANES} panes; a pane of the same label whose command ended is closed before the new one
 * splits the tab's largest pane. Each pane starts in the caller's cwd unless told otherwise, and is kept open after
 * its command exits, for the user to read. Outside Rex it refuses, and the caller runs the command as a background
 * Bash call instead.
 */
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { Refusal, UsageError } from "../errors.ts";
import { makeDirs, readText, strerror, writeAtomic } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asNumber, asObject, asString, parseObject, type Json, type JsonObject } from "../json.ts";
import { withLockAt } from "../lock.ts";
import { registryPlace } from "../registry.ts";
import { cmdLabel } from "../team/launcher.ts";
import { rexRunner, type RexRunner } from "../team/rex.ts";
import { World } from "../world.ts";
import { exitOf, printUsage } from "./exit.ts";

const USAGE = "usage: fleet tab [-h] {run,wait,read,close} ...\n";

export const HELP = `${USAGE}
A long command in a Rex tab beside yours, where the user sees it: a dev server, a watcher, a deploy, a
backfill, any run longer than about a minute. Your tab is the one REX_SESSION and REX_BLOCK name; outside
Rex every command refuses (exit 1), and you run the command as a background Bash call instead.
    run --as WORKER --tab NAME [--label PANE] [--cwd DIR] -- COMMAND...
                           run COMMAND in tab "NAME WORKER <your tab>", opened right after yours, or, when
                           WORKER's run opened it, in a new pane of it; WORKER is your worker id (a
                           coordinator gives its own). The pane is labelled PANE (default: the command's
                           first word), starts in DIR (default: your cwd) with the login shell's environment,
                           not yours, and stays open after the command exits. Prints the pane's block id.
                           A pane of the same label whose command ended is closed first; a tab holds at most
                           4 panes. Group by purpose: a deploy and its backfill are two panes of one tab
    wait BLOCK             block until the pane's command exits; print "exit N", then its last 20 lines, and
                           exit N. Run it as a run_in_background Bash call: its exit notifies you
    read BLOCK [--lines N] print the pane's last N lines (default 40)
    close --as WORKER NAME close the tab WORKER's run opened as NAME, and what runs in it, when you are done
The pane runs the command as you would: a whole suite under
\`fleet fleets gate run --as <name> --wait 1800 -- <command>\`, a build or another heavy check between
\`fleet fleets gate take\` and \`gate free\`.`;

const COMMANDS = ["run", "wait", "read", "close"] as const;

const NOT_IN_REX = "not in Rex (REX_SESSION is not set): run the command as a background Bash call instead";

const WAIT_LINES = 20;

const READ_LINES = 40;

/** The most panes one tab holds. */
const MAX_PANES = 4;

/** What rex prints when it cannot reach its server. */
const UNREACHABLE = /connecting to Rex server/;

function usage(reason: string): Effect.Effect<never, UsageError> {
  return Effect.fail(new UsageError({ prog: "fleet tab", usage: USAGE, reason }));
}

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "tab", reason }));
}

function rowsOf(object: JsonObject, key: string): JsonObject[] {
  return (asArray(object[key]) ?? []).flatMap((row) => {
    const value = asObject(row);

    return value === undefined ? [] : [value];
  });
}

/** The last `n` lines of a pane's screen. */
function lastLines(screen: string, n: number): string {
  const lines = screen.replace(/\n+$/, "").split("\n");

  return lines.slice(-n).join("\n");
}

/** The first line of what rex said on stderr, without its `Error: `. */
function firstLine(stderr: string): string {
  return stderr.trim().split("\n")[0]?.replace(/^Error: /, "") ?? "";
}

interface Window {
  readonly id: string;
  readonly label: string;
}

interface Pane {
  readonly id: string;
  readonly label: string;
  readonly window: string;
}

/** The caller's session: its tabs and panes, and the label its tabs are named after. */
interface Place {
  readonly sid: string;
  readonly windows: readonly Window[];
  readonly panes: readonly Pane[];
  readonly mine: Window;
}

/** A tab `run` opened: in which session, for which worker, under which name. */
interface Opened {
  readonly session: string;
  readonly as: string;
  readonly name: string;
  readonly window: string;
}

function openedOf(row: JsonObject): Opened[] {
  const [session, as, name, window] = [row["session"], row["as"], row["name"], row["window"]].map(asString);

  return session === undefined || as === undefined || name === undefined || window === undefined ? [] : [{ session, as, name, window }];
}

/** The tabs recorded in `path`; none when it is missing or unreadable. */
function readOpened(path: string): Opened[] {
  const text = readText(path);

  return text === undefined ? [] : rowsOf(Option.getOrUndefined(parseObject(text)) ?? {}, "tabs").flatMap(openedOf);
}

/** Rewrite the record at `path` with `change`, under `tabs.lock` beside it; why it could not, else undefined. */
function rewriteOpened(path: string, change: (tabs: readonly Opened[]) => readonly Opened[]): string | undefined {
  try {
    makeDirs(dirname(path));
    withLockAt(join(dirname(path), "tabs.lock"), "a", () => writeAtomic(path, `${JSON.stringify({ tabs: change(readOpened(path)) }, null, 2)}\n`));

    return undefined;
  } catch (error) {
    return strerror(error);
  }
}

/** The rectangle of each pane in a `rex window inspect --json`'s layout: x, y, width and height, each 0 to 1. */
function rectsOf(node: Json | undefined, into: Map<string, readonly number[]>): Map<string, readonly number[]> {
  const object = asObject(node);

  if (object === undefined) return into;
  const block = asString(object["block_id"]);
  const rect = (asArray(object["rect"]) ?? []).map((n) => asNumber(n) ?? 0);

  if (block !== undefined && rect.length === 4) into.set(block, rect);
  const split = asObject(object["split"]);

  if (split !== undefined) {
    rectsOf(split["before"], into);
    rectsOf(split["after"], into);
  }

  for (const layer of asArray(object["layers"]) ?? []) rectsOf(asObject(layer)?.["layout"], into);

  return into;
}

function program(run: RexRunner, argv: readonly string[], env: (name: string) => string | undefined, here: string, state: string): Effect.Effect<number, Refusal | UsageError, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    const printed = (args: readonly string[]): Effect.Effect<string, Refusal> => {
      const ran = run(args);

      if ("why" in ran) return refuse(ran.why);

      if (ran.code !== 0) {
        const said = firstLine(ran.stderr);

        return refuse(`rex ${args.slice(0, 2).join(" ")}: ${said === "" ? `exit ${String(ran.code)}` : said}`);
      }

      return Effect.succeed(ran.stdout);
    };

    const json = (args: readonly string[]): Effect.Effect<JsonObject, Refusal> => Effect.map(printed(args), (stdout) => Option.getOrUndefined(parseObject(stdout)) ?? {});

    const [command, ...rest] = argv;

    if (command === "-h" || command === "--help") return yield* printUsage(HELP);
    const sid = env("REX_SESSION");

    if (sid === undefined || sid === "") return yield* refuse(NOT_IN_REX);

    const place = Effect.gen(function* () {
      const me = env("REX_BLOCK");

      if (me === undefined || me === "") return yield* refuse("REX_BLOCK is not set, so your own tab is not known");
      const listed = yield* json(["window", "ls", "-s", sid, "--json"]);

      const windows = rowsOf(listed, "windows").flatMap((w): Window[] => {
        const id = asString(w["window_id"]);

        return id === undefined ? [] : [{ id, label: asString(w["label"]) ?? "" }];
      });

      const panes = rowsOf(yield* json(["block", "ls", "-s", sid, "--json"]), "blocks").flatMap((b): Pane[] => {
        const id = asString(b["block_id"]);
        const window = asString(b["window_id"]);

        return id === undefined || window === undefined ? [] : [{ id, window, label: asString(b["label"]) ?? "" }];
      });

      const mine = windows.find((w) => w.id === panes.find((p) => p.id === me)?.window);

      if (mine === undefined) return yield* refuse(`rex lists no tab holding your pane ${me}`);
      const label = mine.label === "" ? (asString(listed["label"]) ?? "") : mine.label;

      return { sid, windows, panes, mine: { id: mine.id, label } } satisfies Place;
    });

    const tabName = (name: string | undefined): Effect.Effect<string, UsageError> => {
      if (name === undefined || name === "" || name.startsWith("-")) return usage("a tab NAME is required");

      if (name === "cmd") return usage(`"cmd" is the shell tab fleet team opens beside an agent's (${cmdLabel("<agent>")}), not one of fleet tab's`);

      return Effect.succeed(name);
    };

    const worker = (as: string | undefined): Effect.Effect<string, UsageError> =>
      as === undefined || as === "" || as.startsWith("-") ? usage("--as WORKER is required: your worker id (a coordinator gives its own)") : Effect.succeed(as);

    /** The tabs `as`'s run opened as `name` that are still open, after the record drops this session's closed ones. */
    const recorded = (at: Place, as: string, name: string): Effect.Effect<Window[], Refusal> => {
      const open = new Set(at.windows.map((w) => w.id));
      const why = rewriteOpened(state, (tabs) => tabs.filter((t) => t.session !== at.sid || open.has(t.window)));

      if (why !== undefined) return refuse(`could not read the record of the tabs fleet tab opened (${state}): ${why}`);
      const ids = new Set(readOpened(state).flatMap((t) => (t.session === at.sid && t.as === as && t.name === name ? [t.window] : [])));

      return Effect.succeed(at.windows.filter((w) => ids.has(w.id)));
    };

    if (command === undefined) return yield* usage("the following arguments are required: cmd");

    if (!COMMANDS.some((c) => c === command)) return yield* usage(`argument cmd: invalid choice: '${command}' (choose from ${COMMANDS.map((c) => `'${c}'`).join(", ")})`);

    if (command === "run") {
      const cut = rest.indexOf("--");
      const words = cut === -1 ? [] : rest.slice(cut + 1);
      const flags = cut === -1 ? rest : rest.slice(0, cut);
      const given = new Map<string, string>();

      for (let at = 0; at < flags.length; at += 2) {
        const flag = flags[at] ?? "";
        const value = flags[at + 1];

        if (!["--as", "--tab", "--label", "--cwd"].includes(flag)) return yield* usage(`unrecognized arguments: ${flag}`);

        if (value === undefined) return yield* usage(`argument ${flag}: expected one argument`);
        given.set(flag, value);
      }

      if (words.length === 0) return yield* usage("run takes the command after --");
      const as = yield* worker(given.get("--as"));
      const name = yield* tabName(given.get("--tab"));
      const at = yield* place;
      const label = given.get("--label") ?? words[0]?.split("/").pop() ?? "";
      const where = ["-c", given.get("--cwd") ?? here];
      const title = `${name} ${as} ${at.mine.label}`;
      const [open] = yield* recorded(at, as, name);
      const inTab = at.panes.filter((p) => p.window === open?.id);

      const ended = inTab.filter((p) => {
        if (p.label !== label) return false;
        const ran = run(["block", "call", "-s", at.sid, "-b", p.id, "process"]);
        const shown = "why" in ran || ran.code !== 0 ? undefined : Option.getOrUndefined(parseObject(ran.stdout));

        return asObject(shown?.["last_exit"]) !== undefined;
      });

      const live = inTab.filter((p) => !ended.includes(p));

      if (live.length >= MAX_PANES) {
        return yield* refuse(`tab ${title} holds ${String(live.length)} panes, the most one tab holds: close the tab (fleet tab close --as ${as} ${name}) or use another --tab`);
      }

      for (const p of ended) yield* printed(["block", "close", "-s", at.sid, p.id]);

      if (open !== undefined && live.length > 0) {
        const inspected = run(["window", "inspect", "-s", at.sid, open.id, "--json"]);
        const rects = "why" in inspected || inspected.code !== 0 ? new Map<string, readonly number[]>() : rectsOf(Option.getOrUndefined(parseObject(inspected.stdout)), new Map());
        const area = (p: Pane): number => (rects.get(p.id)?.[2] ?? 0) * (rects.get(p.id)?.[3] ?? 0);
        const anchor = live.reduce((best, p) => (area(p) > area(best) ? p : best));
        const [, , width = 1, height = 1] = rects.get(anchor.id) ?? [];
        const side = width > height ? "--split=right" : "--split=below";
        const made = yield* json(["split", "-s", at.sid, "-b", anchor.id, side, "--label", label, "--keep-open", "--focus=false", ...where, "--json", "--", ...words]);
        const block = asString(asArray(made["block_ids"])?.[0]);

        if (block === undefined) return yield* refuse("rex split did not say the new pane's block id");
        out.out(`${block}\n`);

        return 0;
      }

      const made = yield* json(["window", "new", "-s", at.sid, title, "--keep-open", "--focus=false", ...where, "--json", "--", ...words]);
      const window = asString(made["window_id"]);
      const block = asString(asArray(made["block_ids"])?.[0]);

      if (window === undefined || block === undefined) return yield* refuse("rex window new did not say the new tab's id or its pane's");
      const why = rewriteOpened(state, (tabs) => [...tabs, { session: at.sid, as, name, window }]);

      if (why !== undefined) out.err(`tab: tab ${title} runs, but it could not be recorded (${state}: ${why}), so close will not find it; close it in Rex\n`);
      const renamed = run(["block", "rename", "-s", at.sid, "--", block, label]);

      if ("why" in renamed || renamed.code !== 0) out.err(`tab: the pane runs, but rex could not label it ${label}\n`);
      const moved = run(["window", "move", "-s", at.sid, window, "--after", at.mine.id]);

      if ("why" in moved || moved.code !== 0) out.err(`tab: tab ${title} runs, but rex could not move it beside yours; it is last\n`);
      out.out(`${block}\n`);

      return 0;
    }

    if (command === "close") {
      const flag = rest.indexOf("--as");
      const as = yield* worker(flag === -1 ? undefined : rest[flag + 1]);
      const names = rest.filter((_, i) => i !== flag && i !== flag + 1);

      if (names.length !== 1) return yield* usage("close takes --as WORKER and one tab NAME");
      const name = yield* tabName(names[0]);
      const at = yield* place;
      const open = (yield* recorded(at, as, name)).filter((w) => w.id !== at.mine.id);

      if (open.length === 0) return yield* refuse(`you have no tab ${name} ${as} ${at.mine.label} that fleet tab run opened`);

      for (const w of open) yield* printed(["window", "close", "-s", at.sid, w.id]);
      const closed = new Set(open.map((w) => w.id));
      const why = rewriteOpened(state, (tabs) => tabs.filter((t) => t.session !== at.sid || !closed.has(t.window)));

      if (why !== undefined) out.err(`tab: closed, but the record (${state}) could not be updated: ${why}\n`);

      return 0;
    }

    const [block, ...more] = rest;

    if (block === undefined || block.startsWith("-")) return yield* usage(`${command} takes the pane's BLOCK id`);
    let lines = command === "wait" ? WAIT_LINES : READ_LINES;

    if (command === "read" && more.length > 0) {
      const n = more[0] === "--lines" && more.length === 2 ? Number(more[1]) : Number.NaN;

      if (!Number.isInteger(n) || n < 1) return yield* usage("read takes --lines N, N a whole number above 0");
      lines = n;
    } else if (more.length > 0) return yield* usage(`unrecognized arguments: ${more.join(" ")}`);

    const capture = (): Effect.Effect<string, Refusal> => Effect.map(printed(["capture", "-s", sid, "-b", block, "--trim", "--unwrap"]), (screen) => lastLines(screen, lines));

    if (command === "read") {
      out.out(`${yield* capture()}\n`);

      return 0;
    }

    const waited = run(["wait", "-s", sid, block]);

    if ("why" in waited) return yield* refuse(waited.why);
    const said = firstLine(waited.stderr);

    if (UNREACHABLE.test(waited.stderr)) return yield* refuse(`rex is unreachable, so how ${block} ended is not known: ${said}`);
    const last = asObject((yield* json(["block", "call", "-s", sid, "-b", block, "process"]).pipe(Effect.orElseSucceed((): JsonObject => ({}))))["last_exit"]);
    const status = /^exit status (\d+)$/.exec(said)?.[1];
    const fromWait = said === "" ? waited.code : status === undefined ? undefined : Number(status);
    const code = asNumber(last?.["exit_code"]) ?? fromWait;

    if (code === undefined) return yield* refuse(`rex wait ${block}: ${said}`);
    out.out(`exit ${String(code)}\n`);
    const screen = yield* Effect.result(capture());

    if (Result.isFailure(screen)) out.err(`tab: rex could not capture ${block}: ${screen.failure.reason}\n`);
    else out.out(`${screen.success}\n`);

    return code;
  });
}

/** `fleet tab` with `argv` (after `tab`) over `run`, run from `here`; its exit code. */
export function tabWith(argv: readonly string[], run: RexRunner, here: string): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;
    const state = join(registryPlace(machine.env, machine.config).home, "tabs.json");

    return yield* program(run, argv, machine.env, here, state).pipe(Effect.catch(exitOf));
  });
}

/** `fleet tab` with `argv` (after `tab`) over the installed rex, from this process's cwd. */
export function tabCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return tabWith(argv, rexRunner(), process.cwd());
}
