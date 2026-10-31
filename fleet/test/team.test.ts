/**
 * `fleet team start|stop|attach|list` (src/cli/team.ts, src/team/team.ts) through the CLI's interface, over the
 * fake multiplexer (team-launcher-fake.ts), a temporary registry (FLEET_HOME), a temporary home and a temporary
 * repo. Nothing here touches rex, a live ledger or the live registry.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { teamWith } from "../src/cli/team.ts";
import type { Why } from "../src/team/agents.ts";
import type { Asker } from "../src/team/trust.ts";
import { recordingOut } from "../src/io.ts";
import type { Json } from "../src/json.ts";
import { World } from "../src/world.ts";
import { cutOver, fakeHost, ledgerAt, listTeams, stopHosts, type FakeHost } from "./project-host-fake.ts";
import { baseEnv, machine, tmp, type Environment, type Ran } from "./support.ts";
import { FakeLauncher } from "./team-launcher-fake.ts";

interface Place {
  readonly repo: string;
  readonly session: string;
  readonly env: Environment;
  readonly home: string;
  readonly registry: string;
  /** Claude Code's `.claude.json`, in the test's own CLAUDE_CONFIG_DIR. */
  readonly claude: string;
}

function place(agents: Readonly<Record<string, string>> = { ui: '{"fleet": {"role": "coordinator"}}' }): Place {
  const repo = tmp("fleet-team-repo-");
  const home = tmp("fleet-team-home-");
  // Below a folder of its own, so baseEnv takes it as the registry (one straight in the temp dir gets a fleet-board/ under it).
  const registry = join(tmp("fleet-team-registry-"), "fleet-board");
  mkdirSync(registry);
  mkdirSync(join(repo, ".fleet", "agents"), { recursive: true });

  for (const [name, text] of Object.entries(agents)) writeFileSync(join(repo, ".fleet", "agents", `${name}.json`), text);

  const config = tmp("fleet-team-config-");
  const claude = join(config, ".claude.json");
  writeFileSync(claude, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));

  return { repo, home, registry, claude, session: basename(repo), env: baseEnv(registry, { HOME: home, CLAUDE_CONFIG_DIR: config }) };
}

function team(at: Place, launcher: FakeLauncher, ...argv: string[]): Ran {
  return teamAsking(at, launcher, undefined, ...argv);
}

function teamAsking(at: Place, launcher: FakeLauncher, ask: Asker | undefined, ...argv: string[]): Ran {
  const { layer, recorded } = recordingOut();
  const world = Layer.succeed(World, machine(at.env));
  const code = Effect.runSync(teamWith(argv, () => launcher, at.repo, ask).pipe(Effect.provide(Layer.mergeAll(world, layer))));

  return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
}

function served(at: Place, id: string, dir: string, pid: number): void {
  writeFileSync(join(at.registry, `${id}.json`), JSON.stringify({ id, dir, pid, session: id, role: "coordinator", since: "2026-10-14T00:00:00Z" }));
}

const LEDGER = (at: Place, name: string): string => join(at.home, ".local/state/fleet", name);

describe("start", () => {
  test("opens the repo's session, one tab per agent running a new claude, then sends its opening naming the ledger", () => {
    const at = place({ ui: '{"fleet": {"role": "coordinator"}}', boss: '{"system": "Keep the fleets moving.", "fleet": {"role": "manager", "remote_control": false}}' });
    const launcher = new FakeLauncher();
    const ran = team(at, launcher, "start");

    expect(ran).toEqual({
      code: 0,
      stdout:
        `started session ${at.session}\n` +
        `boss: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "boss")}\n` +
        `ui: started in session ${at.session}, tab w1:t2; its ledger is ${LEDGER(at, "ui")}\n`,
      stderr: "",
    });
    expect(launcher.calls).toEqual([`open ${at.session}`, `tab ${at.session} boss`, `prompt ${at.session} boss`, `tab ${at.session} ui`, `prompt ${at.session} ui`]);
    expect([...launcher.launches.values()].map((l) => ({ cwd: l.cwd, label: l.label, agent: l.agent.name, system: l.agent.system }))).toEqual([
      { cwd: at.repo, label: "boss", agent: "boss", system: "Keep the fleets moving." },
      { cwd: at.repo, label: "ui", agent: "ui", system: undefined },
    ]);
    expect(launcher.prompts).toEqual([`boss: /tstack:manager Your ledger is ${LEDGER(at, "boss")}.`, `ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
  });

  test("is idempotent: an agent it already runs in this session is reported and left", () => {
    const at = place();
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");
    const again = team(at, launcher, "start", "ui");

    expect(again).toEqual({ code: 0, stdout: `ui: already running in session ${at.session}, tab w1:t1; left as it is\n`, stderr: "" });
    expect(launcher.calls.filter((c) => c.startsWith("tab "))).toHaveLength(1);
  });

  test("an agent blocked at its start on a prompt keeps its tab and says how to answer it; a second start sends its opening", () => {
    const at = place();
    const launcher = new FakeLauncher();
    launcher.blockAtStart.add("ui");
    const first = team(at, launcher, "start", "ui");

    expect(first).toEqual({
      code: 1,
      stdout: `started session ${at.session}\n`,
      stderr:
        "team: ui: waits on a prompt in its tab w1:t1 before it is ready, the tab kept open (a startup prompt: trust, an MCP server's approval, ...): " +
        "run `fleet team attach`, answer it, then `fleet team start ui` again, which sends its opening and leaves the running agent as it is\n",
    });
    expect(launcher.calls.filter((c) => c.startsWith("close ") || c.startsWith("prompt "))).toEqual([]);

    const unanswered = team(at, launcher, "start", "ui");

    expect(unanswered.code).toBe(1);
    expect(unanswered.stderr).toBe("team: ui: still waits on a prompt in its tab w1:t1: run `fleet team attach`, answer it, then `fleet team start ui` again\n");

    launcher.answer(at.session, "ui");
    const again = team(at, launcher, "start", "ui");

    expect(again).toEqual({ code: 0, stdout: `ui: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "ui")}\n`, stderr: "" });
    expect(launcher.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
    expect(launcher.calls.filter((c) => c.startsWith("tab "))).toHaveLength(1);
    expect(team(at, launcher, "start", "ui").stdout).toBe(`ui: already running in session ${at.session}, tab w1:t1; left as it is\n`);
  });

  test("an agent whose program ended in the tab it started has that tab closed and starts again", () => {
    const at = place();
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");
    launcher.exit(at.session, "ui");

    expect(team(at, launcher, "start", "ui")).toEqual({
      code: 0,
      stdout: `ui: its program in tab w1:t1 had ended; the tab is closed\nui: started in session ${at.session}, tab w1:t2; its ledger is ${LEDGER(at, "ui")}\n`,
      stderr: "",
    });
    expect(launcher.calls.filter((c) => c.startsWith("close ") || c.startsWith("settle "))).toEqual([`close ${at.session} w1:t1`]);
  });

  test("an agent whose program ends while its unsent opening waits has its tab closed and starts again", () => {
    const at = place();
    const launcher = new FakeLauncher();
    launcher.blockAtStart.add("ui");
    team(at, launcher, "start", "ui");
    launcher.blockAtStart.delete("ui");
    launcher.answer(at.session, "ui");
    launcher.endWhileSettling.add("ui");

    expect(team(at, launcher, "start", "ui").stdout).toBe(`ui: its program in tab w1:t1 had ended; the tab is closed\nui: started in session ${at.session}, tab w1:t2; its ledger is ${LEDGER(at, "ui")}\n`);
    expect(launcher.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
  });

  test("team.json names the session", () => {
    const at = place();
    writeFileSync(join(at.repo, ".fleet", "team.json"), '{"session": "skills"}');
    const launcher = new FakeLauncher();

    expect(team(at, launcher, "start").stdout).toStartWith("started session skills\n");
  });

  test("refuses an agent running in another session, saying where", () => {
    const at = place();
    const launcher = new FakeLauncher().seed("default", [{ handle: "w2:t4", label: "notes" }], [{ name: "ui", tab: "w2:t4", status: "ready" }]);
    const ran = team(at, launcher, "start", "ui");

    expect(ran).toEqual({ code: 1, stdout: "", stderr: "team: ui: already running elsewhere: session default runs an agent named ui; stop it there first\n" });
    expect(launcher.calls.some((c) => c.startsWith("tab "))).toBe(false);
  });

  test("an agent already running in this session that fleet team did not start is reported and left", () => {
    const at = place();
    const launcher = new FakeLauncher().seed(basename(at.repo), [{ handle: "w1:t9", label: "ui" }]);

    expect(team(at, launcher, "start", "ui")).toEqual({ code: 0, stdout: `ui: already running: session ${at.session} has a tab labelled ui (w1:t9), not started by fleet team; left as it is\n`, stderr: "" });
    expect(launcher.calls.some((c) => c.startsWith("tab "))).toBe(false);
  });

  test("refuses an agent whose name is a tab of another session", () => {
    const at = place();
    const launcher = new FakeLauncher().seed("work", [{ handle: "w1:t3", label: "ui" }]);

    expect(team(at, launcher, "start", "ui").stderr).toBe("team: ui: already running elsewhere: session work has a tab labelled ui (w1:t3); stop it there first\n");
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
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");
    const ran = team(at, launcher, "stop", "ui");

    expect(ran).toEqual({ code: 0, stdout: `ui: stopped: tab w1:t1 closed once it was ready\nsession ${at.session} stopped: fleet team started it and nothing is left in it\n`, stderr: "" });
    expect(launcher.calls.slice(-3)).toEqual([`settle ${at.session} ui`, `close ${at.session} w1:t1`, `end ${at.session}`]);
  });

  test("an agent whose start blocked on a prompt (opening unsent, still asking) is closed at once; one started normally that asks mid-task is waited for", () => {
    const at = place({ ui: '{"fleet": {"role": "coordinator"}}', web: '{"fleet": {"role": "coordinator"}}' });
    const launcher = new FakeLauncher();
    launcher.blockAtStart.add("ui");
    team(at, launcher, "start");
    launcher.seed(at.session, [{ handle: "w1:t1", label: "ui" }, { handle: "w1:t2", label: "web" }], [{ name: "ui", tab: "w1:t1", status: "asking" }, { name: "web", tab: "w1:t2", status: "asking" }]);
    const ran = team(at, launcher, "stop", "all");

    expect(ran).toEqual({
      code: 0,
      stdout: "ui: stopped: tab w1:t1 closed at once: it waited on a prompt\nweb: stopped: tab w1:t2 closed once it was ready\n",
      stderr: "",
    });
    expect(launcher.calls.filter((c) => c.startsWith("settle "))).toEqual([`settle ${at.session} web`]);
  });

  test("an agent still silent at its start (its prompt not up: a trust or MCP question) is closed at once", () => {
    const at = place();
    const launcher = new FakeLauncher();
    launcher.blockAtStart.add("ui");
    team(at, launcher, "start", "ui");

    expect(team(at, launcher, "stop", "ui").stdout).toStartWith("ui: stopped: tab w1:t1 closed at once: it waited on a prompt\n");
    expect(launcher.calls.filter((c) => c.startsWith("settle "))).toEqual([]);
  });

  test("an agent whose opening is unsent but no longer asks is waited for", () => {
    const at = place();
    const launcher = new FakeLauncher();
    launcher.blockAtStart.add("ui");
    team(at, launcher, "start", "ui");
    launcher.seed(at.session, [{ handle: "w1:t1", label: "ui" }], [{ name: "ui", tab: "w1:t1", status: "working" }]);
    const ran = team(at, launcher, "stop", "ui");

    expect(ran.stdout).toStartWith("ui: stopped: tab w1:t1 closed once it was ready\n");
    expect(launcher.calls.filter((c) => c.startsWith("settle "))).toEqual([`settle ${at.session} ui`]);
  });

  test("an agent whose program ended is listed so and closed at once, without the wait; one that ends during the wait is closed then", () => {
    const at = place();
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");
    launcher.exit(at.session, "ui");

    expect(team(at, launcher, "list").stdout).toBe(`ui  running here: session ${at.session}, tab w1:t1, ended\n`);
    expect(team(at, launcher, "stop", "ui").stdout).toBe(`ui: stopped: tab w1:t1 closed at once: its program had ended\nsession ${at.session} stopped: fleet team started it and nothing is left in it\n`);
    expect(launcher.calls.filter((c) => c.startsWith("settle "))).toEqual([]);

    team(at, launcher, "start", "ui");
    launcher.endWhileSettling.add("ui");

    expect(team(at, launcher, "stop", "ui").stdout).toStartWith("ui: stopped: tab w1:t2 closed once its program ended\n");
  });

  test("--force closes at once, and a session it did not start is left running", () => {
    const at = place();
    const launcher = new FakeLauncher().seed(basename(at.repo));
    team(at, launcher, "start", "ui");
    const ran = team(at, launcher, "stop", "--force", "all");

    expect(ran).toEqual({ code: 0, stdout: "ui: stopped: tab w1:t1 closed\n", stderr: "" });
    expect(launcher.calls.some((c) => c.startsWith("settle ") || c.startsWith("end "))).toBe(false);
  });

  test("refuses a tab it did not start, even one labelled with the agent's name", () => {
    const at = place();
    const launcher = new FakeLauncher().seed(basename(at.repo), [{ handle: "w1:t9", label: "ui" }]);
    const ran = team(at, launcher, "stop", "ui");

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: ui: fleet team did not start it in session ${at.session}; left as it is\n` });
    expect(launcher.calls.some((c) => c.startsWith("close "))).toBe(false);
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
    const launcher = new FakeLauncher().seed("default", [], [{ name: "web", tab: "w3:t1", status: "working" }]);
    team(at, launcher, "start", "ui");

    expect(team(at, launcher, "list")).toEqual({
      code: 0,
      stdout: `boss  not running\nui  running here: session ${at.session}, tab w1:t1, working\nweb  running elsewhere: session default runs an agent named web\n`,
      stderr: "",
    });
  });

  test("list refuses when the team's session runs but cannot be read, or the sessions cannot; no session is not running", () => {
    const at = place();
    const launcher = new FakeLauncher();

    expect(team(at, launcher, "list")).toEqual({ code: 0, stdout: "ui  not running\n", stderr: "" });
    team(at, launcher, "start", "ui");

    const blind = new (class extends FakeLauncher {
      override look(): Why {
        return { why: "rex could not run" };
      }
    })().seed(at.session);

    expect(team(at, blind, "list")).toEqual({ code: 1, stdout: "", stderr: `team: session ${at.session} could not be read: rex could not run\n` });

    const none = new (class extends FakeLauncher {
      override sessions(): Why {
        return { why: "rex could not run" };
      }
    })();

    expect(team(at, none, "list")).toEqual({ code: 1, stdout: "", stderr: "team: the sessions could not be read: rex could not run\n" });
  });

  test("attach attaches to the team's session", () => {
    const at = place();
    const launcher = new FakeLauncher();

    expect(team(at, launcher, "attach").code).toBe(0);
    expect(launcher.calls).toEqual([`attach ${at.session}`]);
  });

  test("a command not among them and an unset HOME are refused", () => {
    const at = place();

    expect(team(at, new FakeLauncher(), "begin").stderr).toEndWith("fleet team: error: argument cmd: invalid choice: 'begin' (choose from 'start', 'stop', 'attach', 'list', 'add')\n");
    expect(team({ ...at, env: { ...at.env, HOME: "" } }, new FakeLauncher(), "list")).toEqual({ code: 1, stdout: "", stderr: "team: HOME is not set, and the ledgers' fixed homes are under it (~/.local/state/fleet)\n" });
  });

  test("a repo with no agents says where they go", () => {
    const at = place({});

    expect(team(at, new FakeLauncher(), "list")).toEqual({ code: 1, stdout: "", stderr: `team: no agents defined: ${at.repo}/.fleet/agents/<name>.json defines one\n` });
  });
});

/** Another repo of `at`'s folder name, with a ui agent, trusted. */
function twinOf(at: Place): Place {
  const twin = join(tmp("fleet-team-twin-"), basename(at.repo));
  mkdirSync(join(twin, ".fleet", "agents"), { recursive: true });
  writeFileSync(join(twin, ".fleet", "agents", "ui.json"), '{"fleet": {"role": "coordinator"}}');
  writeFileSync(at.claude, JSON.stringify({ projects: { [at.repo]: { hasTrustDialogAccepted: true }, [twin]: { hasTrustDialogAccepted: true } } }));

  return { ...at, repo: twin };
}

describe("safety", () => {
  test("another repo of the same folder name is refused while this one's team runs, saying how to name its own; free once it stops", () => {
    const at = place();
    const other = twinOf(at);
    const twin = other.repo;
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");
    const why = `team: session ${at.session} is the team of ${at.repo}, which fleet team runs; name this repo's in its .fleet/team.json ("session")\n`;

    for (const argv of [["start"], ["stop", "ui"], ["list"], ["attach"]]) expect(team(other, launcher, ...argv)).toEqual({ code: 1, stdout: "", stderr: why });
    expect(launcher.calls.filter((c) => !c.startsWith("open ") && !c.startsWith("tab ") && !c.startsWith("prompt "))).toEqual([]);

    team(at, launcher, "stop", "ui");

    expect(team(other, launcher, "start").stdout).toBe(`started session ${at.session}\nui: started in session ${at.session}, tab w1:t2; its ledger is ${LEDGER(at, "ui")}\n`);
    expect(team(at, launcher, "list")).toEqual({ code: 1, stdout: "", stderr: `team: session ${at.session} is the team of ${twin}, which fleet team runs; name this repo's in its .fleet/team.json ("session")\n` });
  });

  test("another repo's marks that no longer hold (after a reboot, or its session closed in the Rex app) leave the session free", () => {
    const at = place();
    const other = twinOf(at);
    team(at, new FakeLauncher(), "start", "ui");
    const rebooted = new FakeLauncher();

    expect(team(other, rebooted, "start")).toEqual({ code: 0, stdout: `started session ${at.session}\nui: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "ui")}\n`, stderr: "" });
    expect(team(at, rebooted, "list").stderr).toBe(`team: session ${at.session} is the team of ${other.repo}, which fleet team runs; name this repo's in its .fleet/team.json ("session")\n`);
  });

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

    const launcher = new (class extends FakeLauncher {
      override open(name: string) {
        held.push(spawnSync("flock", ["-n", lock, "true"]).status === 0 ? "free" : "held");

        return super.open(name);
      }
    })();

    team(at, launcher, "start", "ui");

    expect(held).toEqual(["held"]);
  });

  test("a stop that cannot read the session refuses and keeps the mark", () => {
    const at = place();
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");

    const blind = new (class extends FakeLauncher {
      override look(): Why {
        return { why: "rex could not run" };
      }
    })();

    expect(team(at, blind, "stop", "--force", "ui")).toEqual({ code: 1, stdout: "", stderr: `team: ui: session ${at.session} could not be read (rex could not run); its tab w1:t1 is left, and so is its mark\n` });
    expect(team(at, launcher, "stop", "--force", "ui").stdout).toStartWith("ui: stopped: tab w1:t1 closed\n");
  });

  test("a session name that is a path or an option is refused", () => {
    for (const name of ["../x", "-x", "a b"]) {
      const at = place();
      writeFileSync(join(at.repo, ".fleet", "team.json"), JSON.stringify({ session: name }));

      expect(team(at, new FakeLauncher(), "list").stderr).toBe(`team: team.json: session '${name}' is not a session name: letters, digits, ., _ and -, starting with a letter or digit, at most 64; .fleet/team.json's "session" names another\n`);
    }
  });
});

describe("trust", () => {
  const SETTINGS = { numStartups: 7, oauthAccount: { emailAddress: "someone@example.com" }, projects: { "/elsewhere": { allowedTools: ["Bash"], hasTrustDialogAccepted: false } } };

  /** A place whose repo Claude Code does not trust yet, its config holding other content, mode 0600. */
  function untrusted(): Place {
    const at = place();
    writeFileSync(at.claude, `${JSON.stringify(SETTINGS, null, 2)}\n`);
    chmodSync(at.claude, 0o600);

    return at;
  }

  function asker(answer: boolean): Asker & { readonly asked: string[] } {
    const asked: string[] = [];

    return Object.assign((question: string) => {
      asked.push(question);

      return answer;
    }, { asked });
  }

  const config = (at: Place): Json => JSON.parse(readFileSync(at.claude, "utf8"));

  test("an untrusted repo asks the owner; a yes sets only its key, keeps the rest and the file's mode, then starts", () => {
    const at = untrusted();
    const ask = asker(true);
    const launcher = new FakeLauncher();
    const ran = teamAsking(at, launcher, ask, "start");

    expect(ask.asked).toEqual([`trust ${at.repo} for Claude Code? Its agents read, edit and run files there. [y/N] `]);
    expect(ran.code).toBe(0);
    expect(ran.stdout.split("\n")[0]).toBe(`trusted ${at.repo} for Claude Code in ${at.claude}`);
    expect(config(at)).toEqual({ ...SETTINGS, projects: { ...SETTINGS.projects, [at.repo]: { hasTrustDialogAccepted: true } } });
    expect(statSync(at.claude).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(at.claude))).toEqual([".claude.json"]);
    expect(launcher.calls).toContain(`tab ${at.session} ui`);
  });

  test("a no refuses and starts nothing, the file left as it was", () => {
    const at = untrusted();
    const before = readFileSync(at.claude, "utf8");
    const launcher = new FakeLauncher();

    expect(teamAsking(at, launcher, asker(false), "start")).toEqual({ code: 1, stdout: "", stderr: `team: ${at.repo} not trusted for Claude Code; nothing started\n` });
    expect(launcher.calls).toEqual([]);
    expect(readFileSync(at.claude, "utf8")).toBe(before);
  });

  test("an untrusted repo whose agents all run already asks nothing and starts nothing", () => {
    const at = untrusted();
    const before = readFileSync(at.claude, "utf8");
    const ask = asker(true);
    const launcher = new FakeLauncher().seed(at.session, [{ handle: "w1:t9", label: "ui" }]);
    const ran = teamAsking(at, launcher, ask, "start");

    expect(ask.asked).toEqual([]);
    expect(ran.code).toBe(0);
    expect(launcher.calls.some((c) => c.startsWith("tab "))).toBe(false);
    expect(readFileSync(at.claude, "utf8")).toBe(before);
  });

  test("with no terminal and no --trust, start refuses naming --trust; --trust writes the key without asking", () => {
    const at = untrusted();
    const launcher = new FakeLauncher();

    expect(team(at, launcher, "start")).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: Claude Code does not trust ${at.repo} yet, and there is no terminal to ask on: \`fleet team start --trust\` trusts it\n`,
    });
    expect(launcher.calls).toEqual([]);

    const ask = asker(false);
    const ran = teamAsking(at, launcher, ask, "start", "--trust");

    expect(ask.asked).toEqual([]);
    expect(ran.code).toBe(0);
    expect(config(at)).toEqual({ ...SETTINGS, projects: { ...SETTINGS.projects, [at.repo]: { hasTrustDialogAccepted: true } } });
  });

  test("a trusted repo is neither asked about nor written", () => {
    const at = place();
    const before = readFileSync(at.claude, "utf8");
    const ask = asker(false);

    expect(teamAsking(at, new FakeLauncher(), ask, "start", "--trust").code).toBe(0);
    expect(ask.asked).toEqual([]);
    expect(readFileSync(at.claude, "utf8")).toBe(before);
  });

  test("the key is the git root above the agents' folder, and another start's temp file is left alone", () => {
    const at = untrusted();
    const below = join(at.repo, "sub");
    mkdirSync(join(below, ".fleet", "agents"), { recursive: true });
    writeFileSync(join(below, ".fleet", "agents", "ui.json"), '{"fleet": {"role": "coordinator"}}');
    mkdirSync(join(at.repo, ".git"));
    writeFileSync(`${at.claude}.fleet-trust.tmp`, "another start's");
    const { layer } = recordingOut();
    const code = Effect.runSync(teamWith(["start", "--trust"], () => new FakeLauncher(), below, undefined).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(World, machine(at.env)), layer))));

    expect(code).toBe(0);
    expect(config(at)).toEqual({ ...SETTINGS, projects: { ...SETTINGS.projects, [at.repo]: { hasTrustDialogAccepted: true } } });
    expect(readdirSync(dirname(at.claude)).toSorted()).toEqual([".claude.json", ".claude.json.fleet-trust.tmp"]);
    expect(readFileSync(`${at.claude}.fleet-trust.tmp`, "utf8")).toBe("another start's");
  });

  test("the file is read again after the answer: what a session wrote meanwhile is kept", () => {
    const at = untrusted();

    const ask: Asker = () => {
      writeFileSync(at.claude, JSON.stringify({ ...SETTINGS, numStartups: 8 }));

      return true;
    };

    expect(teamAsking(at, new FakeLauncher(), ask, "start").code).toBe(0);
    expect(config(at)).toEqual({ ...SETTINGS, numStartups: 8, projects: { ...SETTINGS.projects, [at.repo]: { hasTrustDialogAccepted: true } } });
  });

  test("a missing or unparsable config is refused, never created or clobbered, its content never said", () => {
    const at = untrusted();
    writeFileSync(at.claude, '{"oauthAccount": "secret-ish", ');
    const ran = team(at, new FakeLauncher(), "start", "--trust");

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: Claude Code's config ${at.claude} is not a JSON object; fleet team leaves it as it is\n` });
    expect(readFileSync(at.claude, "utf8")).toBe('{"oauthAccount": "secret-ish", ');

    const gone = { ...at, env: { ...at.env, CLAUDE_CONFIG_DIR: join(at.home, "nowhere") } };

    expect(team(gone, new FakeLauncher(), "start", "--trust")).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: Claude Code's config ${join(at.home, "nowhere", ".claude.json")} could not be read (No such file or directory); fleet team does not create it: run claude once, then start again\n`,
    });
    expect(existsSync(join(at.home, "nowhere"))).toBe(false);
  });

  test("a repo that is the home folder, HOME given through a symlink, is refused: Claude Code never keeps trust there", () => {
    const at = untrusted();
    const home = join(tmp("fleet-team-link-"), "home");
    symlinkSync(at.repo, home);
    const ran = team({ ...at, env: { ...at.env, HOME: home } }, new FakeLauncher(), "start", "--trust");

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: ${at.repo} is the home folder or a folder above it: Claude Code never keeps trust in the home folder, and trusting a folder above it would trust all below; start the team from a repository below it\n`,
    });
  });

  test("--trust is start's alone", () => {
    expect(team(place(), new FakeLauncher(), "list", "--trust")).toMatchObject({ code: 2, stderr: expect.stringContaining("unrecognized arguments: --trust") });
  });
});

/** The repo of `at` with an origin remote, and the agents' calls going to `host`. */
function inProject(at: Place, host: FakeHost): Place {
  for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:CoelhoRocha/Custom-MCP-Servers.git"]]) spawnSync("git", args, { cwd: at.repo });

  return { ...at, env: { ...at.env, FLEET_RUN_URL: host.origin, CLAUDE_CODE_SESSION_ID: "" } };
}

describe("an agent of a project", () => {
  afterEach(stopHosts);

  async function start(at: Place, launcher: FakeLauncher, waitMs = 2_000, argv: readonly string[] = ["start"]): Promise<Ran> {
    const { layer, recorded } = recordingOut();
    const world = Layer.succeed(World, machine(at.env));
    const code = await Effect.runPromise(teamWith(argv, () => launcher, at.repo, undefined, waitMs).pipe(Effect.provide(Layer.mergeAll(world, layer))));

    return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
  }

  const TEAM = (id: string, role: string) => ({ id, project: "court", repo: "coelhorocha/custom-mcp-servers", machine: "office", role, createdBy: { machine: "office", session: null }, createdAt: "2026-10-30T10:01:00.000Z" });

  test("joins the project first, as its role and under its name, then starts naming the ledger the host cut over", async () => {
    let home = "";
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("boss", "manager"), before: () => cutOver(home, "boss") } });
    const at = inProject(place({ boss: '{"fleet": {"role": "manager", "project": "court"}}' }), host);
    home = at.home;
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher);

    expect(ran).toEqual({
      code: 0,
      stdout: `boss: joined project court as team boss (coelhorocha/custom-mcp-servers, manager)\nstarted session ${at.session}\nboss: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "boss")}\n`,
      stderr: "",
    });
    expect(host.sent.map((s) => s.body)).toEqual([{ repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "manager", team: "boss" }]);
    expect(launcher.prompts).toEqual([`boss: /tstack:manager Your ledger is ${LEDGER(at, "boss")}.`]);
  });

  test("an agent whose ledger the host cut over already starts with no join", async () => {
    const host = fakeHost({});
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    cutOver(at.home, "ui");
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher);

    expect(ran.code).toBe(0);
    expect(host.sent).toEqual([]);
    expect(launcher.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
  });

  test("an agent whose join is refused, or whose ledger is not cut over in time, does not start; the others do", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 409, body: { _tag: "ProjectArchived", project: "court" } }, "POST /projects/later/teams": { status: 201, body: { ...TEAM("ux", "coordinator"), project: "later" } } });
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}', ux: '{"fleet": {"role": "coordinator", "project": "later"}}', web: '{"fleet": {"role": "coordinator"}}' }), host);
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher, 200);

    expect(ran).toEqual({
      code: 1,
      stdout: `ux: joined project later as team ux (coelhorocha/custom-mcp-servers, coordinator)\nstarted session ${at.session}\nweb: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "web")}\n`,
      stderr:
        "team: ui: project court is archived: it is read-only, and no team joins it\n" +
        `team: ux: the host has not cut ${LEDGER(at, "ux")} over to the cloud yet (no cloud.json after 0.2 s): \`fleet team start ux\` again waits for it\n`,
    });
    expect(launcher.prompts).toEqual([`web: /tstack:coordinator Your ledger is ${LEDGER(at, "web")}.`]);
  });

  test("an agent with both fleet.ledger and fleet.project, its ledger not cut over, is refused before any join", async () => {
    const host = fakeHost({});
    const at = inProject(place({ ui: `{"fleet": {"role": "coordinator", "project": "court", "ledger": "~/own"}}` }), host);
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher);

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: ui: names both fleet.ledger (${join(at.home, "own")}, not cut over to the cloud) and fleet.project, and the join makes the team's folder itself: drop fleet.ledger, or set it to the joined team's folder once \`fleet project join court\` has printed it\n`,
    });
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("the host's dir is where the start waits; one that is not the agent's ledger is refused, naming it", async () => {
    const dir = join(tmp("fleet-team-dir-"), "ui");
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: { ...TEAM("ui", "coordinator"), dir }, before: () => cutOver("", "ui", dir) } });
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher);

    expect(ran).toEqual({
      code: 1,
      stdout: "ui: joined project court as team ui (coelhorocha/custom-mcp-servers, coordinator)\n",
      stderr: `team: ui: the host made team ui's folder at ${dir}, not ${LEDGER(at, "ui")}: set fleet.ledger in ui.json to ${dir}\n`,
    });
    expect(launcher.calls).toEqual([]);
  });

  test("a team id taken elsewhere says to rename the agent's file, as start has no --team", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 409, body: { _tag: "TeamTaken", team: "ui" } } });
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    const ran = await start(at, new FakeLauncher());

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: ui: the team id ui is taken by another project, repo or machine: rename the agent's file, ${join(at.repo, ".fleet", "agents", "ui.json")}, as its name is the team's id\n`,
    });
  });

  test("an untrusted repo, or a session another repo's team holds, is refused before the cloud team is made", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("ui", "coordinator") } });
    const untrusted = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    writeFileSync(untrusted.claude, "{}");

    expect(await start(untrusted, new FakeLauncher())).toMatchObject({ code: 1, stdout: "", stderr: `team: Claude Code does not trust ${untrusted.repo} yet, and there is no terminal to ask on: \`fleet team start --trust\` trusts it\n` });
    expect(host.sent).toEqual([]);

    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    const launcher = new FakeLauncher();
    team(twinOf(at), launcher, "start");
    const ran = await start(at, launcher);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: expect.stringContaining(`which fleet team runs; name this repo's in its .fleet/team.json ("session")`) });
    expect(host.sent).toEqual([]);
  });

  test("an agent whose ledger is another project's team, or another repo's, is refused before the trust and the join", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("ui", "coordinator") } });
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}', ux: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    cutOver(at.home, "ui", ledgerAt(at.home, "ui"), "tstack");
    listTeams(at.home, [{ id: "ux", project: "court", repo: "luizhcrocha/skills", path: "/elsewhere" }]);
    writeFileSync(at.claude, "{}");
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher, 2_000, ["start", "--trust"]);

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr:
        `team: ui: ${LEDGER(at, "ui")} is the ledger of team ui (project tstack), not this agent's (project court): a team's name is one per machine, so give this agent another (\`fleet fleets list\` lists the teams here)\n` +
        `team: ux: ${LEDGER(at, "ux")} is the ledger of team ux (project court, repo luizhcrocha/skills), not this agent's (repo coelhorocha/custom-mcp-servers): a team's name is one per machine, so give this agent another (\`fleet fleets list\` lists the teams here)\n`,
    });
    expect(readFileSync(at.claude, "utf8")).toBe("{}");
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("an agent file's own ledger is not another repo's team that a join recorded under the agent's name", async () => {
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "ledger": "~/own"}}' }), fakeHost({}));
    listTeams(at.home, [{ id: "ui", project: "court", repo: "luizhcrocha/skills", path: "/elsewhere" }]);
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher);

    expect(ran.stderr).toBe("");
    expect(launcher.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${join(at.home, "own")}.`]);
  });

  test("an agent of a project whose ledger moved to the cloud under no project is refused: it would never join", async () => {
    const host = fakeHost({});
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    mkdirSync(LEDGER(at, "ui"), { recursive: true });
    writeFileSync(join(LEDGER(at, "ui"), "cloud.json"), JSON.stringify({ fleet: "ui", cloud: "https://fleet.example.dev" }));
    const launcher = new FakeLauncher();

    expect(await start(at, launcher)).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: ui: ${LEDGER(at, "ui")} is the ledger of team ui (no project), not this agent's (project court): a team's name is one per machine, so give this agent another (\`fleet fleets list\` lists the teams here)\n`,
    });
    expect(launcher.calls).toEqual([]);
  });

  test("an agent whose ledger is its own project's and repo's team starts in it with no join", async () => {
    const host = fakeHost({});
    const at = inProject(place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' }), host);
    cutOver(at.home, "ui");
    listTeams(at.home, [{ id: "ui", project: "court", repo: "coelhorocha/custom-mcp-servers", path: at.repo }]);
    const launcher = new FakeLauncher();

    expect((await start(at, launcher)).code).toBe(0);
    expect(host.sent).toEqual([]);
    expect(launcher.prompts).toEqual([`ui: /tstack:coordinator Your ledger is ${LEDGER(at, "ui")}.`]);
  });

  test("a repo with no owner/name identity is refused before the trust is written", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("ui", "coordinator") } });
    const base = place({ ui: '{"fleet": {"role": "coordinator", "project": "court"}}' });
    spawnSync("git", ["init", "-q"], { cwd: base.repo });
    const at = { ...base, env: { ...base.env, FLEET_RUN_URL: host.origin } };
    writeFileSync(at.claude, "{}");
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher, 2_000, ["start", "--trust"]);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: ui: ${at.repo} has no origin remote naming owner/name, and is not a folder ~/repos/<owner>/<name>: add its origin remote\n` });
    expect(readFileSync(at.claude, "utf8")).toBe("{}");
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("a join that gives the agent another team than its name is refused: its ledger would not be the agent's", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 200, body: TEAM("court-manager", "manager") } });
    const at = inProject(place({ boss: '{"fleet": {"role": "manager", "project": "court"}}' }), host);
    const launcher = new FakeLauncher();
    const ran = await start(at, launcher);

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: boss: project court's manager on this machine is the team court-manager, not boss: set fleet.ledger in boss.json to its folder (\`fleet project manage court\` prints it)\n`,
    });
    expect(launcher.calls).toEqual([]);
  });
});

describe("add", () => {
  afterEach(stopHosts);

  const TEAM = (id: string, role: string) => ({ id, project: "court", repo: "coelhorocha/custom-mcp-servers", machine: "office", role, createdBy: { machine: "office", session: null }, createdAt: "2026-10-30T10:01:00.000Z" });

  /** `fleet team add ...argv` run from `cwd` (the repo by default), with no terminal unless `ask` is given. */
  async function add(at: Place, launcher: FakeLauncher, argv: readonly string[], { cwd = at.repo, waitMs = 2_000, ask }: { cwd?: string; waitMs?: number; ask?: Asker } = {}): Promise<Ran> {
    const { layer, recorded } = recordingOut();
    const world = Layer.succeed(World, machine(at.env));
    const code = await Effect.runPromise(teamWith(["add", ...argv], () => launcher, cwd, ask, waitMs).pipe(Effect.provide(Layer.mergeAll(world, layer))));

    return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
  }

  const fileOf = (at: Place, name: string): string => join(at.repo, ".fleet", "agents", `${name}.json`);

  /** A place whose repo has the agent `ui` and a host that joins team `id` as `role`, cutting its ledger over. */
  function joining(id: string, role = "coordinator", agents?: Readonly<Record<string, string>>) {
    let home = "";
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM(id, role), before: () => cutOver(home, id) } });
    const at = inProject(place(agents), host);
    home = at.home;

    return { at, host };
  }

  test("writes a coordinator's file naming the project and the mission, then starts it as start does: its own tab, the join, the opening with the mission", async () => {
    const { at, host } = joining("api");
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran).toEqual({
      code: 0,
      stdout:
        `api: wrote ${fileOf(at, "api")}\n` +
        "api: joined project court as team api (coelhorocha/custom-mcp-servers, coordinator)\n" +
        `started session ${at.session}\n` +
        `api: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "api")}\n`,
      stderr: "",
    });
    expect(JSON.parse(readFileSync(fileOf(at, "api"), "utf8"))).toEqual({ fleet: { role: "coordinator", project: "court", mission: "Sync the court data" } });
    expect(host.sent.map((s) => s.body)).toEqual([{ repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "coordinator", team: "api" }]);
    expect(launcher.calls.filter((c) => c.startsWith("tab"))).toEqual([`tab ${at.session} api`]);
    expect(launcher.prompts).toEqual([`api: /tstack:tuca-mode Sync the court data. Your ledger is ${LEDGER(at, "api")}.`]);
  });

  test("starts only the agent it adds: the repo's other agents are left as they are", async () => {
    const { at } = joining("api");
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran.code).toBe(0);
    expect(launcher.prompts.map((p) => p.split(":")[0])).toEqual(["api"]);
  });

  test("--role manager writes a manager, joined as the project's manager", async () => {
    const { at, host } = joining("boss", "manager");
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["boss", "--project", "court", "--role", "manager", "--mission", "Land the court work"]);

    expect(ran.code).toBe(0);
    expect(JSON.parse(readFileSync(fileOf(at, "boss"), "utf8"))).toEqual({ fleet: { role: "manager", project: "court", mission: "Land the court work" } });
    expect(host.sent.map((s) => s.body)).toEqual([{ repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "manager", team: "boss" }]);
    expect(launcher.prompts).toEqual([`boss: /tstack:manager Land the court work. Your ledger is ${LEDGER(at, "boss")}.`]);
  });

  test("--no-start writes the file and starts nothing", async () => {
    const host = fakeHost({});
    const at = inProject(place(), host);
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data", "--no-start"]);

    expect(ran).toEqual({ code: 0, stdout: `api: wrote ${fileOf(at, "api")}; \`fleet team start api\` starts it\n`, stderr: "" });
    expect(existsSync(fileOf(at, "api"))).toBe(true);
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("in a repo with no agents yet, makes .fleet/agents at the repo's root, run from below it", async () => {
    const { at } = joining("api", "coordinator", {});
    rmSync(join(at.repo, ".fleet"), { recursive: true });
    const below = join(at.repo, "src", "deep");
    mkdirSync(below, { recursive: true });
    const ran = await add(at, new FakeLauncher(), ["api", "--project", "court", "--mission", "Sync the court data"], { cwd: below });

    expect(ran.code).toBe(0);
    expect(existsSync(fileOf(at, "api"))).toBe(true);
  });

  test("outside any repo, it is refused and writes nothing", async () => {
    const at = place();
    const nowhere = tmp("fleet-team-nowhere-");
    const ran = await add(at, new FakeLauncher(), ["api", "--project", "court", "--mission", "Sync the court data"], { cwd: nowhere });

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: ${nowhere} is in no repo (no .fleet/agents, .jj or .git from it up): run it in the repo the agent works in\n` });
    expect(readdirSync(nowhere)).toEqual([]);
  });

  test("a name that exists is refused, its file and its agent left as they are", async () => {
    const host = fakeHost({});
    const at = inProject(place({ api: '{"fleet": {"role": "coordinator"}}' }), host);
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: api: ${fileOf(at, "api")} exists already: \`fleet team start api\` starts it, or name another\n` });
    expect(readFileSync(fileOf(at, "api"), "utf8")).toBe('{"fleet": {"role": "coordinator"}}');
    expect(launcher.calls).toEqual([]);
  });

  test("the same add again after a run killed before its start ended (the file as add writes it, no tab) starts it rather than refusing", async () => {
    const { at } = joining("api");
    const argv = ["api", "--project", "court", "--mission", "Sync the court data"];
    expect((await add(at, new FakeLauncher(), [...argv, "--no-start"])).code).toBe(0);

    expect(await add(at, new FakeLauncher(), [...argv, "--no-start"])).toEqual({ code: 0, stdout: `api: ${fileOf(at, "api")} is there already, as add writes it; \`fleet team start api\` starts it\n`, stderr: "" });
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, argv);

    expect(ran).toEqual({
      code: 0,
      stdout:
        `api: ${fileOf(at, "api")} is there already, as add writes it; starting it\n` +
        "api: joined project court as team api (coelhorocha/custom-mcp-servers, coordinator)\n" +
        `started session ${at.session}\n` +
        `api: started in session ${at.session}, tab w1:t1; its ledger is ${LEDGER(at, "api")}\n`,
      stderr: "",
    });
    expect(launcher.prompts).toEqual([`api: /tstack:tuca-mode Sync the court data. Your ledger is ${LEDGER(at, "api")}.`]);
  });

  test("a file add wrote for another mission is refused and left", async () => {
    const host = fakeHost({});
    const at = inProject(place(), host);
    expect((await add(at, new FakeLauncher(), ["api", "--project", "court", "--mission", "Sync the court data", "--no-start"])).code).toBe(0);
    const before = readFileSync(fileOf(at, "api"), "utf8");
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the rest"]);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: api: ${fileOf(at, "api")} exists already: \`fleet team start api\` starts it, or name another\n` });
    expect(readFileSync(fileOf(at, "api"), "utf8")).toBe(before);
    expect(launcher.calls).toEqual([]);
  });

  test.each([
    [
      "the home folder, given through a symlink",
      (repo: string) => {
        const home = join(tmp("fleet-team-link-"), "home");
        symlinkSync(repo, home);

        return home;
      },
    ],
    ["a folder above the home folder", (repo: string) => join(repo, "me")],
  ])("a repo that is %s is refused and nothing is written", async (_, homeOf) => {
    const host = fakeHost({});
    const base = inProject(place({}), host);
    rmSync(join(base.repo, ".fleet"), { recursive: true });
    const at = { ...base, env: { ...base.env, HOME: homeOf(base.repo) } };
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: ${at.repo} is / or the home folder, or a folder above it: an agent's file goes in the repository it works in; run add in one below the home folder\n`,
    });
    expect(existsSync(join(at.repo, ".fleet"))).toBe(false);
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("a start that gives the agent no tab also removes the .fleet/agents and .fleet folders add made", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 404, body: { _tag: "UnknownProject", project: "court" } } });
    const at = inProject(place({}), host);
    rmSync(join(at.repo, ".fleet"), { recursive: true });
    const ran = await add(at, new FakeLauncher(), ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran.code).toBe(1);
    expect(existsSync(join(at.repo, ".fleet"))).toBe(false);
  });

  test("a start that gives the agent no tab keeps a .fleet that was there before add", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 404, body: { _tag: "UnknownProject", project: "court" } } });
    const at = inProject(place({}), host);
    rmSync(join(at.repo, ".fleet", "agents"), { recursive: true });
    writeFileSync(join(at.repo, ".fleet", "team.json"), "{}");
    const ran = await add(at, new FakeLauncher(), ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran.code).toBe(1);
    expect(readdirSync(join(at.repo, ".fleet"))).toEqual(["team.json"]);
  });

  test.each([
    ["a name that is no team id", ["api_x", "--project", "court", "--mission", "Go"], "api_x.json: an agent of a project (fleet.project) is named by lower-case letters, digits and - only: its name is its team's id; rename the file"],
    ["a name with capitals", ["Api", "--project", "court", "--mission", "Go"], "Api.json: name 'Api' is lower-case letters, digits, - and _, starting with a letter, at most 32"],
    ["a project that is no project id", ["api", "--project", "Court", "--mission", "Go"], "api.json: fleet.project is 'Court'; it is a project's id (lower-case letters, digits and -), as `fleet project list` prints it"],
    ["a mission of two lines", ["api", "--project", "court", "--mission", "Sync.\nThen more."], "api.json: fleet.mission is one line: the opening is typed into the agent's prompt, where each line would be sent alone"],
  ])("%s is refused and nothing is written", async (_, argv, why) => {
    const host = fakeHost({});
    const at = inProject(place(), host);
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, argv);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: ${why}\n` });
    expect(readdirSync(join(at.repo, ".fleet", "agents"))).toEqual(["ui.json"]);
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test.each([
    ["no --project", ["api", "--mission", "Go"], "the following arguments are required: --project"],
    ["no --mission", ["api", "--project", "court"], "the following arguments are required: --mission"],
    ["no name", ["--project", "court", "--mission", "Go"], "the following arguments are required: name"],
    ["a role of no kind", ["api", "--project", "court", "--mission", "Go", "--role", "worker"], "argument --role: invalid choice: 'worker' (choose from 'coordinator', 'manager')"],
  ])("%s is a usage error", async (_, argv, reason) => {
    const at = place();
    const ran = await add(at, new FakeLauncher(), argv);

    expect(ran.code).toBe(2);
    expect(ran.stderr).toEndWith(`fleet team add: error: ${reason}\n`);
  });

  test("a start that gives the agent no tab removes the file it wrote, so add runs again once that is fixed", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 404, body: { _tag: "UnknownProject", project: "court" } } });
    const at = inProject(place(), host);
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran).toEqual({
      code: 1,
      stdout: `api: wrote ${fileOf(at, "api")}\n`,
      stderr:
        "team: api: the registry has no project court: `fleet project new` makes one\n" +
        `team: api: not started, so ${fileOf(at, "api")} is removed: \`fleet team add\` again once that is fixed\n`,
    });
    expect(existsSync(fileOf(at, "api"))).toBe(false);
    expect(launcher.calls.filter((c) => c.startsWith("tab"))).toEqual([]);
  });

  test("a resumed add whose start gives no tab keeps the file that was there before it", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 404, body: { _tag: "UnknownProject", project: "court" } } });
    const at = inProject(place(), host);
    const argv = ["api", "--project", "court", "--mission", "Sync the court data"];
    expect((await add(at, new FakeLauncher(), [...argv, "--no-start"])).code).toBe(0);

    const ran = await add(at, new FakeLauncher(), argv);

    expect(ran).toEqual({
      code: 1,
      stdout: `api: ${fileOf(at, "api")} is there already, as add writes it; starting it\n`,
      stderr:
        "team: api: the registry has no project court: `fleet project new` makes one\n" +
        `team: api: not started; ${fileOf(at, "api")} was there before this add, so it stays\n`,
    });
    expect(existsSync(fileOf(at, "api"))).toBe(true);
  });

  test("an untrusted repo with no terminal is refused naming add's --trust; --trust trusts it and starts", async () => {
    const { at } = joining("api");
    writeFileSync(at.claude, JSON.stringify({ projects: {} }));
    const argv = ["api", "--project", "court", "--mission", "Sync the court data"];
    const refused = await add(at, new FakeLauncher(), argv);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      `team: Claude Code does not trust ${at.repo} yet, and there is no terminal to ask on: \`fleet team add\` again with --trust trusts it\n` +
        `team: api: not started, so ${fileOf(at, "api")} is removed: \`fleet team add\` again once that is fixed\n`,
    );
    expect(existsSync(fileOf(at, "api"))).toBe(false);

    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, [...argv, "--trust"]);

    expect(ran.code).toBe(0);
    expect(launcher.prompts).toEqual([`api: /tstack:tuca-mode Sync the court data. Your ledger is ${LEDGER(at, "api")}.`]);
  });

  test("a name whose ledger is another project's team is refused before anything is trusted, joined or written, naming its owner", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("notes", "coordinator") } });
    const at = inProject(place(), host);
    cutOver(at.home, "notes", ledgerAt(at.home, "notes"), "tstack");
    writeFileSync(at.claude, "{}");
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["notes", "--project", "court", "--mission", "Sync the court data", "--trust"]);

    expect(ran).toEqual({
      code: 1,
      stdout: "",
      stderr: `team: notes: ${LEDGER(at, "notes")} is the ledger of team notes (project tstack), not this agent's (project court): a team's name is one per machine, so give this agent another (\`fleet fleets list\` lists the teams here)\n`,
    });
    expect(existsSync(fileOf(at, "notes"))).toBe(false);
    expect(readFileSync(at.claude, "utf8")).toBe("{}");
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("a name whose team another repo joined is refused, naming that repo", async () => {
    const host = fakeHost({});
    const at = inProject(place(), host);
    listTeams(at.home, [{ id: "api", project: "court", repo: "luizhcrocha/skills", path: "/elsewhere" }]);
    const ran = await add(at, new FakeLauncher(), ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(
      `team: api: ${LEDGER(at, "api")} is the ledger of team api (project court, repo luizhcrocha/skills), not this agent's (repo coelhorocha/custom-mcp-servers): a team's name is one per machine, so give this agent another (\`fleet fleets list\` lists the teams here)\n`,
    );
    expect(existsSync(fileOf(at, "api"))).toBe(false);
  });

  test("a name whose ledger is this repo's team of the same project starts in it", async () => {
    const host = fakeHost({});
    const at = inProject(place(), host);
    cutOver(at.home, "api");
    listTeams(at.home, [{ id: "api", project: "court", repo: "coelhorocha/custom-mcp-servers", path: at.repo }]);
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran.code).toBe(0);
    expect(host.sent).toEqual([]);
    expect(launcher.prompts).toEqual([`api: /tstack:tuca-mode Sync the court data. Your ledger is ${LEDGER(at, "api")}.`]);
  });

  test("a repo with no owner/name identity is refused before anything is trusted or written", async () => {
    const host = fakeHost({});
    const base = place();
    spawnSync("git", ["init", "-q"], { cwd: base.repo });
    const at = { ...base, env: { ...base.env, FLEET_RUN_URL: host.origin } };
    writeFileSync(at.claude, "{}");
    const launcher = new FakeLauncher();
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data", "--trust"]);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `team: ${at.repo} has no origin remote naming owner/name, and is not a folder ~/repos/<owner>/<name>: add its origin remote\n` });
    expect(existsSync(fileOf(at, "api"))).toBe(false);
    expect(readFileSync(at.claude, "utf8")).toBe("{}");
    expect(host.sent).toEqual([]);
    expect(launcher.calls).toEqual([]);
  });

  test("an agent whose start blocks on a prompt keeps its tab and its file: start sends its opening once it is answered", async () => {
    const { at } = joining("api");
    const launcher = new FakeLauncher();
    launcher.blockAtStart.add("api");
    const ran = await add(at, launcher, ["api", "--project", "court", "--mission", "Sync the court data"]);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("api: waits on a prompt in its tab w1:t1");
    expect(existsSync(fileOf(at, "api"))).toBe(true);

    launcher.answer(at.session, "api");
    expect(team(at, launcher, "start", "api").code).toBe(0);
    expect(launcher.prompts).toEqual([`api: /tstack:tuca-mode Sync the court data. Your ledger is ${LEDGER(at, "api")}.`]);
  });
});
