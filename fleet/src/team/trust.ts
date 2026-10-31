/**
 * Claude Code's folder trust, for `fleet team start`: a tab started in a folder Claude Code has not trusted stops
 * on its trust question. Claude Code has no flag, setting or variable for it; the one documented route is
 * `projects["<root>"].hasTrustDialogAccepted = true` in its `.claude.json`, keyed on the git repository root (a
 * worktree's main checkout), or the folder itself outside a repository; trust in the home folder is never kept.
 * Running sessions rewrite that file too, so a write sets that one key and leaves the rest as it reads it, through
 * a temp file of its own renamed over it, once the file is seen unchanged since the read. Nothing of the file but
 * that key is ever said.
 */
import { randomUUID } from "node:crypto";
import { type BigIntStats, closeSync, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import * as Option from "effect/Option";

import { exists, isDir, readText, strerror } from "../files.ts";
import { asObject, parseObject, type JsonObject } from "../json.ts";
import type { Why } from "./agents.ts";

/** Asks the owner `question` on a terminal; true only for a yes. */
export type Asker = (question: string) => boolean;

/** How `start` may trust a folder: the owner said `--trust`, or it may ask on a terminal, or neither (`again`
 * says how to give `--trust`, as `\`fleet team start --trust\``). */
export type Consent = { readonly _tag: "Given" } | { readonly _tag: "Ask"; readonly ask: Asker } | { readonly _tag: "None"; readonly again: string };

/** What {@link ensureTrusted} did: nothing, the folder being trusted already, or wrote the key. */
export type Trusted = { readonly _tag: "Already" } | { readonly _tag: "Written"; readonly line: string };

/** Claude Code's `.claude.json`: in `$CLAUDE_CONFIG_DIR` when set, else in the home folder. */
export function claudeConfigOf(env: (name: string) => string | undefined, home: string): string {
  const config = env("CLAUDE_CONFIG_DIR");

  return join(config !== undefined && config !== "" ? config : home, ".claude.json");
}

/** The folder Claude Code keys `dir`'s trust on: the nearest git repository root up from it (a worktree's main
 * checkout), else `dir` itself. */
export function trustRootOf(dir: string): string {
  for (let at = dir; ; at = dirname(at)) {
    const git = join(at, ".git");

    if (isDir(git)) return at;

    if (exists(git)) return mainCheckoutOf(at) ?? at;

    if (dirname(at) === at) return dir;
  }
}

/** The main checkout of the worktree at `at`, realpath'd: only when its `.git` file names
 * `<main>/.git/worktrees/<name>`, that folder's `gitdir` points back at `at`'s `.git`, and `<main>/.git` is a
 * folder; undefined otherwise (a submodule, or a planted file). */
function mainCheckoutOf(at: string): string | undefined {
  const named = /^gitdir:\s*(.+?)\s*$/m.exec(readText(join(at, ".git")) ?? "")?.[1];
  const gitdir = named === undefined ? undefined : resolve(at, named);
  const main = gitdir === undefined ? undefined : /^(.+)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.exec(gitdir)?.[1];
  const back = gitdir === undefined ? undefined : readText(join(gitdir, "gitdir"))?.trim();

  if (main === undefined || back === undefined || !isDir(join(main, ".git")) || realOf(resolve(gitdir ?? "", back)) !== realOf(join(at, ".git"))) return undefined;

  return realOf(main);
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `root` is `/`, empty, the home folder or a folder above it, by their realpaths. */
export function atOrAboveHome(root: string, home: string): boolean {
  if (root === "") return true;
  const real = realOf(root);
  const realHome = realOf(home);

  return real === sep || real === realHome || realHome.startsWith(real.endsWith(sep) ? real : `${real}${sep}`);
}

/** Make sure Claude Code trusts `root`: nothing when it does; else, with the owner's consent, set its key in
 * `config`. Refused in the home folder, without consent, or when `config` is missing or not a JSON object. */
export function ensureTrusted(input: {
  readonly root: string;
  readonly config: string;
  readonly home: string;
  readonly consent: Consent;
  /** Called after each read of the file for the write and before its rename: another writer's window. */
  readonly beforeRename?: () => void;
}): Trusted | Why {
  const { root, config, home, consent } = input;

  if (atOrAboveHome(root, home)) {
    return { why: `${root} is the home folder or a folder above it: Claude Code never keeps trust in the home folder, and trusting a folder above it would trust all below; start the team from a repository below it` };
  }

  const held = readConfig(config);

  if ("why" in held) return held;

  if (asObject(asObject(held.config["projects"])?.[root])?.["hasTrustDialogAccepted"] === true) return { _tag: "Already" };

  switch (consent._tag) {
    case "None":
      return { why: `Claude Code does not trust ${root} yet, and there is no terminal to ask on: ${consent.again} trusts it` };
    case "Ask":
      if (!consent.ask(`trust ${root} for Claude Code? Its agents read, edit and run files there. [y/N] `)) return { why: `${root} not trusted for Claude Code; nothing started` };
      break;
    case "Given":
      break;
  }

  for (let tries = 0; tries < 2; tries += 1) {
    const again = readConfig(config);

    if ("why" in again) return again;
    const written = writeTrust(again, root, input.beforeRename);

    if (written === undefined) return { _tag: "Written", line: `trusted ${root} for Claude Code in ${config}` };

    if (written !== CHANGED) return written;
  }

  return { why: `Claude Code's config ${config} changed while fleet team wrote it, twice; nothing written: start again` };
}

/** What {@link writeTrust} says when the file changed since it was read. */
const CHANGED = { why: "changed since read" } as const satisfies Why;

interface Held {
  /** The file written: `config`, or where its symlink points. */
  readonly path: string;
  readonly mode: number;
  /** The file as read, to see another writer before the rename. */
  readonly seen: string;
  readonly config: JsonObject;
}

function stamp(st: BigIntStats): string {
  return `${String(st.ino)}:${String(st.size)}:${String(st.mtimeNs)}`;
}

function readConfig(config: string): Held | Why {
  let path: string;
  let text: string;
  let st: BigIntStats;

  try {
    path = realpathSync(config);
    const fd = openSync(path, "r");

    try {
      // The stamp comes from the open file before its bytes, so a file renamed in, or written, after the read
      // never stamps content it did not give.
      st = fstatSync(fd, { bigint: true });
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (cause: unknown) {
    return { why: `Claude Code's config ${config} could not be read (${strerror(cause)}); fleet team does not create it: run claude once, then start again` };
  }

  const record = Option.getOrUndefined(parseObject(text));

  if (record === undefined) return { why: `Claude Code's config ${config} is not a JSON object; fleet team leaves it as it is` };

  return { path, mode: Number(st.mode & 0o7777n), seen: stamp(st), config: record };
}

/** Write `held` with `root` trusted, through a temp file of this process's own; {@link CHANGED} when the file
 * changed since it was read, nothing written. */
function writeTrust(held: Held, root: string, beforeRename: (() => void) | undefined): Why | undefined {
  const projects = held.config["projects"] === undefined ? {} : asObject(held.config["projects"]);
  const entry = projects?.[root] === undefined ? {} : asObject(projects?.[root]);

  if (projects === undefined || entry === undefined) return { why: `Claude Code's config ${held.path}: projects is not an object of objects; fleet team leaves it as it is` };
  const next = { ...held.config, projects: { ...projects, [root]: { ...entry, hasTrustDialogAccepted: true } } };
  const scratch = `${held.path}.fleet-trust.${String(process.pid)}.${randomUUID()}.tmp`;
  let made = false;

  try {
    const fd = openSync(scratch, "wx", held.mode);
    made = true;

    try {
      fchmodSync(fd, held.mode);
      writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    beforeRename?.();

    if (stamp(statSync(held.path, { bigint: true })) !== held.seen) {
      rmSync(scratch, { force: true });

      return CHANGED;
    }

    renameSync(scratch, held.path);

    return undefined;
  } catch (cause: unknown) {
    if (made) rmSync(scratch, { force: true });

    return { why: `Claude Code's config ${held.path} could not be written: ${strerror(cause)}` };
  }
}
