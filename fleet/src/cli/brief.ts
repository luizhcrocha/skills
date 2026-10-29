/**
 * `fleet brief DIR WORKER`: the part of a worker's brief the ledger already holds, composed, so the
 * coordinator writes only what it alone knows. From the worker's row: the line the brief opens with,
 * the task, its completion criterion, the skill and how a worker loads it (the Skill tool, or the Read
 * tool for a user-invoked skill, read from the skill's own frontmatter), the lane, the workspace
 * `fleet ws add` recorded for it (or, in a fleet that shares one working copy, that copy) with the rules of
 * history that go with it, the step it works and its id on the chat. Before the brief, on stderr, the
 * line the coordinator spawns it by: the Agent call's `model` and `effort`. After it, also on stderr and so
 * never in the brief, the memo notes `memo recall` finds for the worker's task and completion criterion in
 * the fleet's repo, as candidates the coordinator may paste. Refused for a worker the ledger does not have:
 * a worker is recorded, then spawned.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { exists, readText, resolvePath, SKILL_DIR } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, parseObject, type JsonObject } from "../json.ts";
import { decodeLedger, type Agent, type Ledger } from "../ledger/model.ts";
import { roleDefaults, spawnLine } from "../ledger/roles.ts";
import { activeWorkspaces } from "../ledger/warnings.ts";
import { readObject } from "../registry.ts";
import { readRecord, serverProc } from "../preview/record.ts";
import { kept } from "../preview/sleep.ts";
import { runs } from "../preview/tracked.ts";
import { workspaceRoot } from "../ws/jj.ts";
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

/** The Workspace line of a worker with a jj workspace of its own (the default, isolated mode): where it
 * works, and that history beyond describing its own changes is the coordinator's. */
function isolatedLine(path: string, from: string | undefined): string {
  return (
    `Workspace: ${path}, yours alone. Work there only: absolute paths, or \`cd ${path};\` at the head of each command.` +
    (from === undefined ? "" : ` It was ${from}'s before you: what ${from} left is under your @, and you build on it.`) +
    " End with your changes described there (`jj describe`, `jj split` by intent, `jj new` on top); rebasing them onto the stack, " +
    "bookmarks and pushes are the coordinator's, and so is every other workspace."
  );
}

/** The Workspace line of a worker in a fleet that shares one working copy (`set --workspaces shared`): the
 * old shared-working-copy rules, since every jj command there moves the other workers' files too. */
function sharedLine(path: string | undefined): string {
  return (
    `Workspace: ${path ?? "the coordinator's working copy (the repo's default workspace)"}, the fleet's one working copy, shared with the other workers as they work. ` +
    `Work there only${path === undefined ? "" : ` (absolute paths, or \`cd ${path};\` at the head of each command)`}, on your lane's files only. ` +
    "Move no history and describe nothing: no `jj new`, `jj edit`, `jj rebase`, `jj describe` (nor `split`, `squash`, `commit`, `abandon`, `restore`); " +
    "reading (`jj status`, `jj diff`, `jj log`) is fine. The coordinator splits the working copy by each worker's lane paths into one described " +
    "change per worker: end your report with one line it can use as your change's description."
  );
}

/** Who held workspace `id` before its current worker, when it was handed over (`fleet ws add --reuse`). */
function handedFrom(raw: JsonObject, id: string): string | undefined {
  const row = (asArray(raw["workspaces"]) ?? []).map(asObject).find((w) => asString(w?.["id"]) === id && w?.["status"] !== "pruned");

  return asString(asObject(asArray(row?.["handovers"])?.at(-1))?.["from"]);
}

/** The fleet's repo, which is also its shared working copy: the repo a recorded workspace names, else the
 * default workspace of the repo the command runs in. */
function fleetRepo(raw: JsonObject): string | undefined {
  const named = (asArray(raw["workspaces"]) ?? []).map((w) => asString(asObject(w)?.["repo"])).find((r) => r !== undefined);

  return named ?? workspaceRoot(process.cwd(), "default");
}

/** A worker's brief as the ledger gives it, and what the coordinator is told beside it. */
interface Composed {
  readonly brief: string[];
  readonly notes: string[];
}

/** Where a worker that edits code checks its UI: on the fleet's preview when one runs, else on a dev
 * server of its own on the port its workspace was given, never the framework's default. */
function devLine(root: string, a: Agent, port: number | undefined): string | undefined {
  if (a.lane.length === 0) return undefined;
  const preview = readRecord(root);

  const server = preview?.server ?? null;

  if (preview !== undefined && server !== null && (runs(serverProc(server)) || kept(server))) {
    return (
      `Dev server: the fleet runs a preview, so start none of your own. Check your change alone on your per-worker preview ` +
      `(\`fleet preview ${root} start --per-worker ${a.id}\`, which prints its address), and the merged work at /f/${preview.fleet}/preview/ on the preview server.`
    );
  }

  if (port === undefined) return undefined;

  return (
    `Dev server: when you run one to check your work, run it on port ${String(port)} and no other ` +
    `(Vite: \`--port ${String(port)} --strictPort\`; else PORT=${String(port)}), and stop it before you report.`
  );
}

/** How long `memo recall` may take before the brief goes on without it; its p95 is about 0.14 s. */
const RECALL_MS = 2000;

/** The most notes recalled for one brief. */
const RECALL_LIMIT = 3;

/** The coordinator's lines of the notes `memo` (the program at `memo`) recalls in `repo` for `words`: a
 * heading and memo's lines (its hits, or its line saying it has none), or one line saying why there are
 * none. Never fails and never takes much over {@link RECALL_MS}: recall serves the brief, never blocks it. */
function recalledNotes(memo: string, repo: string | undefined, words: string): string[] {
  const skip = (why: string): string[] => [`brief: no memo notes recalled: ${why}`];

  if (repo === undefined) return skip("the fleet's repo is unknown (no workspace recorded, and not run in a jj repo)");
  const args = ["recall", "--cwd", repo, "--live", "--limit", String(RECALL_LIMIT), "--", words];
  const done = spawnSync(memo, args, { encoding: "utf8", timeout: RECALL_MS, stdio: ["ignore", "pipe", "ignore"] });

  if (done.error !== undefined) {
    const code = "code" in done.error ? String(done.error.code) : done.error.name;

    return skip(code === "ETIMEDOUT" ? `memo recall took over ${String(RECALL_MS / 1000)} s` : `${memo} did not run (${code})`);
  }

  if (done.status !== 0) return skip(`memo recall exited ${String(done.status ?? done.signal)}`);
  const lines = done.stdout.split("\n").filter((l) => l.trim() !== "");

  if (lines.length === 0) return skip("memo recall printed nothing");

  return [
    "brief: memo recall on the task, candidates for you to paste into the brief if they fit; they are not facts (recall rarely abstains), and the worker sees none of them:",
    ...lines.slice(0, RECALL_LIMIT).map((l) => `  ${l}`),
  ];
}

/** A worker's completion criterion without its "done when", or "" when it has none. */
function criterion(a: Agent): string {
  return (a.brief ?? "").replace(/^done when:?\s*/i, "");
}

/** The words a worker's notes are recalled by: its task and its completion criterion. */
function taskWords(a: Agent): string {
  return [a.task, criterion(a)].filter((w) => w !== "").join(" ");
}

function compose(root: string, ledger: Ledger, raw: JsonObject, a: Agent, memo: string): Composed {
  const brief: string[] = [`Read ${join(root, "brief.md")} first; your id is ${a.id}.`, "", `Task: ${a.task}`];
  const notes: string[] = [];
  const done = criterion(a);

  if (done === "") notes.push(`brief: ${a.id} has no completion criterion: \`fleet state ${root} agent ${a.id} --brief "done when ..."\` records one`);
  else brief.push(`Done when: ${done}`);
  const skill = skillLine(a);

  if (skill !== undefined) brief.push(skill);

  brief.push(
    a.lane.length === 0
      ? "Lane: none. You read; you edit no file of the repository."
      : `Lane: ${a.lane.join(", ")}. You edit these; everything else is read-only.`,
  );
  const ws = activeWorkspaces(raw).find((w) => w.agent === a.id);

  if (ledger.workspace_mode === "shared") {
    if (a.lane.length > 0) brief.push(sharedLine(fleetRepo(raw)));
  } else if (ws !== undefined) {
    brief.push(isolatedLine(ws.path, handedFrom(raw, ws.id)));
  } else if (a.lane.length > 0) {
    notes.push(`brief: ${a.id} has a lane and no workspace: \`fleet ws ${root} add ${a.id}\` makes one for a worker that edits code, or \`--reuse\` hands it the idle one of its lane`);
  }

  const dev = devLine(root, a, ws?.port);

  if (dev !== undefined) brief.push(dev);
  const step = stepLine(ledger, a);

  if (step !== undefined) brief.push(step);
  brief.push(`Chat: you are ${a.id} on the fleet's chat; brief.md says when to read your inbox and how to answer.`);
  const role = roleDefaults(a.skill ?? "none", a.model ?? "opus", a.effort);

  notes.push(
    `brief: add the context only you have (decisions from the session, CONTEXT.md terms, ADRs, the user's constraints), ` +
      `spawn ${a.id} on model: "${role.model}", effort: "${role.effort}" (run_in_background), then \`fleet state ${root} agent ${a.id} --task-id <its agentId>\`.`,
  );
  notes.push(...recalledNotes(memo, fleetRepo(raw), taskWords(a)));

  return { brief, notes };
}

function run(argv: readonly string[]): Effect.Effect<number, Refusal, Out | World> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const world = yield* World;
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

    const memo = world.env("FLEET_MEMO") || join(PLUGIN_DIR, "scripts", "memo");
    const { brief, notes } = compose(root, ledger, raw, a, memo);

    out.err(`${spawnLine(a.id, a.skill, a.model, a.effort)}\n`);

    for (const line of brief) out.out(`${line}\n`);

    for (const line of notes) out.err(`${line}\n`);

    return 0;
  });
}

/** Run `fleet brief` with `argv` (after `brief`); the exit code. */
export function briefCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return run(argv).pipe(Effect.catch(exitOf));
}
