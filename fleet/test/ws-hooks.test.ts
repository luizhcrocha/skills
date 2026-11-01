/**
 * `fleet ws`'s hooks, against throwaway jj repos: the ws-add hook that prepares a new workspace, and the lifecycle hooks
 * that gate add and the move to the trash. The rest of `fleet ws` is ws.test.ts.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject, type JsonObject } from "../src/json.ts";
import { wsId } from "../src/ws/hook.ts";
import { FLEET, fleet, fleetAsync } from "./support.ts";
import { base, dir, env, freshRepo, jj, lastEvent, makeTemplate, moreEnv, repo, state, work, workspaces } from "./ws-support.ts";

// Each test runs jj as a subprocess, up to 51 times: ws.test.ts has the numbers.
setDefaultTimeout(60_000);

beforeAll(makeTemplate);

beforeEach(freshRepo);

describe("the ws-add hook: the repo prepares each new workspace", () => {
  /** The repo's own hook, `.fleet/ws-add`, as this shell script, made executable. */
  function hook(script: string): string {
    const at = join(repo, ".fleet", "ws-add");
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    writeFileSync(at, `#!/bin/sh\n${script}\n`);
    chmodSync(at, 0o755);

    return at;
  }

  /** `fleet ws DIR ARGS`, which waits on the hook it runs. */
  function wsHook(...args: string[]): Promise<ReturnType<typeof fleet>> {
    return fleetAsync(["ws", dir, ...args], env);
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);

      return true;
    } catch {
      return false;
    }
  }

  /** The workspace row's `hook`. */
  function ran(id: string): JsonObject | undefined {
    return asObject(workspaces().find((w) => w["id"] === id)?.["hook"]);
  }

  test("present: run in the new workspace with it and the main checkout, its output under a header, its exit recorded", async () => {
    writeFileSync(join(repo, ".gitignore"), ".prepared\n");
    jj(repo, "describe", "-m", "ignore");
    jj(repo, "new");
    hook('echo "preparing $1 from $2 in $(pwd -P)"; echo "a warning" >&2; touch "$1/.prepared"');
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    const made = await wsHook("add", "a1", "--repo", repo);
    const path = join(base, "repo-a1");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(`--- .fleet/ws-add ${path} ${repo} (at most 100 s) ---\npreparing ${path} from ${repo} in ${path}\na warning\n--- .fleet/ws-add exited 0 in `);
    expect(made.stdout).toContain(`your working copy is ${path}`);
    expect(made.stderr).toBe("");
    expect(existsSync(join(path, ".prepared"))).toBe(true);
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: 0, at: "2026-01-05T09:00:00+00:00" });
    expect(ran("a1")?.["timed_out"]).toBeUndefined();
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1's hook ran: \.fleet\/ws-add exited 0 in [\d.]+ s\.$/);
  });

  test("absent: nothing runs and nothing is recorded", async () => {
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stdout).not.toContain("---");
    expect(made.stderr).not.toContain("hook");
    expect(ran("a1")).toBeUndefined();
  });

  test("failing: a warning, never a failure of ws add; the exit is recorded", async () => {
    hook('echo "no venv for you" >&2; exit 3');
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("no venv for you\n--- .fleet/ws-add exited 3 in ");
    expect(made.stderr).toMatch(/^ws: warning: \.fleet\/ws-add exited 3 in [\d.]+ s; workspace a1 is made, but not prepared: .*\(fix .*\.fleet\/ws-add, or run it by hand\)\n/);
    expect(existsSync(join(base, "repo-a1", "README"))).toBe(true);
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: 3 });
  });

  test("timing out: killed with everything it started after --hook-timeout, recorded as timed out", async () => {
    hook('sleep 30 & echo $! > "$1/.child"; echo started; sleep 30');
    const started = Date.now();
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("(at most 1 s) ---\nstarted\n--- .fleet/ws-add timed out after 1 s and was killed ---\n");
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add timed out after 1 s and was killed; workspace a1 is made");
    expect(ran("a1")).toMatchObject({ exit: null, timed_out: true });
    const child = Number(readFileSync(join(base, "repo-a1", ".child"), "utf8"));
    expect(() => process.kill(child, 0)).toThrow();
    expect((await wsHook("add", "a2", "--repo", repo, "--hook-timeout", "soon")).stderr).toContain("--hook-timeout takes the seconds");
    expect((await wsHook("add", "a2", "--repo", repo, "--hook-timeout")).code).toBe(1);
  });

  test("a hook that ignores SIGTERM and never ends is killed with its group at the timeout, 2 s after the SIGTERM", async () => {
    hook('trap "" TERM; echo $$ > "$1/.pid"; echo started; while :; do sleep 1; done');
    const started = Date.now();
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "1");
    const took = Date.now() - started;
    const pid = Number(readFileSync(join(base, "repo-a1", ".pid"), "utf8"));
    expect(alive(pid)).toBe(false);
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(8000);
    expect(made.stdout).toContain("started\n--- .fleet/ws-add timed out after 1 s and was killed ---\n");
    expect(ran("a1")).toMatchObject({ exit: null, timed_out: true });
  }, 20_000);

  test("a hook that ends by itself leaves nothing running: what it started in the background dies with its group", async () => {
    hook('sleep 300 & echo $! > "$1/.child"; echo started');
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "30");
    expect(made.stdout).toContain("--- .fleet/ws-add exited 0 in ");
    expect(alive(Number(readFileSync(join(base, "repo-a1", ".child"), "utf8")))).toBe(false);
  });

  test("a hook that ends by itself before its time is not recorded as timed out", async () => {
    hook("sleep 0.2");
    const made = await wsHook("add", "a1", "--repo", repo, "--hook-timeout", "5");
    expect(made.stdout).toContain("--- .fleet/ws-add exited 0 in ");
    expect(ran("a1")?.["timed_out"]).toBeUndefined();
  });

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`${signal} to ws add during the hook stops the hook's group, removes its temp dir, records it, and ends ws add`, async () => {
      hook('echo $$ > "$1/.pid"; sleep 30 & echo $! > "$1/.child"; wait');
      const temp = join(base, "tmp");
      mkdirSync(temp);
      const child = Bun.spawn([FLEET, "ws", dir, "add", "a1", "--repo", repo], { env: { ...env, FLEET_NO_FORWARD: "1", TMPDIR: temp }, stdout: "pipe", stderr: "pipe" });
      const pidFile = join(base, "repo-a1", ".child");
      const until = Date.now() + 15_000;

      while (!(existsSync(pidFile) && /^\d+\n$/.test(readFileSync(pidFile, "utf8"))) && Date.now() < until) await Bun.sleep(50);
      expect(existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "no .child file after 15 s").toMatch(/^\d+\n$/);
      const pid = Number(readFileSync(join(base, "repo-a1", ".pid"), "utf8"));
      const sleeper = Number(readFileSync(pidFile, "utf8"));
      child.kill(signal);
      const code = await child.exited;
      const stdout = await new Response(child.stdout).text();
      const stopped = Date.now() + 5000;

      while ((alive(pid) || alive(sleeper)) && Date.now() < stopped) await Bun.sleep(50);
      expect(alive(pid)).toBe(false);
      expect(alive(sleeper)).toBe(false);
      expect(readdirSync(temp)).toEqual([]);
      expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: null, interrupted: signal });
      expect(stdout).toContain("--- .fleet/ws-add was stopped after ");
      expect(code).toBe(128 + osConstants.signals[signal]);
    }, 30_000);
  }

  test("a hook that cannot start (a #! line naming a missing interpreter) says why, and records exit null", async () => {
    const at = join(repo, ".fleet", "ws-add");
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    writeFileSync(at, "#!/nonexistent/interp\necho hi\n");
    chmodSync(at, 0o755);
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stdout).not.toContain("undefined");
    expect(made.stdout).toMatch(/--- \.fleet\/ws-add could not start: .*ENOENT.* \(a missing program, or a #! line that names one\) ---\n/);
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add could not start: ");
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: null });
    expect(String(ran("a1")?.["error"])).toContain("ENOENT");
  });

  test("a hook that leaves files in the workspace's @ is warned about, by name", async () => {
    hook('echo x > "$1/junk.txt"; mkdir -p "$1/cache"; echo y > "$1/cache/env"');
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add left files in workspace a1's @, which jj now tracks there: cache/env, junk.txt. A hook writes only ignored paths");
  });

  test("--reuse: run in the reused workspace, which is its source too", async () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    await wsHook("add", "a1", "--repo", repo);
    hook('echo "again $1 from $2"');
    state("agent", "b1", "--task", "t2", "--milestone", "m1");
    const made = await wsHook("add", "b1", "--reuse", "a1");
    const path = join(base, "repo-a1");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(`again ${path} from ${path}\n--- .fleet/ws-add exited 0 in `);
    expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add", exit: 0 });
    expect(lastEvent()).toMatchObject({ agent: "b1", kind: "note" });
  });

  test("never run from outside the repo, nor when it is not executable", async () => {
    const elsewhere = join(base, "outside.sh");
    writeFileSync(elsewhere, `#!/bin/sh\ntouch "$1/.ran"\n`);
    chmodSync(elsewhere, 0o755);
    mkdirSync(join(repo, ".fleet"));
    symlinkSync(elsewhere, join(repo, ".fleet", "ws-add"));
    const made = await wsHook("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain(`ws: ${join(repo, ".fleet", "ws-add")} resolves outside the repo (${repo}): not run\n`);
    expect(existsSync(join(base, "repo-a1", ".ran"))).toBe(false);
    expect(ran("a1")).toBeUndefined();
    rmSync(join(repo, ".fleet", "ws-add"));
    writeFileSync(join(repo, ".fleet", "ws-add"), "#!/bin/sh\nexit 0\n");
    expect((await wsHook("add", "a2", "--repo", repo)).stderr).toContain("is not an executable file: not run");
  });

  describe("a devenv repo with no hook of its own: devenv-run --prepare", () => {
    let bin: string;

    beforeEach(() => {
      writeFileSync(join(repo, "devenv.nix"), "{ ... }: { }\n");
      jj(repo, "describe", "-m", "devenv");
      jj(repo, "new");
      bin = join(base, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "devenv-run"), '#!/bin/sh\necho "devenv-run $* in $(pwd -P)"\n');
      chmodSync(join(bin, "devenv-run"), 0o755);
    });

    test("runs in the new workspace when devenv-run is on PATH", async () => {
      moreEnv({ PATH: `${bin}:${env["PATH"] ?? ""}` });
      const made = await wsHook("add", "a1", "--repo", repo);
      const path = join(base, "repo-a1");
      expect(made.code).toBe(0);
      expect(made.stdout).toContain(`--- devenv-run --prepare (at most 100 s) ---\ndevenv-run --prepare in ${path}\n--- devenv-run --prepare exited 0 in `);
      expect(ran("a1")).toMatchObject({ command: "devenv-run --prepare", exit: 0 });
    });

    test("skipped with a one-line note when devenv-run is not on PATH", async () => {
      moreEnv({ PATH: join(base, "empty") });
      const made = await wsHook("add", "a1", "--repo", repo);
      expect(made.code).toBe(0);
      expect(made.stderr).toContain("ws: a devenv repo, and devenv-run is not on PATH: the workspace's devenv env is not prepared\n");
      expect(made.stdout).not.toContain("---");
      expect(ran("a1")).toBeUndefined();
    });

    test("the repo's own hook replaces it", async () => {
      moreEnv({ PATH: `${bin}:${env["PATH"] ?? ""}` });
      hook('echo "the repo\'s own"');
      const made = await wsHook("add", "a1", "--repo", repo);
      expect(made.stdout).toContain("the repo's own\n");
      expect(made.stdout).not.toContain("devenv-run");
      expect(ran("a1")).toMatchObject({ command: ".fleet/ws-add" });
    });
  });
});

describe("lifecycle hooks: pre-add gates add, post-add only warns, pre-remove gates the move to the trash", () => {
  /** The repo's `.fleet/NAME`, as this shell script, made executable. */
  function hookFile(name: string, script: string): void {
    mkdirSync(join(repo, ".fleet"), { recursive: true });
    writeFileSync(join(repo, ".fleet", name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(repo, ".fleet", name), 0o755);
  }

  function wsAsync(...args: string[]): Promise<ReturnType<typeof fleet>> {
    return fleetAsync(["ws", dir, ...args], env);
  }

  function row(id: string): JsonObject | undefined {
    return workspaces().find((w) => w["id"] === id);
  }

  function names(): string {
    return jj(repo, "workspace", "list", "-T", 'name ++ "\\n"');
  }

  function trashed(): string[] {
    const at = join(base, "registry", "trash", "repo");

    return existsSync(at) ? readdirSync(at).sort() : [];
  }

  /** A log outside the repo the hooks append to, so they leave no file in a workspace. */
  function log(): string {
    return join(base, "hooks.log");
  }

  function logged(): string {
    return existsSync(log()) ? readFileSync(log(), "utf8") : "";
  }

  /** A shell line that runs `fleet ARGS` as a process of its own in this test's environment (a hook gets fleet's
   * caller's environment, not the test's), as a concurrent command would. */
  function fleetLine(...args: string[]): string {
    const unset = Object.keys(process.env).filter((k) => !(k in env)).map((k) => `-u ${k}`);
    const set = Object.entries(env).filter(([k, v]) => process.env[k] !== v).map(([k, v]) => `${k}='${v}'`);

    return `env ${[...unset, ...set].join(" ")} "${FLEET}" ${args.map((a) => `'${a}'`).join(" ")} >/dev/null 2>&1`;
  }

  /** The repo's pre-add check, which runs `line` the first time it runs and passes every time. */
  function preAddOnce(line: string): void {
    const marker = join(base, "pre-add-ran");
    hookFile("ws-pre-add", `[ -e "${marker}" ] || { touch "${marker}"; ${line}; }\nexit 0`);
  }

  /** a1 done, its workspace made; b1 recorded, to take it over. */
  async function handable(): Promise<string> {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    state("agent", "b1", "--task", "t2", "--milestone", "m1");

    return jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id");
  }

  /** a1's workspace, its change in the stack, its worker done: prune's own rules let it go. `.stopped` is ignored. */
  async function integrated(): Promise<string> {
    writeFileSync(join(repo, ".gitignore"), ".stopped\n");
    jj(repo, "describe", "-m", "ignore");
    jj(repo, "new");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: one");
    jj(repo, "rebase", "-r", "a1@-", "-B", "@");
    state("agent", "a1", "--status", "done");

    return at;
  }

  test("pre-add refusing makes nothing: no folder, no jj workspace, no row, and post-add never runs", async () => {
    hookFile("ws-pre-add", 'echo "disk is full"; exit 4');
    hookFile("ws-add", `echo post >> "${log()}"`);
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    const path = join(base, "repo-a1");
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect(made.code).toBe(1);
    expect(made.stdout).toContain(`--- .fleet/ws-pre-add ${path} ${repo} (at most 100 s) ---\ndisk is full\n--- .fleet/ws-pre-add exited 4 in `);
    expect(made.stderr).toMatch(/^ws: \.fleet\/ws-pre-add refused the add: \.fleet\/ws-pre-add exited 4 in [\d.]+ s; no workspace is made\n$/);
    expect(existsSync(path)).toBe(false);
    expect(names()).toBe("default\n");
    expect(workspaces()).toEqual([]);
    expect(logged()).toBe("");
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1 not added: \.fleet\/ws-pre-add exited 4 in [\d.]+ s\.$/);
  });

  test("pre-add passing, then post-add: once each, in that order, the check in the source and the hook in the workspace; both runs on the row", async () => {
    hookFile("ws-pre-add", `echo "pre $(pwd -P)" >> "${log()}"`);
    hookFile("ws-add", `echo "post $(pwd -P)" >> "${log()}"`);
    const made = await wsAsync("add", "a1", "--repo", repo);
    const path = join(base, "repo-a1");
    expect(made.code).toBe(0);
    expect(logged()).toBe(`pre ${repo}\npost ${path}\n`);
    expect(row("a1")?.["pre_add_hook"]).toMatchObject({ command: ".fleet/ws-pre-add", exit: 0, at: "2026-01-05T09:00:00+00:00" });
    expect(row("a1")?.["hook"]).toMatchObject({ command: ".fleet/ws-add", exit: 0 });
  });

  test("post-add failing after pre-add passed keeps the workspace: a warning, and add exits 0", async () => {
    hookFile("ws-pre-add", "exit 0");
    hookFile("ws-add", "exit 5");
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect(made.code).toBe(0);
    expect(made.stderr).toContain("ws: warning: .fleet/ws-add exited 5 in");
    expect(existsSync(join(base, "repo-a1", "README"))).toBe(true);
    expect(row("a1")).toMatchObject({ status: "active", hook: { exit: 5 }, pre_add_hook: { exit: 0 } });
  });

  test("pre-add refusing a --reuse hands nothing over: the workspace stays its last holder's, on the same change", async () => {
    state("agent", "a1", "--task", "t", "--milestone", "m1", "--status", "done");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    const path = join(base, "repo-a1");
    work(path, "one.txt", "a1: one");
    const tip = jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id");
    hookFile("ws-pre-add", `echo "pre $(pwd -P) $1 $2" >> "${log()}"; exit 1`);
    state("agent", "b1", "--task", "t2", "--milestone", "m1");
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect(made.code).toBe(1);
    expect(made.stderr).toContain("ws: .fleet/ws-pre-add refused the add: .fleet/ws-pre-add exited 1 in");
    expect(logged()).toBe(`pre ${path} ${path} ${path}\n`);
    expect(row("a1")).toMatchObject({ agent: "a1", pre_add_hook: { exit: 1 } });
    expect(row("a1")?.["handovers"]).toBeUndefined();
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id")).toBe(tip);
  });

  test("--reuse refuses when the workspace changed hands during the pre-add check: one handover, not two", async () => {
    await handable();
    preAddOnce(fleetLine("ws", dir, "add", "c1", "--reuse", "a1"));
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect([made.code, made.stderr]).toEqual([1, "ws: workspace a1 changed hands during the pre-add check: it is c1's now; nothing is handed over\n"]);
    expect(row("a1")).toMatchObject({ agent: "c1", handovers: [{ from: "a1" }] });
    expect(asArray(row("a1")?.["handovers"])?.length).toBe(1);
  });

  test("--reuse refuses when the last holder went back to work during the pre-add check", async () => {
    const tip = await handable();
    preAddOnce(fleetLine("state", dir, "agent", "a1", "--status", "running", "--no-render"));
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect([made.code, made.stderr]).toEqual([1, "ws: a1 is running again since the pre-add check began: workspace a1 stays a1's; nothing is handed over\n"]);
    expect(row("a1")?.["agent"]).toBe("a1");
    expect(row("a1")?.["handovers"]).toBeUndefined();
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id")).toBe(tip);
  });

  test("--reuse refuses when the worker got a workspace of its own during the pre-add check", async () => {
    const tip = await handable();
    preAddOnce(fleetLine("ws", dir, "add", "b1", "--repo", repo));
    const made = await wsAsync("add", "b1", "--reuse", "a1");
    expect([made.code, made.stderr]).toEqual([1, `ws: b1 got workspace b1 (${join(base, "repo-b1")}) during the pre-add check; a worker holds one workspace: nothing is handed over\n`]);
    expect(row("a1")?.["agent"]).toBe("a1");
    expect(row("b1")?.["agent"]).toBe("b1");
    expect(jj(repo, "log", "--no-graph", "-r", "a1@", "-T", "change_id")).toBe(tip);
  });

  test("a fresh add refuses when its dev-server port was taken during the pre-add check, and makes nothing", async () => {
    preAddOnce(fleetLine("ws", dir, "add", "a2", "--repo", repo));
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect([made.code, made.stderr]).toEqual([1, "ws: dev-server port 5300 was taken during the pre-add check (5301 is free now); no workspace is made: run add again\n"]);
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
    expect(names()).toBe("a2\ndefault\n");
    expect(workspaces().map((w) => [w["id"], w["port"]])).toEqual([["a2", 5300]]);
  });

  test("a fresh add goes ahead when a lower port is freed during the pre-add check: only its own port being taken refuses", async () => {
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    expect((await wsAsync("add", "a2", "--repo", repo)).code).toBe(0);
    state("agent", "a2", "--status", "done");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    preAddOnce(fleetLine("ws", dir, "prune", "--apply"));
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect([made.code, made.stderr]).toEqual([0, ""]);
    expect(names()).toBe("a1\ndefault\n");
    expect(workspaces().map((w) => [w["id"], w["status"], w["port"]])).toEqual([["a2", "pruned", 5300], ["a1", "active", 5301]]);
  });

  test("a pre-add check that is there but not executable refuses the add: a check that did not run never passes", async () => {
    mkdirSync(join(repo, ".fleet"));
    writeFileSync(join(repo, ".fleet", "ws-pre-add"), "#!/bin/sh\nexit 0\n");
    const made = await wsAsync("add", "a1", "--repo", repo);
    expect(made.code).toBe(1);
    expect(made.stderr).toContain("is not an executable file: not run (`chmod +x` it); no workspace is made");
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
  });

  test("a pre-add check that runs out of time is killed and refuses the add", async () => {
    hookFile("ws-pre-add", "echo started; sleep 30");
    const started = Date.now();
    const made = await wsAsync("add", "a1", "--repo", repo, "--hook-timeout", "1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(made.code).toBe(1);
    expect(made.stdout).toContain("(at most 1 s) ---\nstarted\n--- .fleet/ws-pre-add timed out after 1 s and was killed ---\n");
    expect(made.stderr).toContain("ws: .fleet/ws-pre-add refused the add: .fleet/ws-pre-add timed out after 1 s and was killed; no workspace is made");
    expect(existsSync(join(base, "repo-a1"))).toBe(false);
    expect(names()).toBe("default\n");
  });

  test("pre-remove failing keeps the workspace out of the trash: folder, jj workspace and row stay, and prune says why", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", 'echo "the dev server will not stop"; exit 2');
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stdout).toContain(`--- .fleet/ws-pre-remove ${at} (at most 100 s) ---\nthe dev server will not stop\n--- .fleet/ws-pre-remove exited 2 in `);
    expect(kept.stderr).toMatch(/^ws: kept a1: \.fleet\/ws-pre-remove exited 2 in [\d.]+ s; nothing is moved or deleted\n$/);
    expect(existsSync(join(at, ".jj", "repo"))).toBe(true);
    expect(trashed()).toEqual([]);
    expect(names()).toBe("a1\ndefault\n");
    expect(row("a1")).toMatchObject({ status: "active", pre_remove_hook: { command: ".fleet/ws-pre-remove", exit: 2 } });
    expect(lastEvent()?.["text"]).toMatch(/^Workspace a1 kept: \.fleet\/ws-pre-remove exited 2 in [\d.]+ s\.$/);
    // fixed, it runs in the workspace before the folder moves: what it wrote there is in the trash
    hookFile("ws-pre-remove", 'touch "$(pwd -P)/.stopped"');
    const gone = await wsAsync("prune", "--apply");
    expect([gone.code, gone.stderr]).toEqual([0, ""]);
    expect(trashed()).toEqual(["a1@20260105T090000Z", "a1@20260105T090000Z.json"]);
    expect(existsSync(join(base, "registry", "trash", "repo", "a1@20260105T090000Z", ".stopped"))).toBe(true);
    expect(row("a1")).toMatchObject({ status: "pruned", pre_remove_hook: { exit: 0 } });
  });

  test("a pre-remove hook that leaves a change in the workspace keeps it: prune checks again after the hook", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", 'echo x > "$FLEET_WS_PATH/left.txt"');
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain("ws: kept a1: after .fleet/ws-pre-remove, 1 change(s) not in the stack");
    expect(existsSync(join(at, "left.txt"))).toBe(true);
    expect(trashed()).toEqual([]);
  });

  test("a worker that went back to work during the pre-remove hook keeps its workspace: the check after the hook reads the ledger as it is now", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", fleetLine("state", dir, "agent", "a1", "--status", "running", "--no-render"));
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stderr).toBe("ws: kept a1: after .fleet/ws-pre-remove, its worker a1 is running\n");
    expect(existsSync(join(at, ".jj", "repo"))).toBe(true);
    expect(trashed()).toEqual([]);
    expect(row("a1")).toMatchObject({ status: "active", pre_remove_hook: { exit: 0 } });
  });

  test("a workspace handed over during the pre-remove hook stays with its new worker: the check after the hook reads who holds it now", async () => {
    const at = await integrated();
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--status", "running");
    hookFile("ws-pre-remove", fleetLine("ws", dir, "add", "b1", "--reuse", "a1"));
    const kept = await wsAsync("prune", "--apply");
    expect(kept.code).toBe(1);
    expect(kept.stderr).toBe("ws: kept a1: after .fleet/ws-pre-remove, it was handed over to b1\n");
    expect(existsSync(join(at, ".jj", "repo"))).toBe(true);
    expect(names()).toBe("a1\ndefault\n");
    expect(trashed()).toEqual([]);
    expect(row("a1")).toMatchObject({ status: "active", agent: "b1", pre_remove_hook: { exit: 0 } });
  });

  test("a workspace with no hook of its own, handed over during an earlier workspace's pre-remove hook, stays with its new worker", async () => {
    const repoY = join(base, "repoy");
    Bun.spawnSync(["jj", "git", "init", repoY], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(repoY, "README"), "base\n");
    jj(repoY, "describe", "-m", "base");
    jj(repoY, "new");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    expect((await wsAsync("add", "a1", "--repo", repo)).code).toBe(0);
    expect((await wsAsync("add", "a2", "--repo", repoY)).code).toBe(0);
    state("agent", "a1", "--status", "done");
    state("agent", "a2", "--status", "done");
    state("agent", "b1", "--task", "t2", "--milestone", "m1", "--status", "running");
    hookFile("ws-pre-remove", fleetLine("ws", dir, "add", "b1", "--reuse", "a2"));
    const ran = await wsAsync("prune", "--apply");
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain("pruned a1:");
    expect(ran.stderr).toBe("ws: kept a2: after a1's .fleet/ws-pre-remove, it was handed over to b1\n");
    expect(existsSync(join(base, "repoy-a2", ".jj", "repo"))).toBe(true);
    expect(jj(repoY, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a2\ndefault\n");
    expect(workspaces().map((w) => [w["id"], w["agent"], w["status"]])).toEqual([["a1", "a1", "pruned"], ["a2", "b1", "active"]]);
  });

  test("a pre-remove hook that runs out of time is killed and keeps the workspace; a dry run runs no hook", async () => {
    const at = await integrated();
    hookFile("ws-pre-remove", `echo ran >> "${log()}"; sleep 30`);
    expect((await wsAsync("prune")).code).toBe(0);
    expect(logged()).toBe("");
    expect((await wsAsync("prune", "--apply", "--hook-timeout", "soon")).stderr).toContain("--hook-timeout takes the seconds");
    const started = Date.now();
    const kept = await wsAsync("prune", "--apply", "--hook-timeout", "1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain("ws: kept a1: .fleet/ws-pre-remove timed out after 1 s and was killed; nothing is moved or deleted");
    expect(existsSync(at)).toBe(true);
    expect(row("a1")).toMatchObject({ status: "active", pre_remove_hook: { exit: null, timed_out: true } });
  });

  test("--hook-timeout bounds all of prune's hooks together: a workspace whose hook gets no time left is kept, its hook not run", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      state("agent", id, "--task", "t", "--milestone", "m1");
      expect((await wsAsync("add", id, "--repo", repo)).code).toBe(0);
      state("agent", id, "--status", "done");
    }

    hookFile("ws-pre-remove", `echo "$FLEET_WS_NAME" >> "${log()}"; [ "$FLEET_WS_NAME" != a2 ] || sleep 30`);
    const started = Date.now();
    const ran = await wsAsync("prune", "--apply", "--hook-timeout", "2");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ran.code).toBe(1);
    expect(logged()).toBe("a1\na2\n");
    expect(ran.stdout).toContain("pruned a1:");
    expect(ran.stderr).toContain("ws: kept a2: .fleet/ws-pre-remove timed out after ");
    expect(ran.stderr).toContain("ws: kept a3: prune's hooks ran out of their 2 s (--hook-timeout) before its .fleet/ws-pre-remove ran; nothing is moved or deleted\n");
    expect(existsSync(join(base, "repo-a3"))).toBe(true);
    expect(row("a3")).toMatchObject({ status: "active" });
    expect(row("a3")?.["pre_remove_hook"]).toBeUndefined();
  });

  test("every hook gets the same environment, and the row records the workspace's stable id", async () => {
    const line = `echo "$FLEET_EVENT|$FLEET_WS_ID|$FLEET_WS_NAME|$FLEET_WS_PATH|$FLEET_WS_PORT|$FLEET_REPO|$FLEET_FLEET" >> "${log()}"`;
    hookFile("ws-pre-add", line);
    hookFile("ws-add", line);
    hookFile("ws-pre-remove", line);
    const at = await integrated();
    const id = row("a1")?.["ws_id"];
    expect(id).toMatch(/^repo-a1-[0-9a-f]{6}$/);
    expect((await wsAsync("prune", "--apply")).code).toBe(0);
    const tail = `${String(id)}|a1|${at}|5300|${repo}|${dir}`;
    expect(logged()).toBe(`pre-add|${tail}\npost-add|${tail}\npre-remove|${tail}\n`);
  });

  test("a workspace's id is <repo basename>-<name>-<6 hex of sha256 of the repo's real path, NUL, the name>, lower-cased, any other character than a-z, 0-9 or '-' made '-', no leading '-': a compose project name, and names of one spelling but case or punctuation never share one", () => {
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "A1")).toBe("skills-a1-3a1ab7");
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "a1")).toBe("skills-a1-c6af6f");
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "a.1")).toBe("skills-a-1-a2e391");
    expect(wsId("/nonexistent/fleet-ws-id/Skills", "a_1")).toBe("skills-a-1-37ed5d");
    expect(wsId("/nonexistent/fleet-ws-id/.My.Repo", "a1")).toBe("my-repo-a1-49157e");
    const link = join(base, "link");
    symlinkSync(repo, link);
    expect(wsId(link, "a1")).toBe(wsId(repo, "a1"));
  });
});
