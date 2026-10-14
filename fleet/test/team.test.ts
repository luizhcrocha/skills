/**
 * `fleet team start|stop|attach|list` (src/cli/team.ts, src/team/team.ts) through the CLI's interface, over the
 * fake multiplexer (team-launcher-fake.ts), a temporary registry (FLEET_HOME), a temporary home and a temporary
 * repo. Nothing here touches herdr, a live ledger or the live registry.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { teamWith } from "../src/cli/team.ts";
import type { Why } from "../src/team/agents.ts";
import { recordingOut } from "../src/io.ts";
import { World } from "../src/world.ts";
import { baseEnv, machine, tmp, type Environment, type Ran } from "./support.ts";
import { FakeLauncher } from "./team-launcher-fake.ts";

interface Place {
  readonly repo: string;
  readonly session: string;
  readonly env: Environment;
  readonly home: string;
  readonly registry: string;
}

function place(agents: Readonly<Record<string, string>> = { ui: '{"fleet": {"role": "coordinator"}}' }): Place {
  const repo = tmp("fleet-team-repo-");
  const home = tmp("fleet-team-home-");
  // Below a folder of its own, so baseEnv takes it as the registry (one straight in the temp dir gets a fleet-board/ under it).
  const registry = join(tmp("fleet-team-registry-"), "fleet-board");
  mkdirSync(registry);
  mkdirSync(join(repo, ".fleet", "agents"), { recursive: true });

  for (const [name, text] of Object.entries(agents)) writeFileSync(join(repo, ".fleet", "agents", `${name}.json`), text);

  return { repo, home, registry, session: basename(repo), env: baseEnv(registry, { HOME: home, CLAUDE_CONFIG_DIR: tmp("fleet-team-config-") }) };
}

function team(at: Place, launcher: FakeLauncher, ...argv: string[]): Ran {
  const { layer, recorded } = recordingOut();
  const world = Layer.succeed(World, machine(at.env));
  const code = Effect.runSync(teamWith(argv, () => launcher, at.repo).pipe(Effect.provide(Layer.mergeAll(world, layer))));

  return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
}

function served(at: Place, id: string, dir: string, pid: number): void {
  writeFileSync(join(at.registry, `${id}.json`), JSON.stringify({ id, dir, pid, session: id, role: "coordinator", since: "2026-10-14T00:00:00Z" }));
}

const LEDGER = (at: Place, name: string): string => join(at.home, ".local/state/fleet", name);

describe("start", () => {
  test("opens the repo's session, one tab per agent running a new claude, then sends its opening naming the ledger", () => {
    const at = place({ ui: '{"fleet": {"role": "coordinator"}}', boss: '{"system": "Keep the fleets moving.", "fleet": {"role": "manager", "remote_control": false}}' });
    const herdr = new FakeLauncher();
    const ran = team(at, herdr, "start");

    expect(ran).toEqual({
      code: 0,
      stdout:
        `started session ${at.session}\n` +
        `boss: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "boss")}\n` +
        `ui: started in session ${at.session}, tab w1:t2; its ledger is ${LEDGER(at, "ui")}\n`,
      stderr: "",
    });
    expect(herdr.calls).toEqual([`open ${at.session} ${at.repo}`, `tab ${at.session} boss`, `prompt ${at.session} boss`, `tab ${at.session} ui`, `prompt ${at.session} ui`]);
    expect([...herdr.launches.values()].map((l) => ({ cwd: l.cwd, label: l.label, agent: l.agent.name, system: l.agent.system }))).toEqual([
      { cwd: at.repo, label: "boss", agent: "boss", system: "Keep the fleets moving." },
      { cwd: at.repo, label: "ui", agent: "ui", system: undefined },
    ]);
    expect(herdr.prompts).toEqual([`boss: /tstack:manager Your ledger is ${LEDGER(at, "boss")}.`, `ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
  });

  test("is idempotent: an agent it already runs in this session is reported and left", () => {
    const at = place();
    const herdr = new FakeLauncher();
    team(at, herdr, "start", "ui");
    const again = team(at, herdr, "start", "ui");

    expect(again).toEqual({ code: 0, stdout: `ui: already running in session ${at.session}, tab w1:t1; left as it is\n`, stderr: "" });
    expect(herdr.calls.filter((c) => c.startsWith("tab "))).toHaveLength(1);
  });

  test("an agent blocked at its start on a prompt keeps its tab and says how to answer it; a second start sends its opening", () => {
    const at = place();
    const herdr = new FakeLauncher();
    herdr.blockAtStart.add("ui");
    const first = team(at, herdr, "start", "ui");

    expect(first).toEqual({
      code: 1,
      stdout: `started session ${at.session}\n`,
      stderr:
        "team: ui: waits on a prompt in its tab w1:t1 before it is ready, the tab kept open (a startup prompt: trust, an MCP server's approval, ...): " +
        "run `fleet team attach`, answer it, then `fleet team start ui` again, which sends its opening and leaves the running agent as it is\n",
    });
    expect(herdr.calls.filter((c) => c.startsWith("close ") || c.startsWith("prompt "))).toEqual([]);

    const unanswered = team(at, herdr, "start", "ui");

    expect(unanswered.code).toBe(1);
    expect(unanswered.stderr).toBe("team: ui: still waits on a prompt in its tab w1:t1: run `fleet team attach`, answer it, then `fleet team start ui` again\n");

    herdr.answer(at.session, "ui");
    const again = team(at, herdr, "start", "ui");

    expect(again).toEqual({ code: 0, stdout: `ui: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "ui")}\n`, stderr: "" });
    expect(herdr.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
    expect(herdr.calls.filter((c) => c.startsWith("tab "))).toHaveLength(1);
    expect(team(at, herdr, "start", "ui").stdout).toBe(`ui: already running in session ${at.session}, tab w1:t1; left as it is\n`);
  });

  test("team.json names the session", () => {
    const at = place();
    writeFileSync(join(at.repo, ".fleet", "team.json"), '{"session": "skills"}');
    const herdr = new FakeLauncher();

    expect(team(at, herdr, "start").stdout).toStartWith("started session skills\n");
  });

  test("refuses an agent running in another session, saying where", () => {
    const at = place();
    const herdr = new FakeLauncher().seed("default", [{ handle: "w2:t4", label: "notes" }], [{ name: "ui", tab: "w2:t4", status: "ready" }]);
    const ran = team(at, herdr, "start", "ui");

    expect(ran).toEqual({ code: 1, stdout: "", stderr: "team: ui: already running elsewhere: session default runs an agent named ui; stop it there first\n" });
    expect(herdr.calls.some((c) => c.startsWith("tab "))).toBe(false);
  });

  test("an agent already running in this session that fleet team did not start is reported and left", () => {
    const at = place();
    const herdr = new FakeLauncher().seed(basename(at.repo), [{ handle: "w1:t9", label: "ui" }]);

    expect(team(at, herdr, "start", "ui")).toEqual({ code: 0, stdout: `ui: already running: session ${at.session} has a tab labelled ui (w1:t9), not started by fleet team; left as it is\n`, stderr: "" });
    expect(herdr.calls.some((c) => c.startsWith("tab "))).toBe(false);
  });

  test("refuses an agent whose name is a tab of another session", () => {
    const at = place();
    const herdr = new FakeLauncher().seed("work", [{ handle: "w1:t3", label: "ui" }]);

    expect(team(at, herdr, "start", "ui").stderr).toBe("team: ui: already running elsewhere: session work has a tab labelled ui (w1:t3); stop it there first\n");
  });

  test("refuses an agent the registry serves, naming the fleet", () => {
    const at = place();
    served(at, "ui", join(at.home, "scratch", "fleet"), process.pid);
    const ran = team(at, new FakeLauncher(), "start", "ui");

    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(`team: ui: already running elsewhere: the registry serves fleet ui from ${join(at.home, "scratch", "fleet")}; stop it there first\n`);
  });

  test("refuses an agent on another machine: it needs a launcher there", () => {
    const at = place({ ui: '{"fleet": {"role": "coordinator", "machine": "mac"}}' });
    const ran = team(at, new FakeLauncher(), "start");

    expect(ran.stderr).toBe("team: ui: runs on machine 'mac'; an agent away from this machine needs a launcher on that machine, which is not built; only local agents start\n");
    expect(ran.code).toBe(1);
  });

  test("a ledger the registry kept is named in the opening where it is, nothing moved", () => {
    const at = place();
    const old = join(at.home, "scratch", "fleet");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "state.json"), "{}");
    served(at, "ui", old, 2_147_000_000);
    const launcher = new FakeLauncher();
    const ran = team(at, launcher, "start", "ui");

    expect(ran.code).toBe(0);
    expect(launcher.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${old}.`]);
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(existsSync(LEDGER(at, "ui"))).toBe(false);
  });

  test("an agent not defined is refused, naming those that are", () => {
    const at = place();

    expect(team(at, new FakeLauncher(), "start", "web")).toEqual({ code: 1, stdout: "", stderr: `team: no agent web in ${at.repo}/.fleet/agents (defined: ui)\n` });
  });
});

describe("stop", () => {
  test("waits until the agent is idle, closes its tab, and stops the session it started once nothing is left", () => {
    const at = place();
    const herdr = new FakeLauncher();
    team(at, herdr, "start", "ui");
    const ran = team(at, herdr, "stop", "ui");

    expect(ran).toEqual({ code: 0, stdout: `ui: stopped: tab w1:t1 closed once it was ready\nsession ${at.session} stopped: fleet team started it and nothing is left in it\n`, stderr: "" });
    expect(herdr.calls.slice(-3)).toEqual([`settle ${at.session} ui`, `close ${at.session} w1:t1`, `end ${at.session}`]);
  });

  test("an agent whose start blocked on a prompt (opening unsent, still asking) is closed at once; one started normally that asks mid-task is waited for", () => {
    const at = place({ ui: '{"fleet": {"role": "coordinator"}}', web: '{"fleet": {"role": "coordinator"}}' });
    const herdr = new FakeLauncher();
    herdr.blockAtStart.add("ui");
    team(at, herdr, "start");
    herdr.seed(at.session, [{ handle: "w1:t1", label: "ui" }, { handle: "w1:t2", label: "web" }], [{ name: "ui", tab: "w1:t1", status: "asking" }, { name: "web", tab: "w1:t2", status: "asking" }]);
    const ran = team(at, herdr, "stop", "all");

    expect(ran).toEqual({
      code: 0,
      stdout: "ui: stopped: tab w1:t1 closed at once: it waited on a prompt\nweb: stopped: tab w1:t2 closed once it was ready\n",
      stderr: "",
    });
    expect(herdr.calls.filter((c) => c.startsWith("settle "))).toEqual([`settle ${at.session} web`]);
  });

  test("an agent whose opening is unsent but no longer asks is waited for", () => {
    const at = place();
    const herdr = new FakeLauncher();
    herdr.blockAtStart.add("ui");
    team(at, herdr, "start", "ui");
    herdr.seed(at.session, [{ handle: "w1:t1", label: "ui" }], [{ name: "ui", tab: "w1:t1", status: "working" }]);
    const ran = team(at, herdr, "stop", "ui");

    expect(ran.stdout).toStartWith("ui: stopped: tab w1:t1 closed once it was ready\n");
    expect(herdr.calls.filter((c) => c.startsWith("settle "))).toEqual([`settle ${at.session} ui`]);
  });

  test("--force closes at once, and a session it did not start is left running", () => {
    const at = place();
    const herdr = new FakeLauncher().seed(basename(at.repo));
    team(at, herdr, "start", "ui");
    const ran = team(at, herdr, "stop", "--force", "all");

    expect(ran).toEqual({ code: 0, stdout: "ui: stopped: tab w1:t1 closed\n", stderr: "" });
    expect(herdr.calls.some((c) => c.startsWith("settle ") || c.startsWith("end "))).toBe(false);
  });

  test("refuses a tab it did not start, even one labelled with the agent's name", () => {
    const at = place();
    const herdr = new FakeLauncher().seed(basename(at.repo), [{ handle: "w1:t9", label: "ui" }]);
    const ran = team(at, herdr, "stop", "ui");

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: ui: fleet team did not start it in session ${at.session}; left as it is\n` });
    expect(herdr.calls.some((c) => c.startsWith("close "))).toBe(false);
  });

  test("names the agents or all", () => {
    const ran = team(place(), new FakeLauncher(), "stop");

    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("fleet team: error: stop names the agents to stop, or all");
  });
});

describe("list and attach", () => {
  test("list says of each agent: running here, elsewhere (where), or not running", () => {
    const at = place({ ui: '{"fleet": {"role": "coordinator"}}', web: '{"fleet": {"role": "coordinator"}}', boss: '{"fleet": {"role": "manager"}}' });
    const herdr = new FakeLauncher().seed("default", [], [{ name: "web", tab: "w3:t1", status: "working" }]);
    team(at, herdr, "start", "ui");

    expect(team(at, herdr, "list")).toEqual({
      code: 0,
      stdout: `boss  not running\nui  running here: session ${at.session}, tab w1:t1, working\nweb  running elsewhere: session default runs an agent named web\n`,
      stderr: "",
    });
  });

  test("attach attaches to the team's session", () => {
    const at = place();
    const herdr = new FakeLauncher();

    expect(team(at, herdr, "attach").code).toBe(0);
    expect(herdr.calls).toEqual([`attach ${at.session}`]);
  });

  test("a command not among them and an unset HOME are refused", () => {
    const at = place();

    expect(team(at, new FakeLauncher(), "begin").stderr).toEndWith("fleet team: error: argument cmd: invalid choice: 'begin' (choose from 'start', 'stop', 'attach', 'list')\n");
    expect(team({ ...at, env: { ...at.env, HOME: "" } }, new FakeLauncher(), "list")).toEqual({ code: 1, stdout: "", stderr: "team: HOME is not set, and the ledgers' fixed homes are under it (~/.local/state/fleet)\n" });
  });

  test("a repo with no agents says where they go", () => {
    const at = place({});

    expect(team(at, new FakeLauncher(), "list")).toEqual({ code: 1, stdout: "", stderr: `team: no agents defined: ${at.repo}/.fleet/agents/<name>.json defines one\n` });
  });
});

describe("safety", () => {
  test("after a reboot, a restored shell tab with the marked tab's id and label is not its agent: stop closes nothing and start leaves it as a stranger's", () => {
    const at = place();
    team(at, new FakeLauncher(), "start", "ui");
    const rebooted = new FakeLauncher().seed(basename(at.repo), [{ handle: "w1:t1", label: "ui" }]);

    expect(team(at, rebooted, "stop", "--force", "ui")).toEqual({ code: 0, stdout: "ui: not running: its tab w1:t1 no longer runs it; its mark is dropped\n", stderr: "" });
    expect(rebooted.calls.filter((c) => c.startsWith("close ") || c.startsWith("end "))).toEqual([]);
    expect(team(at, rebooted, "start", "ui").stdout).toContain(`ui: already running: session ${at.session} has a tab labelled ui (w1:t1), not started by fleet team; left as it is\n`);
  });

  test("a session it started is not stopped once another instance of it runs: the mark is dropped when start reuses it", () => {
    const at = place();
    const first = new FakeLauncher();
    team(at, first, "start", "ui");
    const rebooted = new FakeLauncher().seed(basename(at.repo));
    team(at, rebooted, "start", "ui");
    team(at, rebooted, "stop", "--force", "ui");

    expect(rebooted.calls.filter((c) => c.startsWith("end "))).toEqual([]);
  });

  test("start and stop hold the team's lock while they drive the session", () => {
    const at = place();
    const lock = join(at.registry, "team", at.session, "team.lock");
    const held: string[] = [];
    mkdirSync(dirname(lock), { recursive: true });

    const herdr = new (class extends FakeLauncher {
      override open(name: string, cwd: string) {
        held.push(spawnSync("flock", ["-n", lock, "true"]).status === 0 ? "free" : "held");

        return super.open(name, cwd);
      }
    })();

    team(at, herdr, "start", "ui");

    expect(held).toEqual(["held"]);
  });

  test("a stop that cannot read the session refuses and keeps the mark", () => {
    const at = place();
    const herdr = new FakeLauncher();
    team(at, herdr, "start", "ui");

    const blind = new (class extends FakeLauncher {
      override look(): Why {
        return { why: "herdr could not run" };
      }
    })();

    expect(team(at, blind, "stop", "--force", "ui")).toEqual({ code: 1, stdout: "", stderr: `team: ui: session ${at.session} could not be read (herdr could not run); its tab w1:t1 is left, and so is its mark\n` });
    expect(team(at, herdr, "stop", "--force", "ui").stdout).toStartWith("ui: stopped: tab w1:t1 closed\n");
  });

  test("a session start brings up with restored tabs is looked at again: a restored tab labelled with the agent is left", () => {
    const at = place();

    const herdr = new (class extends FakeLauncher {
      override open(name: string, cwd: string) {
        const opened = super.open(name, cwd);
        this.seed(name, [{ handle: "w1:t7", label: "ui" }]);

        return opened;
      }
    })();

    expect(team(at, herdr, "start", "ui")).toEqual({
      code: 0,
      stdout: `started session ${at.session}\nui: already running: session ${at.session} has a tab labelled ui (w1:t7), not started by fleet team; left as it is\n`,
      stderr: "",
    });
    expect(herdr.calls.some((c) => c.startsWith("tab "))).toBe(false);
  });

  test("a session name that is a path or an option is refused", () => {
    for (const name of ["../x", "-x", "a b"]) {
      const at = place();
      writeFileSync(join(at.repo, ".fleet", "team.json"), JSON.stringify({ session: name }));

      expect(team(at, new FakeLauncher(), "list").stderr).toBe(`team: team.json: session '${name}' is not a session name: letters, digits, ., _ and -, starting with a letter or digit, at most 64; .fleet/team.json's "session" names another\n`);
    }
  });
});
