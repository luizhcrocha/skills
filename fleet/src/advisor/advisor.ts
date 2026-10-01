/**
 * `fleet advisor DIR [--model fable|opus] [--task-id ID] [--log TEXT]`: the fleet's advisor (the plugin's
 * `advisor` agent) recorded as the worker row `advisor`, and the prompt to spawn it with. The row puts the
 * advisor on the chat roster, so it records each answer with `fleet chat DIR say --as advisor`, and on the
 * page with its model and tokens. It stays `queued` while it waits for questions: a running row idle for
 * twenty minutes would read as a silent worker. It takes the milestone of the current step, else the
 * first. Run again to record the agentId once spawned, or a restart on Opus when Fable is unavailable.
 */
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal } from "../errors.ts";
import { resolvePath, SKILL_DIR } from "../files.ts";
import { Out, recordingOut } from "../io.ts";
import { decodeLedger, type Ledger } from "../ledger/model.ts";
import { readObject } from "../registry.ts";
import { World } from "../world.ts";
import { exitOf } from "../cli/exit.ts";
import { stateCli } from "../cli/state.ts";

/** The advisor's id on the ledger and the chat. */
export const ADVISOR = "advisor";

const MODELS = ["fable", "opus"] as const;

const USAGE = "usage: fleet advisor DIR [--model fable|opus] [--task-id ID] [--log TEXT]";

const TASK = "Answers the fleet's judgement questions before they reach the user";

const FLEET_BIN = join(resolve(SKILL_DIR, "..", "..", ".."), "fleet", "bin", "fleet");

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "advisor", reason }));
}

interface Options {
  readonly dir: string;
  readonly model: string | undefined;
  readonly taskId: string | undefined;
  readonly log: string | undefined;
}

function parse(argv: readonly string[]): Options | Refusal {
  const usage = new Refusal({ speaker: "advisor", reason: USAGE });
  const [dir, ...rest] = argv;

  if (dir === undefined || dir.startsWith("--")) return usage;
  const flags = new Map<string, string>();

  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1];

    if (!["--model", "--task-id", "--log"].includes(flag) || value === undefined) return usage;
    flags.set(flag, value);
  }

  const model = flags.get("--model");

  if (model !== undefined && !MODELS.some((m) => m === model)) {
    return new Refusal({ speaker: "advisor", reason: `the advisor runs on fable, or on opus when Fable is unavailable; not '${model}'` });
  }

  return { dir, model, taskId: flags.get("--task-id"), log: flags.get("--log") };
}

function milestoneOf(ledger: Ledger): string | undefined {
  return (ledger.roadmap.find((m) => m.steps.some((s) => s.status === "current")) ?? ledger.roadmap[0])?.id;
}

function prompt(root: string, model: string): string[] {
  return [
    `You are the advisor of the fleet in ${root}; your id on its chat is ${ADVISOR}.`,
    `Fleet CLI: ${FLEET_BIN}. Ledger: \`${FLEET_BIN} state ${root} show\`, decisions in full in ${join(root, "state.json")}; standards and this fleet's facts: ${join(root, "brief.md")}; the chat and your past answers: \`${FLEET_BIN} chat ${root} log\`.`,
    `Record each answer: \`${FLEET_BIN} chat ${root} say --as ${ADVISOR} "<asker> asked: <question> | <verdict> | <reason> | <confidence>"\`.`,
    `You run on ${model}. Wait for questions: answer each one asked through SendMessage as your agent definition says.`,
  ];
}

function run(argv: readonly string[]): Effect.Effect<number, Refusal, Out | World> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const options = parse(argv);

    if (options instanceof Refusal) return yield* Effect.fail(options);
    const root = resolvePath(options.dir);
    const raw = readObject(join(root, "state.json"));

    if (raw === undefined) return yield* refuse(`no state.json in ${root}; run \`fleet state ${root} init\` first`);
    const ledger = decodeLedger(raw);

    if (ledger instanceof Refusal) return yield* Effect.fail(ledger);
    const known = ledger.agents.find((a) => a.id === ADVISOR);
    const model = options.model ?? (known === undefined ? "fable" : (known.model ?? "fable"));
    const args = ["agent", ADVISOR, "--model", model, "--status", "queued", "--skill", "none"];

    if (known === undefined) {
      const milestone = milestoneOf(ledger);

      if (milestone === undefined) return yield* refuse(`the roadmap of ${root} is empty: record it first, then start the advisor`);
      args.push("--task", TASK, "--milestone", milestone, "--log", options.log ?? `Advisor started on ${model}.`);
    } else if (options.log !== undefined) args.push("--log", options.log);

    if (options.taskId !== undefined) args.push("--task-id", options.taskId);
    const inner = recordingOut();
    const code = yield* stateCli([root, ...args, "-q"]).pipe(Effect.provide(inner.layer));

    for (const line of inner.recorded.stderr) out.err(line);

    if (code !== 0) return code;

    if (options.taskId === undefined) {
      for (const line of prompt(root, model)) out.out(`${line}\n`);
      out.err(
        `advisor: spawn it with the Agent tool (subagent_type "tstack:advisor", model: "${model}", run_in_background, the lines above as its prompt), ` +
          `then \`fleet advisor ${root} --task-id <its agentId>\`. A spawn that fails on the model (unavailable, limits, credits) ` +
          `is spawned again on opus: \`fleet advisor ${root} --model opus --log "Fable unavailable: <the error>"\`.\n`,
      );
    } else {
      out.out(`${ADVISOR} recorded on ${model} as ${options.taskId}\n`);
      out.err(
        `advisor: add under "This fleet" in ${join(root, "brief.md")}: ` +
          `"The advisor: before you ask the user, SendMessage ${options.taskId} your question, your id and what you checked."\n`,
      );
    }

    return 0;
  });
}

/** Run `fleet advisor` with `argv` (after `advisor`); the exit code. */
export function advisorCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return run(argv).pipe(Effect.catch(exitOf));
}
