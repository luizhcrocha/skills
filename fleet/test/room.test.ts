/**
 * The project room as a team folder sees it (room design, slice 5): the host's export writes `room.jsonl` and
 * `room.json` beside `chat.jsonl`; `fleet room <project> since|say|forwarded` reads and writes it; the host's
 * `--once` watch wakes for the lines that name its team; `fleet state` says what is left unread.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { asObject, parseJson, type JsonObject } from "../src/json.ts";

import { baseEnv, fleet, sleep, start, tmp, type Environment } from "./support.ts";

const MEMBERS = {
  project: "casos",
  manager: "mgr",
  teams: [
    { id: "mgr", role: "manager", workers: [] },
    { id: "api", role: "coordinator", workers: [{ id: "c208", name: "tests" }] },
    { id: "web", role: "coordinator", workers: [] },
  ],
};

type Target = { team: string; agent?: string };

function line(id: number, from: string, to: "everyone" | Target[], text: string, re: number | null = null, at = "2026-10-30T09:00:00Z"): string {
  return `${JSON.stringify({ id, at, project: "casos", from, to, re, text, parts: [{ text }] })}\n`;
}

/** #1 untagged from the user, #2 the manager to api, #3 api's answer, #4 the user to api's worker c208, #5 untagged
 * from web, #6 untagged from the manager. */
const ROOM = [
  line(1, "user", "everyone", "morning all"),
  line(2, "mgr", [{ team: "api" }], "api: can you check the deploy?", 1),
  line(3, "api", [{ team: "mgr" }], "on it", 2),
  line(4, "user", [{ team: "api", agent: "c208" }], "c208: rerun the suite", 3),
  line(5, "web", "everyone", "web is green"),
  line(6, "mgr", "everyone", "thanks"),
].join("");

let base: string;

let env: Environment;

let api: string;

let mgr: string;

function team(id: string, role: "coordinator" | "manager"): string {
  const root = join(base, "fleet", id);
  expect(fleet(["state", root, "init", "--project", "casos", "--goal", "g", "--role", role, "--no-render"], env).code).toBe(0);
  writeFileSync(join(root, "cloud.json"), JSON.stringify({ fleet: id }));
  writeFileSync(join(root, "room.json"), JSON.stringify(MEMBERS));
  writeFileSync(join(root, "room.jsonl"), ROOM);

  return root;
}

/** A line from the user in the team's own chat, so a `--once` watch has something to exit on. */
function chatLine(root: string, id: number, to: string): void {
  appendFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id, at: "2026-10-30T09:00:00+00:00", from: "user", to: [to], text: "hi", re: null })}\n`);
}

function events(root: string): (JsonObject | undefined)[] {
  return readFileSync(join(root, "room-events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => asObject(Option.getOrUndefined(parseJson(l))));
}

beforeEach(() => {
  base = tmp();
  mkdirSync(join(base, "fleet"));
  env = baseEnv(join(base, "registry"), { FLEET_NOW: "2026-10-30T09:05:00+00:00" });
  api = team("api", "coordinator");
  mgr = team("mgr", "manager");
});

describe("the --once watch wakes a team for the room lines that name it", () => {
  test("a line to the team, and one to its worker, with each one's re chain, the forward and the pointer", () => {
    const ran = fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env);

    expect(ran.stdout).toBe(
      [
        "room casos #2 from manager to @api: api: can you check the deploy?",
        "  re #1 you: morning all",
        "room casos #4 from you to @api/c208: c208: rerun the suite",
        "  re #3 us: on it   re #2 manager: api: can you check the deploy?   re #1 you: morning all",
        "room: 2 lines since #0 you did not read; `fleet room casos since 0 --as api`",
        "! forward #4 verbatim (SendMessage c208), then `fleet room casos forwarded 4 --to c208 --as api`",
        "",
      ].join("\n"),
    );
    expect(events(api)).toEqual([
      { kind: "delivered", at: "2026-10-30T09:05:00.000Z", team: "api", line: 2, how: "watch" },
      { kind: "delivered", at: "2026-10-30T09:05:00.000Z", team: "api", line: 4, how: "watch" },
    ]);
  });

  test("a line once delivered does not wake again; the pointer rides on the next real wake", () => {
    fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env);
    expect(readFileSync(join(api, "room.seen"), "utf8")).toBe("2\n1\n4\n3\n");
    chatLine(api, 1, "coordinator");

    expect(fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env).stdout).toBe(
      "#1 user -> coordinator: hi\nroom: 2 lines since #0 you did not read; `fleet room casos since 0 --as api`\n",
    );
  });

  test("the manager wakes for the user's untagged line and for a line to it, never for its own", () => {
    expect(fleet(["chat", mgr, "watch", "--as", "manager", "--resume", "--once"], env).stdout).toBe(
      [
        "room casos #1 from you to everyone: morning all",
        "room casos #3 from api to @manager: on it",
        "  re #2 us: api: can you check the deploy?   re #1 you: morning all",
        "room: 2 lines since #0 you did not read; `fleet room casos since 0 --as mgr`",
        "",
      ].join("\n"),
    );
  });

  test("a line session-wake showed (room.seen, one id a line), or one already pulled, does not wake", () => {
    writeFileSync(join(api, "room.seen"), "2\n1\n");
    writeFileSync(join(api, "room.cursor"), "4\n");
    chatLine(api, 1, "coordinator");

    expect(fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env).stdout).toBe(
      "#1 user -> coordinator: hi\nroom: 2 lines since #4 you did not read; `fleet room casos since 4 --as api`\n",
    );
  });

  test("an untagged line from a team or the manager wakes nobody", () => {
    writeFileSync(join(api, "room.jsonl"), [line(5, "web", "everyone", "web is green"), line(6, "mgr", "everyone", "thanks")].join(""));
    chatLine(api, 1, "coordinator");

    expect(fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env).stdout).toBe(
      "#1 user -> coordinator: hi\nroom: 2 lines since #0 you did not read; `fleet room casos since 0 --as api`\n",
    );
  });

  test("the chain cuts its nearest line to about 600 tokens, and a text's breaks to spaces", () => {
    writeFileSync(join(api, "room.jsonl"), [line(1, "user", "everyone", "x".repeat(3000)), line(2, "mgr", [{ team: "api" }], "api:\n  look", 1)].join(""));

    expect(fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env).stdout).toBe(`room casos #2 from manager to @api: api: look\n  re #1 you: ${"x".repeat(2399)}…\n`);
  });

  test("a line the export appends while the watch waits wakes it", async () => {
    fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env);
    const { proc, lines } = start(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env);
    await sleep(800);
    expect(proc.exitCode).toBeNull();
    appendFileSync(join(api, "room.jsonl"), line(7, "web", [{ team: "api" }], "api: the schema moved", 5));
    const done = await Promise.race([proc.exited, sleep(5000).then(() => "still waiting" as const)]);

    if (done === "still waiting") proc.kill();
    expect(done).toBe(0);
    expect(await lines.rest()).toBe(
      "room casos #7 from web to @api: api: the schema moved\n  re #5 web: web is green\nroom: 1 line since #0 you did not read; `fleet room casos since 0 --as api`\n",
    );
  });

  test("a forward left unacked for ten minutes is told again, once", async () => {
    fleet(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], env);
    const later = { ...env, FLEET_NOW: "2026-10-30T09:11:00+00:00", FLEET_CHECK_S: "0.2" };
    const { proc, lines } = start(["chat", api, "watch", "--as", "coordinator", "--resume", "--once"], later);
    const done = await Promise.race([proc.exited, sleep(5000).then(() => "still waiting" as const)]);

    if (done === "still waiting") proc.kill();
    expect(done).toBe(0);
    expect(await lines.rest()).toContain(
      "! #4 for c208 is not forwarded yet: forward it verbatim (SendMessage c208), then `fleet room casos forwarded 4 --to c208 --as api`\n",
    );
  });
});

describe("fleet room <project> since <k>", () => {
  test("prints the lines after k, moves the cursor, records the pull; the pointer then says nothing", () => {
    expect(fleet(["state", api, "show"], env).stderr).toContain("room: 5 lines since #0 you did not read; `fleet room casos since 0 --as api`\n");
    const ran = fleet(["room", "casos", "since", "2", "--as", "api"], env);

    expect(ran.stderr).toBe("");
    expect(ran.stdout).toBe(
      [
        "#3 us -> @manager: on it ↳#2",
        "#4 you -> @api/c208: c208: rerun the suite ↳#3",
        "#5 web -> everyone: web is green",
        "#6 manager -> everyone: thanks",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(api, "room.cursor"), "utf8")).toBe("6");
    expect(events(api)).toEqual([{ kind: "pull", at: "2026-10-30T09:05:00.000Z", team: "api", since: 2, lines: 4 }]);
    expect(fleet(["state", api, "show"], env).stderr).not.toContain("room:");
  });

  test("without --as, the one team folder whose room.json names the project; two are refused by name", () => {
    const two = fleet(["room", "casos", "since", "0"], env);

    expect(two.code).toBe(1);
    expect(two.stderr).toContain("api, mgr");
    writeFileSync(join(mgr, "room.json"), JSON.stringify({ ...MEMBERS, project: "other" }));
    expect(fleet(["room", "casos", "since", "5"], env).stdout).toBe("#6 manager -> everyone: thanks\n");
  });

  test("a project no team folder here names is refused", () => {
    const ran = fleet(["room", "nowhere", "since", "0"], env);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("no team folder on this machine is in project nowhere");
  });
});

describe("fleet room <project> say and forwarded send one program through fleet-run", () => {
  function stub(exit = 0): Environment {
    const bin = join(base, "fleet-run");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$FLEET_DIR" >"${base}/run.dir"\ncat >"${base}/run.program"\necho '{"status":"completed"}'\nexit ${exit}\n`);
    chmodSync(bin, 0o755);

    return { ...env, TSTACK_FLEET_RUN: bin };
  }

  test("say composes room(text, { re }) for the team's folder", () => {
    const ran = fleet(["room", "casos", "say", "--as", "api", "--re", "4", 'done: "green"'], stub());

    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('{"status":"completed"}\n');
    expect(readFileSync(join(base, "run.dir"), "utf8")).toBe(`${api}\n`);
    expect(readFileSync(join(base, "run.program"), "utf8")).toBe('return await room("done: \\"green\\"", { re: 4 });\n');
  });

  test("answer posts a worker's answer as a reply to the line", () => {
    expect(fleet(["room", "casos", "answer", "4", "--as", "api", "suite green"], stub()).code).toBe(0);
    expect(readFileSync(join(base, "run.program"), "utf8")).toBe('return await room.answer(4, "suite green");\n');
  });

  test("forwarded acks the line and records the forward", () => {
    const ran = fleet(["room", "casos", "forwarded", "4", "--to", "c208", "--as", "api"], stub());

    expect(ran.code).toBe(0);
    expect(readFileSync(join(base, "run.program"), "utf8")).toBe('return await room.forwarded(4, "c208");\n');
    expect(events(api)).toEqual([{ kind: "forwarded", at: "2026-10-30T09:05:00.000Z", team: "api", line: 4, agent: "c208" }]);
  });

  test("a forward the program did not complete records nothing, and its exit code is the program's", () => {
    const ran = fleet(["room", "casos", "forwarded", "4", "--to", "c208", "--as", "api"], stub(4));

    expect(ran.code).toBe(4);
    expect(() => readFileSync(join(api, "room-events.jsonl"), "utf8")).toThrow();
  });
});
