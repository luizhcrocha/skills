/**
 * `fleet work due [DIR]`: the work page's answers a moved team has not acted on yet, as the coordinator's per-turn
 * read in the coordinator skill's PROGRAMS.md ("The work page's answers") returns them: one program through
 * fleet-run, which only reads. It prints the program's result, `[]` when nothing is due. The team is DIR's (a folder
 * holding cloud.json), else the fleet the session running the command serves, else $FLEET_DIR's. `fleet state DIR show`
 * counts the same rows in its warning `work: N answers due; fleet work due`, through a count both keep in
 * DIR/work-due.cache for a minute.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { parseInstant, stampOf } from "../clock.ts";
import { isMoved, resolvePath, writeText } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asNumber, asString, parseObject, type Json } from "../json.ts";
import { movedTeam, readObject } from "../registry.ts";
import { secondsNow, World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";
import { failedRun, fleetOf, fleetRunBin } from "./turn.ts";

const USAGE = "usage: fleet work due [DIR]";

/** What `fleet work --help` prints. */
export const HELP = `${USAGE}\n\nThe work page's answers no event of the team names yet, as the program in the coordinator skill's PROGRAMS.md\n("The work page's answers") returns them; [] when none is due.`;

/** How long the read may take, by default ($FLEET_WORK_WAIT_S). */
const WAIT_S = 10;

/** The read of PROGRAMS.md's "The work page's answers", for team `team`: each answer no event names yet. */
export function dueProgram(team: string): string {
  return `const team = ${JSON.stringify(team)};
const away = (await work.read({ team: null })).filter((r) =>
  r.answer?.answer === "hand" && r.answer.to !== team && r.item?.owner?.team === team);
const answered = [...(await work.read()), ...away].filter((r) => r.answer !== null);
if (answered.length === 0) return [];
const acted = new Set((await records.read({ kind: "event" })).map((e) => String(e.record.text ?? "").split(": ")[0]));
const tag = (r, act) => \`work \${act} \${r.key}@\${r.answer.commit} \${r.answer.at}\`;
const act = (r) => (away.includes(r) ? "gave" : r.answer.answer);
const closed = async (d) => d !== undefined &&
  (await records.read({ kind: "decision", key: d })).some((c) => c.record.status !== "open");
const due = [];
for (const r of answered) {
  if (acted.has(tag(r, act(r)))) continue;
  if (acted.has(tag(r, "wait")) && !(r.answer.answer === "park" && (await closed(r.answer.decision)))) continue;
  due.push(r);
}
return due.map((r) => ({
  tag: tag(r, act(r)), wait: tag(r, "wait"), by: r.answer.by._tag, note: r.answer.note, to: r.answer.to,
  decision: r.answer.decision, repo: r.item?.repo, title: r.item?.title, workspace: r.item?.workspace,
  worker: r.item?.owner?.worker, changedSince: r.flags.changedSince }));
`;
}

/** What the read came to: the rows due, or why there are none to show. */
export type Due = { readonly rows: readonly Json[]; readonly unread?: never } | { readonly rows?: never; readonly unread: string };

function waitOf(machine: Machine): number {
  const given = Number(machine.env("FLEET_WORK_WAIT_S")?.trim() ?? "");

  return Number.isFinite(given) && given > 0 ? given : WAIT_S;
}

/** The answers due to the moved team at `root` (`team`, its id), read from the cloud. */
export function readDue(machine: Machine, root: string, team: string, waitS: number = waitOf(machine)): Due {
  // SIGKILL: spawnSync waits for the child, so one that ignores TERM would hold the command past its wait.
  const done = spawnSync(fleetRunBin(machine), [], { input: dueProgram(team), encoding: "utf8", env: { ...process.env, FLEET_DIR: root }, cwd: root, timeout: Math.ceil(waitS * 1000), killSignal: "SIGKILL" });

  if (done.error !== undefined) return { unread: "code" in done.error && done.error.code === "ETIMEDOUT" ? `fleet-run gave no answer in ${String(waitS)} s` : `fleet-run did not run: ${done.error.message}` };

  if (done.status !== 0) return { unread: failedRun(done.status, done.stdout, done.stderr) };
  const outcome = Option.getOrUndefined(parseObject(done.stdout));
  const rows = outcome?.["status"] === "completed" ? asArray(outcome["result"]) : undefined;

  return rows === undefined ? { unread: "fleet-run's answer holds no list of rows" } : { rows };
}

/** The file under a fleet's DIR that keeps the last count of answers due, `{at, due}` (`due` null: the read failed). */
export const WORK_CACHE_FILE = "work-due.cache";

/** How long a kept count stands in for a new read. */
export const WORK_CACHE_S = 60;

/** How long `show`'s read may take before it says nothing. */
export const SHOW_WAIT_S = 2;

function keep(machine: Machine, root: string, due: number | null): void {
  writeText(join(root, WORK_CACHE_FILE), `${JSON.stringify({ at: stampOf(machine.now()), due })}\n`);
}

/** The count kept within {@link WORK_CACHE_S}: a number, null when that read failed, undefined when none stands. */
function kept(machine: Machine, root: string): number | null | undefined {
  const last = readObject(join(root, WORK_CACHE_FILE));
  const at = parseInstant(asString(last?.["at"]) ?? "");

  if (last === undefined || at === undefined || secondsNow(machine) - at / 1000 >= WORK_CACHE_S) return undefined;
  const due = last["due"];

  return due === null ? null : asNumber(due);
}

/** The line for `count` answers due, none for 0. */
export function dueLine(count: number): string | undefined {
  if (count <= 0) return undefined;

  return `work: ${String(count)} ${count === 1 ? "answer" : "answers"} due; fleet work due`;
}

/** `fleet state DIR show`'s acting line for the answers due to a moved team, `work: N answers due; fleet work due`.
 * The count read within {@link WORK_CACHE_S} is reused; else the read waits {@link SHOW_WAIT_S} at most, and a
 * read that fails or times out says nothing, so `show` is never held by the host. */
export function dueWarning(machine: Machine, root: string): string | undefined {
  const team = isMoved(root) ? movedTeam(root) : undefined;

  if (team === undefined) return undefined;
  const cached = kept(machine, root);

  if (cached !== undefined) return cached === null ? undefined : dueLine(cached);
  const read = readDue(machine, root, team.id, SHOW_WAIT_S);
  const due = read.unread === undefined ? read.rows.length : null;

  keep(machine, root, due);

  return due === null ? undefined : dueLine(due);
}

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "work", reason }));
}

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [verb, dir, ...more] = argv;

    if (verb === "-h" || verb === "--help") {
      out.out(`${HELP}\n`);

      return 0;
    }

    if (verb !== "due" || more.length > 0) {
      out.err(`${USAGE}\nfleet work: error: ${verb === undefined ? "the command is due" : `unknown argument ${more[0] ?? verb}`}\n`);

      return 2;
    }

    const root = dir === undefined ? fleetOf(machine, undefined)?.dir : resolvePath(dir);

    if (root === undefined) return yield* refuse(`this session serves no fleet and $FLEET_DIR names none: give its folder, \`fleet work due DIR\``);
    const team = isMoved(root) ? movedTeam(root) : undefined;

    if (team === undefined) return yield* refuse(`${root} holds no cloud.json: only a team moved to the cloud has a work page`);
    const read = readDue(machine, root, team.id);

    keep(machine, root, read.unread === undefined ? read.rows.length : null);

    if (read.unread !== undefined) return yield* refuse(`the work page's answers did not read: ${read.unread}`);
    out.out(read.rows.length === 0 ? "[]\n" : `[\n${read.rows.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]\n`);

    return 0;
  });
}

/** Run `fleet work` with `argv` (after `work`); the exit code. */
export function workCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv).pipe(Effect.catch(exitOf));
  });
}
