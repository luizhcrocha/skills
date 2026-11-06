/**
 * `fleet fleets gate hogs|reap`: what holds the memory a waiter needs, and what may lose it. A pure core over a
 * {@link Snapshot}: {@link judge} groups the machine's process trees by owner and gives each group a verdict, and only
 * a `reap` verdict makes a {@link Killable}. A tree with a dead owner, big, idle and every process of a kind known to
 * rebuild itself or a small helper, is reaped; anything else is reported, for its owner to be asked. No answer, file or
 * flag makes a kill: an agent that wants one stopped asks through the permission path, as a `kill` call of its own.
 * Containers, whose processes no tree of an agent holds, are judged by their compose folder (reaper-containers.ts).
 * reaper-read.ts reads the machine and signals it; this file only decides.
 */
import { basename } from "node:path";

import { stampOf } from "./clock.ts";
import type { Standing } from "./gate.ts";
import { ContainerKillable, containerOwnerText, containerWhere, judgeContainers, type ContainerIo, type ContainerRow, type JudgedContainer } from "./reaper-containers.ts";
import { isClaude, isInteractive, isReaper, onATerminal, sessionOf, stopTree, workspaceOf, type ProcRow } from "./orphans.ts";

export const DEFAULT_MIN_RSS = 256 * 1024 ** 2;

export const DEFAULT_IDLE_S = 15 * 60;

export interface Thresholds {
  readonly minRss: number;
  readonly idleS: number;
}

export const DEFAULTS: Thresholds = { minRss: DEFAULT_MIN_RSS, idleS: DEFAULT_IDLE_S };

/** Resident set and swap in kB a small helper may hold and still not count as what its tree is. */
const KIND_BOUND_KB = 32 * 1024;

export type Owner =
  | { readonly kind: "session"; readonly id: string; readonly live: boolean; readonly tty: number | undefined }
  | { readonly kind: "gate"; readonly unit: string; readonly hold: string }
  | { readonly kind: "unit"; readonly unit: string }
  | { readonly kind: "terminal"; readonly leader: number }
  | { readonly kind: "unknown" };

/** One owner's processes as the reaper sees them: the unit of a report and a kill. */
export interface Group {
  /** Stable across reports while the same processes live: `<owner>-<id>:<root pid>:<root started>`. */
  readonly key: string;
  readonly owner: Owner;
  /** Each tree root first, as `orphans.ts` orders one; every row carries its start, so a kill can check pid reuse. */
  readonly procs: readonly ProcRow[];
  /** Resident set in bytes. */
  readonly rss: number;
  /** Seconds since any of its threads last ran; 0 when one has no reading. */
  readonly idleS: number;
  readonly what: string;
  readonly cwd: string | undefined;
  readonly workspace: string | undefined;
}

export type NeverWhy = "claude session" | "chat watch" | "fleet host" | "1password" | "owner app" | "jj/git in flight" | "live gate scope" | "mcp under live session" | "interactive" | "outside app.slice" | "exempt";

/** The decision, with its reason, encoded so a kill can only take a `reap`. */
export type Verdict =
  | { readonly kind: "never"; readonly why: NeverWhy }
  | { readonly kind: "ask"; readonly why: "owner live" | "owner unknown" | `not a known rebuildable kind: ${string}` | `nothing over the bound: ${string}` }
  | { readonly kind: "reap"; readonly why: { readonly idleS: number; readonly rss: number } }
  | { readonly kind: "skip"; readonly why: "small" | "busy" };

export interface Judged {
  readonly group: Group;
  readonly verdict: Verdict;
}

export interface Report {
  readonly at: string;
  readonly groups: readonly Judged[];
  /** The running containers, judged by where their compose project sits. */
  readonly containers: readonly JudgedContainer[];
  readonly free: { readonly available: number; readonly total: number; readonly floor: number };
  /** Bytes `reap` would free, and bytes held by groups to ask about: the two numbers a waiter prints. */
  readonly reapable: number;
  readonly held: number;
}

/** Everything the classifier needs, read once under the gate's lock so a report and a kill see one world. */
export interface Snapshot {
  readonly rows: readonly ProcRow[];
  /** /proc/PID/cgroup's path. A pid with none is outside the slice, so never. */
  readonly cgroupOf: ReadonlyMap<number, string>;
  /** VmSwap in kB. A pid with none counts as big: a small reading must be a reading. */
  readonly swapOf: ReadonlyMap<number, number>;
  /** Seconds since the process's threads last ran. A pid with none counts as busy. */
  readonly idleOf: ReadonlyMap<number, number>;
  readonly liveSessions: ReadonlySet<string>;
  /** Each live Claude's workspace, else its cwd; never `/` or the home directory. */
  readonly liveWorkspaces: ReadonlySet<string>;
  /** Each live Claude's session id, by pid, from Claude Code's own record of it. */
  readonly recordOf: ReadonlyMap<number, string>;
  /** When each session's transcript was last written, epoch seconds, where one was found. */
  readonly transcriptAt: ReadonlyMap<string, number>;
  /** The holds' systemd units, each to its holder's name. */
  readonly gateUnits: ReadonlyMap<string, string>;
  /** A served fleet's preview pids, this process and its ancestors, the holds' and the waiters' pids. */
  readonly exempt: ReadonlySet<number>;
  /** The running containers; none where docker is absent, refused or slow. */
  readonly containers: readonly ContainerRow[];
  readonly meminfo: { readonly available: number; readonly total: number };
  readonly now: number;
}

/** The units every pane of Rex shares: being in one names no owner. */
const SHARED_UNITS: ReadonlySet<string> = new Set(["rex.service"]);

/** Programs of the owner's day: a browser's content processes and comms as `comm` shows them, at most 15 characters. */
const OWNER_APPS: ReadonlySet<string> = new Set(["slack", "helium", "zen", "op", "1password", "1Password-Brows", "rex", "Web Content", "Isolated Web Co", "chromium", "chrome", "firefox", ".chrome-wrapped"]);

/** The comms a Playwright browser runs as. The owner's browser reads the same: its temp profile is what tells them apart. */
const BROWSER_COMMS: ReadonlySet<string> = new Set(["chromium", "chrome", "firefox", ".chrome-wrapped", "headless_shell", "chrome-headless", "Web Content", "Isolated Web Co"]);

const PLAYWRIGHT = "playwright browser";

/** What a process below the bound may be and not count as work: a shell, a wrapper, a browser's or runner's helper. */
const SMALL_HELPERS: ReadonlySet<string> = new Set(["bash", "sh", "dash", "zsh", "fish", "nu", "env", "timeout", "nice", "ionice", "nohup", "setsid", "flock", "tee", "cat", "sleep", "xargs", "just", "pnpm", "npm", "esbuild", "chrome_crashpad"]);

/** The comm of a process Node or Bun runs: Node's main thread names itself, and a title reads as one. */
const RUNTIME_COMM = /^(?:\.?(?:node|nodejs|bun)(?:-wrapped)?|MainThread|node \(vitest.*)$/;

const isInterpreter = (word: string): boolean => /^\.?(?:node|nodejs|bun)(?:-wrapped)?$/.test(basename(word));

const wordsOf = (r: ProcRow): readonly string[] => (r.argv !== undefined && r.argv.length > 0 ? r.argv : r.command.split(/\s+/));

/** Node's options that take the next word as their value. */
const NODE_VALUE_FLAG = /^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions)$/;

/** Node's options after which no script names what the process runs. */
const NODE_EVAL_FLAG = /^(?:-e|--eval|-p|--print)$/;

/** What the row runs, from its script on: an interpreter and its options dropped. Empty when no script says. */
function runWords(r: ProcRow): readonly string[] {
  const words = wordsOf(r);

  if (!isInterpreter(words[0] ?? "")) return words;

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? "";

    if (NODE_EVAL_FLAG.test(word)) return [];

    if (NODE_VALUE_FLAG.test(word)) i += 1;
    else if (!word.startsWith("-")) return words.slice(i);
  }

  return [];
}

/** The options a test runner or a language server starts with, none of which loads code or eats the next word. */
const PLAIN_OPTION = /^--(?:experimental-import-meta-resolve|experimental-vm-modules|no-warnings|no-deprecation|enable-source-maps|disable-warning=\S+|conditions=\S+|max-old-space-size=\d+|max-semi-space-size=\d+|stack-size=\d+)$/;

/** The one preload a kind runs under: Vitest's own, from its own package. */
const SUPPRESS_WARNINGS = /(?:^|\/)node_modules\/vitest\/suppress-warnings\.cjs$/;

/** The script Node or Bun really runs and its arguments, when the comm agrees and only known options come before it.
 * Any other option may load code (`-r`, `--import`) or take the script's place as its value, so it says nothing. */
function packagedRun(r: ProcRow): readonly string[] {
  const words = wordsOf(r);

  if (!RUNTIME_COMM.test(r.comm) || !isInterpreter(words[0] ?? "")) return [];

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? "";
    const next = words[i + 1] ?? "";

    if ((word === "--require" && SUPPRESS_WARNINGS.test(next)) || word === "--conditions" || word === "-C") i += 1;
    else if (!word.startsWith("-")) return words.slice(i);
    else if (!PLAIN_OPTION.test(word)) return [];
  }

  return [];
}

/** Each kind's scripts in their real package layout: a `.bin` link, or the package's own file. A folder named `vitest`
 * or a script named `tsserver` elsewhere is someone's own program. */
const PACKAGED: readonly (readonly [RegExp, string])[] = [
  [/(?:^|\/)node_modules\/(?:\.bin\/vitest|vitest\/(?:vitest\.mjs|dist\/\S+\.js))$/, "vitest"],
  [/(?:^|\/)node_modules\/(?:\.bin\/jest|jest\/bin\/jest\.js|jest-cli\/bin\/jest\.js)$/, "jest"],
  [/(?:^|\/)node_modules\/(?:\.bin\/tsserver|typescript\/lib\/(?:_?tsserver|typingsInstaller)\.js)$/, "tsserver"],
  [/(?:^|\/)node_modules\/(?:\.bin\/typescript-language-server|typescript-language-server\/lib\/cli\.mjs|\.bin\/vtsls|@vtsls\/language-server\/bin\/vtsls\.js)$/, "typescript language server"],
];

const JEST_WORKER = /(?:^|\/)node_modules\/jest-worker\/build\/\S+\.js$/;

/** The rebuildable kind a process is: its comm agrees with its argv, and a script sits in its package's own layout. A
 * test runner and its workers, a TypeScript server, a stdio `devenv mcp`, a Playwright browser on a temp profile. Each
 * comes back when asked for, and losing one loses no work. Undefined for anything else, which a kill refuses. */
function kindOf(r: ProcRow): string | undefined {
  if (/^node \(vitest(?: \d+)?\)$/.test(r.command) && RUNTIME_COMM.test(r.comm)) return "vitest";
  const words = wordsOf(r);
  const first = basename(words[0] ?? "");

  if (/^\.?bun(?:-wrapped)?$/.test(first) && /^\.?bun(?:-wrapped)?$/.test(r.comm) && words[1] === "test") return "bun test";

  if (/^\.?devenv(?:-wrapped)?$/.test(first) && /^\.?devenv(?:-wrapped)?$/.test(r.comm) && words[1] === "mcp" && words.length === 2) return "devenv mcp";

  if (BROWSER_COMMS.has(r.comm) && /(?:^|\s)(?:--user-data-dir=|-profile\s+)\S*\/playwright_[a-z]+dev_profile-\S*/.test(words.join(" "))) return PLAYWRIGHT;
  const [script = "", sub] = packagedRun(r);

  if (/(?:^|\/)node_modules\/(?:\.bin\/vp|vite-plus\/bin\/vp)$/.test(script) && sub === "test") return "vp test";

  return PACKAGED.find(([path]) => path.test(script))?.[1];
}

/** The comms of a Playwright browser's own children, beyond its main process's. */
const BROWSER_CHILD_COMMS: ReadonlySet<string> = new Set([...BROWSER_COMMS, "Socket Process", "RDD Process", "Utility Process", "WebExtensions", "Privileged Cont"]);

/** Each row of a tree (parents first) to its kind. A Playwright browser's own children go with it, and a jest worker
 * with the jest above it; nothing else inherits, since what a server starts may be anyone's work. */
function kindsOf(tree: readonly ProcRow[]): Map<number, string | undefined> {
  const kinds = new Map<number, string | undefined>();

  for (const r of tree) {
    const parent = kinds.get(r.ppid);
    const own = kindOf(r);
    const inherited = (parent === PLAYWRIGHT && BROWSER_CHILD_COMMS.has(r.comm)) || (parent === "jest" && JEST_WORKER.test(packagedRun(r)[0] ?? ""));

    kinds.set(r.pid, own ?? (inherited ? parent : undefined));
  }

  return kinds;
}

/** A browser on a Playwright temp profile reads as an owner's browser but is the run's. */
function isOwnerApp(r: ProcRow, kinds: ReadonlyMap<number, string | undefined>): boolean {
  return OWNER_APPS.has(r.comm) && !(BROWSER_COMMS.has(r.comm) && kinds.get(r.pid) === PLAYWRIGHT);
}

/** The `mcp` of a server: in its program or script's own name, or its subcommand. A folder in a path says nothing. */
function isMcp(r: ProcRow): boolean {
  const words = wordsOf(r);

  return words[1] === "mcp" || [words[0] ?? "", runWords(r)[0] ?? ""].some((word) => /mcp/i.test(basename(word)));
}

const unitOf = (cgroup: string | undefined): string | undefined => /\/([^/]+\.(?:service|scope))$/.exec(cgroup ?? "")?.[1];

const scopeName = (unit: string | undefined): string | undefined => unit?.replace(/\.(?:service|scope)$/, "");

/** What the never-list reads of one tree. */
interface Seen {
  readonly procs: readonly ProcRow[];
  readonly owner: Owner;
  readonly cgroups: readonly (string | undefined)[];
  readonly snap: Snapshot;
}

/** The never-list. Order matters: the first match names the reason. Fixed in code; no flag widens it. */
const NEVER: readonly { readonly why: NeverWhy; readonly test: (s: Seen) => boolean }[] = [
  { why: "exempt", test: (s) => s.procs.some((r) => s.snap.exempt.has(r.pid)) },
  { why: "outside app.slice", test: (s) => s.cgroups.some((cg) => cg?.includes("/app.slice/") !== true) },
  { why: "live gate scope", test: (s) => s.cgroups.some((cg) => /\/fleet-gate-[^/]+\.scope$/.test(cg ?? "") || s.snap.gateUnits.has(scopeName(unitOf(cg)) ?? "")) },
  { why: "fleet host", test: (s) => s.cgroups.some((cg) => /\/fleet-[^/]*\.service$|\/fleet-preview-[^/]*\.scope$/.test(cg ?? "")) },
  { why: "1password", test: (s) => s.cgroups.some((cg) => cg?.endsWith("/1password.service") === true) },
  { why: "claude session", test: (s) => s.procs.some(isClaude) },
  { why: "chat watch", test: (s) => s.procs.some((r) => /main\.ts chat( |$)/.test(r.command)) },
  { why: "interactive", test: (s) => s.procs.some(isInteractive) || s.owner.kind === "terminal" },
  { why: "owner app", test: (s) => {
    const kinds = kindsOf(s.procs);

    return s.procs.some((r) => isOwnerApp(r, kinds) || /main\.ts (?:host|serve)( |$)/.test(r.command));
  } },
  { why: "jj/git in flight", test: (s) => s.procs.some((r) => /^(?:jj|git)$/.test(r.comm)) },
  { why: "mcp under live session", test: (s) => s.owner.kind === "session" && s.owner.live && s.procs.some(isMcp) },
];

const byPidOf = (rows: readonly ProcRow[]): Map<number, ProcRow> => new Map(rows.map((r) => [r.pid, r]));

/** A Claude at or above `row`: the live session whose child it is, whatever id its environment still carries. */
function claudeAbove(row: ProcRow, byPid: ReadonlyMap<number, ProcRow>): ProcRow | undefined {
  const seen = new Set<number>();

  for (let at: ProcRow | undefined = row; at !== undefined && !seen.has(at.pid); at = byPid.get(at.ppid)) {
    if (isClaude(at)) return at;
    seen.add(at.pid);
  }

  return undefined;
}

function leaderOf(tree: readonly ProcRow[], byPid: ReadonlyMap<number, ProcRow>): number | undefined {
  for (const r of tree) {
    if (r.sid === undefined && (r.tty ?? 0) !== 0) return r.pid;
    const leader = r.sid !== undefined && r.sid > 0 ? byPid.get(r.sid) : undefined;

    if (leader !== undefined && (leader.tty ?? 0) !== 0) return leader.pid;
  }

  return undefined;
}

/** The session a resumed Claude's argv names. A flag after `-r` is no id: `-r` alone opens the picker. */
export function resumedIn(command: string): string | undefined {
  return /(?:^|\s)(?:--resume|-r)[= ]([^\s-]\S*)/.exec(command)?.[1];
}

/** Whether a tree runs where a live Claude works: in its workspace, or in a folder of its session. Its Bash jobs may
 * carry another id, or their cwd may be the only thing left that says whose they are. */
function runsWhereLive(tree: readonly ProcRow[], snap: Snapshot): boolean {
  return tree.some((r) => {
    const cwd = r.cwd?.replace(/ \(deleted\)$/, "");

    return cwd !== undefined && livesAt(cwd, snap);
  });
}

/** Whether a live Claude works at `path`: in a live workspace, or in a folder of a live session. */
function livesAt(path: string, snap: Snapshot): boolean {
  return [...snap.liveWorkspaces].some((w) => path === w || path.startsWith(`${w}/`)) || path.split("/").some((segment) => snap.liveSessions.has(segment));
}

/** Pure. Owner of a tree: a held gate unit, else a Claude above it (live), else the session id it carries (live when
 * any id it carries is in `liveSessions`, or it runs where a live Claude works), else a sid leader on a terminal, else
 * a named unit, else unknown. */
export function ownerOf(tree: readonly ProcRow[], snap: Snapshot): Owner {
  const byPid = byPidOf(snap.rows);
  const cgroups = tree.map((r) => snap.cgroupOf.get(r.pid));

  for (const cg of cgroups) {
    const unit = scopeName(unitOf(cg));
    const hold = unit === undefined ? undefined : snap.gateUnits.get(unit);

    if (unit !== undefined && hold !== undefined) return { kind: "gate", unit, hold };
  }

  const ids = tree.flatMap((r) => sessionOf(r) ?? []);
  const carried = ids.at(0);
  const claude = tree[0] === undefined ? undefined : claudeAbove(tree[0], byPid);

  if (claude !== undefined) {
    const own = sessionOf(claude) ?? snap.recordOf.get(claude.pid) ?? resumedIn(claude.command) ?? `claude-${String(claude.pid)}`;

    return { kind: "session", id: carried ?? own, live: true, tty: (claude.tty ?? 0) === 0 ? undefined : claude.tty };
  }

  if (carried !== undefined) return { kind: "session", id: carried, live: ids.some((id) => snap.liveSessions.has(id)) || runsWhereLive(tree, snap), tty: undefined };
  const leader = leaderOf(tree, byPid);

  if (leader !== undefined) return { kind: "terminal", leader };
  const unit = cgroups.map(unitOf).find((u) => u !== undefined && !SHARED_UNITS.has(u));

  return unit === undefined ? { kind: "unknown" } : { kind: "unit", unit };
}

function slugOf(owner: Owner): string {
  switch (owner.kind) {
    case "session": return `session-${owner.id}`;
    case "gate": return `gate-${owner.unit}`;
    case "unit": return `unit-${owner.unit}`;
    case "terminal": return `terminal-${String(owner.leader)}`;
    case "unknown": return "unknown";
  }
}

/** The program a row runs, as a person names it: the script it was handed, else its binary. */
function programOf(r: ProcRow): string {
  const kind = kindOf(r);

  if (kind !== undefined) return kind;
  const script = /(\S+\.(?:ts|mjs|cjs|js|py))(?: |$)/.exec(r.command)?.[1];

  return script === undefined ? r.comm : basename(script);
}

/** The biggest process's program, with how many of the group run it. Never its arguments: this goes on a report. */
function whatOf(procs: readonly ProcRow[]): string {
  const biggest = procs.reduce<ProcRow | undefined>((best, r) => (best === undefined || r.rss > best.rss ? r : best), undefined);

  if (biggest === undefined) return "";
  const name = programOf(biggest);
  const many = procs.filter((r) => programOf(r) === name).length;

  return many > 1 ? `${name} x${String(many)}` : name;
}

/** The trees of the table: a tree breaks at Claude and under it, under a reaper, and at a sid leader on a terminal.
 * The reapers themselves and the kernel's threads are no one's to judge. */
function treesOf(rows: readonly ProcRow[]): ProcRow[][] {
  const byPid = byPidOf(rows);
  const mine = rows.filter((r) => !isReaper(r, r.pid) && r.pid !== 2 && r.ppid !== 2 && r.pid !== 0);

  const isRoot = (r: ProcRow): boolean => {
    const parent = byPid.get(r.ppid);

    return parent === undefined || isReaper(parent, r.ppid) || isClaude(parent) || isClaude(r) || (r.sid === r.pid && (r.tty ?? 0) !== 0);
  };

  const kids = new Map<number, ProcRow[]>();

  for (const r of mine) if (!isRoot(r)) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);

  return mine.flatMap((root) => {
    if (!isRoot(root)) return [];
    const tree = [root];

    for (let i = 0; i < tree.length; i += 1) tree.push(...(kids.get(tree[i]?.pid ?? -1) ?? []));

    return [tree];
  });
}

function groupOf(trees: readonly (readonly ProcRow[])[], owner: Owner, snap: Snapshot): Group {
  const procs = trees.flat();
  const root = procs[0];
  const cwd = procs.find((r) => r.cwd !== undefined)?.cwd?.replace(/ \(deleted\)$/, "");
  const readings = procs.map((r) => snap.idleOf.get(r.pid));

  return {
    key: `${slugOf(owner)}:${String(root?.pid)}:${String(root?.started)}`,
    owner,
    procs,
    rss: procs.reduce((n, r) => n + r.rss * 1024, 0),
    idleS: readings.every((s) => s !== undefined) ? Math.min(...readings.map((s) => s ?? 0)) : 0,
    what: whatOf(procs),
    cwd,
    workspace: cwd === undefined ? undefined : workspaceOf(cwd) ?? undefined,
  };
}

/** What keeps a tree of one dead owner from a kill unasked, if anything: more than one id, or a root with none, says
 * the id is not the tree's. Every process must be a rebuildable kind, or a small helper, counting what it has swapped
 * out: a 1G job on a full swap reads as 28M resident. And something must be big enough to say what the tree is. */
function unknownIn(tree: readonly ProcRow[], snap: Snapshot): Verdict | undefined {
  const root = tree[0];

  if (root === undefined || sessionOf(root) === undefined || new Set(tree.flatMap((r) => sessionOf(r) ?? [])).size > 1) return { kind: "ask", why: "owner unknown" };
  const kinds = kindsOf(tree);
  const held = (r: ProcRow): number => r.rss + (snap.swapOf.get(r.pid) ?? Number.POSITIVE_INFINITY);
  const big = [...tree].sort((a, b) => held(b) - held(a) || b.rss - a.rss);
  const unknown = big.find((r) => kinds.get(r.pid) === undefined && !(held(r) <= KIND_BOUND_KB && SMALL_HELPERS.has(r.comm)));

  if (unknown !== undefined) return { kind: "ask", why: `not a known rebuildable kind: ${programOf(unknown)}` };

  return big.some((r) => held(r) > KIND_BOUND_KB) ? undefined : { kind: "ask", why: `nothing over the bound: ${whatOf(tree)}` };
}

function verdictOf(group: Group, cgroups: readonly (string | undefined)[], tree: readonly ProcRow[], snap: Snapshot, t: Thresholds): Verdict {
  const never = NEVER.find((rule) => rule.test({ procs: group.procs, owner: group.owner, cgroups, snap }));

  if (never !== undefined) return { kind: "never", why: never.why };

  if (group.rss < t.minRss) return { kind: "skip", why: "small" };
  const owner = group.owner;

  if (owner.kind !== "session") return { kind: "ask", why: "owner unknown" };

  if (owner.live) return { kind: "ask", why: "owner live" };

  const wrote = snap.transcriptAt.get(owner.id);

  if ((wrote !== undefined && snap.now - wrote < t.idleS) || onATerminal(tree, byPidOf(snap.rows))) return { kind: "ask", why: "owner unknown" };
  const unknown = unknownIn(tree, snap);

  if (unknown !== undefined) return unknown;

  if (group.idleS < t.idleS) return { kind: "skip", why: "busy" };

  return { kind: "reap", why: { idleS: group.idleS, rss: group.rss } };
}

/** Whether trees of one owner under this verdict are one group. Only hogs merge, so a small shell stays out of a
 * kill; a never tree stays alone, and an unknown owner is no owner to merge under. */
function merges(j: Judged): boolean {
  if (j.group.owner.kind === "unknown") return false;

  return j.verdict.kind === "reap" || j.verdict.kind === "ask" || (j.verdict.kind === "skip" && j.verdict.why === "busy");
}

/** Pure. Groups the table's trees by owner, judges each, sums the two numbers. The only function that makes a Verdict. */
export function judge(snap: Snapshot, t: Thresholds, floor: number): Report {
  const merged = new Map<string, { trees: (readonly ProcRow[])[]; first: Judged }>();
  const groups: (Judged | { readonly slot: string })[] = [];

  for (const tree of treesOf(snap.rows)) {
    const owner = ownerOf(tree, snap);
    const group = groupOf([tree], owner, snap);
    const j: Judged = { group, verdict: verdictOf(group, tree.map((r) => snap.cgroupOf.get(r.pid)), tree, snap, t) };

    if (!merges(j)) {
      groups.push(j);
      continue;
    }

    const slot = `${slugOf(owner)}|${j.verdict.kind}`;
    const open = merged.get(slot);

    if (open === undefined) {
      merged.set(slot, { trees: [tree], first: j });
      groups.push({ slot });
    } else {
      open.trees.push(tree);
    }
  }

  const final = groups.map((g): Judged => {
    if (!("slot" in g)) return g;
    // SAFETY: the loop above put every group's slot in `merged`.
    const { trees, first } = merged.get(g.slot) as { trees: (readonly ProcRow[])[]; first: Judged };

    if (trees.length === 1) return first;
    const group = groupOf(trees, first.group.owner, snap);

    return { group, verdict: first.verdict.kind === "reap" ? { kind: "reap", why: { idleS: group.idleS, rss: group.rss } } : first.verdict };
  });

  const containers = judgeContainers(snap.containers, (path) => livesAt(path, snap), t, snap.now);

  const sum = (kind: "reap" | "ask"): number =>
    final.reduce((n, j) => n + (j.verdict.kind === kind ? j.group.rss : 0), 0) + containers.reduce((n, j) => n + (j.verdict.kind === kind ? j.container.rss : 0), 0);

  return { at: stampOf(new Date(snap.now * 1000)), groups: final, containers, free: { ...snap.meminfo, floor }, reapable: sum("reap"), held: sum("ask") };
}

/** What a kill may touch: a `reap` group. Nothing else makes one. */
export class Killable {
  readonly group: Group;

  private constructor(group: Group) {
    this.group = group;
  }

  static ofReap(j: Judged): Killable | undefined {
    return j.verdict.kind === "reap" ? new Killable(j.group) : undefined;
  }
}

/** One process, as a kill names it: a pid with its start, so a reused pid is not it. */
export interface PidStart {
  readonly pid: number;
  readonly started: number;
}

/** The audit log's lines. A `kill` is on disk before the first signal; it holds the program's `comm` and kind, never an argument. */
export type AuditLine =
  | { readonly line: "kill"; readonly at: string; readonly key: string; readonly owner: Owner; readonly what: string; readonly comm: string; readonly cwd: string | undefined; readonly pids: readonly PidStart[]; readonly rss: number }
  | { readonly line: "report"; readonly at: string; readonly reapable: number; readonly held: number; readonly groups: readonly { readonly key: string; readonly verdict: Verdict["kind"]; readonly rss: number }[] }
  | { readonly line: "reaped"; readonly at: string; readonly key: string; readonly stopped: readonly number[]; readonly left: readonly number[]; readonly reused: readonly number[]; readonly freed: number }
  | { readonly line: "container"; readonly at: string; readonly key: string; readonly id: string; readonly name: string; readonly dir: string | undefined; readonly rss: number }
  | { readonly line: "removed"; readonly at: string; readonly key: string; readonly id: string; readonly stopped: boolean; readonly removed: boolean; readonly freed: number };

export interface AuditLog {
  readonly append: (line: AuditLine) => void;
}

/** The signals and the re-read, as the shell provides them; a test hands a fake that records calls. */
export interface KillIo {
  readonly signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
  readonly table: () => readonly ProcRow[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly record: (line: AuditLine) => void;
  readonly now: () => string;
  /** `docker stop` and `docker rm`, volumes kept. */
  readonly docker: ContainerIo;
}

export interface Reaped {
  readonly key: string;
  readonly stopped: readonly number[];
  readonly left: readonly number[];
  readonly reused: readonly number[];
  readonly freed: number;
}

/** A reaped container: stopped, then removed, its volumes kept. */
export interface Removed {
  readonly key: string;
  readonly name: string;
  readonly stopped: boolean;
  readonly removed: boolean;
  readonly freed: number;
}

/** Record a container's stop before it is asked for. Throws when it cannot be written. */
function recordContainer(k: ContainerKillable, io: KillIo): void {
  const { key, container } = k.judged;
  const place = container.place;

  io.record({ line: "container", at: io.now(), key, id: container.id, name: container.name, dir: place.kind === "unlabeled" ? undefined : place.dir, rss: container.rss });
}

/** `docker stop`, then `docker rm` once it stopped: never `-v`, so its volumes, and the data `docker compose up` finds
 * again, stay. */
function removeContainer(k: ContainerKillable, io: KillIo): Removed {
  const { key, container } = k.judged;
  const stopped = io.docker.stop(container.id);
  const removed = stopped && io.docker.remove(container.id);
  const freed = stopped ? container.rss : 0;

  io.record({ line: "removed", at: io.now(), key, id: container.id, stopped, removed, freed });

  return { key, name: container.name, stopped, removed, freed };
}

/** The processes of a group, as a kill names them. */
export function pidsOf(group: Group): PidStart[] {
  return group.procs.map((r) => ({ pid: r.pid, started: r.started }));
}

/** Record a kill's attempt. Throws when it cannot be written, and no signal goes before this returned. */
function recordKill(k: Killable, io: KillIo): void {
  const { group } = k;
  const biggest = group.procs.reduce<ProcRow | undefined>((best, r) => (best === undefined || r.rss > best.rss ? r : best), undefined);

  io.record({ line: "kill", at: io.now(), key: group.key, owner: group.owner, what: group.what, comm: biggest?.comm ?? "", cwd: group.cwd, pids: pidsOf(group), rss: group.rss });
}

/** TERM a recorded group's pids with each root last, wait `graceMs`, KILL what is left, re-read. */
async function signalGroup(k: Killable, io: KillIo, graceMs?: number): Promise<Reaped> {
  const { group } = k;
  const done = await stopTree([...group.procs].reverse(), graceMs, io);
  const gone = new Set(done.stopped.filter((pid) => !done.left.includes(pid)));
  const freed = group.procs.reduce((n, r) => n + (gone.has(r.pid) ? r.rss * 1024 : 0), 0);

  io.record({ line: "reaped", at: io.now(), key: group.key, stopped: done.stopped, left: done.left, reused: done.reused, freed });

  return { key: group.key, stopped: done.stopped, left: done.left, reused: done.reused, freed };
}

/** Kill one group: record the attempt, then signal it. */
export async function reapGroup(k: Killable, io: KillIo, graceMs?: number): Promise<Reaped> {
  recordKill(k, io);

  return signalGroup(k, io, graceMs);
}

/** Bytes as a report prints them. */
export function bytesText(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}G` : `${String(Math.round(n / 1024 ** 2))}M`;
}

function idleText(s: number): string {
  return s >= 3600 ? `${String(Math.round(s / 3600))}h` : `${String(Math.round(s / 60))}m`;
}

function ownerText(owner: Owner): string {
  switch (owner.kind) {
    case "session": return owner.live ? `session ${owner.id} (live)` : `owner gone (session ${owner.id})`;
    case "gate": return `gate ${owner.hold}`;
    case "unit": return owner.unit;
    case "terminal": return `terminal ${String(owner.leader)}`;
    case "unknown": return "owner unknown";
  }
}

export interface ReapWorld {
  readonly gate: { readonly whileLocked: <T>(now: () => Date, body: (standing: Standing) => Promise<T>) => Promise<T> };
  readonly read: (standing: Standing) => Snapshot | Promise<Snapshot>;
  readonly io: KillIo;
  readonly floor: number;
  readonly graceMs?: number;
}

export interface ReapOutcome {
  readonly report: Report;
  readonly reaped: readonly Reaped[];
  readonly removed: readonly Removed[];
}

/** `gate reap`: a fresh report, then its kills, all with the gate's lock held: a run admitted between the two would
 * have its hold's unit unread and its processes unknown. Every `reap` group, and nothing else. Every kill is on disk
 * before the first signal to any group; a kill of one group does not wait on another's grace. */
export function reapNow(w: ReapWorld): Promise<ReapOutcome> {
  return w.gate.whileLocked(() => new Date(w.io.now()), async (standing) => {
    const report = judge(await w.read(standing), DEFAULTS, w.floor);
    const killable = report.groups.flatMap((j) => Killable.ofReap(j) ?? []);
    const stoppable = report.containers.flatMap((j) => ContainerKillable.ofReap(j) ?? []);

    for (const k of killable) recordKill(k, w.io);

    for (const k of stoppable) recordContainer(k, w.io);
    const reaped = Promise.all(killable.map((k) => signalGroup(k, w.io, w.graceMs)));
    const removed = stoppable.map((k) => removeContainer(k, w.io));

    return { report, reaped: await reaped, removed };
  });
}

/** What a waiter short on memory adds to its wait line, from the same report; undefined when nothing helps. */
export function waiterClause(report: Report): string | undefined {
  const reap = [...report.groups.filter((j) => j.verdict.kind === "reap"), ...report.containers.filter((j) => j.verdict.kind === "reap")];
  const asks = report.groups.filter((j) => j.verdict.kind === "ask");
  const size = bytesText(report.reapable);

  const free = reap.length === 0 ? [] : [reap.length === 1 ? `1 orphaned group holds ${size} that \`fleet fleets gate reap\` would free` : `${String(reap.length)} orphaned groups hold ${size} that \`fleet fleets gate reap\` would free`];
  const biggest = [...asks].sort((a, b) => b.group.rss - a.group.rss)[0];
  const owner = biggest === undefined ? [] : [`${bytesText(biggest.group.rss)}${reap.length === 0 ? "" : " more"} is ${biggest.group.owner.kind === "session" ? `session ${biggest.group.owner.id}` : ownerText(biggest.group.owner)}'s: ask them (\`fleet fleets gate hogs\` says what it is)`];
  const said = [...free, ...owner];

  return said.length === 0 ? undefined : said.join("; ");
}

const NEVER_WORDS: Readonly<Record<NeverWhy, string>> = {
  "claude session": "Claude sessions",
  "chat watch": "chat watches",
  "fleet host": "fleet services",
  "1password": "1Password",
  "owner app": "owner apps",
  "jj/git in flight": "jj or git",
  "live gate scope": "gate scopes",
  "mcp under live session": "MCP servers",
  interactive: "interactive",
  "outside app.slice": "outside app.slice",
  exempt: "exempt",
};

/** What an `ask` row says after its group: whose it is to decide. */
function askText(why: Extract<Verdict, { kind: "ask" }>["why"]): string {
  return why === "owner live" || why === "owner unknown" ? "held by a live or unknown owner: ask them" : `${why}: ask them`;
}

/** The report in lines: what `reap` would kill, what to ask an owner about, one line each for never, skip and memory, and
 * a line when `t` is not what `gate reap` judges at, since then its `reap` lines are not what it would do. */
export function reportText(report: Report, t: Thresholds): string[] {
  const row = (j: Judged, tail: string): string => {
    const where = j.group.workspace ?? j.group.cwd;

    return `${j.verdict.kind.padEnd(6)} ${bytesText(j.group.rss).padStart(6)}  idle ${idleText(j.group.idleS).padEnd(4)} ${ownerText(j.group.owner).padEnd(36)} ${j.group.what}${where === undefined ? "" : `  ${where}`}${tail}  ${j.group.key}`;
  };

  const tally = (rows: readonly { readonly word: string; readonly rss: number }[]): string =>
    [...new Set(rows.map((r) => r.word))].map((word) => {
      const same = rows.filter((r) => r.word === word);

      return `${bytesText(same.reduce((n, r) => n + r.rss, 0))} ${word} x${String(same.length)}`;
    }).join("; ");

  const never = report.groups.flatMap((j) => (j.verdict.kind === "never" ? [{ word: NEVER_WORDS[j.verdict.why], rss: j.group.rss }] : []));

  const skip = [
    ...report.groups.flatMap((j) => (j.verdict.kind === "skip" ? [{ word: j.verdict.why, rss: j.group.rss }] : [])),
    ...report.containers.flatMap((j) => (j.verdict.kind === "skip" ? [{ word: `${j.verdict.why} container`, rss: j.container.rss }] : [])),
  ];

  const boxed = (j: JudgedContainer, tail: string): string => {
    const where = containerWhere(j.container);

    return `${j.verdict.kind.padEnd(6)} ${bytesText(j.container.rss).padStart(6)}  up   ${idleText(j.ageS).padEnd(4)} ${containerOwnerText(j).padEnd(36)} container ${j.container.name}${where === undefined ? "" : `  ${where}`}${tail}  ${j.key}`;
  };

  return [
    ...report.groups.filter((j) => j.verdict.kind === "reap").map((j) => row(j, "")),
    ...report.containers.filter((j) => j.verdict.kind === "reap").map((j) => boxed(j, "  docker stop, then rm; volumes kept")),
    ...report.groups.flatMap((j) => (j.verdict.kind === "ask" ? [row(j, `  ${askText(j.verdict.why)}`)] : [])),
    ...report.containers.flatMap((j) => (j.verdict.kind === "ask" ? [boxed(j, `  ${j.verdict.why}: ask them`)] : [])),
    ...(never.length === 0 ? [] : [`never  ${tally(never)}`]),
    ...(skip.length === 0 ? [] : [`skip   ${tally(skip)}`]),
    `free   ${bytesText(report.free.available)} of ${bytesText(report.free.total)} available; floor ${bytesText(report.free.floor)}`,
    ...(t.minRss === DEFAULTS.minRss && t.idleS === DEFAULTS.idleS ? [] : [`note   judged at ${bytesText(t.minRss)} and ${idleText(t.idleS)}: \`gate reap\` judges at ${bytesText(DEFAULTS.minRss)} and ${idleText(DEFAULTS.idleS)}, so it may not do these reap lines`]),
  ];
}
