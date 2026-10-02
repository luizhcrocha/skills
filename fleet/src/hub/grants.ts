/**
 * Permission grants (SPEC.md "Permission grants"): when the user answers a permission with allow-once, the
 * hub, not an agent (Claude Code's classifier refuses an agent that writes its own allow rule), adds the
 * row's exact rule to the session's `.claude/settings.local.json` and records the grant in
 * `DIR/grants.jsonl`, before the answer is stored. The plugin's hook removes the rule once the call has
 * run. The ledger is writable by every agent and the hub is not, so the row is trusted only as far as it
 * names a session of this fleet and a rule that lets that one call through.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { isDir, readText, resolvePath, strerror } from "../files.ts";
import * as Option from "effect/Option";

import { Refusal } from "../errors.ts";
import { asArray, asObject, type Json, type JsonObject } from "../json.ts";
import { readBeats } from "../heartbeat.ts";
import { parseLedger, type Decision } from "../ledger/model.ts";
import { findDecision } from "../ledger/numbers.ts";
import { ALLOW_ONCE, PERMISSION_TOOL, ruleOf, settingsOf, whyNoRule } from "../ledger/permission.ts";

/** An answer to a decision of the fleet in `dir`, about to be stored. */
export interface Answered {
  readonly dir: string;
  /** The decision's id or number, as the page sent it. */
  readonly decision: string;
  readonly text: string;
  /** Who gave it: `tailnet:<login>` or `local` (policy.ts `grantor`). */
  readonly by: string;
  /** The stamp the grant records. */
  readonly at: string;
}

/** Why a permission's allow-once cannot be granted. */
class Ungranted {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

/** The trusted grant a permission row asks for. */
interface Asked {
  readonly id: string;
  readonly ref: string;
  readonly rule: string;
  readonly root: string;
}

function askedOf(dir: string, d: Decision): Asked | Ungranted {
  const r = d.refusal ?? undefined;

  if (r === undefined) return new Ungranted("the permission has no refused call to grant");

  if (d.status !== "open") return new Ungranted("the permission is no longer open");

  if (r.tool !== PERMISSION_TOOL) return new Ungranted(`a grant is for ${PERMISSION_TOOL} alone, and this permission is for ${r.tool}`);
  const why = whyNoRule(r.call);

  if (why !== undefined) return new Ungranted(`no grant: ${why}`);

  if (r.rule !== ruleOf(r.call)) return new Ungranted(`the permission's rule ${r.rule} is not the exact rule for its call, ${ruleOf(r.call)}`);

  if (!isAbsolute(r.root)) return new Ungranted(`the permission's root ${r.root} is not an absolute path`);
  const at = resolvePath(r.root);
  const sessions = new Set(readBeats(dir).flatMap((b) => [b.project, b.cwd].flatMap((p) => (p === null ? [] : [resolvePath(p)]))));

  if (!isDir(at) || !sessions.has(at)) return new Ungranted(`the permission's root ${r.root} is no session of this fleet (no heartbeat has it as its project or cwd)`);

  return { id: d.id, ref: d.ref ?? "", rule: r.rule, root: r.root };
}

function parsed(file: string): JsonObject | Ungranted {
  const text = readText(file);

  if (text === undefined) return {};
  let value: Json;

  try {
    // SAFETY: JSON.parse returns JSON values only.
    value = JSON.parse(text) as Json;
  } catch (cause: unknown) {
    return new Ungranted(`${file} does not parse: ${strerror(cause)}`);
  }

  return asObject(value) ?? new Ungranted(`${file} is not a JSON object`);
}

/** `settings` with `rule` added to `permissions.allow`, every other key and entry kept; undefined when the rule
 * is there already; or why it cannot hold it. */
function withRule(file: string, settings: JsonObject, rule: string): JsonObject | Ungranted | undefined {
  const permissions = settings["permissions"] === undefined ? {} : asObject(settings["permissions"]);

  if (permissions === undefined) return new Ungranted(`${file}: permissions is not an object`);
  const allow = permissions["allow"] === undefined ? [] : asArray(permissions["allow"]);

  if (allow === undefined) return new Ungranted(`${file}: permissions.allow is not a list`);

  if (allow.includes(rule)) return undefined;

  return { ...settings, permissions: { ...permissions, allow: [...allow, rule] } };
}

function writeAtomic(file: string, text: string): void {
  const scratch = join(dirname(file), `.${process.pid}.settings.local.json.tmp`);
  writeFileSync(scratch, text, "utf8");
  renameSync(scratch, file);
}

/**
 * Grant the call a permission's allow-once answer lets through: why it cannot be granted (the answer is
 * then refused and nothing is stored), or undefined when it was granted or there is nothing to grant (an
 * answer to another kind, or not allow-once).
 */
export function grantRefusal(answered: Answered): string | undefined {
  if (!answered.text.startsWith(ALLOW_ONCE)) return undefined;
  const ledger = Option.getOrUndefined(parseLedger(readText(join(answered.dir, "state.json")) ?? ""));

  if (ledger === undefined || ledger instanceof Refusal) return "the ledger cannot be read, so the permission cannot be checked";
  const d = findDecision(ledger, answered.decision);

  if (d === undefined || d.kind !== "permission") return undefined;
  const asked = askedOf(answered.dir, d);

  if (asked instanceof Ungranted) return asked.reason;
  const file = settingsOf(asked.root);
  const settings = parsed(file);

  if (settings instanceof Ungranted) return settings.reason;
  const next = withRule(file, settings, asked.rule);

  if (next instanceof Ungranted) return next.reason;

  // Someone put the rule there, and nobody but them takes it out: no grant, so the hook leaves it.
  if (next === undefined) return undefined;
  const reload = isDir(dirname(file)) ? "live" : "restart";

  const before = readText(file);

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (cause: unknown) {
    return `could not grant ${asked.rule} in ${file}: ${strerror(cause)}`;
  }

  try {
    const grant = { op: "grant", decision: asked.id, ref: asked.ref, rule: asked.rule, file, at: answered.at, by: answered.by, reload };
    appendFileSync(join(answered.dir, "grants.jsonl"), `${JSON.stringify(grant)}\n`, "utf8");
  } catch (cause: unknown) {
    // A rule with no grant line is one the hook would never remove: take it back.
    if (before === undefined) rmSync(file, { force: true });
    else writeAtomic(file, before);

    return `could not record the grant in ${join(answered.dir, "grants.jsonl")}: ${strerror(cause)}`;
  }

  return undefined;
}
