/**
 * `fleet project`: each command against a fake host service, a real HTTP server on a free loopback port that
 * answers the run server's `/projects` routes as the contract fixes them and records what it was sent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { projectWith } from "../src/cli/project.ts";
import { recordingOut } from "../src/io.ts";
import { World } from "../src/world.ts";
import { cutOver, fakeHost, ledgerAt, stopHosts, type FakeHost, type Reply } from "./project-host-fake.ts";
import { baseEnv, machine, tmp, type Environment, type Ran } from "./support.ts";

afterEach(stopHosts);

/** A machine for the CLI: its home, its registry (whose moved teams are the home's `.local/state/fleet/<team>`),
 * and a repo under `~/repos/<owner>/<name>` whose origin remote is `remote`. */
interface Place {
  readonly home: string;
  readonly repo: string;
  readonly env: Environment;
}

function place(host: FakeHost, remote: string | undefined = "git@github.com:CoelhoRocha/Custom-MCP-Servers.git"): Place {
  const home = tmp("fleet-project-home-");
  const repo = join(home, "repos", "coelhorocha", "custom-mcp-servers");
  mkdirSync(join(home, ".local", "state", "fleet-board"), { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  git(repo, "init", "-q");

  if (remote !== undefined) git(repo, "remote", "add", "origin", remote);
  const env = baseEnv(join(home, ".local", "state", "fleet-board"), { HOME: home, FLEET_RUN_URL: host.origin, CLAUDE_CODE_SESSION_ID: "sess-1" });

  return { home, repo, env };
}

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync("git", args, { cwd, encoding: "utf8" });

  if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
}

const ledger = (at: Place, id: string): string => ledgerAt(at.home, id);

/** Run `fleet project ARGV` from `cwd`, waiting at most `waitMs` for a joined team's cloud.json. */
async function project(at: Place, cwd: string, argv: readonly string[], waitMs = 2_000): Promise<Ran> {
  const { layer, recorded } = recordingOut();
  const world = Layer.succeed(World, machine(at.env));
  const code = await Effect.runPromise(projectWith(argv, cwd, waitMs).pipe(Effect.provide(Layer.mergeAll(world, layer))));

  return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
}

const CREATED = { machine: "office", session: "sess-1" };

const PROJECT = { id: "court", title: "Court integrations", state: "open", createdBy: CREATED, createdAt: "2026-10-30T10:00:00.000Z", manager: null };

const TEAM = (id: string, role = "coordinator") => ({ id, project: "court", repo: "coelhorocha/custom-mcp-servers", machine: "office", role, createdBy: CREATED, createdAt: "2026-10-30T10:01:00.000Z" });

describe("new", () => {
  test("posts the title and the session's label, and says how to join or manage the project", async () => {
    const host = fakeHost({ "POST /projects": { status: 201, body: PROJECT } });
    const at = place(host);
    const ran = await project(at, at.repo, ["new", "Court integrations"]);

    expect(ran).toEqual({
      code: 0,
      stdout: 'project court ("Court integrations") created. Join it from a repo with `fleet project join court`, or manage it from one with `fleet project manage court`.\n',
      stderr: "",
    });
    expect(host.sent).toEqual([{ method: "POST", path: "/projects", body: { title: "Court integrations", session: "sess-1" }, type: "application/json", origin: null }]);
  });

  test("--id names the project; the page is named when a team of this machine has moved to the cloud", async () => {
    const host = fakeHost({ "POST /projects": { status: 201, body: { ...PROJECT, id: "cr" } } });
    const at = place(host);
    cutOver(at.home, "skills");
    const ran = await project(at, at.repo, ["new", "Court integrations", "--id", "cr"]);

    expect(ran.stdout).toBe('project cr ("Court integrations") created; page https://fleet.example.dev/p/cr. Join it from a repo with `fleet project join cr`, or manage it from one with `fleet project manage cr`.\n');
    expect(host.sent[0]?.body).toEqual({ title: "Court integrations", id: "cr", session: "sess-1" });
  });

  test("a session with no label sends none", async () => {
    const host = fakeHost({ "POST /projects": { status: 201, body: PROJECT } });
    const at = place(host);
    await project({ ...at, env: { ...at.env, CLAUDE_CODE_SESSION_ID: "" } }, at.repo, ["new", "Court integrations"]);

    expect(host.sent[0]?.body).toEqual({ title: "Court integrations" });
  });
});

describe("join and manage", () => {
  test("join from below the repo sends its origin's owner/name in lower case and its folder, then names the ledger once the host cut it over", async () => {
    let at: Place | undefined;
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("court-custom-mcp-servers"), before: () => at !== undefined && cutOver(at.home, "court-custom-mcp-servers") } });
    at = place(host);
    const ran = await project(at, join(at.repo, "src", "deep"), ["join", "court"]);

    expect(ran).toEqual({
      code: 0,
      stdout: `joined project court as team court-custom-mcp-servers (coelhorocha/custom-mcp-servers, coordinator)\nYour ledger is ${ledger(at, "court-custom-mcp-servers")}.\n`,
      stderr: "",
    });
    expect(host.sent).toEqual([
      { method: "POST", path: "/projects/court/teams", body: { repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "coordinator", session: "sess-1" }, type: "application/json", origin: null },
    ]);
  });

  test("--team names the team; a join the registry knew already says so, and waits for a cloud.json that comes later", async () => {
    let at: Place | undefined;

    const host = fakeHost({
      "POST /projects/court/teams": {
        status: 200,
        body: TEAM("api"),
        before: () => void setTimeout(() => at !== undefined && cutOver(at.home, "api"), 300),
      },
    });

    at = place(host);
    const ran = await project(at, at.repo, ["join", "court", "--team", "api"]);

    expect(ran.stdout).toBe(`already in project court as team api (coelhorocha/custom-mcp-servers, coordinator)\nYour ledger is ${ledger(at, "api")}.\n`);
    expect(ran.code).toBe(0);
    expect(host.sent[0]?.body).toEqual({ repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "coordinator", team: "api", session: "sess-1" });
  });

  test("a cloud.json that does not come in time is refused, naming the folder", async () => {
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("api") } });
    const at = place(host);
    const ran = await project(at, at.repo, ["join", "court", "--team", "api"], 300);

    expect(ran).toEqual({
      code: 1,
      stdout: "joined project court as team api (coelhorocha/custom-mcp-servers, coordinator)\n",
      stderr: `project: the host has not cut ${ledger(at, "api")} over to the cloud yet (no cloud.json after 0.3 s): \`fleet project join court --team api\` again waits for it, and \`fleet ls\` lists the team once it has\n`,
    });
  });

  test("manage asks for the manager's team; join --role manager is the same", async () => {
    let at: Place | undefined;
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("court-manager", "manager"), before: () => at !== undefined && cutOver(at.home, "court-manager") } });
    at = place(host);
    const managed = await project(at, at.repo, ["manage", "court"]);
    const joined = await project(at, at.repo, ["join", "court", "--role", "manager"]);

    expect(managed.stdout).toBe(`joined project court as team court-manager (coelhorocha/custom-mcp-servers, manager)\nYour ledger is ${ledger(at, "court-manager")}.\n`);
    expect(joined.stdout).toBe(managed.stdout);
    expect(host.sent.map((s) => s.body)).toEqual([
      { repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "manager", session: "sess-1" },
      { repo: "coelhorocha/custom-mcp-servers", path: at.repo, role: "manager", session: "sess-1" },
    ]);
  });

  test("a repo with no origin remote is named by its folder under ~/repos", async () => {
    let at: Place | undefined;
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("api"), before: () => at !== undefined && cutOver(at.home, "api") } });
    at = place(host, undefined);
    await project(at, at.repo, ["join", "court", "--team", "api"]);

    expect(host.sent[0]?.body).toMatchObject({ repo: "coelhorocha/custom-mcp-servers" });
  });

  test("an https remote is the owner and name of its path", async () => {
    let at: Place | undefined;
    const host = fakeHost({ "POST /projects/court/teams": { status: 201, body: TEAM("api"), before: () => at !== undefined && cutOver(at.home, "api") } });
    at = place(host, "https://github.com/LuizHCRocha/Fleet.git/");
    await project(at, at.repo, ["join", "court", "--team", "api"]);

    expect(host.sent[0]?.body).toMatchObject({ repo: "luizhcrocha/fleet" });
  });

  test("outside a repo nothing is sent", async () => {
    const host = fakeHost({});
    const at = place(host);
    const away = tmp("fleet-project-away-");
    const ran = await project(at, away, ["join", "court"]);

    expect(ran).toEqual({ code: 1, stdout: "", stderr: `project: ${away} is in no repo (no .jj or .git from it up): run it in the repo the team works in\n` });
    expect(host.sent).toEqual([]);
  });
});

describe("refusals", () => {
  const cases: readonly (readonly [string, string, Reply, string])[] = [
    ["new", "ProjectExists", { status: 409, body: { _tag: "ProjectExists", project: "court", state: "open" } }, "project court exists already: join it with `fleet project join court`, or name a new one with --id"],
    ["new", "ProjectExists, archived", { status: 409, body: { _tag: "ProjectExists", project: "court", state: "archived" } }, "project court exists already, archived (an archived project keeps its id): name a new one with --id"],
    ["join", "ProjectArchived", { status: 409, body: { _tag: "ProjectArchived", project: "court" } }, "project court is archived: it is read-only, and no team joins it"],
    ["manage", "HasManager", { status: 409, body: { _tag: "HasManager", project: "court", team: "boss" } }, "project court has a manager already, the team boss of another repo or machine"],
    ["join", "ManyTeams", { status: 409, body: { _tag: "ManyTeams", project: "court", repo: "coelhorocha/custom-mcp-servers", teams: ["api", "web"] } }, "this machine has several teams of project court for coelhorocha/custom-mcp-servers (api, web): name one with --team"],
    ["join", "TeamTaken", { status: 409, body: { _tag: "TeamTaken", team: "api" } }, "the team id api is taken by another project, repo or machine: name another with --team"],
    ["manage", "TeamNotManager", { status: 409, body: { _tag: "TeamNotManager", team: "api" } }, "the team api of this machine is a coordinator's team, not a manager team: name another with --team"],
    ["archive", "NotArchived", { status: 409, body: { _tag: "NotArchived", project: "court" } }, "project court is still open, and only an archived project is deleted"],
    ["archive", "DeclaredByFleets", { status: 409, body: { _tag: "DeclaredByFleets", project: "court", teams: ["api", "web"] } }, "project court still has teams the FLEETS var declares (api, web): it is deleted once FLEETS no longer names them"],
    ["join", "UnknownProject", { status: 404, body: { _tag: "UnknownProject", project: "court" } }, "the registry has no project court: `fleet project new` makes one"],
    ["new", "BadRegistryBody", { status: 400, body: { _tag: "BadRegistryBody", issue: "Expected a string, got 3" } }, "the registry refused what was sent: Expected a string, got 3"],
    ["archive", "NotAllowed", { status: 403, body: { _tag: "NotAllowed", who: "host" } }, "this machine may not: a project is archived by the machine that made it, or by the owner from its page"],
    ["join", "the cloud unreachable", { status: 502, body: { error: "the cloud did not answer: fetch failed" } }, "the cloud did not answer: fetch failed"],
    ["join", "a host with no /projects", { status: 404, body: { error: "no such route" } }, "the host service has no /projects routes (it answered 404 no such route): it runs a build from before projects; restart fleet-host on a newer fleet-live"],
    ["join", "an unknown refusal", { status: 503, body: { _tag: "FleetUnavailable", issue: "the registry could not be read" } }, 'the host answered 503: {"_tag":"FleetUnavailable","issue":"the registry could not be read"}'],
  ];

  for (const [command, tag, reply, words] of cases) {
    test(`${command}: ${reply.status} ${tag} is said in words`, async () => {
      const route = command === "new" ? "POST /projects" : command === "archive" ? "POST /projects/court/archive" : "POST /projects/court/teams";
      const host = fakeHost({ [route]: reply });
      const at = place(host);
      const ran = await project(at, at.repo, command === "new" ? ["new", "Court integrations"] : [command, "court"]);

      expect(ran).toEqual({ code: 1, stdout: "", stderr: `project: ${words}\n` });
    });
  }

  test("a host that is not running is said so, and a FLEET_RUN_URL off loopback sends nothing", async () => {
    const gone = fakeHost({});
    gone.stop();
    const at = place(gone);
    const down = await project(at, at.repo, ["list"]);

    expect(down.code).toBe(1);
    expect(down.stderr).toStartWith(`project: nothing answers at ${gone.origin}: this machine's fleet-host is not running (`);

    const off = await project({ ...at, env: { ...at.env, FLEET_RUN_URL: "https://example.com:7633" } }, at.repo, ["list"]);

    expect(off).toEqual({ code: 1, stdout: "", stderr: "project: FLEET_RUN_URL is https://example.com:7633; it is the host service's http address on 127.0.0.1 with its port\n" });
  });

  test("a command not among them is a usage error", async () => {
    const at = place(fakeHost({}));
    const ran = await project(at, at.repo, ["delete", "court"]);

    expect(ran.code).toBe(2);
    expect(ran.stderr).toEndWith("fleet project: error: argument cmd: invalid choice: 'delete' (choose from 'new', 'join', 'manage', 'archive', 'list')\n");
  });
});

describe("archive and list", () => {
  const ARCHIVED = { ...PROJECT, state: "archived", archivedAt: "2026-10-30T12:00:00.000Z" };

  test("archive says the project is read-only, and names this machine's team folders to prune", async () => {
    const host = fakeHost({
      "POST /projects/court/archive": { status: 200, body: ARCHIVED },
      "GET /projects": { status: 200, body: { machine: "office", projects: [ARCHIVED], teams: [TEAM("api"), { ...TEAM("other"), project: "tstack" }] } },
    });

    const at = place(host);
    const ran = await project(at, at.repo, ["archive", "court"]);

    expect(ran).toEqual({
      code: 0,
      stdout:
        "project court archived 2026-10-30T12:00:00.000Z: read-only from now on; its pages and ledgers still read\n" +
        `team api: stop its agent (\`fleet team stop NAME\` in its repo), then \`fleet ws ${ledger(at, "api")} prune --apply\`\n`,
      stderr: "",
    });
    expect(host.sent.map((s) => `${s.method} ${s.path} ${JSON.stringify(s.body)}`)).toEqual(["POST /projects/court/archive {}", "GET /projects undefined"]);
  });

  test("list prints this machine's projects, each with its teams here", async () => {
    const host = fakeHost({
      "GET /projects": {
        status: 200,
        body: {
          machine: "office",
          projects: [{ ...PROJECT, manager: "court-manager" }, { ...ARCHIVED, id: "old", title: "Old", createdBy: { machine: "office", session: null } }],
          teams: [TEAM("api"), TEAM("court-manager", "manager"), { ...TEAM("old-x"), project: "old" }],
        },
      },
    });

    const at = place(host);
    const ran = await project(at, at.repo, ["list"]);

    expect(ran).toEqual({
      code: 0,
      stdout:
        'court "Court integrations": open, made by office (session sess-1) 2026-10-30T10:00:00.000Z, managed by court-manager\n' +
        "  api: coordinator of coelhorocha/custom-mcp-servers\n" +
        "  court-manager: manager of coelhorocha/custom-mcp-servers\n" +
        'old "Old": archived 2026-10-30T12:00:00.000Z, made by office 2026-10-30T10:00:00.000Z, no manager\n' +
        "  old-x: coordinator of coelhorocha/custom-mcp-servers\n",
      stderr: "",
    });
  });

  test("list with no project says so", async () => {
    const host = fakeHost({ "GET /projects": { status: 200, body: { machine: "office", projects: [], teams: [] } } });
    const at = place(host);

    expect((await project(at, at.repo, ["list"])).stdout).toBe("this machine (office) has no team in any project\n");
  });
});
