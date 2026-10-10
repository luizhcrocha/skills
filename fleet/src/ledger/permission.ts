/**
 * A permission (TypeScript's alone, SPEC.md "Permission grants"): a tool call the harness refused in auto
 * mode, which the user may let through once. The plugin's hook opens it with the call as the harness saw
 * it; this module makes the row's refusal and its two options, and holds the one rule both the CLI and
 * the hub check a call against: an exact allow rule, `Bash(<call>)`, and only for a call it can express; or,
 * for a spawn, `Agent(<its input as JSON>)`, which the plugin's PreToolUse hook matches (auto mode drops
 * Agent allow rules from the settings, and a hook's allow is what clears a refused spawn).
 */
import { isAbsolute, join } from "node:path";

import * as Effect from "effect/Effect";

import { stateRefusal, type Refusal } from "../errors.ts";
import { asObject, type Json } from "../json.ts";
import type { Choice, RefusedCall } from "./model.ts";

/** The tools a permission handles: a shell command, and a subagent's spawn. */
export const PERMISSION_TOOLS: readonly string[] = ["Bash", "Agent"];

/** The option that grants the call once. */
export const ALLOW_ONCE = "allow-once";

/** How long a grant the call has not used stays; the hook's GRANT_TTL_S is the same. */
const GRANT_TTL_MIN = 30;

/** The exact rule that lets `tool`'s `call` through. */
export function ruleOf(tool: string, call: string): string {
  return `${tool}(${call})`;
}

/** Why no exact rule can let `tool`'s `call` through, or undefined when one can. An Agent call is its input
 * as a JSON object, which the hook alone matches. For Bash the hook's RULE_UNSAFE_CHARS is the same set: a
 * newline ends a rule, a `*` would match more than the call, and a backslash starts an escape in Claude
 * Code's rule parser, so the rule would not match the call. */
export function whyNoRule(tool: string, call: string): string | undefined {
  if (tool === "Agent") return isJsonObject(call) ? undefined : "an Agent call is its tool input, a JSON object";

  if (call.includes("\n") || call.includes("\r")) return "the call has a newline, which an exact allow rule cannot hold";

  if (call.includes("*")) return "the call has a *, which an allow rule reads as a wildcard";

  if (call.includes("\\")) return "the call has a backslash, which an allow rule reads as an escape";

  return undefined;
}

function isJsonObject(text: string): boolean {
  try {
    // SAFETY: JSON.parse returns JSON values only.
    return asObject(JSON.parse(text) as Json) !== undefined;
  } catch {
    return false;
  }
}

/** The file a grant of `tool`'s call for a session rooted at `root` goes into: its settings for Bash; for
 * Agent, whose allow rules auto mode drops, the grants file the plugin's PreToolUse hook reads (the hook's
 * AGENT_GRANTS). Both sit in `.claude`, a path auto mode routes an agent's write of to the classifier. */
export function grantFileOf(tool: string, root: string): string {
  return join(root, ".claude", tool === "Agent" ? "tstack-grants.json" : "settings.local.json");
}

/** What the hook gives for a refused call. */
export interface RefusedGiven {
  readonly tool: string;
  readonly call: string;
  readonly cause: string;
  readonly root: string;
  readonly agentId: string | null;
}

/** The refusal a permission row carries, or why the CLI refuses to open one. */
export function makeRefusedCall(given: RefusedGiven): Effect.Effect<RefusedCall, Refusal> {
  if (!PERMISSION_TOOLS.includes(given.tool)) return Effect.fail(stateRefusal(`a permission handles ${PERMISSION_TOOLS.join(" and ")} alone, got --tool ${given.tool}`));
  const why = whyNoRule(given.tool, given.call);

  if (why !== undefined) return Effect.fail(stateRefusal(`no permission for this call: ${why}; open an action with --manual instead`));

  if (!isAbsolute(given.root)) return Effect.fail(stateRefusal(`--root is the session's project directory, an absolute path, got ${given.root}`));

  return Effect.succeed({ tool: given.tool, call: given.call, rule: ruleOf(given.tool, given.call), cause: given.cause, root: given.root, agent_id: given.agentId });
}

/** A permission's two options, which the CLI sets itself, each saying what it means for the user; the rule
 * and the file it goes into show with the call on the page. */
export function permissionOptions(refusal: RefusedCall): Choice[] {
  const what = refusal.tool === "Agent" ? "starts this exact agent" : "runs this exact call";

  return [
    {
      id: ALLOW_ONCE,
      label: "Allow this call once",
      consequence: `the worker ${what} once, and nothing like it after: the one-time grant goes once it is used, or after ${String(GRANT_TTL_MIN)} minutes`,
    },
    { id: "deny", label: "Deny", consequence: "the worker stays stopped; your note goes to it" },
  ];
}
