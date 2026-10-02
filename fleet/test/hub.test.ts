/**
 * The hub (ported from the coordinator's tests/test_chat.py server classes and test_chat_serve.py,
 * against the hub's routes): each fleet of the registry at /f/<fleet>/ with serve_dashboard.py's routes
 * and status codes, the live stream, the index, who may write, and a peer hub's fleets passed through.
 * Every test starts a real hub on a free loopback port, with a registry of its own and a fake
 * `tailscale` that names this machine's owner.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { append } from "../src/chat/chat.ts";
import { readChat } from "../src/chat/store.ts";
import { ChatError } from "../src/errors.ts";
import { collapse } from "../src/hub/hub.ts";
import { grantor, hello, postRefusal, viewerOf, writerRefusal } from "../src/hub/policy.ts";
import { lsofListenersOf } from "../src/hub/served.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import { frontmatter } from "../src/hub/skills.ts";
import { isTailnetIp, tailnetOf } from "../src/hub/tailnet.ts";
import { asArray, asObject, asString, type JsonObject } from "../src/json.ts";
import { elapsedOf, lsofFiles, parentsOf } from "../src/procs.ts";
import { baseEnv, fleet, machine, spawnFleet, tmp, type Environment } from "./support.ts";

const OWNER = "luiz@example.com";

const FAKE_TAILSCALE = `#!/bin/sh
case "$1 $2" in
  "status --json") printf '%s' '{"BackendState": "Running", "Self": {"DNSName": "box.tail.ts.net.", "TailscaleIPs": ["127.0.0.9"], "UserID": 7}, "User": {"7": {"LoginName": "${OWNER}"}}, "Peer": {}}' ;;
  *) exit 1 ;;
esac
`;

let base: string;

let home: string;

let root: string;

let env: Environment;

let running: Running | undefined;

let port: number;

const stubs: ReturnType<typeof Bun.serve>[] = [];

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const got = probe.port ?? 0;
  void probe.stop(true);

  return got;
}

function writeState(dir: string, agents: readonly JsonObject[], more: JsonObject = {}): void {
  const rows = agents.map((a) => ({ id: a["id"] ?? "", name: a["name"] ?? a["id"] ?? "", task: "t", status: a["status"] ?? "running", lane: [], milestone: "m1" }));

  const state = {
    project: "p",
    goal: "g",
    status: "running",
    now: "n",
    started: "2026-01-01T00:00:00+00:00",
    roadmap: [{ id: "m1", title: "M", steps: [] }],
    agents: rows,
    roadblocks: [],
    events: [],
    ...more,
  };

  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

async function start(options: { readonly tailscale?: string; readonly peers?: boolean } = {}): Promise<void> {
  port = freePort();
  const m = machine(env);
  const got = await startHub({ port, machine: m, tailscale: options.tailscale ?? join(base, "no-tailscale"), peers: options.peers ?? false, hosts: [], https: undefined }, () => {});

  if (got instanceof Error) throw got;
  running = got;
}

function register(dir: string, id?: string): void {
  const m = machine(env);
  const entry = m.registry.register(dir, "u", process.pid, "2026-01-01T00:00:00+00:00");

  if (id !== undefined && entry.id !== id) throw new Error(`registered as ${entry.id}`);
}

interface Answer {
  readonly status: number;
  readonly body: JsonObject;
  readonly headers: Headers;
}

async function request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
  const init: RequestInit = { method, headers, redirect: "manual" };

  if (body !== undefined) init.body = body;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let parsed: JsonObject = {};

  try {
    parsed = asObject(JSON.parse(text)) ?? {};
  } catch {
    parsed = { text };
  }

  return { status: res.status, body: parsed, headers: res.headers };
}

function post(payload: string | JsonObject, headers: Record<string, string> = {}, path = "/f/p/chat"): Promise<Answer> {
  return request("POST", path, payload instanceof Object ? JSON.stringify(payload) : payload, { "Content-Type": "application/json", ...headers });
}

/** An open stream, read one event at a time. */
class Stream {
  private readonly reader: { read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }> };
  private buffer = "";
  private readonly decoder = new TextDecoder();
  readonly response: Response;
  private readonly abort: AbortController;

  private constructor(response: Response, abort: AbortController) {
    this.response = response;
    this.abort = abort;
    const body = response.body;

    if (body === null) throw new Error("no body");
    this.reader = body.getReader();
  }

  static async open(path: string, headers: Record<string, string> = {}): Promise<Stream> {
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: abort.signal });

    return new Stream(res, abort);
  }

  async next(ms = 5000): Promise<Record<string, string>> {
    const deadline = Date.now() + ms;

    for (;;) {
      const end = this.buffer.indexOf("\n\n");

      if (end >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);

        if (block.startsWith(":")) continue;
        const event: Record<string, string> = {};

        for (const line of block.split("\n")) {
          const at = line.indexOf(": ");
          event[line.slice(0, at)] = line.slice(at + 2);
        }

        return event;
      }

      const left = deadline - Date.now();

      if (left <= 0) throw new Error(`no event within ${ms} ms (have ${JSON.stringify(this.buffer)})`);
      const got = await Promise.race([this.reader.read(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), left))]);

      if (got === "timeout") continue;

      if (got.done || got.value === undefined) throw new Error("the stream ended");
      this.buffer += this.decoder.decode(got.value, { stream: true });
    }
  }

  async nextOf(kind: string): Promise<Record<string, string>> {
    for (;;) {
      const event = await this.next();

      if (event["event"] === kind) return event;
    }
  }

  close(): void {
    this.abort.abort();
  }
}

function data(event: Record<string, string>): JsonObject {
  return asObject(JSON.parse(event["data"] ?? "null")) ?? {};
}

function say(sender: string, text: string, more: { readonly re?: number; readonly decision?: string } = {}): number {
  const m = append(machine(env), root, { sender, text, allowUser: true, ...more }, "2026-01-01T00:00:00+00:00");

  if (m instanceof ChatError) throw new Error(m.reason);

  return m.id;
}

beforeEach(() => {
  base = tmp("fleet-hub-");
  home = join(base, "registry");
  root = join(base, "p", "coordinator");
  mkdirSync(root, { recursive: true });
  env = baseEnv(home);
  writeState(root, [{ id: "a1", name: "notes-impl" }, { id: "a2", status: "done" }]);
  register(root, "p");
});

afterEach(async () => {
  await running?.stop();
  running = undefined;

  for (const stub of stubs.splice(0)) void stub.stop(true);
});

describe("a fleet's chat through the hub", () => {
  beforeEach(() => start());

  test("POST stores the user's message and GET lists the messages after an id", async () => {
    const sent = await post({ text: "@a1 status?" });
    expect(sent.status).toBe(201);
    expect([sent.body["id"], sent.body["from"], sent.body["to"]]).toEqual([1, "user", ["a1"]]);
    say("a1", "halfway", { re: 1 });
    const after = await request("GET", "/f/p/chat?after=1");
    expect(after.status).toBe(200);
    expect((asArray(after.body["messages"]) ?? []).map((m) => [asObject(m)?.["id"], asObject(m)?.["text"], asObject(m)?.["re"]])).toEqual([[2, "halfway", 1]]);
    expect(asArray((await request("GET", "/f/p/chat")).body["messages"])?.length).toBe(2);
  });

  test("a command typed on the page is stored as it was typed, and reaches GET /chat and the stream", async () => {
    const stream = await Stream.open("/f/p/events");
    const sent = await post({ text: "/tstack:tdd fix the parser" });
    expect([sent.status, sent.body["from"], sent.body["to"], sent.body["text"]]).toEqual([201, "user", ["coordinator"], "/tstack:tdd fix the parser"]);
    expect(asArray((await request("GET", "/f/p/chat")).body["messages"])).toEqual([sent.body]);
    expect(data(await stream.nextOf("chat"))).toEqual(sent.body);
    stream.close();
  });

  test("a refused post stores nothing and says why", async () => {
    say("user", "one");

    const cases: (readonly [number, Answer])[] = [
      [415, await request("POST", "/f/p/chat", '{"text": "hi"}', { "Content-Type": "text/plain" })],
      [403, await post({ text: "hi" }, { Origin: "https://evil.example" })],
      [413, await post({ text: "x".repeat(300_000) })],
      [400, await post({ text: "  " })],
      [400, await post({ text: "hi", re: 9 })],
      [400, await post("not json")],
      [400, await post({ text: "hi", re: true })],
      [404, await post({ text: "hi" }, {}, "/f/p/elsewhere")],
    ];

    for (const [status, answer] of cases) {
      expect(answer.status).toBe(status);
      expect(asString(answer.body["error"])).toBeString();
    }

    expect(readChat(root).length).toBe(1);
  });

  test("a message of 78 KB is taken; one over 256 KiB is a 413 that says how big it is and what to do", async () => {
    const long = await post({ text: "y".repeat(78_000) });
    expect([long.status, asString(long.body["text"])?.length]).toEqual([201, 78_000]);
    const over = await post({ text: "x".repeat(300_000) });
    expect([over.status, over.body]).toEqual([
      413,
      { error: "This message is 293 KiB; the most a message can be is 256 KiB. Shorten it, or put the long part in a file and give its path." },
    ]);
    expect(readChat(root).length).toBe(1);
  });

  test("hello tells the page the most bytes a post may have", async () => {
    const stream = await Stream.open("/f/p/events");
    expect(data(await stream.next())).toEqual({ write: true, max_bytes: 256 * 1024 });
    stream.close();
  });

  test("a same-origin post is taken", async () => {
    const sent = await post({ text: "hi" }, { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json; charset=utf-8" });
    expect(sent.status).toBe(201);
  });

  test("a store that cannot be written is a 500, not blamed on the body", async () => {
    mkdirSync(join(root, "chat.jsonl"));
    const sent = await post({ text: "hi" });
    expect(sent.status).toBe(500);
    expect(asString(sent.body["error"])).not.toContain("body");
  });

  test("an unknown fleet is a 404 and a fleet's address without its slash moves to it", async () => {
    expect((await request("GET", "/f/nobody/")).status).toBe(404);
    const moved = await request("GET", "/f/p?x=1");
    expect([moved.status, moved.headers.get("Location")]).toEqual([301, "/f/p/?x=1"]);
  });
});

describe("the page and the files", () => {
  beforeEach(() => start());

  test("the page is rendered from state.json on each load", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/f/p/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('<script id="fleet-state" type="application/json">{"project": "p"');
    fleet(["state", root, "set", "--now", "now from the ledger", "-q"], env);
    expect(await (await fetch(`http://127.0.0.1:${port}/f/p/index.html`)).text()).toContain("now from the ledger");
  });

  test("a decision's body is served without the page's origin, wherever its path leads", async () => {
    mkdirSync(join(root, "decisions"));
    writeFileSync(join(root, "decisions", "d1.html"), "<script>fetch('/chat')</script>");

    for (const path of ["/f/p/decisions/d1.html", "/f/p/decisions/d1.html?v=2", "/f/p/decisions/../decisions/d1.html"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy") ?? "").toStartWith("sandbox allow-scripts");
    }

    expect((await fetch(`http://127.0.0.1:${port}/f/p/`)).headers.get("Content-Security-Policy")).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/f/p/state.json`)).headers.get("Content-Security-Policy")).toBeNull();
  });

  test("nothing outside the fleet's directory is served", async () => {
    writeFileSync(join(base, "p", "secret.txt"), "no");

    for (const path of ["/f/p/../secret.txt", "/f/p/%2e%2e/secret.txt", "/f/p/.hidden"]) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(404);
    }
  });
});

describe("the live stream", () => {
  beforeEach(() => start());

  test("hello, then the state on connect, with the stream's headers", async () => {
    const stream = await Stream.open("/f/p/events");
    expect(stream.response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(stream.response.headers.get("Cache-Control")).toBe("no-store");
    expect(stream.response.headers.get("X-Accel-Buffering")).toBe("no");
    const first = await stream.next();
    const state = await stream.next();
    expect([first["event"], data(first)["write"], first["id"]]).toEqual(["hello", true, undefined]);
    expect([state["event"], state["id"]]).toEqual(["state", undefined]);
    expect((asArray(data(state)["agents"]) ?? []).map((a) => asObject(a)?.["id"])).toEqual(["a1", "a2"]);
    stream.close();
  });

  test("a replay after Last-Event-ID, then a message posted on the page", async () => {
    for (const text of ["one", "two", "three"]) say("user", text);
    const stream = await Stream.open("/f/p/events", { "Last-Event-ID": "1" });
    const replayed = [await stream.nextOf("chat"), await stream.nextOf("chat")];
    expect(replayed.map((e) => [e["id"], data(e)["text"]])).toEqual([
      ["2", "two"],
      ["3", "three"],
    ]);
    await post({ text: "@a1 four" });
    const live = await stream.nextOf("chat");
    expect([live["id"], data(live)["to"]]).toEqual(["4", ["a1"]]);
    stream.close();
  });

  test("?after is the resume point without the header", async () => {
    say("user", "one");
    say("user", "two");
    const stream = await Stream.open("/f/p/events?after=1");
    expect((await stream.nextOf("chat"))["id"]).toBe("2");
    stream.close();
  });

  test("a change to the ledger is a state event", async () => {
    const stream = await Stream.open("/f/p/events");
    await stream.next();
    await stream.next();
    fleet(["state", root, "set", "--now", "landing the adapter", "--no-render"], env);
    const event = await stream.nextOf("state");
    expect(data(event)["now"]).toBe("landing the adapter");
    stream.close();
  });

  test("a torn line in the store does not stop the stream or the posts", async () => {
    say("a1", "one");
    const stream = await Stream.open("/f/p/events", { "Last-Event-ID": "1" });
    await stream.next();
    writeFileSync(join(root, "chat.jsonl"), Buffer.concat([readFileSync(join(root, "chat.jsonl")), Buffer.from('{"id": 2, "text": "'), Buffer.from([0xff])]));
    const sent = await post({ text: "@a1 two" });
    expect([sent.status, sent.body["id"]]).toEqual([201, 2]);
    expect((await stream.nextOf("chat"))["id"]).toBe("2");
    stream.close();
  });

  test("clients that leave leave the hub serving", async () => {
    for (let i = 0; i < 3; i += 1) {
      const stream = await Stream.open("/f/p/events");
      await stream.next();
      stream.close();
    }

    say("user", "after the drop");
    expect((await request("GET", "/f/p/chat")).status).toBe(200);
  });
});

describe("preview", () => {
  beforeEach(() => start());

  function preview(payload: string | JsonObject, headers: Record<string, string> = {}): Promise<Answer> {
    return post(payload, headers, "/f/p/chat/preview");
  }

  test("answers whom a text would reach and stores nothing", async () => {
    say("a1", "done?");
    const before = readFileSync(join(root, "chat.jsonl"));
    const got = await preview({ text: "@a2. and you", re: 1 });
    expect([got.status, got.body]).toEqual([200, { to: ["a2", "a1"], parts: [{ text: "@a2", mention: "a2" }, { text: ". and you" }] }]);
    expect((await preview({ text: "" })).body).toEqual({ to: ["coordinator"], parts: [] });
    expect((await preview({ text: "", re: 1 })).body).toEqual({ to: ["a1"], parts: [] });
    expect(readFileSync(join(root, "chat.jsonl")).equals(before)).toBe(true);
  });

  test("is refused as a post is", async () => {
    say("a1", "one");

    const cases: (readonly [number, Answer])[] = [
      [421, await preview({ text: "hi" }, { Host: "evil.com" })],
      [415, await request("POST", "/f/p/chat/preview", '{"text": "hi"}', { "Content-Type": "text/plain" })],
      [403, await preview({ text: "hi" }, { Origin: "https://evil.example" })],
      [413, await preview({ text: "x".repeat(300_000) })],
      [400, await preview({ text: "hi", re: 9 })],
      [400, await preview("not json")],
    ];

    for (const [status, answer] of cases) expect(answer.status).toBe(status);
    expect(readChat(root).length).toBe(1);
  });

  test("every shared recipient case of the user's", async () => {
    const groups = asArray(JSON.parse(readFileSync(join(import.meta.dir, "../../skills/productivity/coordinator/tests/recipients.json"), "utf8"))) ?? [];

    for (const group of groups) {
      for (const raw of asArray(asObject(group)?.["cases"]) ?? []) {
        const c = asObject(raw) ?? {};

        if (c["sender"] !== "user") continue;
        writeFileSync(join(root, "state.json"), JSON.stringify(asObject(group)?.["roster"]));
        writeFileSync(join(root, "chat.jsonl"), "");
        const reSender = asString(c["re_sender"]);
        const re = reSender === undefined ? null : say(reSender, "earlier");
        const got = await preview({ text: asString(c["text"]) ?? "", re });
        expect([got.status, got.body["to"]]).toEqual([200, c["to"]]);

        if (c["parts"] !== undefined) expect(got.body["parts"]).toEqual(c["parts"]);
      }
    }
  });
});

describe("the skills a fleet's session can run", () => {
  let config: string;

  let repo: string;

  function skillFile(dir: string, lines: readonly string[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, dir.endsWith("commands") ? "" : "SKILL.md"), ["---", ...lines, "---", "", "The body is never read."].join("\n"));
  }

  function file(path: string, text: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }

  function plugin(dir: string, name: string): string {
    file(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));

    return dir;
  }

  beforeEach(() => {
    config = join(base, "home", ".claude");
    repo = join(base, "repo");
    env = { ...env, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: config };
    const good = plugin(join(base, "cache", "good"), "good");
    const off = plugin(join(base, "cache", "off"), "off");
    const otherTstack = plugin(join(base, "cache", "tstack"), "tstack");
    const elsewhere = plugin(join(base, "cache", "elsewhere"), "elsewhere");
    skillFile(join(good, "skills", "lint"), ["name: lint", "description: >", "  Lint the code,", "  every file.", 'argument-hint: "[path]"']);
    skillFile(join(good, "skills", "hidden"), ["description: only the model runs it", "user-invocable: false"]);
    file(join(good, "commands", "ship.md"), "---\ndescription: 'Ship it, don''t wait'\ndisable-model-invocation: true\n---\nbody\n");
    skillFile(join(off, "skills", "x"), ["description: disabled"]);
    skillFile(join(otherTstack, "skills", "tdd"), ["description: an older tstack"]);
    skillFile(join(elsewhere, "skills", "y"), ["description: another project's"]);

    const installs = {
      "good@mk": [{ scope: "user", installPath: good }],
      "off@mk": [{ scope: "user", installPath: off }],
      "tstack@tstack": [{ scope: "user", installPath: otherTstack }],
      "elsewhere@mk": [{ scope: "project", projectPath: join(base, "other-repo"), installPath: elsewhere }],
    };

    file(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installs }));
    file(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "good@mk": true, "off@mk": false } }));
    skillFile(join(config, "skills", "notes"), ["name: notes", "description: |", "  Keep notes.", "  Two lines."]);
    skillFile(join(config, "skills", "shared"), ["description: the user's"]);
    mkdirSync(join(repo, ".jj"), { recursive: true });
    skillFile(join(repo, ".claude", "skills", "deploy"), ["description: Deploy the app", "disable-model-invocation: true", "allowed-tools:", "  - Bash"]);
    skillFile(join(repo, ".claude", "skills", "shared"), ["description: the project's"]);
  });

  function byName(body: JsonObject): Map<string, JsonObject> {
    return new Map((asArray(body["skills"]) ?? []).map((s) => [asString(asObject(s)?.["name"]) ?? "", asObject(s) ?? {}]));
  }

  test("lists this plugin's, the enabled plugins', the user's and the project's, sorted, each once", async () => {
    const dir = join(base, "-repo", "abc", "scratchpad", "coordinator");
    mkdirSync(dir, { recursive: true });
    writeState(dir, [], { project: "s" });
    file(join(config, "projects", "-repo", "abc.jsonl"), `${JSON.stringify({ type: "mode" })}\n${JSON.stringify({ type: "user", cwd: repo })}\n`);
    register(dir, "s");
    await start();
    const got = await request("GET", "/f/s/skills");
    expect([got.status, got.headers.get("Content-Type"), got.body["builtins"]]).toEqual([200, "application/json; charset=utf-8", false]);
    const skills = byName(got.body);
    const names = [...skills.keys()];
    expect(names).toEqual([...names].sort());
    expect(skills.get("good:lint")).toEqual({ name: "good:lint", description: "Lint the code, every file.", hint: "[path]", source: "plugin", model: true });
    expect(skills.get("good:ship")).toEqual({ name: "good:ship", description: "Ship it, don't wait", hint: "", source: "plugin", model: false });
    expect(skills.get("notes")).toEqual({ name: "notes", description: "Keep notes.\nTwo lines.", hint: "", source: "user", model: true });
    expect(skills.get("deploy")).toEqual({ name: "deploy", description: "Deploy the app", hint: "", source: "project", model: false });
    expect([skills.get("shared")?.["description"], skills.get("shared")?.["source"]]).toEqual(["the user's", "user"]);
    expect(skills.get("tstack:tdd")?.["source"]).toBe("plugin");
    expect(asString(skills.get("tstack:tdd")?.["description"])).toStartWith("Test-first");
    expect(names.filter((n) => n === "tstack:tdd").length).toBe(1);

    for (const gone of ["good:hidden", "off:x", "elsewhere:y"]) expect(skills.has(gone)).toBe(false);
  });

  test("without a transcript the ledger's workspace names the repository; the list is held for a minute", async () => {
    writeState(root, [], { workspaces: [{ id: "w1", agent: "a1", path: join(base, "repo-w1"), repo, status: "active" }] });
    await start();
    const first = await request("GET", "/f/p/skills");
    expect(byName(first.body).get("deploy")?.["source"]).toBe("project");
    skillFile(join(config, "skills", "later"), ["description: added after"]);
    expect(await request("GET", "/f/p/skills")).toMatchObject({ status: 200, body: first.body });
  });

  test("a fleet whose repository nothing records lists no project skills, and an unknown fleet is a 404", async () => {
    await start();
    const skills = byName((await request("GET", "/f/p/skills")).body);
    expect([skills.has("deploy"), skills.get("shared")?.["source"], skills.has("good:lint")]).toEqual([false, "user", true]);
    expect((await request("GET", "/f/nobody/skills")).status).toBe(404);
  });

  test("the frontmatter's scalars: plain, quoted, folded and literal; lists and the body are skipped", () => {
    const text = ["---", "name: a", 'description: "say \\"hi\\""', "hint: >-", "  one", "  two", "", "  three", "tools:", "  - Bash", "plain: x # note", "---", "body: no"].join("\n");
    expect(Object.fromEntries(frontmatter(text))).toEqual({ name: "a", description: 'say "hi"', hint: "one two\nthree", plain: "x" });
    expect(frontmatter("no frontmatter\nname: x").size).toBe(0);
  });
});

describe("hosts and origins", () => {
  beforeEach(() => start());

  test("a foreign Host is refused on every route", async () => {
    const evil = { Host: "evil.com" };

    for (const path of ["/", "/events", "/api/fleets", "/f/p/", "/f/p/state.json", "/f/p/events", "/f/p/chat"]) {
      const got = await request("GET", path, undefined, evil);
      expect([path, got.status, got.body]).toEqual([path, 421, { error: "unknown host" }]);
    }

    expect((await post({ text: "hi" }, evil)).status).toBe(421);
    expect((await post({ text: "hi" }, { Host: "evil.com", Origin: "http://evil.com" })).status).toBe(421);
    expect(readChat(root)).toEqual([]);
  });

  test("the https name tailscale serve gives it is still answered after the tailnet is read again", async () => {
    await running?.stop();
    const fake = join(base, "tailscale");
    writeFileSync(fake, FAKE_TAILSCALE.replace('  *) exit 1 ;;', '  "serve --bg") exit 0 ;;\n  *) exit 1 ;;'));
    chmodSync(fake, 0o755);
    port = freePort();
    const got = await startHub({ port, machine: machine(env), tailscale: fake, peers: false, hosts: [], https: 7443 }, () => {});

    if (got instanceof Error) throw got;
    running = got;
    expect(running.url).toBe("https://box.tail.ts.net:7443/");
    const https = { Host: "box.tail.ts.net:7443" };
    expect((await request("GET", "/api/fleets", undefined, https)).status).toBe(200);
    await running.hub.refresh();
    expect((await request("GET", "/api/fleets", undefined, https)).status).toBe(200);
  });

  test("localhost is allowed", async () => {
    expect((await post({ text: "hi" }, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status).toBe(201);
  });

  test("an origin must be http or https on a name the hub answers to", async () => {
    for (const origin of [`ftp://127.0.0.1:${port}`, `http://localhost:${port + 1}`, "null"]) {
      expect((await post({ text: "hi" }, { Origin: origin })).status).toBe(403);
    }
  });
});

describe("the Mac's process readings (ps and lsof, no /proc)", () => {
  test("lsof -F pn: each pid's open names, in order", () => {
    const text = "p12\nfcwd\nn/Users/u/repo\np34\nf5\nn127.0.0.1:7420\nf8\nn100.91.33.44:7420\n";
    expect([...lsofFiles(text)]).toEqual([
      [12, ["/Users/u/repo"]],
      [34, ["127.0.0.1:7420", "100.91.33.44:7420"]],
    ]);
  });

  test("listening ports from lsof, the first pid on each", () => {
    const text = "p34\nf5\nn127.0.0.1:7420\nf8\nn[::1]:7420\np56\nf3\nn*:8080\n";
    expect([...lsofListenersOf(text)]).toEqual([
      [7420, 34],
      [8080, 56],
    ]);
  });

  test("ps etime in seconds", () => {
    expect([elapsedOf("00:07"), elapsedOf("01:02:03"), elapsedOf(" 2-00:00:01\n"), elapsedOf("")]).toEqual([7, 3723, 172801, Number.NaN]);
  });

  test("ps pid ppid: each pid's parent", () => {
    expect([...parentsOf("    1     0\n  412     1\n\n")]).toEqual([
      [1, 0],
      [412, 1],
    ]);
  });
});

describe("answers to decisions", () => {
  beforeEach(async () => {
    const decisions = [
      { id: "d1", kind: "decision", title: "Invoice schema", question: "q", status: "open", resolution: null, opened: "2026-01-01T00:00:00+00:00" },
      { id: "d2", kind: "decision", title: "Invoice schema", question: "q", status: "withdrawn", resolution: "found in the docs", opened: "2026-01-01T00:00:00+00:00" },
      { id: "d3", kind: "secret", title: "Neo4j password", question: "q", status: "open", resolution: null, opened: "2026-01-01T00:00:00+00:00" },
    ];

    writeState(root, [{ id: "a1", name: "notes-impl" }], { decisions });
    await start();
  });

  test("an answer to an open decision is stored with its tag", async () => {
    const sent = await post({ text: "B: keep both", decision: "d1" });
    expect([sent.status, sent.body["decision"], sent.body["to"]]).toEqual([201, "d1", ["coordinator"]]);
  });

  test("an answer that cannot be taken is refused with the reason and not stored", async () => {
    const cases = [
      [400, "unknown decision", { text: "A", decision: "d9" }],
      [409, "found in the docs", { text: "A", decision: "d2" }],
      [400, "never the value", { text: "ghp_16C7e42F292c6912E7710c838347Ae178B4a", decision: "d3" }],
      [400, "decision", { text: "A", decision: 3 }],
    ] as const;

    for (const [status, word, payload] of cases) {
      const got = await post(payload);
      expect(got.status).toBe(status);
      expect(asString(got.body["error"])).toContain(word);
    }

    expect(readChat(root)).toEqual([]);
  });

  test("a secret given as a reference is stored", async () => {
    const sent = await post({ text: "op://Engineering/Neo4j Aura/password", decision: "d3" });
    expect([sent.status, sent.body["decision"]]).toEqual([201, "d3"]);
  });
});

describe("who may write", () => {
  test("without Tailscale this machine writes, and the chat says nothing of a login", async () => {
    await start();
    const sent = await post({ text: "hi" });
    expect([sent.status, sent.body["author"]]).toEqual([201, undefined]);
    const stream = await Stream.open("/f/p/events");
    expect(data(await stream.next())).toEqual({ write: true, max_bytes: 256 * 1024 });
    stream.close();
  });

  test("with Tailscale only the machine's owner writes, and the message records the login", async () => {
    const fake = join(base, "tailscale");
    writeFileSync(fake, FAKE_TAILSCALE);
    chmodSync(fake, 0o755);
    await start({ tailscale: fake });
    expect(running?.url).toBe(`http://box.tail.ts.net:${port}/`);
    const eve = await post({ text: "hi" }, { "Tailscale-User-Login": "eve@example.com" });
    expect([eve.status, eve.body]).toEqual([403, { error: `only ${OWNER} can write here` }]);
    const me = await post({ text: "hi" }, { "Tailscale-User-Login": "LUIZ@example.com" });
    expect([me.status, me.body["author"]]).toEqual([201, "LUIZ@example.com"]);
    const local = await post({ text: "from this machine" });
    expect([local.status, local.body["author"]]).toEqual([201, OWNER]);
    const stream = await Stream.open("/f/p/events", { "Tailscale-User-Login": "eve@example.com" });
    expect(data(await stream.next())).toEqual({ write: false, reason: `only ${OWNER} can write here`, you: "eve@example.com", max_bytes: 256 * 1024 });
    stream.close();
    expect((await request("GET", "/f/p/chat", undefined, { Host: `box.tail.ts.net:${port}` })).status).toBe(200);
  });

  test("a tailnet address is whoever Tailscale says owns it; any other address reads only", async () => {
    const header = (): string | null => null;
    const whois = (ip: string): Promise<string | undefined> => Promise.resolve(ip === "100.101.1.2" ? OWNER : "eve@example.com");
    const mine = await viewerOf("100.101.1.2", header, OWNER, whois);
    const theirs = await viewerOf("100.90.3.4", header, OWNER, whois);
    const outside = await viewerOf("192.168.1.5", header, OWNER, whois);
    expect([writerRefusal(OWNER, mine), writerRefusal(OWNER, theirs), writerRefusal(OWNER, outside)]).toEqual([
      undefined,
      `only ${OWNER} can write here`,
      `only ${OWNER} can write here`,
    ]);
    expect(hello(OWNER, theirs)).toEqual({ write: false, reason: `only ${OWNER} can write here`, you: "eve@example.com", max_bytes: 256 * 1024 });
    expect(postRefusal(undefined, outside, new Set(), header)?.[0]).toBe(403);
    expect([isTailnetIp("100.64.0.1"), isTailnetIp("100.127.255.1"), isTailnetIp("100.128.0.1"), isTailnetIp("fd7a:115c:a1e0::1"), isTailnetIp("10.0.0.1")]).toEqual([
      true,
      true,
      false,
      true,
      false,
    ]);
  });

  test("tailscale status reads as this machine, its owner and its online peers", () => {
    const net = tailnetOf({
      BackendState: "Running",
      Self: { DNSName: "box.tail.ts.net.", TailscaleIPs: ["100.69.1.1", "fd7a::1"], UserID: 7 },
      User: { "7": { LoginName: OWNER } },
      Peer: { k: { DNSName: "cache.tail.ts.net.", TailscaleIPs: ["100.70.1.1"], Online: true }, j: { DNSName: "mac.tail.ts.net.", TailscaleIPs: [], Online: false } },
    });

    expect([net?.self.name, net?.self.ip, net?.login, net?.peers.map((p) => [p.name, p.ip, p.online])]).toEqual([
      "box",
      "100.69.1.1",
      OWNER,
      [
        ["cache", "100.70.1.1", true],
        ["mac", undefined, false],
      ],
    ]);
    expect(tailnetOf({ BackendState: "Stopped" })).toBeUndefined();
  });
});

describe("the index and the manager", () => {
  test("the index lists every fleet of the registry, and its stream follows them", async () => {
    await start();
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('"path": "/f/p/"');
    const stream = await Stream.open("/events");
    const first = data(await stream.nextOf("fleets"));
    const fleets = asArray(asObject(asArray(first["machines"])?.[0])?.["fleets"]) ?? [];
    expect(fleets.map((f) => [asObject(f)?.["id"], asObject(f)?.["status"]])).toEqual([["p", "running"]]);
    const other = join(base, "infra", "coordinator");
    mkdirSync(other, { recursive: true });
    writeState(other, [], { project: "infra" });
    register(other, "infra");
    const next = data(await stream.nextOf("fleets"));
    const ids = (asArray(asObject(asArray(next["machines"])?.[0])?.["fleets"]) ?? []).map((f) => asObject(f)?.["id"]);
    expect(ids.sort()).toEqual(["infra", "p"]);
    stream.close();
    const api = await request("GET", "/api/fleets");
    expect((asArray(api.body["fleets"]) ?? []).length).toBe(2);
  });

  test("the manager's stream holds every coordinator and follows what they do; its links to them resolve", async () => {
    const manager = join(base, "m", "manager");
    mkdirSync(manager, { recursive: true });
    writeState(manager, [], { role: "manager", project: "all" });
    register(manager, "manager");
    await start();
    const stream = await Stream.open("/f/manager/events");
    await stream.next();
    const state = data(await stream.nextOf("state"));
    expect((asArray(state["coordinators"]) ?? []).map((c) => [asObject(c)?.["id"], asObject(c)?.["now"]])).toEqual([["p", "n"]]);
    fleet(["state", root, "set", "--now", "landing the adapter", "--no-render"], env);
    const next = data(await stream.nextOf("state"));
    expect(asObject(asArray(next["coordinators"])?.[0])?.["now"]).toBe("landing the adapter");
    stream.close();
    expect(collapse("/f/manager/f/p/chat")).toBe("/f/p/chat");
    expect((await request("GET", "/f/manager/f/p/chat")).status).toBe(200);
  });
});

describe("a peer hub's fleets", () => {
  test("show on the index and are passed through, posts checked here first", async () => {
    const seen: { method: string; path: string; body: string; type: string | null }[] = [];
    await start();

    const stub = Bun.serve({
      hostname: "127.0.0.2",
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen.push({ method: req.method, path: url.pathname + url.search, body: await req.text(), type: req.headers.get("Content-Type") });

        if (url.pathname === "/api/fleets") return Response.json({ name: "stub", fleets: [{ id: "infra", status: "running", now: "on the peer", decisions: [] }] });

        if (url.pathname === "/f/infra/chat" && req.method === "POST") return Response.json({ id: 1, from: "user" }, { status: 201 });

        if (url.pathname === "/f/infra/events") {
          return new Response("event: hello\ndata: {\"write\": true}\n\n", { headers: { "Content-Type": "text/event-stream" } });
        }

        return new Response("<p>infra's page</p>", { headers: { "Content-Type": "text/html" } });
      },
    });

    stubs.push(stub);
    expect(await running?.hub.addPeer("stub", "127.0.0.2")).toBe(true);
    const index = running?.hub.indexPayload();
    const peer = asObject(asArray(index?.["machines"])?.[1]);
    expect([peer?.["name"], asObject(asArray(peer?.["fleets"])?.[0])?.["path"]]).toEqual(["stub", "/f/infra%40stub/"]);
    const page = await fetch(`http://127.0.0.1:${port}/f/infra@stub/?x=1`);
    expect([page.status, await page.text()]).toEqual([200, "<p>infra's page</p>"]);
    expect(seen.at(-1)?.path).toBe("/f/infra/?x=1");
    const moved = await request("GET", "/f/infra@stub");
    expect([moved.status, moved.headers.get("Location")]).toEqual([301, "/f/infra@stub/"]);
    const sent = await post({ text: "status?" }, { Origin: `http://127.0.0.1:${port}` }, "/f/infra@stub/chat");
    expect([sent.status, seen.at(-1)?.body, seen.at(-1)?.type]).toEqual([201, '{"text":"status?"}', "application/json"]);
    const count = seen.length;
    expect((await post({ text: "x" }, { Origin: "https://evil.example" }, "/f/infra@stub/chat")).status).toBe(403);
    expect(seen.length).toBe(count);
    const events = await fetch(`http://127.0.0.1:${port}/f/infra@stub/events`);
    expect([events.status, await events.text()]).toEqual([200, 'event: hello\ndata: {"write": true}\n\n']);
    expect((await request("GET", "/f/infra@stub/skills")).status).toBe(200);
    expect(seen.at(-1)?.path).toBe("/f/infra/skills");
    expect((await request("GET", "/f/infra@nowhere/")).status).toBe(404);
  });
});

describe("fleet serve", () => {
  test("puts a fleet in the registry at the hub's address and takes it out", () => {
    const fresh = join(base, "acme", "coordinator");
    mkdirSync(fresh, { recursive: true });
    writeState(fresh, [], { project: "acme billing" });
    const served = spawnFleet(["serve", fresh, "--pid", String(process.pid), "--port", "47999"], { ...env, TAILSCALE: join(base, "none") });
    expect(served.code).toBe(0);
    expect(served.stdout).toBe("http://127.0.0.1:47999/f/acme-billing/\n");
    expect(served.stderr).toContain("no hub runs on this machine yet");
    const entry = machine(env).registry.find(fresh);
    expect([entry?.id, entry?.url]).toEqual(["acme-billing", "http://127.0.0.1:47999/f/acme-billing/"]);
    const stopped = spawnFleet(["serve", fresh, "--stop"], env);
    expect([stopped.code, stopped.stdout]).toEqual([0, "stopped http://127.0.0.1:47999/f/acme-billing/\n"]);
    expect(machine(env).registry.find(fresh)).toBeUndefined();
  });
});

describe("a permission's answer grants the call once", () => {
  const CALL = "git push --force origin HEAD:main";
  const RULE = `Bash(${CALL})`;

  let session: string;

  let settings: string;

  function permission(over: JsonObject = {}): JsonObject {
    return {
      id: "p-1a2b3c4d",
      ref: "P1",
      kind: "permission",
      title: "Force-push main",
      question: "q",
      status: "open",
      resolution: null,
      opened: "2026-01-01T00:00:00+00:00",
      refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "[Git Destructive]", root: session, agent_id: "agent-7f" },
      ...over,
    };
  }

  function withRows(...decisions: JsonObject[]): void {
    writeState(root, [{ id: "a1", name: "notes-impl" }], { decisions });
  }

  function grants(): JsonObject[] {
    try {
      return readFileSync(join(root, "grants.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => asObject(JSON.parse(l)) ?? {});
    } catch {
      return [];
    }
  }

  const allow = { text: "allow-once: Allow this call once", decision: "p-1a2b3c4d", rule: RULE };

  beforeEach(() => {
    session = join(base, "repo");
    settings = join(session, ".claude", "settings.local.json");
    mkdirSync(join(session, ".claude"), { recursive: true });
    mkdirSync(join(root, "heartbeats"), { recursive: true });
    writeFileSync(join(root, "heartbeats", "s1.json"), JSON.stringify({ session: "s1", at: "2026-01-01T00:00:00+00:00", cwd: session }));
    withRows(permission());
  });

  test("allow-once adds the exact rule to the session's settings, keeps the rest, records the grant, then stores the answer", async () => {
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf /)"] }, model: "opus" }));
    await start();
    const sent = await post(allow);
    expect([sent.status, sent.body["decision"]]).toEqual([201, "p-1a2b3c4d"]);
    const text = readFileSync(settings, "utf8");
    expect(text).toBe(`${JSON.stringify({ permissions: { allow: ["Bash(ls)", RULE], deny: ["Bash(rm -rf /)"] }, model: "opus" }, null, 2)}\n`);
    const [grant, ...more] = grants();
    expect(more).toEqual([]);
    expect(Object.keys(grant ?? {})).toEqual(["op", "decision", "ref", "rule", "agent_id", "file", "at", "by", "reload"]);
    expect([grant?.["op"], grant?.["decision"], grant?.["ref"], grant?.["rule"], grant?.["agent_id"], grant?.["file"], grant?.["by"], grant?.["reload"]]).toEqual([
      "grant",
      "p-1a2b3c4d",
      "P1",
      RULE,
      "agent-7f",
      settings,
      "local",
      "live",
    ]);
    expect(String(grant?.["at"])).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(readFileSync(join(root, "grants.jsonl"), "utf8")).toBe(`${JSON.stringify(grant)}\n`);
    expect(readChat(root).map((m) => m.stored["decision"])).toEqual(["p-1a2b3c4d"]);
    expect(readdirSync(join(session, ".claude"))).toEqual(["settings.local.json"]);
  });

  test("a main thread's grant names no agent", async () => {
    withRows(permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: session, agent_id: null } }));
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(grants()[0]?.["agent_id"]).toBeNull();
  });

  test("allow-once grants the rule the page showed: none, or one the row no longer has, refuses and stores nothing", async () => {
    await start();
    const { rule: _shown, ...unbound } = allow;

    for (const body of [unbound, { ...allow, rule: "Bash(git push origin HEAD:main)" }]) {
      const got = await post(body);
      expect([got.status, asString(got.body["error"])?.includes("rule")]).toEqual([409, true]);
    }

    expect((await post({ ...allow, rule: 5 })).status).toBe(400);
    expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
  });

  test("the hub writes under the settings lock the hook takes: a held one refuses after a wait, a stale one is taken", async () => {
    const lock = join(session, ".claude", ".settings.local.json.lock");
    mkdirSync(lock);
    await start();
    const started = performance.now();
    const held = await post(allow);
    expect(performance.now() - started).toBeGreaterThanOrEqual(2000);
    expect([held.status, asString(held.body["error"])?.includes("lock")]).toEqual([409, true]);
    expect([existsSync(settings), grants(), readChat(root), existsSync(lock)]).toEqual([false, [], [], true]);
    const old = new Date(Date.now() - 11_000);
    utimesSync(lock, old, old);
    expect((await post(allow)).status).toBe(201);
    expect([JSON.parse(readFileSync(settings, "utf8")), existsSync(lock)]).toEqual([{ permissions: { allow: [RULE] } }, false]);
  });

  test("an absent settings file starts empty", async () => {
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
  });

  test("a rule already there is someone's own: the hub writes nothing and records no grant, and the answer is stored", async () => {
    const mine = JSON.stringify({ permissions: { allow: [RULE] } });
    writeFileSync(settings, mine);
    await start();
    expect((await post(allow)).status).toBe(201);
    expect([readFileSync(settings, "utf8"), grants(), readChat(root).length]).toEqual([mine, [], 1]);
  });

  test("a session without a .claude folder gets one, and the grant says the session must restart to see it", async () => {
    const fresh = join(base, "fresh");
    mkdirSync(fresh);
    writeFileSync(join(root, "heartbeats", "s2.json"), JSON.stringify({ session: "s2", at: "2026-01-01T00:00:00+00:00", cwd: fresh }));
    withRows(permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: fresh, agent_id: null } }));
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(join(fresh, ".claude", "settings.local.json"), "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    expect(grants()[0]?.["reload"]).toBe("restart");
  });

  test("a session is known by its project directory too, when its shell has moved elsewhere", async () => {
    writeFileSync(join(root, "heartbeats", "s1.json"), JSON.stringify({ session: "s1", at: "2026-01-01T00:00:00+00:00", cwd: join(session, "src"), project: session }));
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
  });

  test("deny is stored as any answer, and grants nothing", async () => {
    await start();
    expect((await post({ text: "deny: Deny\nnot on main", decision: "p-1a2b3c4d" })).status).toBe(201);
    expect([existsSync(settings), grants()]).toEqual([false, []]);
  });

  test("a row the hub cannot trust, or settings it cannot read, refuse with the reason and store nothing", async () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    const refusal = (over: JsonObject): JsonObject => permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: session, agent_id: null, ...over } });

    const cases: (readonly [string, JsonObject])[] = [
      ["no session of this fleet", refusal({ root: elsewhere })],
      ["no session of this fleet", refusal({ root: join(base, "missing") })],
      ["absolute", refusal({ root: "repo" })],
      ["rule", refusal({ rule: "Bash(git push:*)" })],
      ["*", refusal({ call: "rm -rf *", rule: "Bash(rm -rf *)" })],
      ["Bash", refusal({ tool: "Edit", rule: `Edit(${CALL})` })],
      ["refused call", permission({ refusal: null })],
    ];

    await start();

    for (const [word, row] of cases) {
      withRows(row);
      const got = await post(allow);
      expect([got.status, asString(got.body["error"])?.includes(word)]).toEqual([409, true]);
    }

    withRows(permission());
    expect((await post({ ...allow, quote: 5 })).status).toBe(400);
    expect(existsSync(settings)).toBe(false);
    writeFileSync(settings, "{ not json");
    const bad = await post(allow);
    expect([bad.status, asString(bad.body["error"])?.includes("settings.local.json")]).toEqual([409, true]);
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
    expect([readChat(root), grants(), existsSync(join(elsewhere, ".claude"))]).toEqual([[], [], false]);
  });

  test("a login claimed in a header on this machine is only this machine's word: the grant says local", async () => {
    const fake = join(base, "tailscale");
    writeFileSync(fake, FAKE_TAILSCALE);
    chmodSync(fake, 0o755);
    await start({ tailscale: fake });
    expect((await post(allow, { "Tailscale-User-Login": OWNER })).status).toBe(201);
    expect(grants()[0]?.["by"]).toBe("local");
  });
});

test("a grant names the tailnet login Tailscale gives a peer, and this machine's own address as local", async () => {
  const header = (): string | null => null;
  const whois = (ip: string): Promise<string | undefined> => Promise.resolve(ip === "100.101.1.2" ? OWNER : undefined);
  const peer = await viewerOf("100.101.1.2", header, OWNER, whois, "100.69.1.1");
  const self = await viewerOf("100.69.1.1", header, OWNER, whois, "100.69.1.1");
  const forged = await viewerOf("127.0.0.1", (name) => (name === "Tailscale-User-Login" ? OWNER : null), OWNER, whois, "100.69.1.1");
  expect([grantor(peer), grantor(self), grantor(forged)]).toEqual([`tailnet:${OWNER}`, "local", "local"]);
});
