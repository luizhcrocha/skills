/**
 * The kind of a call, read by hooks/tstack-kind-match.py (`python3 -I`; its head holds the contract and the threat model). The host runs the same matcher again before it grants anything, so this reading only words the card.
 * What the matcher refuses, or a matcher that fails, is no kind, which hides the option.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import * as Option from "effect/Option";

import { SKILL_DIR } from "../files.ts";
import { parseObject } from "../json.ts";
import type { Machine } from "../world.ts";
import { callKindOf, type CallKind } from "./allow-kind.ts";


const MATCHER = join(resolve(SKILL_DIR, "..", "..", ".."), "hooks", "tstack-kind-match.py");

const MATCH_MS = 10_000;

/** The one kind `call` in `cwd` reaches, or undefined. */
export function kindOfCall(machine: Machine, call: string, cwd: string): CallKind | undefined {
  const env = { HOME: machine.env("HOME") ?? "" };
  const done = spawnSync("python3", ["-I", MATCHER], { input: JSON.stringify({ command: call, cwd, env }), encoding: "utf8", timeout: MATCH_MS, killSignal: "SIGKILL" });

  return done.status === 0 ? callKindOf(Option.getOrUndefined(parseObject(done.stdout))?.["kind"]) : undefined;
}
