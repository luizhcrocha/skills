/**
 * The hub's own code, watched: a hub under a supervisor (systemd, launchd) exits when its sources change,
 * so the supervisor starts it again on the new code. Its page is read at each request; its server is not,
 * and a plugin update or an edit to the checkout would otherwise leave an old server running new pages.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The exit code a hub that restarts for new code ends with: EX_TEMPFAIL, so `Restart=on-failure` and launchd's `SuccessfulExit = false` bring it back. */
export const RELOAD_EXIT = 75;

/** How often the sources are looked at. A change counts once two looks in a row agree, so a checkout half-way through an edit is not started. */
export const RELOAD_MS = 15_000;

/** The package's root: `fleet/`, two levels above this file. */
export const FLEET_ROOT = join(import.meta.dir, "..", "..");

/** Whether a supervisor runs this process: systemd sets INVOCATION_ID, launchd sets XPC_SERVICE_NAME to the job's label. */
export function supervised(env: (name: string) => string | undefined): boolean {
  const xpc = env("XPC_SERVICE_NAME");

  return Boolean(env("INVOCATION_ID")) || (xpc !== undefined && xpc !== "" && xpc !== "0");
}

function walk(dir: string, into: string[]): void {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names.sort()) {
    const path = join(dir, name);

    try {
      const s = statSync(path);

      if (s.isDirectory()) walk(path, into);
      else if (s.isFile()) into.push(`${path} ${String(s.size)} ${String(s.mtimeMs)}`);
    } catch {
      into.push(`${path} gone`);
    }
  }
}

/** One line per source file (path, size, modification time), plus the manifest and the lockfile. */
export function fingerprint(root: string = FLEET_ROOT): string {
  const lines: string[] = [];

  walk(join(root, "src"), lines);

  for (const name of ["package.json", "bun.lock"]) {
    try {
      const s = statSync(join(root, name));

      lines.push(`${name} ${String(s.size)} ${String(s.mtimeMs)}`);
    } catch {
      lines.push(`${name} gone`);
    }
  }

  return lines.join("\n");
}

/** A watch on the hub's sources: `changed` resolves once they changed and held still; `stop` ends it. */
export interface CodeWatch {
  readonly changed: Promise<void>;
  readonly stop: () => void;
}

/**
 * Resolves once the sources under `root` differ from what they were at the call and have held still for one
 * look; never resolves while they stay the same. `stop` ends the watch.
 */
export function codeChanged(root: string = FLEET_ROOT, every: number = RELOAD_MS): CodeWatch {
  const start = fingerprint(root);
  let last = start;
  let timer: ReturnType<typeof setInterval> | undefined;

  const changed = new Promise<void>((resolve) => {
    timer = setInterval(() => {
      const now = fingerprint(root);

      if (now !== start && now === last) {
        clearInterval(timer);
        resolve();
      }

      last = now;
    }, every);
  });

  return { changed, stop: () => clearInterval(timer) };
}
