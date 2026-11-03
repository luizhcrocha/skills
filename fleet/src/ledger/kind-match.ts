/**
 * The kind of a call, read by the deploy part's matcher (`python3 -I hooks/tstack-hook-deploy.py match`; its head holds
 * the contract). The host runs the same matcher again before it grants anything, so this reading only words the card.
 * What the matcher refuses, or a matcher that fails, is no kind, which hides the option.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import * as Option from "effect/Option";

import { SKILL_DIR } from "../files.ts";
import { parseObject } from "../json.ts";
import type { Machine } from "../world.ts";
import { callKindOf, type CallKind } from "./allow-kind.ts";


const MATCHER = join(resolve(SKILL_DIR, "..", "..", ".."), "hooks", "tstack-hook-deploy.py");

const MATCH_MS = 10_000;

/** A URL holding a password: a card goes to the cloud, so such an origin words no card. */
const CREDENTIAL_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/u;

/** The one kind `call` in `cwd` reaches, or undefined. */
export function kindOfCall(machine: Machine, call: string, cwd: string): CallKind | undefined {
  const env = { HOME: machine.env("HOME") ?? "", CLAUDE_PROJECT_DIR: machine.env("CLAUDE_PROJECT_DIR") ?? cwd };
  const done = spawnSync("python3", ["-I", MATCHER, "match"], { input: JSON.stringify({ command: call, cwd, env }), encoding: "utf8", timeout: MATCH_MS, killSignal: "SIGKILL" });

  const kind = done.status === 0 ? callKindOf(Option.getOrUndefined(parseObject(done.stdout))?.["kind"]) : undefined;

  return kind?.repo.origin !== null && kind?.repo.origin !== undefined && CREDENTIAL_URL.test(kind.repo.origin) ? undefined : kind;
}
