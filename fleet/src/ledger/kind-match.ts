/**
 * The kind of a call, read by hooks/tstack-kind-match.py (`python3 -I`; its head holds the contract and the threat model). The host runs the same matcher again before it grants anything, so this reading only words the card and carries the script's text to the owner (`refusal.kind.text`).
 * What the matcher refuses, or a matcher that fails, is no kind, which hides the option; `why` says so to the opener.
 * `root` goes as CLAUDE_PROJECT_DIR, as the host's answer sends it, and it is the one workspace a one-off script may sit in.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import * as Option from "effect/Option";

import { SKILL_DIR } from "../files.ts";
import { asString, parseObject } from "../json.ts";
import type { Machine } from "../world.ts";
import { callKindOf, type CallKind } from "./allow-kind.ts";


const MATCHER = join(resolve(SKILL_DIR, "..", "..", ".."), "hooks", "tstack-kind-match.py");

const MATCH_MS = 10_000;

/** The one kind `call` under `root` reaches, or why it reaches none. */
export function kindOfCall(machine: Machine, call: string, root: string): { readonly kind: CallKind } | { readonly why: string } {
  const env = { HOME: machine.env("HOME") ?? "", CLAUDE_PROJECT_DIR: root };
  const done = spawnSync("python3", ["-I", MATCHER], { input: JSON.stringify({ command: call, cwd: root, env }), encoding: "utf8", timeout: MATCH_MS, killSignal: "SIGKILL" });
  const said = done.status === 0 ? Option.getOrUndefined(parseObject(done.stdout)) : undefined;
  const kind = callKindOf(said?.["kind"]);

  if (kind !== undefined) return { kind };

  return { why: asString(said?.["refused"]) ?? "the matcher gave no answer it could read" };
}
