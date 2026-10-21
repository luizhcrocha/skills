/**
 * `fleet fleets gate run` in a systemd user scope: the scope's ceiling and stop, the processes it takes back, the
 * run's record and the estimate the next run makes of it, and its asks (CPUs, light runs, --landing). Skipped where
 * there is no systemd user manager (the Mac). The rest of gate run is gate-run.test.ts; this file is its own so that
 * bun_files.py runs the two at once, each within its per-file limit.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { cpusHere, memEstimate, sizeText } from "../src/gate.ts";
import { asArray, asNumber, asObject, type JsonObject } from "../src/json.ts";
import { alive, budgetBytes, first, freshRegistry, gate, holdFile, home, pidIn, records, running, SCOPE, standing, stopAll, until } from "./gate-run-support.ts";
import { tmp } from "./support.ts";

// Each run is a fleet process or two, and a stopped tree has seconds of grace.
setDefaultTimeout(30_000);

beforeEach(freshRegistry);

describe.skipIf(!SCOPE)("gate run's scope", () => {
  test("a child over the ceiling, the whole budget, is killed by the kernel inside the scope, and the run says so", () => {
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024); print('survived')"];
    const done = gate(["run", "--as", "w1", "--wait", "5", "--", ...hog], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "64M" });
    expect(done.stdout).not.toContain("survived");
    expect(done.code).toBe(137);
    expect(done.stderr).toContain("MemoryMax=64.0M (the budget), no swap");
    // oom_kill counts the machine-wide OOM killer's kills too: the line blames neither the run alone nor names a
    // flag or variable that widens it.
    expect(done.stderr).toMatch(/\ngate run: \d+ process\(es\) of the run killed for memory: the run or the machine ran out \(its ceiling MemoryMax=64\.0M is the whole budget, 64M\)\n/);
    expect(done.stderr).not.toContain("Run it again");
    expect(done.stderr.split("\n").find((line) => line.includes("killed for memory"))).not.toContain("FLEET_GATE");
    expect(first()).toBe("free");
    expect(records()[0]).toMatchObject({ name: "w1", asked: "25%", cap: 64 * 1024 ** 2, estimate: 64 * 1024 ** 2, code: 137 });
    expect(asNumber(records()[0]?.["killed"])).toBeGreaterThan(0);
    expect(gate([]).stdout).toMatch(/\nlast 24 h: 1 runs, .*, 1 hit the cap\n$/);
  });

  test("the estimate is a quarter of the RAM by default, $FLEET_GATE_MEMORY_MAX with no earlier run, and a smaller budget lowers it; the ceiling is the budget", () => {
    const budget = budgetBytes();
    const plain = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" });
    expect(plain.stderr).toContain("from the default 25% (no earlier run)");
    expect(plain.stderr).toContain(`; MemoryMax=${sizeText(budget)} (the budget, 50% of `);
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_MAX: "50%" }).stderr).toContain("from $FLEET_GATE_MEMORY_MAX 50% (no earlier run)");
    const lowered = gate(["run", "--as", "w1", "--", "sh", "-c", ":"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "256M" });
    expect(lowered.code).toBe(0);
    expect(lowered.stderr).toContain("estimate 256.0M from the default 25% (no earlier run), lowered from ");
    expect(lowered.stderr).toContain("MemoryMax=256.0M (the budget), no swap");
  });

  test("the command reaches the scope word for word: systemd-run does not rewrite its dollar signs", () => {
    const done = gate(["run", "--as", "w1", "--", "sh", "-c", "echo ${FLEET_HOME} $$"], { FLEET_GATE_SCOPE: "1" });
    expect(done.code).toBe(0);
    expect(done.stdout).toMatch(new RegExp(`^${home} \\d+\n$`));
  });

  test("the scope's memory peak is kept, when the command ends and when it is stopped", () => {
    expect(gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" }).stderr).toMatch(/exit 0 after [\d.]+s, memory peak [\d.]+[KMG]; freed the gate/);
    expect(gate(["run", "--as", "w1", "--timeout", "1", "--", "sleep", "30"], { FLEET_GATE_SCOPE: "1" }).code).toBe(124);
    expect(records().map((r) => (asNumber(r["peak"]) ?? 0) > 0)).toEqual([true, true]);
    expect(asNumber(standing().day?.["max_peak"])).toBeGreaterThan(0);
  });

  test("a process of the run that asks for an app scope of its own, as Chromium does, is taken back: the cap, the peak and the stop count it", () => {
    const dir = tmp("fleet-gate-app-");
    const app = `app-fleet-test-${String(process.pid)}-${String(Date.now())}`;

    // systemd-run --scope asks the user manager for the scope over D-Bus and execs into it, as Chromium's browser process asks for app-org.chromium.Chromium-<pid>.scope.
    const command = `systemd-run --user --scope --quiet --collect --unit ${app} sleep 300 & echo $! > ${dir}/pid; sleep 2; ` +
      `if [ "$(cat /proc/$(cat ${dir}/pid)/cgroup)" = "$(cat /proc/self/cgroup)" ]; then echo inside; else echo outside; fi`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stdout).toBe("inside\n");
      expect(done.stderr).toContain(`took back into the run's scope the processes of the run that had left it for an app scope (1 from ${app}.scope)`);
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("an app scope's process whose chain reaches the run only through another scope (a gate run inside the run) is that scope's, and left alone", () => {
    const dir = tmp("fleet-gate-nested-");
    const stamp = `${String(process.pid)}-${String(Date.now())}`;
    const [inner, bare, marked] = [`fleet-test-inner-${stamp}`, `app-fleet-test-bare-${stamp}`, `app-fleet-test-marked-${stamp}`];

    // The inner scope is a gate run inside the run, its own FLEET_GATE_RUN: one escapee keeps it, one has none, so only its parent chain says whose it is.
    const launch = `env -u FLEET_GATE_RUN systemd-run --user --scope --quiet --collect --unit ${bare} sleep 300 & echo $! > ${dir}/bare; ` +
      `systemd-run --user --scope --quiet --collect --unit ${marked} sleep 300 & echo $! > ${dir}/marked; wait`;

    const command = `FLEET_GATE_RUN=${inner} systemd-run --user --scope --quiet --collect --unit ${inner} sh -c '${launch}' >/dev/null 2>&1 & sleep 2; ` +
      `for p in bare marked; do sed -n 's/.*\\///p' /proc/$(cat ${dir}/$p)/cgroup; done`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stdout).toBe(`${bare}.scope\n${marked}.scope\n`);
      expect(done.stderr).not.toContain("took back");
    } finally {
      for (const unit of [inner, bare, marked]) Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("a process of the run orphaned before it asks for an app scope is still taken back, by the FLEET_GATE_RUN it carries", () => {
    const dir = tmp("fleet-gate-orphan-");
    const app = `app-fleet-test-orphan-${String(process.pid)}-${String(Date.now())}`;

    // The shell that starts it exits first: the user manager inherits it, and no parent chain leads back to the run.
    const command = `sh -c '(sleep 0.5; exec systemd-run --user --scope --quiet --collect --unit ${app} sleep 300) >/dev/null 2>&1 & echo $! > ${dir}/pid'; sleep 3; ` +
      `if [ "$(cat /proc/$(cat ${dir}/pid)/cgroup)" = "$(cat /proc/self/cgroup)" ]; then echo inside; else echo outside; fi`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stdout).toBe("inside\n");
      expect(done.stderr).toContain(`(1 from ${app}.scope)`);
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("a process of the run that leaves for an app scope as the run ends dies with the run's stop, and the run says so", () => {
    const dir = tmp("fleet-gate-late-");
    const app = `app-fleet-test-late-${String(process.pid)}-${String(Date.now())}`;

    // The command ends the moment its child is in the app scope: no sweep of the run's sees it while the run goes.
    const command = `systemd-run --user --scope --quiet --collect --unit ${app} sleep 300 >/dev/null 2>&1 & echo $! > ${dir}/pid; ` +
      `while [ "$(cat /proc/$!/cgroup)" = "$(cat /proc/self/cgroup)" ]; do :; done`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
      expect(done.stderr.includes(`(1 from ${app}.scope)`) || done.stderr.includes(`(1 in ${app}.scope)`)).toBe(true);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("a process the run could not take back is named, with the error, and dies with the run's stop", () => {
    const dir = tmp("fleet-gate-refused-");
    const app = `app-fleet-test-refused-${String(process.pid)}-${String(Date.now())}`;

    // The run's own cgroup.procs, read-only, refuses the runner's write.
    const command = `chmod a-w "/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)/cgroup.procs"; ` +
      `systemd-run --user --scope --quiet --collect --unit ${app} sleep 300 >/dev/null 2>&1 & echo $! > ${dir}/pid; sleep 1.5`;

    try {
      const done = gate(["run", "--as", "w1", "--", "sh", "-c", command], { FLEET_GATE_SCOPE: "1" });
      expect(done.stderr).toContain(`gate run: could not take back 1 from ${app}.scope: EACCES`);
      expect(alive(pidIn(join(dir, "pid")))).toBe(false);
    } finally {
      Bun.spawnSync(["systemctl", "--user", "stop", `${app}.scope`], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("the scope has a CPU weight, so two runs share the cores evenly; without one the run is niced", () => {
    const weight = ["sh", "-c", 'cat "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/cpu.weight"'];
    const weighed = gate(["run", "--as", "w1", "--", ...weight], { FLEET_GATE_SCOPE: "1" });

    // Where the user manager has the cpu controller, the scope is weighed; elsewhere it says why not and nices.
    if (weighed.stderr.includes("CPUWeight=100")) {
      expect(weighed.stdout).toBe("100\n");
      expect(gate(["run", "--as", "w1", "--", ...weight], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPU_WEIGHT: "300" }).stdout).toBe("300\n");
    } else {
      expect(weighed.stderr).toContain("nice 5 (no CPU weight");
    }

    const niced = gate(["run", "--as", "w1", "--", "sh", "-c", "nice"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPU_WEIGHT: "0" });
    expect(niced.stderr).toContain("nice 5 (no CPU weight");
    expect(Number(niced.stdout)).toBeGreaterThanOrEqual(5);
  });

  test("the scope has a CPU quota, so a pool sized by a count that reads it (nproc, Node's) starts no more workers than that", () => {
    const sees = ["sh", "-c", "nproc; node -p 'require(\"os\").availableParallelism()'"];
    const all = cpusHere();
    const half = Math.max(2, Math.floor(all / 2));
    // --cpus is the estimate, for admission alone: the quota is the same for every run.
    const halved = gate(["run", "--as", "w1", "--cpus", "2", "--", ...sees], { FLEET_GATE_SCOPE: "1" });

    // Where the user manager has no cpu controller there is no quota, as there is no weight, and the run says so.
    if (!halved.stderr.includes("CPUWeight=")) {
      expect(halved.stderr).toContain("no CPUQuota (the systemd user manager has no cpu controller)");

      return;
    }

    if (half < all) {
      expect(halved.stdout).toBe(`${String(half)}\n${String(half)}\n`);
      expect(halved.stderr).toContain(`CPUQuota=${String(half * 100)}% (${String(half)} of ${String(all)} CPUs: nproc, Node's os.availableParallelism(), Rust's and Go's (1.25 on) count ${String(half)}, so a pool they size starts ${String(half)} workers; one sized by os.cpus(), Bun's os.availableParallelism(), a config's maxWorkers or Playwright keeps its size)`);
    }

    if (all > 3) expect(gate(["run", "--as", "w1", "--", ...sees], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPUS: "3" }).stdout).toBe("3\n3\n");

    // $FLEET_GATE_CPUS as large as the machine: no quota.
    const whole = gate(["run", "--as", "w1", "--", ...sees], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPUS: String(all) });
    expect(whole.stdout).toBe(`${String(all)}\n${String(all)}\n`);
    expect(whole.stderr).toContain(`no CPUQuota ($FLEET_GATE_CPUS is ${String(all)}, at least the machine's ${String(all)} CPUs)`);
  });

  test("a $FLEET_GATE_CPUS that is not a whole number is named in the run's line, and half the CPUs taken", () => {
    for (const given of ["abc", "-1", "2.5", "+4", ""]) {
      const said = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPUS: given });
      expect(said.stderr).toContain(`$FLEET_GATE_CPUS "${given}" is not a whole number of CPUs: half the CPUs taken`);
    }
  });
});

describe.skipIf(!SCOPE)("gate run's record, and its estimate from the last runs", () => {
  const more = { FLEET_GATE_SCOPE: "1" };
  /** A command of more than 80 characters, a word each that needs no quoting: its record's `what` is these words. */
  const long = ["sh", "-c", "true", "first-word", "second-word", "third-word", "fourth-word", "fifth-word", "sixth-word", "seventh-word", "eighth-word"];

  function sh(cwd: string, command: readonly string[]): string {
    const done = Bun.spawnSync([...command], { cwd, env: { ...process.env, JJ_USER: "t", JJ_EMAIL: "t@example.com" }, stdout: "pipe", stderr: "pipe" });
    expect(done.exitCode).toBe(0);

    return done.stdout.toString().trim();
  }

  function gitRepo(): string {
    const dir = tmp("fleet-gate-git-");
    sh(dir, ["git", "init", "-q"]);
    sh(dir, ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one"]);

    return dir;
  }

  test("in a git repository a run keeps the repository's common directory, its root, HEAD, the whole command, its CPU seconds and its CPUs", () => {
    const repo = gitRepo();
    expect(gate(["run", "--as", "w1", "--", ...long], more, repo).code).toBe(0);
    const [kept] = records();
    expect(long.join(" ").length).toBeGreaterThan(80);
    expect(kept).toMatchObject({ repo: realpathSync(join(repo, ".git")), workspace: sh(repo, ["git", "rev-parse", "--show-toplevel"]), commit: sh(repo, ["git", "rev-parse", "HEAD"]), what: long.join(" ") });
    expect(asNumber(kept?.["cpu_s"])).toBeGreaterThan(0);
    expect(asNumber(kept?.["cpus"])).toBeGreaterThan(0);
    expect(asNumber(kept?.["estimate"])).toBeGreaterThan(0);
    expect(kept?.["landing"]).toBeUndefined();
    // A first run, which never waited: not light, and nothing it waited for or behind.
    expect(kept).not.toContainAnyKeys(["light", "waited_for", "behind"]);
  });

  test.skipIf(Bun.which("jj") === null)("in a jj repository the commit is @-'s, and a landing gate is marked", () => {
    const repo = tmp("fleet-gate-jj-");
    sh(repo, ["jj", "git", "init", "--quiet"]);
    writeFileSync(join(repo, "a"), "a\n");
    sh(repo, ["jj", "commit", "--quiet", "-m", "one"]);
    const parent = sh(repo, ["jj", "log", "--ignore-working-copy", "--no-graph", "-r", "@-", "-T", "commit_id"]);
    expect(gate(["run", "--as", "w1", "--landing", "--", "true"], more, repo).code).toBe(0);
    expect(records()[0]).toMatchObject({ repo: realpathSync(join(repo, ".jj", "repo")), workspace: realpathSync(repo), commit: parent, what: "true", landing: true });
  });

  test.skipIf(Bun.which("jj") === null)("a new jj workspace has its repository's history", () => {
    const repo = tmp("fleet-gate-jj-");
    sh(repo, ["jj", "git", "init", "--quiet"]);
    const other = join(tmp("fleet-gate-ws-"), "ws");
    sh(repo, ["jj", "workspace", "add", "--quiet", other]);
    expect(gate(["run", "--as", "w1", "--", "true"], more, repo).code).toBe(0);
    expect(gate(["run", "--as", "w1", "--", "true"], more, other).stderr).toContain(", estimate 2.0G from its last run (");
    expect(records()[1]).toMatchObject({ repo: realpathSync(join(repo, ".jj", "repo")), workspace: realpathSync(other) });
  });

  test("a run with no --mem is estimated from its last runs' peak in the same repository; with none, by the default", () => {
    const repo = gitRepo();
    const first = gate(["run", "--as", "w1", "--", "true"], more, repo);
    expect(first.stderr).toMatch(/, estimate [\d.]+G from the default 25% \(no earlier run\) and 8 of the \d+ CPUs of all runs from the default \(no earlier run\); MemoryMax=[\d.]+G \(the budget, 50% of /);
    // A first run is never light: it has no runs to say it is short.
    expect(first.stderr).not.toContain("a light run");
    const [measured] = records();

    const second = gate(["run", "--as", "w1", "--", "true"], more, repo);
    const peak = asNumber(measured?.["peak"]) ?? 0;
    expect(second.stderr).toContain(`, estimate 2.0G from its last run (${sizeText(peak)} peak at ${String(measured?.["at"])}) and `);
    expect(second.stderr).toContain(`; MemoryMax=${sizeText(budgetBytes())} (the budget`);
    // An estimate of 4G at most and each of its last runs 2 minutes at most: a light run.
    expect(second.stderr).toContain("w1 holds the gate, a light run (token");
    expect(records()[1]).toMatchObject({ asked: "last runs", estimate: 2 * 1024 ** 3, cap: budgetBytes() });

    // --mem is the run's own; another command, or the same in another repository, has no earlier run.
    expect(gate(["run", "--as", "w1", "--mem", "3G", "--", "true"], more, repo).stderr).toContain(", estimate 3.0G from --mem and ");
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "true"], more, repo).stderr).toContain("(no earlier run)");
    expect(gate(["run", "--as", "w1", "--", "true"], more, gitRepo()).stderr).toContain("(no earlier run)");
  });

  // 10-22: agent-tools' land-gate was given --mem 4G against a measured 9.5G peak, and the reaper stopped it.
  test("a --mem below the command's measured peak is raised to that peak, and the run says so", () => {
    const GB = 1024 ** 3;
    const repo = gitRepo();
    const store = realpathSync(join(repo, ".git"));
    const at = new Date(Date.now() - 3600_000).toISOString();
    mkdirSync(join(home, "gate"), { recursive: true });
    writeFileSync(join(home, "gate", "runs.jsonl"), `${JSON.stringify({ at, name: "w", kind: "session", what: "true", asked: "4G", cap: 32 * GB, waited: 0, ran: 600, code: 0, peak: 9.5 * GB, killed: 0, repo: store })}\n`);
    const env = { ...more, FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_FLOOR: "0" };

    const below = gate(["run", "--as", "w1", "--mem", "4G", "--", "true"], env, repo);
    expect(below.code).toBe(0);
    expect(below.stderr).toContain("gate run: --mem 4G is below this command's measured peak 9.5G: claiming 9.5G\n");
    expect(below.stderr).toContain(`, estimate 9.5G from --mem 4G raised to the peak of its last run (9.5G at ${at}) and `);
    expect(records().at(-1)).toMatchObject({ asked: "4G raised to the peak", estimate: 9.5 * GB });

    // A --mem at or above the peak is the run's own.
    const above = gate(["run", "--as", "w1", "--mem", "12G", "--", "true"], env, repo);
    expect(above.stderr).not.toContain("is below this command's measured peak");
    expect(above.stderr).toContain(", estimate 12.0G from --mem and ");
  });

  // The review of 10-22 (A3): a leak killed at the ceiling leaves a peak of the whole budget, which no later run lowers.
  test("a --mem below a peak that a killed run left (OOM-killed, or a signal's exit) is kept as given, and the run says why", () => {
    const GB = 1024 ** 3;
    const repo = gitRepo();
    const store = realpathSync(join(repo, ".git"));
    const at = new Date(Date.now() - 3600_000).toISOString();
    const env = { ...more, FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_FLOOR: "0" };
    mkdirSync(join(home, "gate"), { recursive: true });

    for (const [end, why] of [[{ code: 137, killed: 0 }, "exit 137"], [{ code: 1, killed: 4 }, "4 process(es) killed for memory"]] as const) {
      writeFileSync(join(home, "gate", "runs.jsonl"), `${JSON.stringify({ at, name: "w", kind: "session", what: "true", asked: "8G", cap: 32 * GB, waited: 0, ran: 600, peak: 32 * GB, repo: store, ...end })}\n`);
      const kept = gate(["run", "--as", "w1", "--mem", "8G", "--", "true"], env, repo);
      expect(kept.code).toBe(0);
      expect(kept.stderr).toContain(`gate run: --mem 8G is below this command's measured peak 32.0G, but that peak is a killed run's (${why}): claiming 8.0G as given\n`);
      expect(kept.stderr).toContain(`, estimate 8.0G from --mem kept (the peak of its last run, 32.0G at ${at}, is a killed run's: ${why}) and `);
      expect(records().at(-1)).toMatchObject({ asked: "8G", estimate: 8 * GB });
    }
  });

  test("a raised --mem lowered to the budget says the claim it makes, not the peak", () => {
    const GB = 1024 ** 3;
    const repo = gitRepo();
    const store = realpathSync(join(repo, ".git"));
    const at = new Date(Date.now() - 3600_000).toISOString();
    mkdirSync(join(home, "gate"), { recursive: true });
    writeFileSync(join(home, "gate", "runs.jsonl"), `${JSON.stringify({ at, name: "w", kind: "session", what: "true", asked: "4G", cap: 32 * GB, waited: 0, ran: 600, code: 0, peak: 9.5 * GB, killed: 0, repo: store })}\n`);

    const lowered = gate(["run", "--as", "w1", "--mem", "4G", "--", "true"], { ...more, FLEET_GATE_MEMORY_BUDGET: "8G", FLEET_GATE_MEMORY_FLOOR: "0" }, repo);
    expect(lowered.code).toBe(0);
    expect(lowered.stderr).toContain("gate run: --mem 4G is below this command's measured peak 9.5G: claiming 8.0G, the budget\n");
    expect(lowered.stderr).toContain(", estimate 8.0G from --mem 4G raised to the peak of its last run (9.5G at ");
    expect(records().at(-1)).toMatchObject({ asked: "4G raised to the peak", estimate: 8 * GB });
  });

  // The Manager's 10-22 gate: 6 of 10 queued first runs asked 25% each while no run's peak passed 10.3G.
  test.skipIf(Bun.which("jj") === null)("a new workspace's first run is estimated from the largest peak of its family in the repository's workspaces in the last 24 h, plus 25%; never another repository's; $FLEET_GATE_MEMORY_MAX wins", () => {
    const GB = 1024 ** 3;
    const env = { ...more, FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_FLOOR: "0" };
    const main = tmp("fleet-gate-jj-");
    sh(main, ["jj", "git", "init", "--quiet"]);

    const ws = (name: string): string => {
      const dir = join(tmp("fleet-gate-ws-"), name);

      sh(main, ["jj", "workspace", "add", "--quiet", dir]);

      return sh(dir, ["jj", "root"]);
    };

    const [root, other, third] = [sh(main, ["jj", "root"]), ws("other"), ws("third")];
    const stranger = gitRepo();
    const strangerRoot = sh(stranger, ["git", "rev-parse", "--show-toplevel"]);

    for (const dir of [other, third, strangerRoot]) writeFileSync(join(dir, "gate-x.sh"), "true\n");
    const store = realpathSync(join(main, ".jj", "repo"));
    const hour = new Date(Date.now() - 3600_000).toISOString();
    const line = (at: string, peak: number): string => JSON.stringify({ at, name: "w", kind: "session", what: `bash ${root}/gate-x.sh`, asked: "25%", cap: 16 * GB, waited: 0, ran: 60, code: 0, peak, killed: 0, repo: store, workspace: root });
    mkdirSync(join(home, "gate"), { recursive: true });
    writeFileSync(join(home, "gate", "runs.jsonl"), `${line(hour, 3 * GB)}\n${line(new Date(Date.now() - 25 * 3600_000).toISOString(), 9 * GB)}\n`);

    const first = gate(["run", "--as", "w1", "--", "bash", `${other}/gate-x.sh`], env, other);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(`, estimate ${sizeText(memEstimate(3 * GB))} from the 24 h peak of 'bash <workspace>/gate-x.sh' in ${root} (repository ${store}), 3.0G at ${hour}, plus 25% and `);
    expect(records().at(-1)).toMatchObject({ asked: "its family's runs", estimate: memEstimate(3 * GB) });

    // Another command has no family run; another repository's runs are never this one's; the operator's word wins.
    writeFileSync(join(other, "gate-y.sh"), "true\n");
    expect(gate(["run", "--as", "w1", "--", "bash", `${other}/gate-y.sh`], env, other).stderr).toMatch(/, estimate [\d.]+G from the default 25% \(no earlier run\) and /);
    expect(gate(["run", "--as", "w1", "--", "bash", `${strangerRoot}/gate-x.sh`], env, stranger).stderr).toMatch(/, estimate [\d.]+G from the default 25% \(no earlier run\) and /);
    expect(gate(["run", "--as", "w1", "--", "bash", `${third}/gate-x.sh`], { ...env, FLEET_GATE_MEMORY_MAX: "5G" }, third).stderr).toContain(", estimate 5.0G from $FLEET_GATE_MEMORY_MAX 5G (no earlier run) and ");

    // With no run of its own, a --mem below its family's peak is raised to that peak.
    writeFileSync(join(home, "gate", "runs.jsonl"), `${line(hour, 3 * GB)}\n`);
    const fourth = ws("fourth");
    writeFileSync(join(fourth, "gate-x.sh"), "true\n");
    const given = gate(["run", "--as", "w1", "--mem", "1G", "--", "bash", `${fourth}/gate-x.sh`], env, fourth);
    expect(given.stderr).toContain("gate run: --mem 1G is below this command's measured peak 3.0G: claiming 3.0G\n");
    expect(given.stderr).toContain(`, estimate 3.0G from --mem 1G raised to the 24 h peak of 'bash <workspace>/gate-x.sh' in ${root} (repository ${store}), 3.0G at ${hour} and `);
  });

  // A run's peak past its estimate is not killed: only the ceiling, the whole budget, limits it, and the peak raises
  // the next run's estimate, whatever its end.
  test("a run past its estimate goes on under the ceiling, the same for every run, and its peak, a failure's too, raises the next estimate", () => {
    const repo = gitRepo();
    const hog = ["python3", "-c", "x = bytearray(400 * 1024 * 1024); print('survived'); raise SystemExit(3)"];
    const over = gate(["run", "--as", "w1", "--mem", "64M", "--", ...hog], more, repo);
    expect(over.stdout).toBe("survived\n");
    expect(over.code).toBe(3);
    expect(over.stderr).toContain(`, estimate 64.0M from --mem and `);
    expect(over.stderr).toContain(`; MemoryMax=${sizeText(budgetBytes())} (the budget`);
    const [ran] = records();
    expect(ran).toMatchObject({ estimate: 64 * 1024 ** 2, cap: budgetBytes(), code: 3, killed: 0 });
    const peak = asNumber(ran?.["peak"]) ?? 0;
    expect(peak).toBeGreaterThan(400 * 1024 ** 2);

    const next = gate(["run", "--as", "w1", "--", ...hog], more, repo);
    expect(next.stderr).toContain(`, estimate 2.0G from its last run (${sizeText(peak)} peak at ${String(ran?.["at"])}) and `);
    expect(records()[1]).toMatchObject({ asked: "last runs", estimate: 2 * 1024 ** 3, cap: budgetBytes() });
  });

  test("outside a repository a run keeps neither, and is never capped from an earlier one", () => {
    const dir = tmp("fleet-gate-norepo-");
    expect(gate(["run", "--as", "w1", "--", "true"], more, dir).code).toBe(0);
    expect(gate(["run", "--as", "w1", "--", "true"], more, dir).stderr).toContain("(no earlier run)");
    expect(Object.keys(records()[0] ?? {})).not.toContain("repo");
    expect(Object.keys(records()[0] ?? {})).not.toContain("commit");
  });

  test("lines an older fleet kept, without the new fields, still read", () => {
    const repo = gitRepo();
    mkdirSync(join(home, "gate"), { recursive: true });
    const older = { at: new Date().toISOString(), name: "w", kind: "session", what: "true", asked: "25%", cap: 16 * 1024 ** 3, waited: 30, ran: 5, code: 0, peak: 1024 ** 3, killed: 0 };
    writeFileSync(join(home, "gate", "runs.jsonl"), `${JSON.stringify(older)}\n`);

    // The older line names no repository: it is no run's history.
    expect(gate(["run", "--as", "w1", "--", "true"], more, repo).stderr).toContain("(no earlier run)");
    expect(records().length).toBe(2);
    expect(gate([]).stdout).toMatch(/^last 24 h: 2 runs, wait median 0s, p90 30s, memory peak max 1\.0G$/m);
  });
});

describe.skipIf(!SCOPE)("gate run's asks: the CPUs, light runs, --landing", () => {
  const GB = 1024 ** 3;
  const AT = "2026-10-20T12:00:00.000Z";
  const half = Math.max(2, Math.floor(cpusHere() / 2));
  /** A CPU budget of half the machine's CPUs and 8, on any machine. */
  const cpuEnv = { FLEET_GATE_SCOPE: "1", FLEET_GATE_CPU_BUDGET: String(half + 8) };
  const memEnv = { FLEET_GATE_SCOPE: "1", FLEET_GATE_MEMORY_BUDGET: "32G", FLEET_GATE_MEMORY_MAX: "16G", FLEET_GATE_MEMORY_FLOOR: "0" };

  /** A git repository: its directory, and the repository its runs are kept under. */
  interface Repository {
    readonly dir: string;
    readonly id: string;
  }

  function repository(): Repository {
    const dir = tmp("fleet-gate-ask-");
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: dir }).exitCode).toBe(0);

    return { dir, id: realpathSync(join(dir, ".git")) };
  }

  /** Runs kept before the test's, a line each. */
  function kept(...runs: readonly JsonObject[]): void {
    mkdirSync(join(home, "gate"), { recursive: true });
    const line = (more: JsonObject): string => JSON.stringify({ at: AT, name: "w", kind: "session", asked: "25%", cap: 16 * GB, waited: 0, ran: 60, code: 0, peak: GB, killed: 0, ...more });
    writeFileSync(join(home, "gate", "runs.jsonl"), `${runs.map(line).join("\n")}\n`);
  }

  function last(): JsonObject {
    return records().at(-1) ?? {};
  }

  // A fleet's gate is one script that runs the tiers one after another: one gate run, one scope, one cap.
  test("a landing gate that is a script of tiers is admitted once, estimated from that script's runs in any session's scratchpad", () => {
    const repo = repository();

    const pad = (session: string): string => {
      const dir = join(tmp("fleet-gate-pad-"), session, "scratchpad");

      mkdirSync(dir, { recursive: true });

      return dir;
    };

    const before = join(pad("21adec87-2e88-42c8-b0b5-5f8352b34ddd"), "gate-grafo.sh");
    const now = join(pad("9f1c0d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"), "gate-grafo.sh");
    const seen = join(home, "seen.json");
    writeFileSync(now, ["#!/usr/bin/env bash", "echo '=== tier check'; true; c=$?", `cp ${holdFile()} ${seen}`, "echo '=== tier test'; sh -c true; t=$?",
      "echo '=== tier browser'; true; b=$?", `[ "$c$t$b" = "000" ]`, ""].join("\n"));
    kept({ repo: repo.id, what: `bash ${before}`, landing: true, peak: 6.8 * GB });

    const done = gate(["run", "--as", "w1", "--landing", "--", "bash", now], memEnv, repo.dir);
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("=== tier check\n=== tier test\n=== tier browser\n");
    expect(done.stderr).toContain(`, estimate ${sizeText(memEstimate(6.8 * GB))} from its last run (6.8G peak at ${AT})`);

    // While its tiers ran, the gate held one hold, this run's: no tier asked the gate again.
    const during = asObject(JSON.parse(readFileSync(seen, "utf8"))) ?? {};
    const held = (asArray(during["holds"]) ?? [during]).map((hold) => asObject(hold) ?? {});
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ landing: true, cap: memEstimate(6.8 * GB) });
    expect(records()).toHaveLength(2);
    expect(last()).toMatchObject({ what: `bash ${now}`, landing: true, code: 0 });
  });

  test("--cpus past the CPU budget of all runs together is refused, exit 2, a landing gate's too: --landing has no room of its own", () => {
    const over = gate(["run", "--as", "w1", "--cpus", String(half + 9), "--", "true"], cpuEnv);
    expect(over.code).toBe(2);
    expect(over.stderr).toBe(`gate run: --cpus ${String(half + 9)} is more than the CPU budget of all runs together (${String(half + 8)}): ask for at most that\n`);
    expect(gate(["run", "--as", "w1", "--landing", "--cpus", String(half + 9), "--", "true"], cpuEnv).code).toBe(2);
    expect(gate(["run", "--as", "w1", "--cpus", String(half + 8), "--", "true"], cpuEnv).code).toBe(0);
    expect(last()).toMatchObject({ cpus: half + 8 });
  });

  test("--landing is recorded, and changes nothing else: the same estimate as the run unmarked", () => {
    const repo = repository();
    kept({ repo: repo.id, what: "true", ran: 100, cpu_s: 400, peak: 6 * GB });
    const marked = gate(["run", "--as", "w1", "--landing", "--", "true"], cpuEnv, repo.dir);
    expect(marked.code).toBe(0);
    expect(marked.stderr).toContain("w1 holds the gate as a landing gate (token");
    expect(last()).toMatchObject({ landing: true, estimate: memEstimate(6 * GB), cpus: 5 });
    const plain = gate(["run", "--as", "w1", "--", "true"], cpuEnv, repo.dir);
    expect(plain.code).toBe(0);
    expect(last()).toMatchObject({ estimate: memEstimate(6 * GB), cpus: 5 });
    expect(last()["landing"]).toBeUndefined();
  });

  test("a run estimates the CPUs its last runs used on average times 1.25, 2 at least; 8 with none", () => {
    const repo = repository();
    kept({ repo: repo.id, what: "true", ran: 100, cpu_s: 400 }, { repo: repo.id, what: "sh -c true", ran: 100, cpu_s: 10 });
    const sized = gate(["run", "--as", "w1", "--", "true"], cpuEnv, repo.dir);
    expect(sized.stderr).toContain(` and 5 of the ${String(half + 8)} CPUs of all runs from its last run (4.0 used on average)`);
    expect(last()["cpus"]).toBe(5);
    gate(["run", "--as", "w1", "--", "sh", "-c", "true"], cpuEnv, repo.dir);
    expect(last()["cpus"]).toBe(2);
    gate(["run", "--as", "w1", "--", "sh", "-c", ":"], cpuEnv, repo.dir);
    expect(last()["cpus"]).toBe(8);
  });

  // A 16-CPU machine's budget is 8: a suite that used 12 on a larger one would ask 15 and never fit.
  test("a run whose last runs give more CPUs than the CPU budget asks the budget, and is admitted", () => {
    const repo = repository();
    kept({ repo: repo.id, what: "true", ran: 100, cpu_s: 1200 });
    const small = { ...memEnv, FLEET_GATE_CPU_BUDGET: "8" };
    const done = gate(["run", "--as", "w1", "--wait", "0", "--", "true"], small, repo.dir);
    expect(done.code).toBe(0);
    expect(done.stderr).toContain(" and 8 of the 8 CPUs of all runs from its last run (12.0 used on average)");
    expect(last()).toMatchObject({ code: 0, cpus: 8 });
  });

  test("a light run: an estimate of 4G at most and each of its last 3 runs 2 minutes at most, each at its bound", () => {
    const repo = repository();
    kept(
      { repo: repo.id, what: "true", ran: 120, peak: 3.2 * GB },
      { repo: repo.id, what: "sh -c true", ran: 121, peak: GB },
      { repo: repo.id, what: "sh -c :", ran: 60, peak: 3.3 * GB },
      { repo: repo.id, what: "echo", ran: 121, peak: GB },
      { repo: repo.id, what: "echo", ran: 30, peak: GB },
      { repo: repo.id, what: "echo", ran: 30, peak: GB },
    );
    const light = gate(["run", "--as", "w1", "--", "true"], { FLEET_GATE_SCOPE: "1" }, repo.dir);
    expect(light.stderr).toContain(", estimate 4.0G from its last run");
    expect(light.stderr).toContain("w1 holds the gate, a light run (token");
    expect(last()).toMatchObject({ what: "true", light: true });
    expect(gate(["run", "--as", "w1", "--", "sh", "-c", "true"], { FLEET_GATE_SCOPE: "1" }, repo.dir).stderr).not.toContain("a light run");
    expect(last()).not.toHaveProperty("light");
    const big = gate(["run", "--as", "w1", "--", "sh", "-c", ":"], { FLEET_GATE_SCOPE: "1" }, repo.dir);
    expect(big.stderr).toContain(", estimate 4.1G from its last run");
    expect(big.stderr).not.toContain("a light run");
    // A first run is never light, however small its estimate: it has no runs to say it is short.
    expect(gate(["run", "--as", "w1", "--mem", "2G", "--", "sh", "-c", "exit 0"], { FLEET_GATE_SCOPE: "1" }, repo.dir).stderr).not.toContain("a light run");
    // Two short runs and one of 121s before them: not light.
    const third = gate(["run", "--as", "w1", "--", "echo"], { FLEET_GATE_SCOPE: "1" }, repo.dir);
    expect(third.stderr).toContain("from its last 3 runs");
    expect(third.stderr).not.toContain("a light run");
  });

  // 2026-10-20 13:37: load 66.8 on 32 cores with 25G available; a gate timed out with no failed assertion.
  test("a run whose memory fits waits while the holds' CPUs fill the CPU budget, and its line says it waits for CPU", async () => {
    const both = { ...memEnv, ...cpuEnv };
    const runs = [running(["--as", "gate", "--landing", "--cpus", String(half), "--", "sleep", "30"], both), running(["--as", "bench", "--mem", "2G", "--cpus", "8", "--", "sleep", "30"], both)];

    try {
      expect(await until(() => standing().holders.length === 2, 10000)).toBe(true);
      expect(standing().holders.reduce((sum, h) => sum + (asNumber(h["cpus"]) ?? 0), 0)).toBe(half + 8);

      const late = gate(["run", "--as", "late", "--mem", "2G", "--cpus", "2", "--wait", "1", "--", "sh", "-c", "echo ran"], both);
      expect(late.code).toBe(75);
      expect(late.stdout).toBe("");
      expect(late.stderr).toContain("gate run: waiting for CPU: the gate is held by ");
      expect(late.stderr).not.toContain("waiting for memory");
      expect(last()).toMatchObject({ name: "late", code: 75, waited_for: ["cpu"] });
      const behind = (asArray(last()["behind"]) ?? []).map((b) => asObject(b) ?? {}).toSorted((a, b) => String(a["name"]).localeCompare(String(b["name"])));
      expect(behind).toEqual([{ name: "bench" }, { name: "gate", landing: true }]);
    } finally {
      await stopAll(runs);
    }
  });

  test("a tier and a light run, each at the CPUs its last runs give, run at once", async () => {
    const repo = repository();
    kept({ repo: repo.id, what: "sleep 30", ran: 300, cpu_s: 1200, peak: 3 * GB }, { repo: repo.id, what: "true", ran: 10, cpu_s: 1, peak: 0.1 * GB });
    const tier = running(["--as", "tier", "--", "sleep", "30"], cpuEnv, repo.dir);

    try {
      expect(await until(() => standing().holders.length === 1, 10000)).toBe(true);
      expect(standing().holders[0]?.["cpus"]).toBe(5);
      const light = gate(["run", "--as", "light", "--wait", "0", "--", "true"], cpuEnv, repo.dir);
      expect(light.stderr).toContain("light holds the gate, a light run (token");
      expect(light.code).toBe(0);
      expect(last()).toMatchObject({ name: "light", cpus: 2, light: true });
    } finally {
      await stopAll([tier]);
    }
  });
});
