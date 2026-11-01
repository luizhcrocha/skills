/**
 * A permission asked before the call on a moved team (fleet/SPEC.md, Permission grants). The cloud reads no file, so
 * its fold refuses a program's script card with no `runs`, and the old CLI's writers refuse a moved folder because the
 * host's export owns it. This command writes no ledger: it runs the same `decision` handler over the export, in memory,
 * so an ask is held to what it is held to anywhere and `runs` is hashed on this machine, then sends the card through
 * fleet-run. The fold, then the host at the yes, check what it sent.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal, stateRefusal } from "../errors.ts";
import { FLEET_BIN } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, parseObject } from "../json.ts";
import * as commands from "../ledger/commands.ts";
import type { Decision, Ledger } from "../ledger/model.ts";
import { callsOf } from "../ledger/permission.ts";
import type { Machine } from "../world.ts";
import type { Args } from "./args.ts";
import { failedRun, fleetRunBin } from "./turn.ts";

/** What an ask takes here. `--body` writes a file into the folder, so it stays with `decision.body`; `--decide` and the rest stay refused. */
const ASK_ARGS: ReadonlySet<string> = new Set(["dir", "id", "kind", "tool", "call", "then", "root", "title", "why", "recommend", "reason", "blocking", "not_blocking", "once", "agent", "agent_id", "step", "milestone"]);

/** The card's `under`, on no card but one this route opens: the hook denies a call only by such a card (tstack-hook.py's ASK_ROUTE). Neither `runs` nor an empty `cause` tells one from a card the hook opened from a refusal, and the cloud and the export keep no field they do not know, so it takes a field they do, shown only on a notice. */
export const ASK_ROUTE = "ask";

/** What reads as a credential: the plugin hook's SECRET_IN_CALL, source for source (test_moved_ask.py compares them). A moved team's card goes to the cloud, and such a text never does. */
export const SECRET_IN_CALL =
  /\bBearer\s|\bAuthorization:|\bAKIA[0-9A-Z]{12}|-----BEGIN|_authToken\b|[\w-]*(?:api[_-]?key|token|secret|access[_-]?key|password|passwd|pwd|authtoken)[\w-]*\s*[:=]|\b(?:sk-|ghp_|gho_|ghs_|github_pat_|glpat-|npm_|xox[abposr]-)[A-Za-z0-9]|:\/\/[^/\s:@]+:[^/\s@]+@|--pass(?:word)?\b|\s-u\s*\S+:\S|\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*\s-p\S|\b(?:sshpass|docker\s+login)\b[^;&|\n]*\s-p\b/iu;

/** A 1Password reference, the hook's OP_REFERENCE: a call reads it, and words may name it. */
export const OP_REFERENCE = /op:\/\//u;

/** fleet-run's exits: the program is queued for the link; it was sent, and no answer came back (resend under its id). */
const QUEUED = 3;

const UNKNOWN = 5;

/** The client waits 120 s for the host service. */
const SEND_MS = 130_000;

/** Whether this command is the one write a moved team's old CLI takes: opening a permission, with nothing else in it. */
export function asksOnMoved(command: string, args: Args): boolean {
  return command === "decision" && args.str("kind") === "permission" && args.str("call") !== undefined && args.given().every((dest) => ASK_ARGS.has(dest));
}

/** The card as a program opens it. The fold refuses a program's `recommend`, so the recommendation goes in the why. */
function cardOf(d: Decision) {
  return {
    kind: "permission",
    title: d.title,
    question: d.question,
    why: `${d.why ?? ""} Recommendation: ${d.recommend ?? ""} (${d.reason ?? ""}).`,
    blocking: d.blocking,
    agent: d.agent,
    options: d.options,
    refusal: d.refusal,
    under: ASK_ROUTE,
    step: d.step ?? undefined,
    milestone: d.milestone ?? undefined,
  };
}

/** `program` through fleet-run; one sent with no answer goes again under its id, which runs it at most once. */
function send(machine: Machine, root: string, program: string): SpawnSyncReturns<string> {
  const run = (args: readonly string[]) =>
    spawnSync(fleetRunBin(machine), args, { input: program, encoding: "utf8", env: { ...process.env, FLEET_DIR: root }, cwd: root, timeout: SEND_MS, killSignal: "SIGKILL" });

  const first = run([]);
  const id = first.status === UNKNOWN ? asString(Option.getOrUndefined(parseObject(first.stdout))?.["id"]) : undefined;

  return id === undefined ? first : run(["--id", id]);
}

/** The key the card opened under, or why the fleet did not apply it. */
function openedKey(stdout: string): { readonly key: string } | { readonly why: string } {
  const [op] = asArray(Option.getOrUndefined(parseObject(stdout))?.["ops"]) ?? [];
  const result = asObject(op);
  const tag = asString(result?.["_tag"]);

  if (tag !== "applied" && tag !== "duplicate") return { why: asString(result?.["issue"]) ?? JSON.stringify(op ?? stdout).slice(0, 500) };

  return { key: asString(result?.["key"]) ?? "" };
}

/** The first field of the card that reads as a credential, by name. */
function leaked(d: Decision, refusal: NonNullable<Decision["refusal"]>): string | undefined {
  if (callsOf(refusal).some((call) => SECRET_IN_CALL.test(call) || OP_REFERENCE.test(call))) return "call";
  const words = { title: d.title, why: d.why, recommend: d.recommend, reason: d.reason };

  return Object.entries(words).find(([, text]) => SECRET_IN_CALL.test(text ?? ""))?.[0];
}

/** Open the ask on the cloud. Nothing here writes the folder: `ledger` is thrown away. */
export function movedAsk(machine: Machine, root: string, args: Args, ledger: Ledger): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const id = args.str("id") ?? "";

    if ((ledger.decisions ?? []).some((d) => d.id === id)) return yield* Effect.fail(stateRefusal(`${id} is a card of this fleet already: on a moved team, ask under a new id`));
    const quiet = (): void => undefined;
    const asked = yield* commands.decision(ledger, { machine, root, cmd: "decision", args, say: quiet, warn: (line) => out.err(`${line}\n`), after: quiet, tell: quiet });
    const d = (asked.decisions ?? []).find((row) => row.id === id);

    if (d?.refusal === undefined || d.refusal === null) return yield* Effect.fail(stateRefusal(`${id} opened no permission`));

    const field = leaked(d, d.refusal);

    if (field !== undefined) return yield* Effect.fail(stateRefusal(`the ${field} may carry a credential, and a moved team's card sends its text to the cloud: put the secret where the script reads it, and word the card without it`));
    const done = send(machine, root, `decision.open(${JSON.stringify(id)}, ${JSON.stringify(cardOf(d))});\nreturn records.apply(ops);\n`);

    if (done.error !== undefined) return yield* Effect.fail(stateRefusal(`fleet-run gave no answer (${done.error.message}): read state.json before you ask again`));

    if (done.status === QUEUED) {
      out.out(`queued ${id}: the link to the cloud is down, so the card is not open yet. It opens when the link is back, and a refusal then reaches no one: once the link is back and no row ${id} is in state.json, the cloud refused it, so ask again. Run nothing of it until it is allowed.\n`);

      return QUEUED;
    }

    if (done.status !== 0) return yield* Effect.fail(stateRefusal(failedRun(done.status, done.stdout, done.stderr)));
    const opened = openedKey(done.stdout);

    if ("why" in opened) return yield* Effect.fail(stateRefusal(`the cloud did not open the card: ${opened.why}`));
    const calls = callsOf(d.refusal).join("\n  ");

    out.out(`asked ${opened.key} on its card, with the files it binds. Arm its answer's wake now, as a background command (run_in_background): \`${FLEET_BIN} chat ${root} wait ${opened.key}\`. Run nothing of it until that says the grant stands; the hook denies it before. Then run each, unchanged, once, as a Bash call of its own:\n  ${calls}\n`);

    return 0;
  });
}
