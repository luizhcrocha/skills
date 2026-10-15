/**
 * A moved team stays in the machine's view (fleet slice 3): `fleet serve --stop` takes it off the hub, but its
 * folder beside the registry (`~/.local/state/fleet/<team>`) holds cloud.json and the ledger and chat the host
 * service exports from the cloud. What waits on the user there is listed, read from those files, and links go to
 * the team's cloud page, `<cloud>/<fleet>`.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { append } from "../src/chat/chat.ts";
import { FleetNews } from "../src/chat/news.ts";
import { asArray, asObject, parseObject, type JsonObject } from "../src/json.ts";
import { cliLookups } from "../src/page/lookups.ts";
import { view } from "../src/page/view.ts";
import { baseEnv, fleet, machine, tmp, type Environment } from "./support.ts";

const PAGE = "https://fleet.example.dev/skills";

let base: string;

let env: Environment;

let root: string;

function ledger(more: JsonObject = {}): JsonObject {
  return {
    project: "skills",
    goal: "move to the cloud",
    status: "running",
    now: "slice 3 cut over",
    started: "2026-10-15T10:00:00+00:00",
    roadmap: [],
    agents: [],
    roadblocks: [],
    events: [],
    decisions: [
      { id: "D1", title: "Pick the export host", question: "Which machine exports?", status: "open", asks: "user", opened: "2026-10-15T13:00:00+00:00" },
      { id: "A1", kind: "action", title: "Approve the 1Password prompt", question: "Approve it", status: "open", asks: "user", opened: "2026-10-15T13:05:00+00:00" },
    ],
    ...more,
  };
}

function userSays(dir: string, text: string): void {
  const sent = append(machine(env), dir, { sender: "user", text, allowUser: true }, "2026-10-15T14:00:00+00:00");

  if ("reason" in sent) throw new Error(sent.reason);
}

/** A manager served from this process, in its own folder outside the moved teams'. */
function servedManager(): string {
  const dir = join(base, "m", "coordinator");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...ledger({ decisions: [] }), project: "everything", role: "manager" }));
  machine(env).registry.register(dir, "https://box.ts.net:7420/f/manager/", process.pid, "2026-10-15T09:00:00+00:00");

  return dir;
}

beforeEach(() => {
  base = tmp("fleet-moved-");
  env = baseEnv(join(base, "fleet-board"), { CLAUDE_CONFIG_DIR: join(base, "config") });
  root = join(base, "fleet", "skills");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify(ledger()));
  userSays(root, "item 1 says something is needed from me");
  writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills", cloud: "https://fleet.example.dev", since: "2026-10-15T13:57:41.898Z", host: "box" }));
});

describe("a moved team no server here serves", () => {
  test("`fleets list` shows it with its cloud page and what waits in it", () => {
    const ran = fleet(["fleets", "list"], env);

    expect(ran.stdout).not.toContain("no fleet is being served");
    expect(ran.stdout).toContain("skills  (coordinator, running, moved to the cloud)");
    expect(ran.stdout).toContain(`  page     ${PAGE}\n`);
    expect(ran.stdout).toContain(`  ledger   ${root}\n`);
    expect(ran.stdout).toContain("Pick the export host");
    expect(ran.stdout).toContain("Approve the 1Password prompt");
  });

  test("`fleets waiting` lists its open decision and its action", () => {
    const ran = fleet(["fleets", "waiting"], env);

    expect(ran.stdout).toMatch(/^skills \S+ \[decision\] Pick the export host {2}since 2026-10-15 13:00$/m);
    expect(ran.stdout).toMatch(/^skills \S+ \[action\] Approve the 1Password prompt {2}since 2026-10-15 13:05$/m);
  });

  test("`fleets decision` links a moved team's card by its id, the address the cloud page reads", () => {
    writeFileSync(join(root, "state.json"), JSON.stringify(ledger({ decisions: [
      { id: "s4-smoke", ref: "A81", kind: "action", title: "Rerun the CPU smoke test", question: "Run it", status: "open", asks: "user", opened: "2026-10-15T13:05:00+00:00" },
    ] })));
    const ran = fleet(["fleets", "decision", "skills", "s4-smoke"], env);

    expect(ran.stdout).toContain(`page: ${PAGE}#decision/s4-smoke\n`);
    expect(ran.stdout).not.toContain("#decision/skills/");
  });

  test("`fleets show` reads its ledger and its unread message from the user", () => {
    const ran = fleet(["fleets", "show", "skills"], env);

    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain(`skills  running  ${PAGE}\n`);
    expect(ran.stdout).toContain("1 from the user unread");
    expect(ran.stdout).toContain("Pick the export host: Which machine exports?");
    expect(fleet(["fleets", "decision", "skills", "A1"], env).stdout).toContain("skills A1 [action, for the user] Approve the 1Password prompt");
  });

  test("a folder without cloud.json beside the registry is not a moved team", () => {
    const other = join(base, "fleet", "scratch");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "state.json"), JSON.stringify(ledger({ project: "scratch" })));

    expect(fleet(["fleets", "list"], env).stdout).not.toContain("scratch");
  });

  test("the manager's page lists it among the fleets, its cards linked to the cloud page", () => {
    const manager = servedManager();
    const coordinators = asArray(view(machine(env), cliLookups(), { project: "everything", role: "manager" }, manager)["coordinators"]) ?? [];
    const c = asObject(coordinators.find((x) => asObject(x)?.["id"] === "skills")) ?? {};

    expect(c["url"]).toBe(PAGE);
    expect((asArray(c["decisions"]) ?? []).map((d) => asObject(d)?.["title"])).toEqual(["Pick the export host", "Approve the 1Password prompt"]);
    expect(asObject(c["chat"])?.["unread"]).toBe(1);
  });

  test("the manager's watch --fleets tells its news, from the exported files", () => {
    const manager = servedManager();
    const news = new FleetNews(machine(env), manager, false);

    expect(news.read(), "first seen: from now on").toEqual([]);
    userSays(root, "and the second one?");
    const state = Option.getOrElse(parseObject(readFileSync(join(root, "state.json"), "utf8")), (): JsonObject => ({}));
    const decided = (asArray(state["decisions"]) ?? []).map((d) => (asObject(d)?.["id"] === "D1" ? { ...asObject(d), status: "decided", answer: "the office host" } : d));
    writeFileSync(join(root, "state.json"), JSON.stringify({ ...state, decisions: decided }));

    const lines = news.read();

    expect(lines.some((l) => l.startsWith("skills: you wrote to") && l.endsWith("and the second one?"))).toBe(true);
    expect(lines.some((l) => l.startsWith("skills ") && l.includes("decided: Pick the export host: the office host"))).toBe(true);
  });
});

/** The moved team `skills` as this machine shows it, with `cloud` as its marker's cloud. */
function shownWith(cloud: string | undefined): readonly { readonly id: string; readonly url: string }[] {
  writeFileSync(join(root, "cloud.json"), JSON.stringify(cloud === undefined ? { fleet: "skills" } : { fleet: "skills", cloud }));

  return machine(env).registry.shown().filter((e) => e.id === "skills");
}

describe("a moved team's cloud page is an https address or none", () => {
  for (const cloud of ["javascript:alert(document.domain)//", "JavaScript:alert(1)", "http://fleet.example.dev", "https://me:pw@fleet.example.dev", "https://fleet.example.dev/?next=x", "https://fleet.example.dev/#x", "fleet.example.dev", "data:text/html,<script>alert(1)</script>"]) {
    test(`no page from cloud ${JSON.stringify(cloud)}`, () => {
      expect(shownWith(cloud).map((e) => e.url)).toEqual([""]);
    });
  }

  test("no page when the marker names no cloud, and the team is still listed", () => {
    expect(shownWith(undefined).map((e) => e.url)).toEqual([""]);
  });

  test("an https cloud with a path keeps the path", () => {
    expect(shownWith("https://fleet.example.dev/teams/").map((e) => e.url)).toEqual(["https://fleet.example.dev/teams/skills"]);
  });

  test("the manager's card has no link to a javascript: cloud", () => {
    writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: "skills", cloud: "javascript:alert(document.domain)//" }));
    const manager = servedManager();
    const coordinators = asArray(view(machine(env), cliLookups(), { project: "everything", role: "manager" }, manager)["coordinators"]) ?? [];

    expect(asObject(coordinators.find((x) => asObject(x)?.["id"] === "skills"))?.["url"]).toBe("");
  });
});

describe("each team is shown once", () => {
  test("a live fleet serving the moved team's folder is listed once, as the live one", () => {
    machine(env).registry.register(root, "https://box.ts.net:7420/f/skills/", process.pid, "2026-10-15T09:00:00+00:00");
    const here = machine(env).registry.shown().filter((e) => e.dir === root);

    expect(here.map((e) => e.moved === true)).toEqual([false]);
  });

  test("two moved folders naming one team: the first folder by path is shown", () => {
    const copy = join(base, "fleet", "skills-copy");
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "state.json"), JSON.stringify(ledger()));
    writeFileSync(join(copy, "cloud.json"), JSON.stringify({ fleet: "skills", cloud: "https://other.example.dev" }));

    expect(machine(env).registry.shown().filter((e) => e.id === "skills").map((e) => e.dir)).toEqual([root]);
  });

  test("a moved team named as a live fleet is not shown beside it", () => {
    const registry = machine(env).registry;
    servedManager();
    const live = registry.live();
    const id = live[0]?.id ?? "";
    writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: id, cloud: "https://fleet.example.dev" }));

    expect(registry.shown().filter((e) => e.id === id).map((e) => e.moved === true)).toEqual([false]);
  });

  test("a moved team named as a live fleet's old name is not shown", () => {
    const registry = machine(env).registry;
    const other = join(base, "m", "other");
    mkdirSync(other, { recursive: true });
    registry.register(other, "https://box.ts.net:7420/f/other/", process.pid, "2026-10-15T09:00:00+00:00");
    const live = registry.live().map((e) => ({ ...e, aliases: ["skills"] }));

    expect(registry.moved(live).map((e) => e.id)).toEqual([]);
    expect(registry.moved([]).map((e) => e.id)).toEqual(["skills"]);
  });
});

describe("the manager's news across a half-written export", () => {
  test("a state.json that does not parse, then parses again unchanged, tells no news", () => {
    const manager = servedManager();
    const news = new FleetNews(machine(env), manager, false);
    const whole = readFileSync(join(root, "state.json"), "utf8");

    expect(news.read(), "first seen").toEqual([]);
    writeFileSync(join(root, "state.json"), whole.slice(0, 40));
    expect(news.read(), "mid-export").toEqual([]);
    writeFileSync(join(root, "state.json"), `${whole}\n`);
    expect(news.read(), "export done").toEqual([]);
  });
});

describe("the test environment", () => {
  test("a test's FLEET_HOME has a private parent, so no test reads the shared $TMPDIR/fleet", () => {
    expect(dirname(baseEnv(tmp("fleet-home-"))["FLEET_HOME"] ?? "")).not.toBe(realpathSync(tmpdir()));
  });
});
