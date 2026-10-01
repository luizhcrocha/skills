/**
 * `fleet brief DIR WORKER`: the part of a worker's brief the ledger already holds, composed, so the
 * coordinator writes only what it alone knows. From the worker's row: the line the brief opens with,
 * the task, its completion criterion, the skill and how a worker loads it (the Skill tool, or the Read
 * tool for a user-invoked skill, read from the skill's own frontmatter), the lane, the workspace
 * `fleet ws add` recorded for it, the step it works and its id on the chat. Refused for a worker the
 * ledger does not have: a worker is recorded, then spawned.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { exists, readText, resolvePath, SKILL_DIR } from "../files.ts";
import { Out } from "../io.ts";
import { asString, parseObject, type JsonObject } from "../json.ts";
import { decodeLedger, type Agent, type Ledger } from "../ledger/model.ts";
import { activeWorkspaces } from "../ledger/warnings.ts";
import { readObject } from "../registry.ts";
import { World } from "../world.ts";
import { exitOf } from "./exit.ts";

const USAGE = "usage: fleet brief DIR WORKER";

/** The plugin's root: the coordinator skill is `skills/productivity/coordinator` under it. */
const PLUGIN_DIR = resolve(SKILL_DIR, "..", "..", "..");

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "brief", reason }));
}

/** Where the plugin keeps skill `name`, and the name the Skill tool knows it by. */
interface SkillFile {
  readonly path: string;
  readonly qualified: string;
  /** `disable-model-invocation: true`: the Skill tool refuses it for a worker, which reads the file instead. */
  readonly userInvoked: boolean;
}

function skillFile(name: string): SkillFile | undefined {
  const skills = join(PLUGIN_DIR, "skills");
  let groups: string[] = [];

  try {
    groups = readdirSync(skills);
  } catch {
    return undefined;
  }

  const path = groups.map((g) => join(skills, g, name, "SKILL.md")).find((p) => exists(p));

  if (path === undefined) return undefined;
  const text = readText(path) ?? "";
  const head = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
  const manifest = Option.getOrUndefined(parseObject(readText(join(PLUGIN_DIR, ".claude-plugin", "plugin.json")) ?? ""));
  const plugin = asString(manifest?.["name"]);

  return { path, qualified: plugin === undefined ? name : `${plugin}:${name}`, userInvoked: /^disable-model-invocation:\s*true\s*$/m.test(head) };
}

function skillLine(a: Agent): string | undefined {
  const name = a.skill ?? "none";

  if (name === "none" || name === "") return undefined;
  const file = skillFile(name);

  if (file === undefined) return `Skill: call the Skill tool with "${name}" and follow it.`;

  if (file.userInvoked) return `Skill: read ${file.path} with the Read tool and follow it (the Skill tool refuses "${name}" to a worker).`;

  return `Skill: call the Skill tool with "${file.qualified}" and follow it.`;
}

function stepLine(ledger: Ledger, a: Agent): string | undefined {
  for (const m of ledger.roadmap) {
    const s = m.steps.find((x) => x.agent === a.id && x.status === "current");

    if (s !== undefined) return `Step: ${s.id} (${s.title}), in milestone ${m.id} (${m.title}).`;
  }

  return undefined;
}

/** A worker's brief as the ledger gives it, and what the coordinator is told beside it. */
interface Composed {
  readonly brief: string[];
  readonly notes: string[];
}

function compose(root: string, ledger: Ledger, raw: JsonObject, a: Agent): Composed {
  const brief: string[] = [`Read ${join(root, "brief.md")} first; your id is ${a.id}.`, "", `Task: ${a.task}`];
  const notes: string[] = [];
  const done = a.brief ?? "";

  if (done === "") notes.push(`brief: ${a.id} has no completion criterion: \`fleet state ${root} agent ${a.id} --brief "done when ..."\` records one`);
  else brief.push(`Done when: ${done.replace(/^done when:?\s*/i, "")}`);
  const skill = skillLine(a);

  if (skill !== undefined) brief.push(skill);

  brief.push(
    a.lane.length === 0
      ? "Lane: none. You read; you edit no file of the repository."
      : `Lane: ${a.lane.join(", ")}. You edit these; everything else is read-only.`,
  );
  const ws = activeWorkspaces(raw).find((w) => w.agent === a.id);

  if (ws !== undefined) {
    brief.push(`Workspace: ${ws.path}. Work there only: absolute paths, or \`cd ${ws.path};\` at the head of each command.`);
  } else if (a.lane.length > 0) {
    notes.push(`brief: ${a.id} has a lane and no workspace: \`fleet ws ${root} add ${a.id}\` makes one for a worker that edits code`);
  }

  const step = stepLine(ledger, a);

  if (step !== undefined) brief.push(step);
  brief.push(`Chat: you are ${a.id} on the fleet's chat; brief.md says when to read your inbox and how to answer.`);
  notes.push(
    `brief: add the context only you have (decisions from the session, CONTEXT.md terms, ADRs, the user's constraints), ` +
      `spawn ${a.id} on model: "${a.model ?? "opus"}" (run_in_background), then \`fleet state ${root} agent ${a.id} --task-id <its agentId>\`.`,
  );

  return { brief, notes };
}

function run(argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [dir, worker, ...rest] = argv;

    if (dir === undefined || worker === undefined || rest.length > 0) return yield* refuse(USAGE);
    const root = resolvePath(dir);
    const raw = readObject(join(root, "state.json"));

    if (raw === undefined) return yield* refuse(`no state.json in ${root}; run \`fleet state ${root} init\` first`);
    const ledger = decodeLedger(raw);

    if (ledger instanceof Refusal) return yield* Effect.fail(ledger);
    const a = ledger.agents.find((x) => x.id === worker) ?? ledger.agents.find((x) => x.name === worker);

    if (a === undefined) {
      return yield* refuse(`no worker '${worker}' in ${root}: record it first (\`fleet state ${root} agent ${worker} --task T --milestone M ...\`), then brief and spawn it`);
    }

    const { brief, notes } = compose(root, ledger, raw, a);

    for (const line of brief) out.out(`${line}\n`);

    for (const line of notes) out.err(`${line}\n`);

    return 0;
  });
}

/** Run `fleet brief` with `argv` (after `brief`); the exit code. */
export function briefCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return run(argv).pipe(Effect.catch(exitOf));
}
