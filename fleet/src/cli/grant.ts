/**
 * `fleet grant use DIR --call CALL` and `fleet grants DIR`: a kind the owner granted for 24 hours (allow-24h), used and
 * listed. The host alone writes the kinds file and issues rules; this reads the file and asks. It holds no authority:
 * the host runs the matcher again over the call and issues today's one-time grant for it, or refuses.
 *
 * The wire, in this one place, is `POST /grants/use` on the host service (`$FLEET_RUN_URL`, project.ts `hostOf`):
 *   request   {@link UseAsk}. Of the environment only HOME and CLAUDE_PROJECT_DIR go out, so no secret can.
 *   200       {@link Issued}, with `rule` exactly `Bash(<call>)`; anything else fails closed here.
 *   non-2xx   `{_tag, why}`.
 */
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal, UsageError } from "../errors.ts";
import { exists, readText } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, parseObject, pyStr, type Json } from "../json.ts";
import { callKindOf, kindWords, type CallKind } from "../ledger/allow-kind.ts";
import { World, type Machine } from "../world.ts";
import { formatUsage, opt, parseArgs, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";
import { call, hostOf } from "./project.ts";

/** What `fleet grant use` sends. */
interface UseAsk {
  readonly dir: string;
  readonly call: string;
  readonly cwd: string;
  readonly root: string;
  readonly agent_id: string | null;
  readonly env: { readonly HOME: string; readonly CLAUDE_PROJECT_DIR: string };
}

/** What the host answers when it issued the grant. */
interface Issued {
  readonly kind: CallKind;
  readonly rule: string;
  readonly file: string;
  readonly until: string;
}

const USE_PATH = "/grants/use";

const NO_RUN = "Run nothing of it; ask on a card";

const USE: CommandSpec = { name: "use", positionals: [{ dest: "dir" }], options: [opt.value("--call", { metavar: "CALL" }), opt.value("--root", { metavar: "ROOT" }), opt.value("--agent-id", { metavar: "ID" })] };

const LIST: CommandSpec = { name: "grants", positionals: [{ dest: "dir" }], options: [] };

export const GRANT_HELP = `usage: fleet grant use DIR --call CALL [--root ROOT] [--agent-id ID]

Ask this machine's fleet-host for today's one-time grant of CALL, under a kind the owner allowed for 24 hours. It issues the exact rule or refuses; no host, no grant. Then run CALL, unchanged, once, as a Bash call of its own.`;

export const LIST_HELP = `usage: fleet grants DIR

Every kind granted on this machine, what holds it now, and each use. A kind is of a repo, not of a fleet, so DIR names who asks and filters nothing.`;

/** The host's answer as {@link Issued}, when it issued exactly `asked`; else why nothing runs. */
function issuedOf(body: Json | undefined, asked: string): Issued | { readonly why: string } {
  const row = asObject(body);
  const kind = callKindOf(row?.["kind"]);
  const rule = asString(row?.["rule"]);
  const file = asString(row?.["file"]);
  const until = asString(row?.["until"]);

  if (kind === undefined || rule === undefined || file === undefined || until === undefined) return { why: `the host's answer is not a grant (${JSON.stringify(body ?? null).slice(0, 200)}): run nothing, and tell the owner` };

  return rule === `Bash(${asked})` ? { kind, rule, file, until } : { why: `the host issued ${rule}, which is not this call: run nothing, and tell the owner` };
}

function refused(status: number, body: Json | undefined, text: string): string {
  const row = asObject(body);

  if (status === 404 && asString(row?.["error"]) === "no such route") return `this machine's fleet-host has no ${USE_PATH} yet: no 24-hour kind can be used here. ${NO_RUN}`;

  return `the host refused (${asString(row?.["_tag"]) ?? String(status)}): ${asString(row?.["why"]) ?? (text.trim() === "" || row !== undefined ? "no reason given" : text.trim())}. ${NO_RUN}`;
}

function use(machine: Machine, argv: readonly string[], cwd: string): Effect.Effect<number, Refusal | UsageError | "help", Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const fail = (reason: string) => Effect.fail(new Refusal({ speaker: "grant", reason }));
    const width = usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined);
    const [verb, ...rest] = argv;

    if (verb === "-h" || verb === "--help") return yield* Effect.fail("help" as const);

    if (verb !== "use") return yield* Effect.fail(new UsageError({ prog: "fleet grant", usage: formatUsage("fleet grant", ["[-h]"], ["{use} ..."], width), reason: verb === undefined ? "the following arguments are required: cmd" : `argument cmd: invalid choice: ${pyStr(verb)} (choose from 'use')` }));
    const parsed = parseArgs("fleet grant use", USE, rest, width);

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);
    const usage = (reason: string) => new UsageError({ prog: "fleet grant use", usage: "usage: fleet grant use DIR --call CALL [--root ROOT] [--agent-id ID]", reason });

    if (parsed.extras.length > 0) return yield* Effect.fail(usage(`unrecognized arguments: ${parsed.extras.join(" ")}`));
    const asked = parsed.args.str("call");

    if (asked === undefined) return yield* Effect.fail(usage("the following arguments are required: --call"));
    const origin = hostOf(machine);

    if ("why" in origin) return yield* fail(origin.why);
    const projectDir = machine.env("CLAUDE_PROJECT_DIR") ?? cwd;

    const body: UseAsk = {
      dir: resolve(cwd, parsed.args.str("dir") ?? ""),
      call: asked,
      cwd,
      root: parsed.args.str("root") ?? projectDir,
      agent_id: parsed.args.str("agent_id") ?? null,
      env: { HOME: machine.env("HOME") ?? "", CLAUDE_PROJECT_DIR: projectDir },
    };

    const reply = yield* Effect.promise(() => call(origin.origin, "POST", USE_PATH, { ...body }));

    if ("why" in reply) return yield* fail(`${reply.why}: nothing is granted, so run nothing of it`);

    if (reply.status < 200 || reply.status > 299) return yield* fail(refused(reply.status, reply.body, reply.text));
    const issued = issuedOf(reply.body, asked);

    if ("why" in issued) return yield* fail(issued.why);
    out.out(`granted under the kind: ${kindWords(issued.kind)}, until ${issued.until}. Run exactly this call now, unchanged, once, as a Bash call of its own; the rule is in ${issued.file}:\n  ${asked}\n`);

    return 0;
  });
}

/** What holds a kind now: its ended record, else the clock against its end time. */
function standing(row: Record<string, Json | undefined>, now: Date): string {
  const ended = asObject(row["ended"]);
  const until = asString(row["until"]) ?? "?";

  if (ended !== undefined) return `${asString(ended["why"]) ?? "ended"} ${asString(ended["at"]) ?? "?"}`;

  return new Date(until).getTime() > now.getTime() ? `live until ${until}` : `lapsed ${until}`;
}

/** One kind and its uses, as `fleet grants` prints them. */
function kindLines(value: Json, now: Date): string {
  const row = asObject(value);
  const kind = callKindOf(value);

  if (row === undefined || kind === undefined) return `a row of kinds.json does not read: ${JSON.stringify(value).slice(0, 200)}\n`;
  const granted = asObject(row["granted"]);
  const uses = asArray(row["uses"]) ?? [];
  const head = `${asString(row["id"]) ?? "?"}: ${kindWords(kind)}: ${standing(row, now)}, granted on ${asString(granted?.["card"]) ?? "?"} of ${asString(granted?.["team"]) ?? "?"}, ${String(uses.length)} ${uses.length === 1 ? "use" : "uses"}\n`;

  return head + uses.map((u) => {
    const one = asObject(u);
    const field = (name: string): string => asString(one?.[name]) ?? "?";

    return `  ${field("at")} ${field("team")} ${field("workspace")} ${field("commit")}: ${field("command")}\n`;
  }).join("");
}

function grants(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal | UsageError | "help", Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const fail = (reason: string) => Effect.fail(new Refusal({ speaker: "grant", reason }));
    const parsed = parseArgs("fleet grants", LIST, argv, usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined));

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);

    if (parsed.extras.length > 0) return yield* Effect.fail(new UsageError({ prog: "fleet grants", usage: "usage: fleet grants DIR", reason: `unrecognized arguments: ${parsed.extras.join(" ")}` }));
    const dir = parsed.args.str("dir") ?? "";

    if (!exists(join(dir, "state.json")) && !exists(join(dir, "cloud.json"))) return yield* fail(`${dir} is not a fleet's folder: it holds no state.json or cloud.json`);
    const file = join(machine.env("HOME") ?? "", ".claude", "tstack-grants", "kinds.json");
    const text = readText(file);

    if (text === undefined) {
      out.out("no kind is granted on this machine\n");

      return 0;
    }

    const kinds = asArray(Option.getOrUndefined(parseObject(text))?.["kinds"]);

    if (kinds === undefined) return yield* fail(`${file} does not read: it is the host's to write, so tell the owner`);
    out.out(kinds.length === 0 ? "no kind is granted on this machine\n" : kinds.map((k) => kindLines(k, machine.now())).join(""));

    return 0;
  });
}

const finish = (help: string) => (failure: Refusal | UsageError | "help") => (failure === "help" ? printUsage(help) : exitOf(failure));

/** `fleet grant` with `argv` (after `grant`), from `cwd`; the exit code. */
export function grantWith(argv: readonly string[], cwd: string): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    return yield* use(yield* World, argv, cwd).pipe(Effect.catch(finish(GRANT_HELP)));
  });
}

/** `fleet grants` with `argv` (after `grants`); the exit code. */
export function grantsWith(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    return yield* grants(yield* World, argv).pipe(Effect.catch(finish(LIST_HELP)));
  });
}

/** `fleet grant` with `argv` (after `grant`), from the process's directory. */
export function grantCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return grantWith(argv, process.cwd());
}
