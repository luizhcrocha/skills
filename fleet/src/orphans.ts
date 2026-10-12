/**
 * Orphaned test and dev processes: a suite, a dev server or a headless browser whose session went away
 * and left it running, adopted by PID 1 or by `systemd --user` (a subreaper). Claude Code's Bash tool runs a
 * background job as `zsh -c ...`; when the session or the job's runner dies, that shell and what it started
 * keep going for hours, holding memory nobody frees. The hub reports them on the manager's page, with the
 * session and fleet that started them, and stops one only when Luiz clicks its Stop: never on its own.
 *
 * Stop must never reach an interactive program or a live session, so a tree is reported only when nothing in it
 * is a terminal, a multiplexer, an editor or an interactive shell (matched by the program's own name, never by an
 * argument), no process in it belongs to a session whose leader is alive on a terminal, and no process in it
 * carries a live Claude Code session's id. Stop signals the reported tree's own processes, never a process group.
 *
 * `orphansIn` is pure: it reads a process table ({@link ProcRow}), so a test hands it a fake one. The
 * readers fill the table from /proc (Linux) or `ps` (the Mac, without environment or cwd).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import * as Option from "effect/Option";

import { readBeats } from "./heartbeat.ts";
import { asString, parseObject } from "./json.ts";
import { readRecord } from "./preview/record.ts";
import { exists, readText } from "./files.ts";
import { elapsedOf } from "./procs.ts";
import type { Entry } from "./registry.ts";

/** One process as the report reads it. */
export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  /** When it started, in epoch seconds. */
  readonly started: number;
  /** Its resident memory in KiB. */
  readonly rss: number;
  /** Its short name (/proc/PID/comm). */
  readonly comm: string;
  /** Its arguments joined by spaces. */
  readonly command: string;
  /** The binary it runs, when known (/proc/PID/exe). */
  readonly exe?: string | undefined;
  /** Its working directory, when known. */
  readonly cwd?: string | undefined;
  /** `$CLAUDE_CODE_SESSION_ID` in its environment: the session whose Bash tool started it. */
  readonly session?: string | undefined;
  /** `$FLEET_DIR` in its environment. */
  readonly fleetDir?: string | undefined;
  /** The session folder whose `tasks/` it writes into (a background job's output file), when it does. */
  readonly tasks?: string | undefined;
  /** Its session id (/proc/PID/stat), when known: the pid of its session's leader. */
  readonly sid?: number | undefined;
  /** Its controlling terminal (/proc/PID/stat's tty_nr; on the Mac 1 for any), 0 for none, when known. */
  readonly tty?: number | undefined;
}

/** A heartbeat as the report reads it: which fleet a session, and a working directory, belong to. */
export interface BeatOf {
  readonly fleet: string;
  readonly session: string;
  readonly cwd: string | null;
}

/** One orphaned process tree. */
export interface Orphan {
  /** The tree's root: the process PID 1 or the subreaper adopted. */
  readonly pid: number;
  /** The root's start, in epoch seconds: Stop acts only on the same process. */
  readonly started: number;
  /** The test or dev command in the tree: the root's when it is one, else the first one under it. */
  readonly command: string;
  /** Seconds since the root started. */
  readonly age: number;
  /** The whole tree's resident memory in KiB. */
  readonly rss: number;
  /** Every pid in the tree, root first. */
  readonly pids: readonly number[];
  readonly cwd: string | null;
  /** The jj workspace or git checkout the cwd is in. */
  readonly workspace: string | null;
  /** The session that started it, from its environment or its task file. */
  readonly session: string | null;
  /** That session's fleet, or the fleet whose heartbeats name its cwd. */
  readonly fleet: string | null;
}

/** How old a tree must be to be reported, by default: a suite or a dev server outliving its session this long is no run in progress. */
export const DEFAULT_MIN_HOURS = 2;

/** `$FLEET_ORPHAN_HOURS` as seconds, else {@link DEFAULT_MIN_HOURS}. */
export function minAgeOf(env: (name: string) => string | undefined): number {
  const hours = Number(env("FLEET_ORPHAN_HOURS"));

  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MIN_HOURS) * 3600;
}

/** Interpreters whose script names the program: `node .../vitest.mjs`, `python3 -m pytest`, `sh .../vitest`. */
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|sh|bash|zsh|dash)$/;

/** The words of a command line. */
function wordsOf(command: string): string[] {
  return command.split(/\s+/).filter((w) => w !== "");
}

/** The script an interpreter row runs (its first argument that is no option), or `-m`'s module; else undefined. */
function scriptOf(row: ProcRow): { readonly path: string; readonly options: readonly string[] } | undefined {
  const words = wordsOf(row.command);

  if (!INTERPRETERS.test(basename(words[0] ?? "")) && !INTERPRETERS.test(row.comm)) return undefined;
  const options: string[] = [];

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? "";

    if (word === "-c" || word === "-e" || word === "--eval") return undefined;

    if (word === "-m") return words[i + 1] === undefined ? undefined : { path: words[i + 1] ?? "", options };

    if (!word.startsWith("-")) return { path: word, options };
    options.push(word);
  }

  return undefined;
}

/** The names `row`'s program goes by: its comm, its argv[0] and exe basenames, and an interpreter's script's.
 * Never an argument's: an editor opened on `node_modules/vitest/...` is an editor. */
export function programNames(row: ProcRow): string[] {
  const first = wordsOf(row.command)[0] ?? "";
  const script = scriptOf(row);
  const names = [row.comm, basename(first), basename(row.exe ?? ""), script === undefined ? "" : basename(script.path)];

  return [...new Set(names.flatMap((n) => (n === "" || n === "-" ? [] : [n.replace(/^-/, "")])))];
}

const SUITE_PROGRAMS = new Set(["vitest", "vitest.mjs", "vitest.js", "pytest", "py.test", "pnpm", "pnpm.cjs", "pnpm.mjs", "pnpm.js", "vp", "bun_files.py", "unittest_shards.py", "gates"]);

const BROWSERS = /^(chrome|chromium|chromium-browser|google-chrome.*|headless_shell|chrome-headless-shell)$/;

/** Whether `row` runs a suite, a dev server's package manager or a headless browser, by its program's name. */
export function isTestOrDev(row: ProcRow): boolean {
  const names = programNames(row);
  const words = wordsOf(row.command);
  const script = scriptOf(row);

  if (names.some((n) => SUITE_PROGRAMS.has(n))) return true;

  if (script !== undefined && /\/node_modules\/vitest\//.test(script.path)) return true;

  if (names.includes("bun") && words[1] === "test") return true;

  if (names.some((n) => n === "node" || n === "nodejs") && (script?.options ?? words.slice(1)).includes("--test")) return true;

  return names.some((n) => BROWSERS.test(n)) && words.some((w) => w === "--headless" || w.startsWith("--headless="));
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "nu"]);

/** Terminals, multiplexers and editors, by program name: a tree holding one is someone's session, never an orphan. */
const INTERACTIVE = /^(foot|footclient|ghostty|alacritty|kitty|wezterm|wezterm-gui|wezterm-mux-server|tmux|tmux: server|tmux: client|zellij|nvim|vim|vi|view|emacs|emacs-[\d.]+|emacsclient|code|code-oss|codium|code-insiders)$/;

/** Whether `command` is a shell running a command line (`zsh -c ...`): how a Bash tool's job runs, never an interactive shell. */
export function isShellRun(command: string): boolean {
  const [first = "", ...rest] = wordsOf(command);

  return SHELLS.has(basename(first).replace(/^-/, "")) && rest.some((w) => /^-[a-z]*c[a-z]*$/.test(w));
}

/** Whether `row` is a terminal, a multiplexer, an editor or an interactive shell (one with neither `-c` nor a
 * script, or with `-i`), by its program's name. */
export function isInteractive(row: ProcRow): boolean {
  const names = programNames(row);

  if (names.some((n) => INTERACTIVE.test(n))) return true;
  const [first = "", ...rest] = wordsOf(row.command);

  if (!SHELLS.has(basename(first).replace(/^-/, "")) && !SHELLS.has(row.comm.replace(/^-/, ""))) return false;

  if (rest.includes("-i") || first.startsWith("-")) return true;

  return !isShellRun(row.command) && !rest.some((w) => !w.startsWith("-"));
}

/** Whether `row` is Claude Code: named `claude`, or the native install's `claude/versions/<version>`. */
export function isClaude(row: ProcRow): boolean {
  const first = row.command.split(/\s+/)[0] ?? "";

  return row.comm === "claude" || [row.exe ?? "", first].some((p) => /\/claude\/versions\/[^/]+$/.test(p) || basename(p) === "claude");
}

/** Whether `row` adopts orphans: PID 1, or a `systemd --user` manager (a subreaper), or the Mac's launchd. */
export function isReaper(row: ProcRow | undefined, pid: number): boolean {
  if (pid === 1) return true;

  return row !== undefined && (row.comm === "systemd" || row.comm === "launchd");
}

/** Whether a process of `tree` is in a session whose leader is alive on a terminal (the Mac, without session ids:
 * whether it has a terminal itself). */
function onATerminal(tree: readonly ProcRow[], byPid: ReadonlyMap<number, ProcRow>): boolean {
  return tree.some((r) => {
    if (r.sid === undefined) return (r.tty ?? 0) !== 0;
    const leader = r.sid > 0 ? byPid.get(r.sid) : undefined;

    return leader !== undefined && (leader.tty ?? 0) !== 0;
  });
}

/** The session a row belongs to: its `$CLAUDE_CODE_SESSION_ID`, else the session folder its task file is in. */
function sessionOf(row: ProcRow): string | undefined {
  return row.session ?? row.tasks?.split("/").at(-1);
}

/** The command a shell wrapper runs: `eval '...'`'s text, as procs.ts reads a background job. */
function unwrapped(command: string): string {
  return /eval '([^']*)'/.exec(command)?.[1] ?? command;
}

/** Every pid under `pid` (it included, first), breadth first. */
export function treeOf(pid: number, children: ReadonlyMap<number, readonly number[]>): number[] {
  const out = [pid];

  for (let i = 0; i < out.length; i += 1) for (const kid of children.get(out[i] ?? 0) ?? []) if (!out.includes(kid)) out.push(kid);

  return out;
}

/** pid -> its children's pids. */
export function childrenOf(rows: readonly ProcRow[]): Map<number, number[]> {
  const kids = new Map<number, number[]>();

  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);

  return kids;
}

/** An orphaned tree before its owner is looked up: its root, its rows, the test or dev row in it. */
export interface OrphanTree {
  readonly root: ProcRow;
  readonly tree: readonly ProcRow[];
  readonly hit: ProcRow;
}

/** The orphaned trees in `rows` at `now` (epoch seconds) at least `minAge` seconds old. A root is a process a
 * reaper adopted, with no Claude Code above it, that is itself a test or dev process or a shell running a
 * command line, and whose tree holds a test or dev process. Never reported: a tree holding a terminal, a
 * multiplexer, an editor or an interactive shell (a dev server Luiz started in one), a tree in a session whose
 * leader is alive on a terminal, a tree carrying a session id in `liveSessions` (a live Claude Code session's
 * job), and a root in `exempt` (a served fleet's preview dev server, which runs detached on purpose). */
export function orphansIn(rows: readonly ProcRow[], now: number, minAge: number, exempt: ReadonlySet<number> = new Set(), liveSessions: ReadonlySet<string> = new Set()): OrphanTree[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const kids = childrenOf(rows);
  const found: OrphanTree[] = [];

  for (const root of rows) {
    if (root.pid === 1 || isReaper(root, root.pid) || !isReaper(byPid.get(root.ppid), root.ppid)) continue;

    if (isClaude(root) || exempt.has(root.pid) || now - root.started < minAge) continue;
    const rootIsHit = isTestOrDev(root);

    if (!rootIsHit && !isShellRun(root.command)) continue;
    const tree = treeOf(root.pid, kids).flatMap((pid) => byPid.get(pid) ?? []);

    if (tree.some((r) => isClaude(r) || isInteractive(r)) || onATerminal(tree, byPid)) continue;

    if (tree.some((r) => liveSessions.has(sessionOf(r) ?? ""))) continue;
    const hit = rootIsHit ? root : tree.find(isTestOrDev);

    if (hit !== undefined) found.push({ root, tree, hit });
  }

  return found.sort((a, b) => a.root.started - b.root.started);
}

/** The jj workspace or git checkout holding `path`: the nearest directory with `.jj` or `.git`. */
export function workspaceOf(path: string): string | null {
  for (let at = path; at !== "" && at !== "/"; at = dirname(at)) if (exists(join(at, ".jj")) || exists(join(at, ".git"))) return at;

  return null;
}

/** The fleet `session` belongs to: the registry entry recording it, or whose DIR is in that session's scratchpad
 * (`<project>/<session>/scratchpad/<name>`); else a fleet one of whose heartbeats is that session's. */
export function fleetOfSession(session: string, entries: readonly Entry[], beats: readonly BeatOf[]): string | null {
  const recorded = entries.find((e) => e.raw["session_id"] === session) ?? entries.find((e) => basename(dirname(dirname(e.dir))) === session);

  return recorded?.id ?? beats.find((b) => b.session === session)?.fleet ?? null;
}

/** The fleet whose heartbeats ran in `cwd`, in its workspace `workspace`, or in the deepest directory above it;
 * `home`, a directory above it, and `/` name no fleet. */
export function fleetOfCwd(cwd: string, workspace: string | null, beats: readonly BeatOf[], home: string = process.env["HOME"] ?? ""): string | null {
  const exact = beats.find((b) => b.cwd === cwd);

  if (exact !== undefined) return exact.fleet;

  if (workspace !== null) {
    const inside = beats.find((b) => b.cwd !== null && (b.cwd === workspace || b.cwd.startsWith(`${workspace}/`)));

    if (inside !== undefined) return inside.fleet;
  }

  const above = beats
    .flatMap((b) => (b.cwd !== null && b.cwd !== "/" && b.cwd !== home && !home.startsWith(`${b.cwd}/`) && cwd.startsWith(`${b.cwd}/`) ? [{ fleet: b.fleet, depth: b.cwd.length }] : []))
    .sort((a, b) => b.depth - a.depth);

  return above[0]?.fleet ?? null;
}

/** The report of one found tree at `now`: who started it, from the tree's environment, task files and cwd. */
export function describe(f: OrphanTree, now: number, entries: readonly Entry[], beats: readonly BeatOf[], workspace: (cwd: string) => string | null = workspaceOf): Orphan {
  const session = f.tree.find((r) => r.session !== undefined)?.session ?? (f.tree.find((r) => r.tasks !== undefined)?.tasks?.split("/").at(-1) ?? null);
  const dirFleet = f.tree.find((r) => r.fleetDir !== undefined)?.fleetDir;
  const given = f.hit.cwd ?? f.root.cwd;
  const cwd = given === undefined ? null : given.replace(/ \(deleted\)$/, "");
  const where = cwd === null ? null : workspace(cwd);
  const byDir = dirFleet === undefined ? undefined : entries.find((e) => e.dir === dirFleet)?.id;
  const fleet = (session === null ? null : fleetOfSession(session, entries, beats)) ?? byDir ?? (cwd === null ? null : fleetOfCwd(cwd, where, beats));

  return {
    pid: f.root.pid,
    started: f.root.started,
    command: [...unwrapped(f.hit.command)].slice(0, 300).join(""),
    age: Math.max(0, Math.round(now - f.root.started)),
    rss: f.tree.reduce((n, r) => n + r.rss, 0),
    pids: f.tree.map((r) => r.pid),
    cwd,
    workspace: where,
    session,
    fleet,
  };
}

/** The heartbeats of every fleet in `entries`, as {@link BeatOf}. */
export function beatsOf(entries: readonly Entry[]): BeatOf[] {
  return entries.flatMap((e) => readBeats(e.dir).map((b) => ({ fleet: e.id, session: b.session, cwd: b.cwd })));
}

// -- reading the process table --------------------------------------------------------------------------

const DARWIN = process.platform === "darwin";

const PAGE_KIB = 4;

const TICKS = 100;

function bootTime(): number | undefined {
  const boot = Number(/^btime (\d+)/m.exec(readText("/proc/stat") ?? "")?.[1]);

  return Number.isNaN(boot) ? undefined : boot;
}

/** One /proc entry's basic row (no environment, fd or cwd), or undefined when it is gone. */
function linuxRow(pid: number, boot: number): ProcRow | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();

    return { pid, ppid: Number(rest[1]), started: boot + Number(rest[19]) / TICKS, rss: Number(rest[21]) * PAGE_KIB, comm, command, sid: Number(rest[3]), tty: Number(rest[4]) };
  } catch {
    return undefined;
  }
}

/** The facts only a tree under suspicion needs: its exe, cwd, environment and task files. */
function linuxDetails(row: ProcRow): ProcRow {
  const at = `/proc/${row.pid}`;

  const link = (path: string): string | undefined => {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  };

  let env: string[] = [];

  try {
    env = readFileSync(`${at}/environ`).toString("utf8").split("\0");
  } catch {
    // another user's process, or gone
  }

  const value = (name: string): string | undefined => env.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1) || undefined;
  let tasks: string | undefined;

  try {
    for (const fd of readdirSync(`${at}/fd`)) {
      const target = link(`${at}/fd/${fd}`) ?? "";
      const m = /^(.*)\/tasks\/[^/]+$/.exec(target);

      if (m?.[1] !== undefined) {
        tasks = m[1];
        break;
      }
    }
  } catch {
    // no access to its fds
  }

  return { ...row, exe: link(`${at}/exe`), cwd: link(`${at}/cwd`), session: value("CLAUDE_CODE_SESSION_ID"), fleetDir: value("FLEET_DIR"), tasks };
}

/** Every process of the machine, from /proc. */
function linuxTable(): ProcRow[] {
  const boot = bootTime();

  if (boot === undefined) return [];

  return readdirSync("/proc").flatMap((name) => (/^\d+$/.test(name) ? (linuxRow(Number(name), boot) ?? []) : []));
}

/** Every process of the Mac, from `ps -o pid=,ppid=,rss=,etime=,tty=,ucomm=,command=` (no environment, cwd or
 * session id; a terminal shows as tty 1, none as 0). */
export function psTable(text: string, now: number): ProcRow[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);

    if (m === null) return [];
    const elapsed = elapsedOf(m[4] ?? "");

    if (Number.isNaN(elapsed)) return [];
    const tty = m[5] === "??" || m[5] === "-" ? 0 : 1;

    return [{ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), started: now - elapsed, tty, comm: basename(m[6] ?? ""), command: (m[7] ?? "").trim() }];
  });
}

/** The machine's process table now; `detailed` fills the environment, cwd and task files of the pids it names. */
export function processTable(detailed: (rows: readonly ProcRow[]) => ReadonlySet<number> = () => new Set()): ProcRow[] {
  if (DARWIN) {
    const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,etime=,tty=,ucomm=,command="], { encoding: "utf8", timeout: 10000 });

    return psTable(ps.stdout ?? "", Date.now() / 1000);
  }

  const rows = linuxTable();
  const wanted = detailed(rows);

  return rows.map((r) => (wanted.has(r.pid) ? linuxDetails(r) : r));
}

/** The pids of the preview dev servers and updaters the served fleets in `live` run: detached on purpose, they
 * outlive the command that started them, and `fleet preview stop` stops them. */
export function previewPids(live: readonly Entry[]): Set<number> {
  return new Set(
    live.flatMap((e) => {
      const record = readRecord(e.dir);

      return record === undefined ? [] : [record.server?.pid ?? null, record.updater, ...record.workers.map((w) => w.pid)].flatMap((p) => (p === null ? [] : [p]));
    }),
  );
}

/** The session ids of the Claude Code processes running in `rows`, from Claude Code's live record of each
 * (`<config>/sessions/<pid>.json`). */
export function liveSessionsOf(rows: readonly ProcRow[], config: string): Set<string> {
  return new Set(
    rows.filter(isClaude).flatMap((r) => {
      const text = readText(join(config, "sessions", `${String(r.pid)}.json`));
      const record = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));
      const id = asString(record?.["sessionId"]);

      return id === undefined || id === "" ? [] : [id];
    }),
  );
}

/** The orphaned trees of this machine now, each with its owner. `known` is every fleet the registry knows, its
 * served ones first (`Registry.known`): only a served fleet's previews are exempt. `config` is Claude Code's
 * config folder, whose `sessions/` names the live sessions. */
export function orphansNow(known: readonly Entry[], live: readonly Entry[], minAge: number, config: string): Orphan[] {
  const now = Date.now() / 1000;
  const exempt = previewPids(live);
  const rows = processTable((basic) => new Set(orphansIn(basic, now, minAge, exempt).flatMap((f) => f.tree.map((r) => r.pid))));
  const beats = beatsOf(known);

  return orphansIn(rows, now, minAge, exempt, liveSessionsOf(rows, config)).map((f) => describe(f, now, known, beats));
}

// -- stopping one ---------------------------------------------------------------------------------------

/** What a Stop did: the pids signalled, and those still there after the KILL; or why it did nothing. */
export type Stopped = { readonly stopped: readonly number[]; readonly left: readonly number[] } | { readonly why: string };

/** How long a stopped tree has between TERM and KILL. */
export const STOP_GRACE_MS = 3000;

function signal(target: number, name: NodeJS.Signals): void {
  try {
    process.kill(target, name);
  } catch {
    // gone already, or not ours
  }
}

/** Whether `pid` still runs as the process `started` named (not a zombie, not a reused pid). */
function same(pid: number, started: number | undefined, table: readonly ProcRow[]): boolean {
  const row = table.find((r) => r.pid === pid);

  if (row === undefined) return false;

  if (!DARWIN) {
    const stat = readText(`/proc/${pid}/stat`) ?? "";

    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
  }

  return started === undefined || Math.abs(row.started - started) < 1;
}

/** TERM every process of a tree (the pids, collected first), then KILL what is left after `graceMs`. Only these
 * processes, each while it is still the same one: never a process group, which may reach outside the tree.
 * `table` reads the process table again, for what is left. */
export async function stopTree(pids: readonly ProcRow[], graceMs = STOP_GRACE_MS, table: () => ProcRow[] = () => processTable()): Promise<{ readonly stopped: number[]; readonly left: number[] }> {
  const first = table();

  for (const r of pids) if (r.pid > 1 && same(r.pid, r.started, first)) signal(r.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let rest = pids.filter((r) => same(r.pid, r.started, table()));

  while (rest.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    const now = table();
    rest = rest.filter((r) => same(r.pid, r.started, now));
  }

  for (const r of rest) if (r.pid > 1) signal(r.pid, "SIGKILL");

  if (rest.length > 0) await Bun.sleep(200);
  const after = table();

  return { stopped: pids.map((r) => r.pid), left: rest.filter((r) => same(r.pid, r.started, after)).map((r) => r.pid) };
}

/** Stop the orphaned tree whose root is `pid`, started at `started`: only while it is still reported (an
 * orphan, old enough, the same process), so a pid reused since the page was drawn is never hit. */
export async function stopOrphan(pid: number, started: number, minAge: number, exempt: ReadonlySet<number>, rows: () => ProcRow[] = () => processTable(), liveSessions: (rows: readonly ProcRow[]) => ReadonlySet<string> = () => new Set()): Promise<Stopped> {
  const now = Date.now() / 1000;
  const table = rows();
  const found = orphansIn(table, now, minAge, exempt, liveSessions(table)).find((f) => f.root.pid === pid);

  if (found === undefined) return { why: `process ${pid} is no orphaned test or dev process now; nothing was stopped` };

  if (Math.abs(found.root.started - started) >= 1) return { why: `process ${pid} is not the one the page showed (it started at another time); nothing was stopped` };

  return stopTree(found.tree, STOP_GRACE_MS, rows);
}
