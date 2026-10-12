/**
 * What prepares a workspace `fleet ws add` has just made or handed over, so its worker does not pay the
 * repo's setup (a dev shell, a virtualenv, about 70 s) on its first command: the repo's own executable
 * `<repo>/.fleet/ws-add <workspace> <source>`, else, in a devenv repo, the machine's `devenv-run --prepare`
 * (it saves the workspace's devenv env once). A hook that fails or runs out of time is reported, never a
 * failure of `ws add`: the workspace is there either way.
 */
import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";

import { exists, readText } from "../files.ts";
import type { JsonObject } from "../json.ts";

/** The repo's own hook, relative to the root of its default workspace. */
export const HOOK_PATH = join(".fleet", "ws-add");

/** The default for a repo with a devenv.nix and no hook of its own. */
export const DEVENV_RUN = "devenv-run";

/** How long a hook may run, in seconds, unless `--hook-timeout` says otherwise: under the 120 s a Bash
 * tool call gets by default, so a hook that hangs ends before the call that runs `ws add` is killed. */
export const HOOK_TIMEOUT_S = 100;

/** One run to make: the program, its arguments, where it runs, and how it is named. */
export interface HookCall {
  readonly name: string;
  /** The call as the header over its output shows it. */
  readonly line: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** What `ws add` does after jj: run a hook, say why it runs none (`note`), or nothing at all. */
export type HookPlan = { readonly call: HookCall } | { readonly note: string } | undefined;

/** Where `name` is on `path` (a PATH value) as an executable file, or undefined. */
function onPath(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const at = join(dir, name);

    if (executableFile(at)) return at;
  }

  return undefined;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);

    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether `path`, symlinks resolved, is inside `root`, symlinks resolved. */
function inside(path: string, root: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));

    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** The hook for a workspace at `workspace`, made from `source` (the repo's default workspace, or the
 * workspace handed over), in the repo whose default workspace is `repo`. `path` is the PATH to find
 * `devenv-run` on. A hook file that resolves outside the repo, or is not executable, is never run. */
export function planHook(repo: string, workspace: string, source: string, path: string): HookPlan {
  const own = join(repo, HOOK_PATH);

  if (exists(own)) {
    if (!inside(own, repo)) return { note: `ws: ${own} resolves outside the repo (${repo}): not run` };

    if (!executableFile(own)) return { note: `ws: ${own} is not an executable file: not run (\`chmod +x\` it)` };

    return { call: { name: HOOK_PATH, line: `${HOOK_PATH} ${workspace} ${source}`, program: realpathSync(own), args: [workspace, source], cwd: workspace } };
  }

  if (readText(join(workspace, "devenv.nix")) === undefined) return undefined;
  const devenvRun = onPath(DEVENV_RUN, path);

  if (devenvRun === undefined) return { note: `ws: a devenv repo, and ${DEVENV_RUN} is not on PATH: the workspace's devenv env is not prepared` };

  return { call: { name: `${DEVENV_RUN} --prepare`, line: `${DEVENV_RUN} --prepare`, program: devenvRun, args: ["--prepare"], cwd: workspace } };
}

/** How a hook's run ended. */
export interface HookRun {
  /** Its exit code; null when it timed out, was killed, was interrupted, or could not start. */
  readonly exit: number | null;
  /** Its time ran out, and its process group was sent SIGTERM, then SIGKILL. */
  readonly timedOut: boolean;
  /** The signal `ws add` itself received while the hook ran, which stopped the hook's process group. */
  readonly interrupted: NodeJS.Signals | undefined;
  readonly seconds: number;
  /** Its stdout and stderr, interleaved as written. */
  readonly output: string;
  /** Why it could not start or was killed, when it did not exit by itself. */
  readonly error: string | undefined;
  /** It never ran: the program is missing, or its `#!` line names one that is. */
  readonly unstarted: boolean;
}

/** The signals that stop `ws add` while its hook runs: each stops the hook's process group first. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** How long a stopped hook's process group has between SIGTERM and SIGKILL. */
export const STOP_GRACE_MS = 2000;

/** Whether process group `pgid` still has a process in it. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is gone already.
  }
}

/** SIGTERM to the whole group; SIGKILL to what is left of it after {@link STOP_GRACE_MS}. */
async function stopGroup(pgid: number | undefined): Promise<void> {
  if (pgid === undefined || pgid <= 0) return;
  signalGroup(pgid, "SIGTERM");
  const until = Date.now() + STOP_GRACE_MS;

  while (groupAlive(pgid) && Date.now() < until) await new Promise((wake) => setTimeout(wake, 50));
  signalGroup(pgid, "SIGKILL");
}

/** How the hook's own process ended. */
interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: string | undefined;
}

/**
 * Run the hook to its end or for `timeoutS` seconds. It runs in a process group of its own, so a timeout,
 * or a TERM, INT or HUP that `ws add` receives meanwhile, stops every process it started: SIGTERM to the
 * group, SIGKILL after {@link STOP_GRACE_MS}. A hook that ends by itself has what it left in its group
 * stopped the same way. Its output goes to a file, not a pipe, so a process it left
 * behind never holds the run open; the file's directory is removed however the run ends.
 */
export async function runHook(call: HookCall, timeoutS: number, env: Readonly<Record<string, string | undefined>>): Promise<HookRun> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ws-hook-"));
  const log = join(dir, "output");
  const fd = openSync(log, "w");
  const started = Date.now();
  const handlers: [NodeJS.Signals, () => void][] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const child = spawn(call.program, [...call.args], { cwd: call.cwd, env, stdio: ["ignore", fd, fd], detached: true });

    const ended = new Promise<Ended>((resolve) => {
      child.once("error", (e) => {
        resolve({ code: null, signal: null, error: e.message });
      });
      child.once("exit", (code, signal) => {
        resolve({ code, signal, error: undefined });
      });
    });

    let why: "timeout" | NodeJS.Signals | undefined;
    let stopped: Promise<void> = Promise.resolve();

    const stop = (reason: "timeout" | NodeJS.Signals): void => {
      if (why !== undefined) return;
      why = reason;
      stopped = stopGroup(child.pid);
    };

    timer = setTimeout(() => {
      stop("timeout");
    }, timeoutS * 1000);

    for (const signal of STOP_SIGNALS) {
      const handler = (): void => {
        stop(signal);
      };

      handlers.push([signal, handler]);
      process.on(signal, handler);
    }

    const end = await ended;
    clearTimeout(timer);
    await stopped;

    // What the hook left running in its group (a server, a watcher) dies with it.
    if (why === undefined && child.pid !== undefined && groupAlive(child.pid)) await stopGroup(child.pid);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const output = readText(log) ?? "";
    const reason: "timeout" | NodeJS.Signals | undefined = why;

    const run = { exit: null, timedOut: false, interrupted: undefined, seconds, output, error: undefined, unstarted: false };

    if (end.error !== undefined) return { ...run, error: end.error, unstarted: true };

    if (reason === "timeout") return { ...run, timedOut: true };

    if (reason !== undefined) return { ...run, interrupted: reason, error: `stopped: fleet ws add received ${reason}` };

    return { ...run, exit: end.code, error: end.signal === null ? undefined : `killed by ${end.signal}` };
  } finally {
    clearTimeout(timer);

    for (const [signal, handler] of handlers) process.off(signal, handler);
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The ledger's record of a run, on the workspace's row (`hook`). */
export function hookRecord(call: HookCall, run: HookRun, at: string): JsonObject {
  const record: JsonObject = { command: call.name, at, exit: run.exit, seconds: run.seconds };

  if (run.timedOut) return { ...record, timed_out: true };

  if (run.interrupted !== undefined) return { ...record, interrupted: run.interrupted };

  return run.error === undefined ? record : { ...record, error: run.error };
}

/** The run in words, for the ledger's event and the last line printed. */
export function hookOutcome(call: HookCall, run: HookRun, timeoutS: number): string {
  if (run.timedOut) return `${call.name} timed out after ${String(timeoutS)} s and was killed`;

  if (run.interrupted !== undefined) return `${call.name} was stopped after ${String(run.seconds)} s: fleet ws add received ${run.interrupted}`;

  if (run.unstarted) return `${call.name} could not start: ${run.error ?? "no reason given"} (a missing program, or a #! line that names one)`;

  if (run.exit === null) return `${call.name} did not run to its end: ${run.error ?? "no exit code"}`;

  return `${call.name} exited ${String(run.exit)} in ${String(run.seconds)} s`;
}
