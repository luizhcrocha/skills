/**
 * `fleet team start|stop|attach|list` (src/cli/team.ts, src/team/team.ts) through the CLI's interface, over the
 * fake multiplexer (team-launcher-fake.ts), a temporary registry (FLEET_HOME), a temporary home and a temporary
 * repo. Nothing here touches rex, a live ledger or the live registry.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { teamWith } from "../src/cli/team.ts";
import type { Why } from "../src/team/agents.ts";
import type { Asker } from "../src/team/trust.ts";
import { recordingOut } from "../src/io.ts";
import type { Json } from "../src/json.ts";
import { World } from "../src/world.ts";
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

    expect(team(at, new FakeLauncher(), "begin").stderr).toEndWith("fleet team: error: argument cmd: invalid choice: 'begin' (choose from 'start', 'stop', 'attach', 'list')\n");
    expect(team({ ...at, env: { ...at.env, HOME: "" } }, new FakeLauncher(), "list")).toEqual({ code: 1, stdout: "", stderr: "team: HOME is not set, and the ledgers' fixed homes are under it (~/.local/state/fleet)\n" });
  });

  test("a repo with no agents says where they go", () => {
    const at = place({});

    expect(team(at, new FakeLauncher(), "list")).toEqual({ code: 1, stdout: "", stderr: `team: no agents defined: ${at.repo}/.fleet/agents/<name>.json defines one\n` });
  });
});

describe("safety", () => {
  test("another repo of the same folder name is refused while this one's team runs, saying how to name its own; free once it stops", () => {
    const at = place();
    const twin = join(tmp("fleet-team-twin-"), basename(at.repo));
    mkdirSync(join(twin, ".fleet", "agents"), { recursive: true });
    writeFileSync(join(twin, ".fleet", "agents", "ui.json"), '{"fleet": {"role": "coordinator"}}');
    writeFileSync(at.claude, JSON.stringify({ projects: { [at.repo]: { hasTrustDialogAccepted: true }, [twin]: { hasTrustDialogAccepted: true } } }));
    const other: Place = { ...at, repo: twin };
    const launcher = new FakeLauncher();
    team(at, launcher, "start", "ui");
    const why = `team: session ${at.session} is the team of ${at.repo}, which fleet team runs; name this repo's in its .fleet/team.json ("session")\n`;

    for (const argv of [["start"], ["stop", "ui"], ["list"], ["attach"]]) expect(team(other, launcher, ...argv)).toEqual({ code: 1, stdout: "", stderr: why });
    expect(launcher.calls.filter((c) => !c.startsWith("open ") && !c.startsWith("tab ") && !c.startsWith("prompt "))).toEqual([]);

    team(at, launcher, "stop", "ui");

    expect(team(other, launcher, "start").stdout).toBe(`started session ${at.session}\nui: started in session ${at.session}, tab w1:t2; its ledger is ${LEDGER(at, "ui")}\n`);
    expect(team(at, launcher, "list")).toEqual({ code: 1, stdout: "", stderr: `team: session ${at.session} is the team of ${twin}, which fleet team runs; name this repo's in its .fleet/team.json ("session")\n` });
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
