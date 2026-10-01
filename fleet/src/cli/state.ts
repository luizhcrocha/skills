/**
 * `fleet state DIR COMMAND …`: the ledger CLI (Python's `state.py`), one command per event. The run of
 * one command is SPEC's: refuse `note`, strip `--no-render`/`-q`, parse, make DIR, read the ledger, run
 * the handler, print the warnings, then number, stamp, check and write, and render the page.
 */
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { deafWarning } from "../chat/chat.ts";
import { stampOf } from "../clock.ts";
import { Refusal, stateRefusal, UsageError } from "../errors.ts";
import { exists, makeDirs, readText, resolvePath, SKILL_DIR, writeText } from "../files.ts";
import { Out } from "../io.ts";
import { parseObject } from "../json.ts";
import { cliLookups } from "../page/lookups.ts";
import { pageHtml, readTemplate, TEMPLATE, writePage } from "../page/render.ts";
import { view } from "../page/view.ts";
import * as commands from "../ledger/commands.ts";
import { ledgerText, parseLedger, type Ledger } from "../ledger/model.ts";
import { nextStepId, number } from "../ledger/numbers.ts";
import { showLines } from "../ledger/show.ts";
import { AGENT_STATUSES, ASKS, KINDS, STATUSES, STEP_STATUSES, validate } from "../ledger/validate.ts";
import { readChat } from "../chat/store.ts";
import { activeWorkspaces, leftOpen, offPolicy, overlapping, staleNow, staleRows, unpruned, unrecorded } from "../ledger/warnings.ts";
import { readObject } from "../registry.ts";
import { World, type Machine } from "../world.ts";
import { opt, parseCommand, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";

const ID = [{ dest: "id" }] as const;

/** Each command and what it takes, as state.py's argparse declares them. */
export const STATE_COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    positionals: [],
    options: [
      opt.value("--project", { required: true }),
      opt.value("--goal", { required: true }),
      opt.value("--now"),
      opt.value("--role", { choices: ["coordinator", "manager"] }),
    ],
  },
  {
    name: "set",
    positionals: [],
    options: [opt.value("--status", { choices: STATUSES }), opt.value("--now"), opt.value("--goal")],
  },
  { name: "milestone", positionals: ID, options: [opt.value("--title")] },
  {
    name: "step",
    positionals: ID,
    options: [
      opt.value("--milestone"),
      opt.value("--title"),
      opt.value("--status", { choices: STEP_STATUSES }),
      opt.value("--agent"),
      opt.value("--before", { metavar: "STEP" }),
      opt.value("--after", { metavar: "STEP" }),
      opt.value("--remove", { metavar: "REASON" }),
    ],
    exclusive: [["before", "after", "remove"]],
  },
  {
    name: "agent",
    positionals: ID,
    options: [
      opt.value("--task"),
      opt.value("--skill", { choices: commands.SKILLS }),
      opt.value("--model", { choices: commands.MODELS }),
      opt.star("--lane"),
      opt.value("--milestone"),
      opt.value("--status", { choices: AGENT_STATUSES }),
      opt.value("--tokens", { int: true }),
      opt.value("--duration-ms", { int: true }),
      opt.value("--task-id"),
      opt.value("--report"),
      opt.value("--brief"),
      opt.value("--name"),
      opt.value("--step"),
      opt.value("--log"),
      opt.flag("--important"),
    ],
  },
  {
    name: "roadblock",
    positionals: ID,
    options: [
      opt.value("--title"),
      opt.value("--detail"),
      opt.value("--severity", { choices: commands.SEVERITIES }),
      opt.value("--needs", { choices: commands.NEEDS }),
      opt.value("--agent"),
      opt.value("--decision"),
      opt.flag("--resolved"),
      opt.flag("--open"),
      opt.flag("--important"),
    ],
    exclusive: [["resolved", "open"]],
  },
  {
    name: "decision",
    positionals: ID,
    options: [
      opt.value("--kind", { choices: KINDS }),
      opt.value("--title"),
      opt.value("--question"),
      opt.value("--why"),
      opt.flag("--blocking"),
      opt.flag("--not-blocking"),
      opt.append("--option", { metavar: '"KEY: label | consequence"' }),
      opt.flag("--same-options"),
      opt.value("--recommend"),
      opt.value("--reason"),
      opt.value("--secret", { metavar: "NAME" }),
      opt.value("--manual"),
      opt.value("--body", { metavar: "FILE" }),
      opt.flag("--no-body"),
      opt.value("--agent"),
      opt.value("--supersedes", { metavar: "ID" }),
      opt.value("--step"),
      opt.value("--milestone"),
      opt.value("--log"),
      opt.value("--asks", { choices: ASKS }),
      opt.value("--decide", { metavar: "ANSWER" }),
      opt.value("--withdraw", { metavar: "REASON" }),
      opt.value("--resolution", { metavar: "HOW" }),
    ],
    exclusive: [
      ["blocking", "not_blocking"],
      ["body", "no_body"],
      ["decide", "withdraw"],
    ],
  },
  {
    name: "event",
    positionals: [{ dest: "text" }],
    options: [opt.value("--agent"), opt.value("--kind", { choices: commands.EVENT_KINDS }), opt.flag("--important")],
  },
  {
    name: "grill",
    positionals: ID,
    options: [
      opt.value("--title"),
      opt.value("--why"),
      opt.append("--ask", { metavar: '"TITLE | QUESTION | RECOMMENDATION | WHY"' }),
      opt.append("--reason", { metavar: '"Q3: WHY"' }),
      opt.value("--of", { metavar: "Q" }),
      opt.append("--answer", { metavar: '"Q3: ANSWER"' }),
      opt.append("--drop", { metavar: '"Q4: WHY"' }),
      opt.append("--revise", { metavar: '"Q3: TITLE | QUESTION | RECOMMENDATION | WHY"' }),
      opt.flag("--blocking"),
      opt.value("--agent"),
      opt.value("--step"),
      opt.value("--milestone"),
      opt.value("--done", { metavar: "SUMMARY" }),
    ],
  },
  {
    name: "link",
    positionals: ID,
    options: [
      opt.value("--url"),
      opt.value("--title"),
      opt.value("--kind", { choices: commands.LINK_KINDS }),
      opt.value("--decision"),
      opt.value("--agent"),
      opt.value("--note"),
      opt.value("--drop", { metavar: "REASON" }),
    ],
  },
  { name: "keep", positionals: [{ dest: "id" }, { dest: "text", nargs: "?" }], options: [opt.value("--drop", { metavar: "REASON" })] },
  { name: "park", positionals: [{ dest: "reason" }], options: [opt.append("--agent")] },
  { name: "show", positionals: [], options: [] },
];

const PROG = "state.py";

const HELP = `usage: ${PROG} DIR COMMAND [ARGS] [--no-render] [-q]

Record fleet events in the dashboard state (DIR/state.json) and re-render, one command per event.
Commands: ${STATE_COMMANDS.map((c) => c.name).join(", ")}. \`${PROG} DIR show\` prints the ledger and every
command with the values its flags take. Add --no-render anywhere to write state.json without
rendering, -q to render without saying so.`;

type Handler = (ledger: Ledger, run: commands.Run) => Effect.Effect<Ledger, Refusal>;

const HANDLERS = new Map<string, Handler>(Object.entries({
  set: commands.set,
  milestone: commands.milestone,
  step: commands.step,
  agent: commands.agent,
  roadblock: commands.roadblock,
  decision: commands.decision,
  grill: commands.grill,
  event: commands.event,
  park: commands.park,
  keep: commands.keep,
  link: commands.link,
}));

/** DIR/brief.md from assets/brief.md with this fleet's paths, and a manager's DIR/standing.md, each
 * unless it is there: what was added to them stays. */
function ensureBrief(root: string, ledger: Ledger): void {
  const brief = join(root, "brief.md");

  if (!exists(brief)) {
    const template = readText(join(SKILL_DIR, "assets", "brief.md")) ?? "";
    writeText(brief, template.replaceAll("{skill_dir}", SKILL_DIR).replaceAll("{dashboard_dir}", root));
  }

  const standing = join(root, "standing.md");

  if (ledger.role === "manager" && !exists(standing)) writeText(standing, readText(join(SKILL_DIR, "assets", "standing.md")) ?? "");
}

/** The page: `updated` stamped again, state.json written a second time (open-15), and DIR/index.html
 * written around the page's view of the ledger, as Python's `render_dashboard.main` does. */
function render(machine: Machine, root: string, ledger: Ledger, quiet: boolean): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    ledger.updated = stampOf(machine.now());
    const text = ledgerText(ledger);
    writeText(join(root, "state.json"), text);
    const template = readTemplate();
    const html = template === undefined ? new Error(`cannot read ${TEMPLATE}`) : pageHtml(template, view(machine, cliLookups(), Option.getOrElse(parseObject(text), () => ({})), root), false);

    if (html instanceof Error) {
      out.err(`render_dashboard: ${html.message}\n`);

      return 1;
    }

    const page = join(root, "index.html");
    writePage(page, html);

    if (!quiet) out.out(`rendered ${page} (${ledger.agents.length} agents, updated ${ledger.updated})\n`);

    return 0;
  });
}

function loadLedger(path: string): Ledger | Refusal | undefined {
  const text = readText(path);

  if (text === undefined) return undefined;

  return Option.getOrElse(parseLedger(text), () => stateRefusal(`${path} is not a JSON object`));
}

function runCommand(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal | UsageError | "help", Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (argv[1] === "note") return yield* Effect.fail(stateRefusal("there is no `note` command: a note is `event --kind note TEXT`"));
    const noRender = argv.includes("--no-render");
    const quiet = argv.includes("-q");
    const rest = argv.filter((a) => a !== "--no-render" && a !== "-q");
    const parsed = parseCommand(PROG, STATE_COMMANDS, rest, usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined));

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);
    const { spec, dir, args } = parsed;
    const cmd = spec.name;
    const root = resolvePath(dir);
    makeDirs(root);
    const path = join(root, "state.json");
    const loaded = loadLedger(path);

    if (cmd !== "init" && loaded instanceof Refusal) return yield* Effect.fail(loaded);
    const ledger = loaded instanceof Refusal ? undefined : loaded;

    if (ledger === undefined && cmd !== "init") return yield* Effect.fail(stateRefusal(`no state.json in ${root}; run \`init\` first`));

    // What the command says waits until the ledger it gives back is checked: a refused write says nothing (open-2).
    const said: string[] = [];

    const run: commands.Run = {
      machine,
      root,
      cmd,
      args,
      say: (line) => said.push(`${line}\n`),
      warn: (line) => out.err(`${line}\n`),
    };

    const nextStep = cmd === "step" && args.str("id") === "next" && ledger !== undefined ? nextStepId(ledger, args.str("milestone") ?? "") : undefined;
    let result: Ledger | undefined;

    if (cmd === "init") {
      result = yield* commands.init(loaded !== undefined, run);
    } else if (ledger !== undefined && cmd !== "show") {
      const handler = HANDLERS.get(cmd);

      if (handler !== undefined) result = yield* handler(ledger, run);
    }

    const seen = result ?? ledger;
    const settingDone = cmd === "set" && args.str("status") === "done";
    const running = cmd === "agent" && (args.list("lane") !== undefined || args.str("status") === "running" || (args.str("task") ?? "") !== "");

    const warnings = [
      cmd === "init" ? undefined : deafWarning(machine, root),
      seen === undefined ? undefined : staleRows(seen),
      seen === undefined || cmd === "init" || (cmd === "set" && args.str("now") !== undefined) ? undefined : staleNow(machine, seen),
      ...(seen === undefined || cmd === "init" ? [] : unrecorded(seen, readChat(root))),
      seen === undefined ? undefined : leftOpen(seen, settingDone),
      seen === undefined || !running ? undefined : overlapping(seen, args.str("id") ?? ""),
      seen === undefined || cmd !== "agent" ? undefined : offPolicy(args.str("id") ?? "", args.str("model")),
      ...(seen === undefined ? [] : unpruned(seen, activeWorkspaces(readObject(path)), settingDone)),
    ];

    for (const warning of warnings) if (warning !== undefined) run.warn(warning);

    const flush = (): void => {
      for (const line of said) out.out(line);
    };

    if (cmd === "show") {
      if (ledger !== undefined) for (const line of showLines(ledger)) out.out(`${line}\n`);

      return 0;
    }

    if (result === undefined) return 0;
    commands.measure(machine, root, result);
    number(result);
    result.updated = stampOf(machine.now());
    const fault = validate(result);

    if (fault !== undefined) return yield* Effect.fail(fault);
    writeText(path, ledgerText(result));
    ensureBrief(root, result);
    flush();

    if (noRender) {
      const id = spec.positionals.some((p) => p.dest === "id") ? (nextStep ?? args.str("id") ?? "") : "";
      out.out(`state.json updated (${cmd} ${id})\n`);

      return 0;
    }

    return yield* render(machine, root, result, quiet);
  });
}

/** Run `fleet state` with `argv` (after `state`); the exit code. */
export function stateCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* runCommand(machine, argv).pipe(
      Effect.catch((failure) => (failure === "help" ? printUsage(HELP) : exitOf(failure))),
    );
  });
}
