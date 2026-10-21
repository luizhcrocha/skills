/**
 * `fleet waste`: what a worker's transcript says it wasted (excess calls, polls, probes, bloated
 * context), as one record per worker. The fixtures under test/waste are small transcripts in Claude
 * Code's shape; every message, thinking block, command and tool result in them holds {@link SECRET},
 * which no output may carry.
 */
import * as fs from "node:fs";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { workerFigures, workerTitle } from "../src/transcripts.ts";
import { wasteOf, type WorkerWaste } from "../src/waste.ts";
import { baseEnv, fleet, tmp, type Environment } from "./support.ts";

const SECRET = "SECRET-VALUE-do-not-print";

const fixture = (name: string): string => new URL(`waste/${name}.jsonl`, import.meta.url).pathname;

function of(name: string): WorkerWaste {
  const got = wasteOf(fixture(name));

  if (got === undefined) throw new Error(`no record for ${name}`);

  return got;
}


/** One call of a made transcript: a Bash command, a Read of a path, or a call with this usage and no tool. */
type Made = { readonly bash: string } | { readonly read: string } | { readonly tool: string; readonly input: Record<string, string> } | { readonly usage: readonly [input: number, read: number, created: number] };

/** Bash calls, one per command. */
const sh = (...commands: string[]): Made[] => commands.map((bash) => ({ bash }));

/**
 * A transcript in Claude Code's shape with a call per use, run in `cwd`, each result a second after its use and
 * the next call a second later; its record read with `home` as HOME.
 */
function made(uses: readonly Made[], cwd = "/r", home = "/home/u"): WorkerWaste {
  const at = (s: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
  const lines: unknown[] = [{ type: "user", timestamp: at(0), message: { role: "user", content: `your id is w1, ${SECRET}` } }];

  uses.forEach((use, k) => {
    const usage = "usage" in use ? use.usage : [1, 1000, 10];
    const bash = "bash" in use ? use.bash : undefined;
    const read = "read" in use ? use.read : undefined;
    const named = "tool" in use ? { name: use.tool, input: use.input } : undefined;
    const tool = bash !== undefined ? { name: "Bash", input: { command: bash, description: SECRET } } : read === undefined ? named : { name: "Read", input: { file_path: read } };
    const content = tool === undefined ? [{ type: "text", text: SECRET }] : [{ type: "tool_use", id: `tu_${k}`, ...tool }];

    lines.push({
      type: "assistant",
      cwd,
      timestamp: at(2 * k + 1),
      message: { id: `msg_${k}`, role: "assistant", usage: { input_tokens: usage[0], cache_read_input_tokens: usage[1], cache_creation_input_tokens: usage[2], output_tokens: 5 }, content },
    });

    if (tool !== undefined) lines.push({ type: "user", timestamp: at(2 * k + 2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${k}`, content: SECRET }] } });
  });

  const path = join(tmp("waste-made-"), "agent-x.jsonl");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const got = wasteOf(path, home);

  if (got === undefined) throw new Error("no record for a made transcript");

  return got;
}

const SCRATCH = "/tmp/claude-1000/-home-u-repo/s1/scratchpad/rv-s2fix";

describe("a worker's waste, from its transcript", () => {
  test("a message streamed over several lines is one call", () => {
    expect(of("usage").calls).toBe(3);
  });

  test("its peak context is the largest input + cache read + cache creation of a call", () => {
    expect(of("usage").peak_context).toBe(160500);
  });

  test("calls past 150k and their share of the worker's cache read plus input", () => {
    const { past_cap } = of("usage");

    expect([past_cap.calls, past_cap.tokens]).toEqual([1, 160000]);
    expect(past_cap.share).toBeCloseTo(160000 / 161015, 6);
  });

  test("its cache hit ratio, and the calls that wrote more cache than they read", () => {
    const { cache } = of("usage");

    expect(cache.hit_ratio).toBeCloseTo(161000 / 164515, 6);
    expect(cache.misses).toBe(2);
  });

  test("one point per call: context, cache, latency since the result before it, tools", () => {
    expect(of("usage").series).toMatchObject([
      { index: 0, context: 1010, cache_read: 0, cache_creation: 1000, latency_ms: 2000, tools: ["Read"] },
      { index: 1, context: 160500, cache_read: 160000, cache_creation: 500, latency_ms: 2000, tools: ["Bash"] },
      { index: 2, context: 3005, cache_read: 1000, cache_creation: 2000, latency_ms: 4000, tools: [] },
    ]);
  });

  test("each call's share of context held by tool results, estimated at 4 characters a token", () => {
    const shares = of("usage").series.map((p) => p.tool_result_share);

    expect(shares[0]).toBe(0);
    expect(shares[1]).toBeCloseTo(1000 / 160500, 6);
    expect(shares[2]).toBeCloseTo(1100 / 3005, 6);
  });

  test("files read more than once: how many, the re-reads, the top 3 paths", () => {
    expect(of("reads").rereads).toEqual({
      files: 3,
      rereads: 4,
      top: [
        { path: "/r/a.ts", reads: 3 },
        { path: "/r/b.ts", reads: 2 },
        { path: "/r/d.ts", reads: 2 },
      ],
    });
  });

  test("cat, head, tail, sed -n and less on a file are reads, keyed as the Read tool's path", () => {
    expect(of("bashreads").rereads).toEqual({
      files: 3,
      rereads: 4,
      top: [
        { path: "/r/a.ts", reads: 3 },
        { path: "/r/b.ts", reads: 2 },
        { path: "/r/c.ts", reads: 2 },
      ],
    });
  });

  test("a Bash write ends the ramp: sed -i, a redirect outside /tmp and /dev, tee, patch, jj describe, commit and squash", () => {
    const forms = ["sed", "redirect", "append", "tee", "patch", "describe", "commit", "squash"];

    expect(forms.map((f) => [f, of(`bashwrite-${f}`).ramp])).toEqual(forms.map((f) => [f, { calls: 2, wrote: true }]));
    expect(of("bashreads").ramp).toEqual({ calls: 10, wrote: false });
  });

  test("the ramp is the calls before the first write", () => {
    expect(of("reads").ramp).toEqual({ calls: 7, wrote: true });
    expect(of("polls").ramp).toEqual({ calls: 4, wrote: true });
    expect(of("usage").ramp).toEqual({ calls: 3, wrote: false });
  });

  test("poll-like Bash waits: sleep loops, long sleeps, a read-only command repeated with no write between, and the seconds they held", () => {
    expect(of("polls").polls).toEqual({ calls: 3, seconds: 108, bash_seconds: 128 });
  });

  test("runs of 3 or more consecutive probe or screenshot calls", () => {
    expect(of("probes").probe_runs).toEqual({ runs: 2, calls: 7, seconds: 10 });
    expect(of("reads").probe_runs).toEqual({ runs: 0, calls: 0, seconds: 0 });
  });

  test("no transcript, or none with usage, is no record", () => {
    expect(wasteOf(join(tmp("waste-"), "agent-none.jsonl"))).toBeUndefined();
  });

  test("the record carries no message contents", () => {
    for (const name of ["usage", "reads", "polls", "probes", "bashreads", "bashwrite-redirect"]) expect(JSON.stringify(of(name))).not.toContain(SECRET);
  });
});


describe("what a Bash call wrote, read and waited on, as the shell reads it", () => {
  const wrote = (...commands: string[]): boolean => made(sh(...commands)).ramp.wrote;

  test("a redirect into a variable the line set is followed there: under /tmp it is no write, elsewhere it is", () => {
    expect(wrote(`P=${SCRATCH}; cat > $P/probe4.ts <<'EOF'\nconst a = 1 > 0;\nEOF`)).toBe(false);
    expect(wrote(`S=${SCRATCH}; cd /r && HOME=$S/home XDG_CACHE_HOME=$S/home/.cache bash -c 'mkdir -p "$HOME"' >$S/base.log 2>&1; echo rc=$? >>$S/base.log`)).toBe(false);
    expect(wrote(`export D=${SCRATCH}; mkdir -p $D; jj diff --git > \${D}/cloud.diff`)).toBe(false);
    expect(wrote("D=/r/out; cat a > $D/x")).toBe(true);
  });

  test("the Write, Edit and NotebookEdit tools on a path under /tmp are no write, as a Bash write there is not", () => {
    const tool = (name: string, key: string, path: string): Made => ({ tool: name, input: { [key]: path } });

    expect(made([tool("Write", "file_path", `${SCRATCH}/notes.md`), tool("Edit", "file_path", "/tmp/x.ts"), tool("NotebookEdit", "notebook_path", "/tmp/n.ipynb")]).ramp).toEqual({ calls: 3, wrote: false });
    expect(made([tool("Write", "file_path", `${SCRATCH}/notes.md`), tool("Edit", "file_path", "/r/src/a.ts")]).ramp).toEqual({ calls: 1, wrote: true });
    expect(made([tool("NotebookEdit", "notebook_path", "n.ipynb")]).ramp).toEqual({ calls: 0, wrote: true });
  });

  test("a redirect into a variable the line never set is unknown, and no write", () => {
    expect(wrote("cat a > $UNSET/out")).toBe(false);
    expect(wrote("cat a > $(pwd)/out")).toBe(false);
  });

  test("a leading ~ is HOME, for writes and for reads", () => {
    expect(wrote("echo x > ~/notes.md")).toBe(true);
    expect(made([...sh("cat ~/repos/a.ts"), { read: "/home/u/repos/a.ts" }]).rereads.top).toEqual([{ path: "/home/u/repos/a.ts", reads: 2 }]);
  });

  test("sed -i writes only when its file is outside /tmp and /dev, a cd to a set variable followed", () => {
    expect(wrote(`S=${SCRATCH}; cd $S && sed -i 's/status: "open",$/x/' probe.ts`)).toBe(false);
    expect(wrote("sed -i 's/a/b/' src/x.ts")).toBe(true);
    expect(wrote("cd /tmp/w && sed -i.bak -e 's/a/b/' x.ts")).toBe(false);
  });

  test('a \\" inside double quotes does not end them, so an operator after it stays quoted', () => {
    expect(wrote(String.raw`cd ~/repos/x; grep -n "const a\|case \"ops\"" e.ts; grep -n "error.status\|status >= 400" h.ts | head -3`)).toBe(false);
  });

  test("an unbalanced ' runs to the end of its line, not of the command", () => {
    expect(wrote("echo it's\necho x > out.txt")).toBe(true);
  });

  test("a redirect before the program is a write; one in a comment is not", () => {
    expect(wrote("> out.txt echo hi")).toBe(true);
    expect(wrote("ls # > out.txt")).toBe(false);
  });

  test("an fd redirect to a file writes it; one to another fd does not", () => {
    expect(wrote("make 2> err.log")).toBe(true);
    expect(wrote("make 2>/dev/null; make 2>&1 | tail; echo x >&2")).toBe(false);
    expect(wrote("make >& all.log")).toBe(true);
  });

  test("a here-string is not a heredoc: the lines after it are read", () => {
    expect(wrote("base64 -d <<< abc\necho x > out.txt")).toBe(true);
  });

  test("a cd to another directory keys the reads after it there", () => {
    expect(made([...sh("cd /other && cat a.ts"), { read: "/other/a.ts" }, ...sh("cat a.ts")]).rereads.top).toEqual([{ path: "/other/a.ts", reads: 2 }]);
  });

  test("a read's quoted path, and a $VAR path the line set, are keyed as the Read tool's", () => {
    expect(made([...sh(`cat "/r/my file.ts"`), { read: "/r/my file.ts" }, ...sh("S=/r; head -n 5 $S/b.ts"), { read: "/r/b.ts" }]).rereads.files).toBe(2);
  });

  test("sed -n -i is a write, not a read", () => {
    expect(made([...sh("sed -n -i 's/x/y/p' /r/c.ts"), { read: "/r/c.ts" }]).rereads.files).toBe(0);
  });

  test("a sleep, a loop or a probe word inside quotes or a heredoc body is no poll or probe", () => {
    expect(made(sh(`grep -n "while true; do sleep 60" a.ts`, `python3 - <<'EOF'\nimport time\nwhile True: time.sleep(60)\nEOF`)).polls.calls).toBe(0);
    expect(made(sh('grep -n "screenshot" a.ts', 'grep -n "a; curl -s" b.ts', "echo 'take a screenshot'")).probe_runs.runs).toBe(0);
  });

  test("a loop in a nested shell's script is a poll", () => {
    expect(made(sh(`timeout 590 bash -c 'while pgrep -f "scripts/gates changed" >/dev/null; do sleep 5; done'; cat /tmp/t.output`, "timeout 28 sh -c 'until grep -q done /tmp/m.tsv; do sleep 3; done'; tail -4 /tmp/m.tsv")).polls.calls).toBe(2);
  });

  test("tail -f after other options is a poll", () => {
    expect(made(sh("tail -n 20 -f /tmp/x.log", "tail -F log", "tail -n 5 file-f")).polls.calls).toBe(2);
  });

  test("a > inside quotes does not make a repeated command a mutation", () => {
    expect(made(sh('grep -c "a > b" f.ts', 'grep -c "a > b" f.ts')).polls.calls).toBe(1);
  });

  test("export sets a variable as a bare assignment does", () => {
    expect(wrote("export D=/r/out; cat a > $D/x")).toBe(true);
  });

  test("a variable reassigned to an unknown value is unknown after it", () => {
    expect(wrote("D=/r/out; D=$(pwd); cat a > $D/x")).toBe(false);
  });

  test("screenshot counts as a probe only as the program, not as an argument", () => {
    expect(made(sh("ls screenshot.png", "grep -n screenshot a.ts", "rm -f /tmp/screenshot-1.png")).probe_runs.runs).toBe(0);
    expect(made(sh("screenshot a.png", "gnome-screenshot -f b.png", "cd /r && ./bin/screenshot c.png")).probe_runs).toMatchObject({ runs: 1, calls: 3 });
  });

  test("a sleep after a loop's done is no loop poll; one inside it, or inside an outer loop, is", () => {
    expect(made(sh("for f in a b; do wc -l $f; done; sleep 5", "while read l; do echo $l; done < list; sleep 2")).polls.calls).toBe(0);
    expect(made(sh("for i in 1 2 3; do curl -s x; sleep 2; done", "while true; do for f in a; do wc -l $f; done; sleep 5; done")).polls.calls).toBe(2);
  });

  test("a > inside $(( )) is a comparison, not a redirect", () => {
    expect(wrote("echo $((a>b))")).toBe(false);
    expect(made(sh("echo $((a>b))", "echo $((a>b))")).polls.calls).toBe(1);
  });

  test("a cd inside ( ) does not carry on after the subshell", () => {
    expect(made([...sh("(cd /other && cat a.ts); cat a.ts"), { read: "/r/a.ts" }, { read: "/other/a.ts" }]).rereads.top).toEqual([
      { path: "/other/a.ts", reads: 2 },
      { path: "/r/a.ts", reads: 2 },
    ]);
    expect(made([...sh("(cd /other); (cat a.ts)"), { read: "/r/a.ts" }]).rereads.top).toEqual([{ path: "/r/a.ts", reads: 2 }]);
  });

  test("a call at exactly 150k is not past the cap, and one that created as much cache as it read is no miss", () => {
    const got = made([
      { usage: [0, 149_000, 1000] },
      { usage: [1, 149_000, 1000] },
      { usage: [0, 500, 500] },
    ]);

    expect([got.past_cap.calls, got.cache.misses]).toEqual([1, 0]);
  });
});

describe("fleet waste", () => {
  const PROJECT = "-home-x-repo";
  let root: string;
  let env: Environment;

  let config: string;

  /** A ledger in `dir` with these workers (id, task id), and DIR's `heartbeats/` and chat watch owner as given. */
  function ledgerIn(dir: string, workers: readonly (readonly [string, string?])[]): void {
    mkdirSync(dir, { recursive: true });

    const state = (...args: string[]): void => {
      expect(fleet(["state", dir, ...args, "--no-render"], env).code).toBe(0);
    };

    state("init", "--project", "p", "--goal", "g");
    state("milestone", "m1", "--title", "M");

    for (const [id, task] of workers) state("agent", id, "--task", "t", "--milestone", "m1", ...(task === undefined ? [] : ["--task-id", task]));
  }

  /** Add worker `id` with task id `task` to the ledger in `dir`. */
  function agentIn(dir: string, id: string, task: string): void {
    expect(fleet(["state", dir, "agent", id, "--task", "t", "--milestone", "m1", "--task-id", task, "--no-render"], env).code).toBe(0);
  }

  /** Put fixture `name` as subagent `task`'s transcript in session `session` of project `project`. */
  function transcript(project: string, session: string, task: string, name: string): void {
    const sub = join(config, "projects", project, session, "subagents");

    mkdirSync(sub, { recursive: true });
    copyFileSync(fixture(name), join(sub, `agent-${task}.jsonl`));
  }

  /** Record session `session` (pid 4242, its start `procStart`) as the owner of DIR's chat watch, the watch having
   * recorded `started`. */
  function owned(dir: string, session: string, started: string, procStart: string): void {
    writeFileSync(join(dir, "watch-coordinator.owner.pid"), JSON.stringify({ watch: 1, session: 4242, started }));
    mkdirSync(join(config, "sessions"), { recursive: true });
    writeFileSync(join(config, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: session, procStart }));
  }

  /** The workers `fleet waste DIR --json` gives rows for, in order. */
  function workers(dir: string): string[] {
    const ran = fleet(["waste", dir, "--json"], env);

    // SAFETY: `fleet waste --json` prints an array of rows that each name their worker.
    return (JSON.parse(ran.stdout) as { worker: string }[]).map((r) => r.worker);
  }

  beforeEach(() => {
    config = tmp("claude-");
    root = join(tmp("scratch-"), PROJECT, "s1", "scratchpad", "coordinator");
    env = baseEnv(tmp("fleet-home-"), { CLAUDE_CONFIG_DIR: config });
    transcript(PROJECT, "s1", "tu", "usage");
    transcript(PROJECT, "s1", "tp", "polls");
    ledgerIn(root, [["a-polls", "tp"], ["a-usage", "tu"], ["a-none"], ["a-lost", "gone"]]);
  });

  test("a transcript in another project's folder is never read", () => {
    transcript("-home-other", "s9", "gone", "usage");

    const ran = fleet(["waste", root, "--json"], env);

    // SAFETY: `fleet waste --json` prints an array of rows that each name their worker.
    expect((JSON.parse(ran.stdout) as { worker: string }[]).map((r) => r.worker)).toEqual(["a-usage", "a-polls"]);
  });

  test("a fleet with no known serving session gives no rows, and says so", () => {
    const moved = join(tmp("state-"), "fleet", "skills");

    ledgerIn(moved, [["a-usage", "tu"]]);

    const ran = fleet(["waste", moved], env);

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("no session known");
    expect(ran.stdout).not.toContain("a-usage ");
  });

  test("the sessions that beat for the fleet and its chat watch's owner serve it", () => {
    const moved = join(tmp("state-"), "fleet", "skills");

    ledgerIn(moved, [["a-usage", "tu"], ["a-polls", "tp"]]);
    transcript(PROJECT, "s7", "tu", "usage");
    transcript(PROJECT, "s8", "tp", "polls");
    mkdirSync(join(moved, "heartbeats"), { recursive: true });
    writeFileSync(join(moved, "heartbeats", "s7.tu.json"), JSON.stringify({ session: "s7", agent: "tu", at: "2026-10-01T12:00:00Z" }));
    owned(moved, "s8", "777", "777");

    expect(workers(moved)).toEqual(["a-usage", "a-polls"]);
  });

  test("a chat watch owner whose pid another process now holds (another start) serves nothing", () => {
    const moved = join(tmp("state-"), "fleet", "skills");

    ledgerIn(moved, [["a-polls", "tp"]]);
    transcript(PROJECT, "s8", "tp", "polls");
    owned(moved, "s8", "777", "778");

    expect(workers(moved)).toEqual([]);
  });

  test("a heartbeat's session in another project is followed, and nothing there is opened but its workers' transcripts", () => {
    const moved = join(tmp("state-"), "fleet", "skills");
    const projectOf = join(config, "projects", "-home-other");

    ledgerIn(moved, [["a-usage", "tu"]]);
    transcript("-home-other", "s9", "tu", "usage");
    transcript("-home-other", "s9", "tz", "polls");
    writeFileSync(join(projectOf, "s9", "subagents", "agent-tu.meta.json"), JSON.stringify({ name: SECRET }));
    mkdirSync(join(projectOf, "s9", "tool-results"), { recursive: true });
    writeFileSync(join(projectOf, "s9", "tool-results", "r.txt"), SECRET);
    writeFileSync(join(projectOf, "s9.jsonl"), `${JSON.stringify({ type: "user", message: { content: `unrelated work ${SECRET}` } })}\n`);
    mkdirSync(join(moved, "heartbeats"), { recursive: true });
    writeFileSync(join(moved, "heartbeats", "s9.tu.json"), JSON.stringify({ session: "s9", agent: "tu", at: "2026-10-01T12:00:00Z" }));

    const spies = [spyOn(fs, "readFileSync"), spyOn(fs, "readdirSync"), spyOn(fs, "openSync"), spyOn(fs, "opendirSync")];

    try {
      expect(workers(moved)).toEqual(["a-usage"]);
      const touched = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).filter((p) => p.includes("/-home-other/"));

      expect(touched.length).toBeGreaterThan(0);
      expect(touched.filter((p) => !p.endsWith("/-home-other/s9/subagents/agent-tu.jsonl"))).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test("a session folder or subagents/ that resolves outside its project is refused, even when subagents/ leads back in", () => {
    const projects = join(config, "projects");

    agentIn(root, "a-dir", "t6");
    agentIn(root, "a-sub", "t5");
    transcript("-home-other", "s9", "t6", "usage");
    transcript("-home-other", "s8", "t5", "usage");
    symlinkSync(join(projects, "-home-other", "s9"), join(projects, PROJECT, "s6"));
    mkdirSync(join(projects, PROJECT, "s5"), { recursive: true });
    symlinkSync(join(projects, "-home-other", "s8", "subagents"), join(projects, PROJECT, "s5", "subagents"));
    agentIn(root, "a-back", "t4");
    transcript(PROJECT, "s3", "t4", "usage");
    mkdirSync(join(projects, "-home-other", "s4x"), { recursive: true });
    symlinkSync(join(projects, PROJECT, "s3", "subagents"), join(projects, "-home-other", "s4x", "subagents"));
    symlinkSync(join(projects, "-home-other", "s4x"), join(projects, PROJECT, "s4"));
    mkdirSync(join(root, "heartbeats"), { recursive: true });
    writeFileSync(join(root, "heartbeats", "s4.t4.json"), JSON.stringify({ session: "s4", agent: "t4", at: "2026-10-01T12:00:00Z" }));
    writeFileSync(join(root, "heartbeats", "s6.t6.json"), JSON.stringify({ session: "s6", agent: "t6", at: "2026-10-01T12:00:00Z" }));
    writeFileSync(join(root, "heartbeats", "s5.t5.json"), JSON.stringify({ session: "s5", agent: "t5", at: "2026-10-01T12:00:00Z" }));

    expect(workers(root)).toEqual(["a-usage", "a-polls"]);
  });

  test("a task id that is not a plain id is never made into a path", () => {
    transcript("-home-other", "s9", "gone", "usage");
    agentIn(root, "a-evil", "x/../../../../-home-other/s9/subagents/agent-gone");

    expect(workers(root)).toEqual(["a-usage", "a-polls"]);
  });

  test("a symlinked transcript is not followed", () => {
    const sub = join(config, "projects", PROJECT, "s1", "subagents");

    transcript("-home-other", "s9", "gone", "usage");
    symlinkSync(join(config, "projects", "-home-other", "s9", "subagents", "agent-gone.jsonl"), join(sub, "agent-tl.jsonl"));
    agentIn(root, "a-link", "tl");

    expect(workers(root)).toEqual(["a-usage", "a-polls"]);
  });

  test("a worker's title and figures refuse a task id that is not a plain id", () => {
    const folder = join(config, "projects", PROJECT, "s1");

    mkdirSync(join(folder, "x"), { recursive: true });
    writeFileSync(join(folder, "x", "agent-y.meta.json"), JSON.stringify({ name: "elsewhere" }));
    copyFileSync(fixture("usage"), join(folder, "x", "agent-y.jsonl"));

    expect(workerTitle([folder], "/../../x/agent-y")).toBeUndefined();
    expect(workerFigures(root, config, "/../../x/agent-y")).toBeUndefined();
  });

  test("one row per worker with a task id and a transcript, worst first", () => {
    const ran = fleet(["waste", root], env);
    const rows = ran.stdout.split("\n").filter((l) => l.startsWith("a-"));

    expect(ran.code).toBe(0);
    expect(rows.map((l) => l.split(/\s+/)[0])).toEqual(["a-usage", "a-polls"]);
    expect(ran.stdout).toContain("a-lost");
    expect(ran.stdout).not.toContain(SECRET);
  });

  test("--json gives each worker's record with its series", () => {
    const ran = fleet(["waste", root, "--json"], env);
    // SAFETY: `fleet waste --json` prints an array of its rows, each a worker, its task id and its record (src/cli/waste.ts).
    const got = JSON.parse(ran.stdout) as { worker: string; task_id: string; waste: WorkerWaste }[];

    expect(got.map((r) => [r.worker, r.task_id, r.waste.series.length])).toEqual([
      ["a-usage", "tu", 3],
      ["a-polls", "tp", 11],
    ]);
    expect(ran.stdout).not.toContain(SECRET);
  });

  test("a worker id narrows to that worker, and names its re-read paths", () => {
    const ran = fleet(["waste", root, "a-polls"], env);

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("a-polls");
    expect(ran.stdout).not.toContain("a-usage");
  });

  test("an unknown worker is refused", () => {
    const ran = fleet(["waste", root, "nobody"], env);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("nobody");
  });
});
