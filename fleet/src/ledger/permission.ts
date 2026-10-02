/**
 * A permission (TypeScript's alone, SPEC.md "Permission grants"): a tool call the harness refused in auto
 * mode, which the user may let through once. The plugin's hook opens it with the call as the harness saw
 * it; this module makes the row's refusal and its two options, and holds the one rule both the CLI and
 * the hub check a call against: an exact allow rule, `Bash(<call>)`, and only for a call it can express.
 */
import { isAbsolute, join } from "node:path";

import * as Effect from "effect/Effect";

import { stateRefusal, type Refusal } from "../errors.ts";
import type { Choice, RefusedCall } from "./model.ts";

/** The one tool a permission handles in this cut. */
export const PERMISSION_TOOL = "Bash";

/** The option that grants the call once. */
export const ALLOW_ONCE = "allow-once";

/** How long a grant the call has not used stays; the hook's GRANT_TTL_S is the same. */
const GRANT_TTL_MIN = 30;

/** The exact allow rule that lets `call` through. */
export function ruleOf(call: string): string {
  return `${PERMISSION_TOOL}(${call})`;
}

/** Why no exact rule can let `call` through, or undefined when one can: the hook's NO_RULE is the same set. A
 * newline ends a rule, a `*` would match more than the call, and a backslash starts an escape in Claude
 * Code's rule parser, so the rule would not match the call. */
export function whyNoRule(call: string): string | undefined {
  if (call.includes("\n") || call.includes("\r")) return "the call has a newline, which an exact allow rule cannot hold";

  if (call.includes("*")) return "the call has a *, which an allow rule reads as a wildcard";

  if (call.includes("\\")) return "the call has a backslash, which an allow rule reads as an escape";

  return undefined;
}

/** The settings file a grant for a session rooted at `root` goes into. */
export function settingsOf(root: string): string {
  return join(root, ".claude", "settings.local.json");
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
  if (given.tool !== PERMISSION_TOOL) return Effect.fail(stateRefusal(`a permission handles ${PERMISSION_TOOL} alone, got --tool ${given.tool}`));
  const why = whyNoRule(given.call);

  if (why !== undefined) return Effect.fail(stateRefusal(`no permission for this call: ${why}; open an action with --manual instead`));

  if (!isAbsolute(given.root)) return Effect.fail(stateRefusal(`--root is the session's project directory, an absolute path, got ${given.root}`));

  return Effect.succeed({ tool: given.tool, call: given.call, rule: ruleOf(given.call), cause: given.cause, root: given.root, agent_id: given.agentId });
}

/** A permission's two options, which the CLI sets itself. */
export function permissionOptions(refusal: RefusedCall): Choice[] {
  return [
    {
      id: ALLOW_ONCE,
      label: "Allow this call once",
      consequence: `the hub adds ${refusal.rule} to ${settingsOf(refusal.root)}; the plugin hook removes it once the call has run, or at the first tool call of the session after ${String(GRANT_TTL_MIN)} minutes`,
    },
    { id: "deny", label: "Deny", consequence: "the worker stays stopped; your note goes to it" },
  ];
}
