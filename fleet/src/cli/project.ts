/**
 * `fleet project {new,join,manage,archive,list}`: the cloud registry's projects, asked through this machine's host
 * service on loopback (`$FLEET_RUN_URL`, else http://127.0.0.1:7633), which calls the cloud under the machine's
 * token; the CLI holds none. `join` and `manage` run in a repo (the nearest folder up holding `.jj` or `.git`) and
 * send its identity, the owner and name of its origin remote in lower case; the host makes the team's ledger
 * folder and cuts it over to the cloud, and the command waits for its cloud.json. Each refusal of the registry is
 * said in words.
 */
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Refusal, UsageError } from "../errors.ts";
import { exists, isMoved } from "../files.ts";
import { Out } from "../io.ts";
import { asArray, asObject, asString, parseObject, pyStr, type Json, type JsonObject } from "../json.ts";
import type { Role, Why } from "../team/agents.ts";
import { ledgerNamed } from "../team/ledger.ts";
import { World, type Machine } from "../world.ts";
import { formatUsage, opt, parseArgs, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";

const PROG = "fleet project";

/** The host service's address when `$FLEET_RUN_URL` names none: the run server's port, 7633. */
const HOST = "http://127.0.0.1:7633";

/** How long a join waits for the host to cut the team's folder over, in milliseconds. */
export const JOIN_WAIT_MS = 30_000;

const TEAM = opt.value("--team", { metavar: "ID" });

const COMMANDS: readonly CommandSpec[] = [
  { name: "new", positionals: [{ dest: "title" }], options: [opt.value("--id", { metavar: "ID" })] },
  { name: "join", positionals: [{ dest: "project" }], options: [TEAM, opt.value("--role", { choices: ["coordinator", "manager"] })] },
  { name: "manage", positionals: [{ dest: "project" }], options: [TEAM] },
  { name: "archive", positionals: [{ dest: "project" }], options: [] },
  { name: "list", positionals: [], options: [] },
];

const HELP = `usage: ${PROG} {new,join,manage,archive,list} ...

The cloud's projects, through this machine's fleet-host (FLEET_RUN_URL, else http://127.0.0.1:7633).

    new TITLE [--id ID]               make a project; its id is the title's (Court integrations: court-integrations)
    join PROJECT [--team ID] [--role {coordinator,manager}]
                                      this repo's team in PROJECT: made, or the one this repo and machine have;
                                      waits until the host has cut its ledger over and prints it
    manage PROJECT [--team ID]        the same as join --role manager: the project's one manager team
    archive PROJECT                   make PROJECT read-only (only the machine that made it; the owner, on its page)
    list                              this machine's projects and their teams here

join and manage run in the repo: its identity is its origin remote's owner/name, else its folder under ~/repos.`;

/** A host service's answer: its status and its body. */
interface Reply {
  readonly status: number;
  readonly body: JsonObject | undefined;
  readonly text: string;
}

/** A repo as the registry knows it: its folder here and its identity across machines (`owner/name`). */
export interface Repo {
  readonly root: string;
  readonly id: string;
}

/** What a join asks: the project, the role, the team's id when one is named, the repo; `taken` is what to do when
 * that id is another's (default: name another with --team). */
export interface JoinAsk {
  readonly project: string;
  readonly role: Role;
  readonly team: string | undefined;
  readonly repo: Repo;
  readonly taken?: string;
}

/** The team a join gave, its folder when the host named it, and what to say of it. */
export interface Joined {
  readonly team: string;
  readonly dir: string | undefined;
  readonly line: string;
}

const REPO_ID = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/;

const str = (value: Json | undefined): string => asString(value) ?? "?";

const strs = (value: Json | undefined): string => (asArray(value) ?? []).map(str).join(", ");

/** The host service's origin, or why `$FLEET_RUN_URL` is not one. */
function hostOf(machine: Machine): { readonly origin: string } | Why {
  const given = machine.env("FLEET_RUN_URL");
  const text = given === undefined || given === "" ? HOST : given;
  const url = URL.parse(text);

  return url !== null && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""
    ? { origin: url.origin }
    : { why: `FLEET_RUN_URL is ${text}; it is the host service's http address on 127.0.0.1 with its port` };
}

/** `method path` asked of the host service at `origin`, with `body` as JSON; the reply, or why none came. */
async function call(origin: string, method: "GET" | "POST", path: string, body?: JsonObject): Promise<Reply | Why> {
  const init: RequestInit = { method, redirect: "error", signal: AbortSignal.timeout(60_000) };

  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${origin}${path}`, init);
    const text = await response.text();

    return { status: response.status, body: Option.getOrUndefined(parseObject(text)), text };
  } catch (cause) {
    const said = cause instanceof Error ? cause.message : String(cause);

    return cause instanceof Error && "code" in cause && cause.code === "UnexpectedRedirect"
      ? { why: `${origin} answered with a redirect, which the host service never sends: another service listens there (${said})` }
      : { why: `nothing answers at ${origin}: this machine's fleet-host is not running (${said})` };
  }
}

type Words = (body: JsonObject) => string;

/** Each refusal the registry, the cloud's access or the host answers with, in words. */
const REFUSALS = new Map<string, Words>([
  [
    "ProjectExists",
    (b) =>
      b["state"] === "archived"
        ? `project ${str(b["project"])} exists already, archived (an archived project keeps its id): name a new one with --id`
        : `project ${str(b["project"])} exists already: join it with \`fleet project join ${str(b["project"])}\`, or name a new one with --id`,
  ],
  ["ProjectArchived", (b) => `project ${str(b["project"])} is archived: it is read-only, and no team joins it`],
  ["HasManager", (b) => `project ${str(b["project"])} has a manager already, the team ${str(b["team"])} of another repo or machine`],
  ["ManyTeams", (b) => `this machine has several teams of project ${str(b["project"])} for ${str(b["repo"])} (${strs(b["teams"])}): name one with --team`],
  ["TeamNotManager", (b) => `the team ${str(b["team"])} of this machine is a coordinator's team, not a manager team: name another with --team`],
  ["UnknownProject", (b) => `the registry has no project ${str(b["project"])}: \`fleet project new\` makes one`],
  ["BadRegistryBody", (b) => `the registry refused what was sent: ${str(b["issue"])}`],
  ["NotAllowed", () => "this machine may not: a project is archived by the machine that made it, or by the owner from its page"],
]);

/** A team id taken, and what to do about it. */
const teamTaken =
  (then: string): Words =>
  (b) =>
    `the team id ${str(b["team"])} is taken by another project, repo or machine: ${then}`;

/** Why the host service did not do what was asked, from its answer; `more` words a refusal REFUSALS does not. */
function refusalOf(reply: Reply, more: ReadonlyMap<string, Words>): Why {
  const tag = asString(reply.body?.["_tag"]);
  const words = tag === undefined ? undefined : (more.get(tag) ?? REFUSALS.get(tag));

  if (words !== undefined && reply.body !== undefined) return { why: words(reply.body) };
  const error = asString(reply.body?.["error"]);

  if (reply.status === 404 && error === "no such route")
    return { why: "the host service has no /projects routes (it answered 404 no such route): it runs a build from before projects; restart fleet-host on a newer fleet-live" };

  return { why: error ?? `the host answered ${reply.status}: ${reply.text}` };
}

/** Ask the host service, and take its 2xx answer's body; any other answer is its refusal, worded by `more` first. */
function ask(machine: Machine, method: "GET" | "POST", path: string, body?: JsonObject, more: ReadonlyMap<string, Words> = new Map()): Effect.Effect<{ readonly status: number; readonly body: JsonObject }, Why> {
  return Effect.gen(function* () {
    const origin = hostOf(machine);

    if ("why" in origin) return yield* Effect.fail(origin);
    const reply = yield* Effect.promise(() => call(origin.origin, method, path, body));

    if ("why" in reply) return yield* Effect.fail(reply);

    if (reply.status < 200 || reply.status > 299 || reply.body === undefined) return yield* Effect.fail(refusalOf(reply, more));

    return { status: reply.status, body: reply.body };
  });
}

/** `owner/name` of a remote's URL (`git@github.com:Owner/Name.git`, `https://host/owner/name`), lower case. */
function repoIdOf(url: string): string | undefined {
  const parts = url
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .split(/[/:]/u)
    .filter((p) => p !== "");

  const id = parts.slice(-2).join("/").toLowerCase();

  return parts.length >= 2 && REPO_ID.test(id) ? id : undefined;
}

/** The `owner/name` of the repo at `root` by its origin remote: jj's fetch URL when it is a jj repo and that names
 * one (`origin <url>`, then ` (push: <url>)` when a push URL is set), else git's; undefined when neither does. */
function originIdOf(root: string): string | undefined {
  if (exists(join(root, ".jj"))) {
    const listed = spawnSync("jj", ["git", "remote", "list", "--ignore-working-copy"], { cwd: root, encoding: "utf8" });
    const line = listed.status === 0 ? listed.stdout.split("\n").find((l) => l.startsWith("origin ")) : undefined;
    const url = line?.slice("origin ".length).split(" ")[0];
    const id = url === undefined ? undefined : repoIdOf(url);

    if (id !== undefined) return id;
  }

  const got = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });

  return got.status === 0 ? repoIdOf(got.stdout) : undefined;
}

/** The repo `cwd` is in, the nearest folder up holding `.jj` or `.git`, named by its origin remote; else by its
 * folder under `~/repos/<owner>/<name>`; or why it has no name. */
export function repoAt(cwd: string, home: string): Repo | Why {
  let root = cwd;

  while (!exists(join(root, ".jj")) && !exists(join(root, ".git"))) {
    if (dirname(root) === root) return { why: `${cwd} is in no repo (no .jj or .git from it up): run it in the repo the team works in` };
    root = dirname(root);
  }

  const fromRemote = originIdOf(root);

  if (fromRemote !== undefined) return { root, id: fromRemote };
  const under = relative(join(home, "repos"), root);
  const fromFolder = `${basename(dirname(root))}/${basename(root)}`.toLowerCase();

  return under !== "" && !under.startsWith("..") && under.split(sep).length >= 2 && REPO_ID.test(fromFolder)
    ? { root, id: fromFolder }
    : { why: `${root} has no origin remote naming owner/name, and is not a folder ~/repos/<owner>/<name>: add its origin remote` };
}

/** A request's body: `fields` but those not given, and the session's label (`$CLAUDE_CODE_SESSION_ID`), which the
 * registry records as who made a row. */
function bodyOf(machine: Machine, fields: Readonly<Record<string, string | undefined>>): JsonObject {
  const body: Record<string, string> = {};

  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body[key] = value;
  const label = machine.env("CLAUDE_CODE_SESSION_ID");

  if (label !== undefined && label !== "") body["session"] = label;

  return body;
}

/** Join `ask.project` from `ask.repo` (its team made, or the one it has), through the host service. */
export function joinProject(machine: Machine, asked: JoinAsk): Effect.Effect<Joined, Why> {
  return Effect.gen(function* () {
    const body = bodyOf(machine, { repo: asked.repo.id, path: asked.repo.root, role: asked.role, team: asked.team });
    const more = new Map([["TeamTaken", teamTaken(asked.taken ?? "name another with --team")]]);
    const answer = yield* ask(machine, "POST", `/projects/${encodeURIComponent(asked.project)}/teams`, body, more);
    const team = str(answer.body["id"]);
    const dir = asString(answer.body["dir"]);
    const how = answer.status === 201 ? "joined" : "already in";

    return {
      team,
      dir: dir !== undefined && isAbsolute(dir) ? dir : undefined,
      line: `${how} project ${str(answer.body["project"])} as team ${team} (${str(answer.body["repo"])}, ${str(answer.body["role"])})`,
    };
  });
}

/** Whether `ledger` holds its cloud.json within `waitMs`: the host has cut the team's folder over. */
export function awaitMoved(ledger: string, waitMs: number): Effect.Effect<boolean> {
  return Effect.promise(async () => {
    const until = Date.now() + waitMs;

    while (!isMoved(ledger)) {
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, waitMs)));
    }

    return true;
  });
}

/** The joined team's ledger once its host cut it over: the folder the host named, else the one {@link ledgerNamed}
 * finds; or why it is not there yet. `again` is the command that waits again. */
export function ledgerOfJoined(machine: Machine, joined: Joined, waitMs: number, again: string): Effect.Effect<string, Why> {
  return Effect.gen(function* () {
    const found = joined.dir === undefined ? ledgerNamed(joined.team, machine.registry.known(), machine.env("HOME") ?? "") : { ledger: joined.dir };

    if ("why" in found) return yield* Effect.fail(found);

    if (yield* awaitMoved(found.ledger, waitMs)) return found.ledger;

    return yield* Effect.fail({
      why: `the host has not cut ${found.ledger} over to the cloud yet (no cloud.json after ${waitMs / 1000} s): \`${again}\` again waits for it, and \`fleet ls\` lists the team once it has`,
    });
  });
}

/** The page of project `id`, beside the page of a team of this machine moved to the cloud; "" when none has. */
function pageOf(machine: Machine, id: string): string {
  const url = machine.registry.shown().find((e) => e.moved === true && e.url !== "")?.url;

  return url === undefined ? "" : `${url.slice(0, url.lastIndexOf("/"))}/p/${id}`;
}

/** One project of a machine's view, as `list` prints it. */
function projectLine(p: JsonObject): string {
  const by = asObject(p["createdBy"]);
  const session = asString(by?.["session"]);
  const state = p["state"] === "archived" ? `archived ${str(p["archivedAt"])}` : "open";
  const manager = asString(p["manager"]);

  return `${str(p["id"])} ${JSON.stringify(str(p["title"]))}: ${state}, made by ${str(by?.["machine"])}${session === undefined ? "" : ` (session ${session})`} ${str(p["createdAt"])}, ${manager === undefined ? "no manager" : `managed by ${manager}`}`;
}

function objects(value: Json | undefined): JsonObject[] {
  return (asArray(value) ?? []).flatMap((v) => {
    const object = asObject(v);

    return object === undefined ? [] : [object];
  });
}

type Step = Effect.Effect<number, Why | UsageError | "help", Out>;

function run(machine: Machine, argv: readonly string[], cwd: string, waitMs: number): Step {
  return Effect.gen(function* () {
    const out = yield* Out;
    const width = usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined);
    const names = COMMANDS.map((c) => c.name);
    const [cmd, ...rest] = argv;

    if (cmd === "-h" || cmd === "--help") return yield* Effect.fail("help" as const);
    const top = (reason: string): UsageError => new UsageError({ prog: PROG, usage: formatUsage(PROG, ["[-h]"], [`{${names.join(",")}} ...`], width), reason });

    if (cmd === undefined) return yield* Effect.fail(top("the following arguments are required: cmd"));
    const spec = COMMANDS.find((c) => c.name === cmd);

    if (spec === undefined) return yield* Effect.fail(top(`argument cmd: invalid choice: ${pyStr(cmd)} (choose from ${names.map((n) => pyStr(n)).join(", ")})`));
    const parsed = parseArgs(`${PROG} ${cmd}`, spec, rest, width);

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);

    if (parsed.extras.length > 0) return yield* Effect.fail(top(`unrecognized arguments: ${parsed.extras.join(" ")}`));
    const { args } = parsed;
    const project = args.str("project") ?? "";

    if (cmd === "new") {
      const made = yield* ask(machine, "POST", "/projects", bodyOf(machine, { title: args.str("title") ?? "", id: args.str("id") }));
      const id = str(made.body["id"]);
      const page = pageOf(machine, id);

      out.out(
        `project ${id} (${JSON.stringify(str(made.body["title"]))}) created${page === "" ? "" : `; page ${page}`}. ` +
          `Join it from a repo with \`fleet project join ${id}\`, or manage it from one with \`fleet project manage ${id}\`.\n`,
      );

      return 0;
    }

    if (cmd === "join" || cmd === "manage") {
      const repo = repoAt(cwd, machine.env("HOME") ?? "");

      if ("why" in repo) return yield* Effect.fail(repo);
      const role: Role = cmd === "manage" || args.str("role") === "manager" ? "manager" : "coordinator";
      const joined = yield* joinProject(machine, { project, role, team: args.str("team"), repo });

      out.out(`${joined.line}\n`);
      const ledger = yield* ledgerOfJoined(machine, joined, waitMs, `fleet project ${role === "manager" ? "manage" : "join"} ${project} --team ${joined.team}`);

      out.out(`Your ledger is ${ledger}.\n`);

      return 0;
    }

    if (cmd === "archive") {
      const archived = yield* ask(machine, "POST", `/projects/${encodeURIComponent(project)}/archive`, {});

      out.out(`project ${str(archived.body["id"])} archived ${str(archived.body["archivedAt"])}: read-only from now on; its pages and ledgers still read\n`);
      const view = yield* ask(machine, "GET", "/projects");

      for (const team of objects(view.body["teams"]).filter((t) => t["project"] === project))
        out.out(
          `team ${str(team["id"])}: stop its agent with \`fleet team stop ${str(team["id"])}\` in its repo; ` +
            `no command takes out a moved team's workspaces yet, so take them out by hand as the coordinator skill's PROGRAMS.md says ("What stays on the old CLI")\n`,
        );

      return 0;
    }

    const view = yield* ask(machine, "GET", "/projects");
    const projects = objects(view.body["projects"]);
    const teams = objects(view.body["teams"]);

    if (projects.length === 0) out.out(`this machine (${str(view.body["machine"])}) has no team in any project\n`);

    for (const p of projects) {
      out.out(`${projectLine(p)}\n`);

      for (const t of teams.filter((team) => team["project"] === p["id"])) out.out(`  ${str(t["id"])}: ${str(t["role"])} of ${str(t["repo"])}\n`);
    }

    return 0;
  });
}

/** `fleet project` with `argv` (after `project`), the repo found from `cwd`, a join waiting at most `waitMs` for its
 * team's cloud.json; the exit code. */
export function projectWith(argv: readonly string[], cwd: string, waitMs: number): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv, cwd, waitMs).pipe(
      Effect.catch((failure) => (failure === "help" ? printUsage(HELP) : exitOf(failure instanceof UsageError ? failure : new Refusal({ speaker: "project", reason: failure.why })))),
    );
  });
}

/** `fleet project` with `argv` (after `project`), from the process's directory. */
export function projectCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return projectWith(argv, process.cwd(), JOIN_WAIT_MS);
}
