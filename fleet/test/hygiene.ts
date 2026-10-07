/**
 * Preloaded by bunfig.toml into every `bun test` run: the run's temp files live under one parent
 * directory (TMPDIR points at it, so every `mkdtemp` and every child process uses it), and every
 * process the run started (a preview's updater and dev server start detached, hubs, stub servers)
 * carries FLEET_TEST_RUN in its environment. When the run ends, fails, or is stopped by SIGTERM or
 * SIGINT, what is still alive is stopped (SIGTERM, then SIGKILL after a short wait) and the parent is
 * removed. A leak that the tests themselves should have cleaned up fails the run.
 *
 * The run sheds the Claude Code session it may be started from: every `CLAUDE*` variable is removed,
 * so `fleet serve` does not name a fixture fleet after that session. A test that needs one sets it.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "bun:test";

const MARK = "FLEET_TEST_RUN";

const GRACE_MS = 500;

// Always its own: a parallel worker inherits the coordinator's environment, and must not stop its siblings' processes.
const outer = realpathSync(tmpdir());

const parent = mkdtempSync(join(outer, "fleet-test-run-"));

writeFileSync(join(parent, "run.pid"), String(process.pid));

// A `fleet` a test spawns forwards to the newest tstack on the machine unless told not to; the run
// tests this copy's code.
Object.assign(process.env, { [MARK]: parent, TMPDIR: parent, FLEET_NO_FORWARD: "1" });

for (const name of Object.keys(process.env)) if (name.startsWith("CLAUDE")) delete process.env[name];

/** Pids of this run's processes still alive (not this one): marked in their environment, or running in or on the run's directory. */
function survivors(owned: string = parent): number[] {
  const found: number[] = [];

  for (const name of readdirSync("/proc")) {
    const pid = Number(name);

    if (!Number.isInteger(pid) || pid === process.pid) continue;

    try {
      const state = /^State:\s+(\S)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];

      if (state === "Z") continue;

      const env = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "latin1");
      const cwd = readlinkSync(`/proc/${pid}/cwd`);

      if (env.includes(`${MARK}=${owned}`) || cmd.includes(owned) || cwd.startsWith(owned)) found.push(pid);
    } catch {
      // gone, or not ours to read
    }
  }

  return found;
}

function pgidOf(pid: number): number {
  try {
    return Number(readFileSync(`/proc/${pid}/stat`, "latin1").replace(/^.*\) /, "").split(" ")[2]);
  } catch {
    return 0;
  }
}

function signal(pids: readonly number[], sig: NodeJS.Signals): void {
  const own = pgidOf(process.pid);

  for (const pid of pids) {
    const group = pgidOf(pid);

    try {
      process.kill(group > 1 && group !== own ? -group : pid, sig);
    } catch {
      // gone
    }
  }
}

/** Stop what is left, synchronously (the exit and signal paths cannot wait on a promise). */
function stopAll(owned: string = parent): number[] {
  const left = survivors(owned);

  if (left.length === 0) return left;

  signal(left, "SIGTERM");
  const until = Date.now() + GRACE_MS;

  while (survivors(owned).length > 0 && Date.now() < until) Bun.sleepSync(20);

  signal(survivors(owned), "SIGKILL");

  return left;
}

/** Whether the run that made `dir` is over: its bun pid is dead or is not a bun (a recycled pid); a dir with no pid file yet is given a minute. */
function runIsGone(dir: string): boolean {
  let pid: number;

  try {
    pid = Number(readFileSync(join(dir, "run.pid"), "utf8"));
  } catch {
    return Date.now() - statSync(dir).mtimeMs > 60_000;
  }

  try {
    const state = /^State:\s+(\S)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];

    return state === "Z" || readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "bun";
  } catch {
    return true;
  }
}

/** Earlier runs' parents in tmp whose run is gone (killed past any handler): their processes stopped, the dirs removed. */
export function reapEarlierRuns(): string[] {
  const reaped: string[] = [];

  for (const name of readdirSync(outer)) {
    const dir = join(outer, name);

    if (!name.startsWith("fleet-test-run-") || dir === parent) continue;

    try {
      if (!runIsGone(dir)) continue;

      stopAll(dir);
      rmSync(dir, { recursive: true, force: true });
      reaped.push(dir);
    } catch {
      // not ours to remove
    }
  }

  return reaped;
}

reapEarlierRuns();

let finished = false;

function finish(): number[] {
  if (finished) return [];
  finished = true;
  const left = stopAll();
  rmSync(parent, { recursive: true, force: true });

  return left;
}

afterAll(() => {
  const left = finish();

  if (left.length > 0) {
    process.stderr.write(`fleet test hygiene: ${left.length} process(es) of this run were still alive after the suite (pids ${left.join(", ")}); stopped, but a test must stop what it starts\n`);
    process.exitCode = 1;
  }

  if (existsSync(parent)) {
    process.stderr.write(`fleet test hygiene: ${parent} still exists after the suite\n`);
    process.exitCode = 1;
  }
});

process.on("exit", () => void finish());

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    finish();
    process.exit(128 + (sig === "SIGTERM" ? 15 : sig === "SIGINT" ? 2 : 1));
  });
}
