/**
 * The sessions that serve a fleet, and its workers' transcripts in them, for `fleet waste`
 * ([cli/waste.ts](cli/waste.ts)). Other sessions' and projects' transcripts are unrelated private work: they are
 * never looked through; in a serving session's folder only `subagents/agent-<task id>.jsonl` of a task id in the
 * fleet's ledger is ever opened. Its own module, not the registry's: the chat watch's owner record (chat/watchers.ts)
 * reaches the registry through host.ts, so a registry that read it would import itself.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { readOwner } from "./chat/watchers.ts";
import { isDir, isRegularFile } from "./files.ts";
import { readBeats } from "./heartbeat.ts";
import { asString } from "./json.ts";
import { readObject, type Registry } from "./registry.ts";
import { isPlainId, sessionFolderOf } from "./transcripts.ts";

/** The session that owns the coordinator's chat watch on `root`: the owner record's pid, looked up in Claude
 * Code's `sessions/<pid>.json`, only while that file's `procStart` is the start the watch recorded (a later
 * process with the pid is another session). */
function ownerSession(config: string, root: string): string | undefined {
  const owner = readOwner(root, "coordinator");

  if (owner === undefined || owner.session === null || owner.started === null) return undefined;
  const live = readObject(join(config, "sessions", `${Math.trunc(owner.session)}.json`));

  return asString(live?.["procStart"]) === owner.started ? asString(live?.["sessionId"]) : undefined;
}

/**
 * The folders of the sessions that serve the fleet at `root`, and only those: the session whose scratchpad holds
 * `root` and its registry entry's (when served), the session that owns the coordinator's chat watch, and the
 * sessions that beat in `root/heartbeats/`, in whichever project each one is. Nothing in them is read here.
 */
export function servingSessions(registry: Registry, config: string, root: string): string[] {
  const owner = sessionFolderOf(config, ownerSession(config, root));
  const beating = [...new Set(readBeats(root).map((b) => b.session))].flatMap((id) => sessionFolderOf(config, id) ?? []);

  return [...new Set([...registry.sessionFolders(root), ...(owner === undefined ? [] : [owner]), ...beating])].filter(isDir);
}

/** The real path of `path`, or undefined when it has none. */
function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Worker `taskId`'s transcript in the first of `folders` (each `projects/<project>/<session>`) that has it as a
 * regular file (a symlinked file is not followed), as its real path, or undefined; undefined too for a task id
 * that is not a plain id. A folder whose own or whose `subagents/`'s real path is outside its project's folder
 * is refused.
 */
export function workerTranscript(folders: readonly string[], taskId: string): string | undefined {
  if (!isPlainId(taskId)) return undefined;

  for (const folder of folders) {
    const projects = realOf(dirname(dirname(folder)));
    const project = projects === undefined ? undefined : join(projects, basename(dirname(folder)));
    const within = (path: string | undefined): path is string => project !== undefined && path !== undefined && path.startsWith(project + sep);
    const sub = realOf(join(folder, "subagents"));

    if (!within(realOf(folder)) || !within(sub)) continue;
    const file = join(sub, `agent-${taskId}.jsonl`);

    if (isRegularFile(file)) return file;
  }

  return undefined;
}
