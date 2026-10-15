/**
 * An answer that grants, given on the manager's page to another fleet's card, in headless Chromium against a real
 * hub: the manager's page shows the card as that fleet's own page in a frame (`?embed=1`), which the hub serves
 * without the page token (only a top-level load gets one), so the frame sends the token of the page it is shown in.
 * Allow once, Allow once and save this kind, and Add this rule each go through; the frame's own document still
 * holds no token. A forged token in the manager's page is the one the frame sends, and is refused; a page of another
 * origin that frames a fleet's page has no token to give, so the frame's answer goes without one. Skipped when no Chromium (FLEET_CHROMIUM, or chromium on the PATH) or no puppeteer-core
 * (fleet/page's, installed by `just test-page`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { readChat } from "../src/chat/store.ts";
import { recordJson, type PreviewRecord } from "../src/preview/record.ts";
import { startedAt } from "../src/preview/tracked.ts";
import { startHub, type Running, type StartOptions } from "../src/hub/server.ts";
import { asObject, type JsonObject } from "../src/json.ts";
import { baseEnv, machine, tmp } from "./support.ts";

/** The part of a puppeteer-core frame this test drives. */
interface Frame {
  url(): string;
  /** An expression evaluated in the frame, as a string, number or boolean. */
  evaluate(expression: string): Promise<string | number | boolean | null>;
  waitForFunction(expression: string, options?: { readonly timeout?: number }): Promise<object>;
}

/** The part of a puppeteer-core request and response this test reads. */
interface HttpRequest {
  url(): string;
  method(): string;
  /** Its headers, names lowercased. */
  headers(): Readonly<Record<string, string>>;
}

interface HttpResponse {
  request(): HttpRequest;
  status(): number;
}

interface Page extends Frame {
  goto(url: string): Promise<object | null>;
  frames(): Frame[];
  on(event: "request", handler: (request: HttpRequest) => void): void;
  on(event: "response", handler: (response: HttpResponse) => void): void;
  close(): Promise<void>;
}

interface Browser {
  newPage(): Promise<Page>;
  /** A context of its own, with no service worker or storage of any other. */
  createBrowserContext(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}

interface Puppeteer {
  launch(options: { readonly executablePath: string; readonly headless: boolean; readonly args: readonly string[]; readonly env: Readonly<Record<string, string | undefined>> }): Promise<Browser>;
}

const PUPPETEER = join(import.meta.dir, "..", "page", "node_modules", "puppeteer-core");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium) && existsSync(PUPPETEER);

const CALL = "git push --force origin HEAD:main";

const RULE = `Bash(${CALL})`;

const FORGED = `forged-${"x".repeat(25)}`;

const STALE = "the page token is missing or stale: reload the fleet's page and answer again";

/** A service worker that would show every page in its scope as "SW SAW: " and the page's HTML, token and all. */
const SPY = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") e.respondWith(fetch(e.request).then((r) => r.text()).then((t) => new Response("SW SAW: " + t, { headers: { "Content-Type": "text/plain" } })));
});`;

const ENTRY = "Removing a finished jj workspace: `jj workspace forget <name>` in a repo under /home/u/repos.\nNot covered: the default workspace, `jj abandon`, deleting the folder.";

let browser: Browser | undefined;

let running: Running | undefined;

let base = "";

let root = "";

let session = "";

let target = "";

let origin = "";

/** How the hub was started, and its environment: `restart` starts another on the same registry, HOME and port. */
let options: StartOptions | undefined;

let environment: Readonly<Record<string, string>> = {};

function permission(id: string, ref: string): JsonObject {
  return {
    id,
    ref,
    kind: "permission",
    title: "Force-push main",
    question: "q",
    status: "open",
    resolution: null,
    opened: "2026-01-01T00:00:00+00:00",
    refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "[Git Destructive]", root: session, agent_id: "agent-7f" },
    options: [
      { id: "allow-once", label: "Allow this call once", consequence: "c" },
      { id: "deny", label: "Deny", consequence: "c" },
    ],
  };
}

const ruleCard: JsonObject = {
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
};

function writeState(dir: string, more: JsonObject): void {
  const state = { project: "p", goal: "g", status: "running", now: "n", started: "2026-01-01T00:00:00+00:00", roadmap: [], agents: [], roadblocks: [], events: [], decisions: [], ...more };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
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

beforeAll(async () => {
  if (!found) return;
  // SAFETY: PUPPETEER is fleet/page's puppeteer-core (checked to exist above), whose default export has `launch`.
  const imported = (await import(PUPPETEER)) as { readonly default: Puppeteer };
  // Chromium's singleton socket lives in $TMPDIR, and the gate's per-file one is past a socket path's 108 bytes.
  browser = await imported.default.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"], env: { ...process.env, TMPDIR: "/tmp" } });
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  if (!found) return;
  base = tmp("fleet-hub-grant-");
  root = join(base, "p", "coordinator");
  session = join(base, "repo");
  const manager = join(base, "all", "coordinator");
  const home = join(base, "home");
  target = join(base, "dotfiles", "claude", "settings.json");

  for (const dir of [root, manager, join(root, "heartbeats"), join(session, ".claude"), join(home, ".claude"), join(base, "dotfiles", "claude")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "heartbeats", "s1.json"), JSON.stringify({ session: "s1", at: "2026-01-01T00:00:00+00:00", cwd: session }));
  writeState(root, { decisions: [permission("p-1a2b3c4d", "P1"), permission("p-5e6f7a8b", "P2"), ruleCard] });
  writeState(manager, { role: "manager", project: "all" });
  // A temp HOME whose settings.json is a link into a dotfiles checkout, as on Luiz's machines: never the real one.
  writeFileSync(target, `${JSON.stringify({ autoMode: { allow: ["$defaults"] } }, null, 2)}\n`);
  symlinkSync(target, join(home, ".claude", "settings.json"));
  const env = baseEnv(join(base, "registry"), { HOME: home });
  environment = env;

  for (const [dir, id] of [
    [root, "p"],
    [manager, "manager"],
  ] as const) {
    const entry = machine(env).registry.register(dir, "u", process.pid, "2026-01-01T00:00:00+00:00");

    if (entry.id !== id) throw new Error(`registered as ${entry.id}`);
  }

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  options = { port, machine: machine(env), tailscale: join(base, "no-tailscale"), peers: false, hosts: [], https: undefined };
  const got = await startHub(options, () => {});

  if (got instanceof Error) throw got;
  running = got;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** The hub stopped and a new one started on the same registry, HOME and port, as a landing restarts it. */
async function restart(): Promise<void> {
  if (running === undefined) throw new Error("no hub");
  await running.stop();
  running = undefined;
  await startAgain();
}

/** A hub started on the registry, HOME and port the first one had. */
async function startAgain(): Promise<void> {
  if (options === undefined) throw new Error("no hub");
  const got = await startHub({ ...options, machine: machine(environment) }, () => {});

  if (got instanceof Error) throw got;
  running = got;
}

/** Fleet p's own page open on its card `id`, once its answer form is there. */
async function fleetOn(id: string): Promise<Page> {
  if (browser === undefined) throw new Error("no browser");
  const page = await browser.newPage();
  await page.goto(`${origin}/f/p/#decision/${id}`);
  await page.waitForFunction('document.querySelector(\'#dv-answer form input[name="choice"]\') !== null', { timeout: 10_000 });

  return page;
}

/** A post to fleet p's chat as the browser sent it: its page token header (null for none) and the hub's status, once answered. */
interface Post {
  readonly token: string | null;
  status: number | null;
}

/** Every post to fleet p's chat that `page` or one of its frames sends from now on. */
function chatPosts(page: Page): Post[] {
  const posts: Post[] = [];
  const sent = new Map<HttpRequest, Post>();

  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/f/p/chat") return;
    const post: Post = { token: request.headers()["x-fleet-page-token"] ?? null, status: null };
    sent.set(request, post);
    posts.push(post);
  });

  page.on("response", (response) => {
    const post = sent.get(response.request());

    if (post !== undefined) post.status = response.status();
  });

  return posts;
}

/** `posts` once each has its answer, or as they are after 5 s. */
async function answered(posts: Post[]): Promise<Post[]> {
  for (let i = 0; i < 50 && posts.some((p) => p.status === null); i += 1) await Bun.sleep(100);

  return posts;
}

/** The manager's page open on fleet p's card `id`, and the frame that shows it once its answer form is there. */
async function managerOn(id: string): Promise<{ readonly page: Page; readonly frame: Frame; readonly posts: Post[] }> {
  if (browser === undefined) throw new Error("no browser");
  const page = await browser.newPage();
  const posts = chatPosts(page);
  await page.goto(`${origin}/f/manager/#decision/p/${id}`);
  await page.waitForFunction('document.querySelector("#dv-embed") !== null', { timeout: 10_000 });

  return { page, frame: await cardFrame(page), posts };
}

/** The frame of `page` that shows fleet p's page (`?embed=1`), once its answer form is there. */
async function cardFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i += 1) {
    const frame = page.frames().find((f) => f.url().includes("/f/p/?embed=1"));

    if (frame !== undefined) {
      await frame.waitForFunction('document.querySelector(\'#dv-answer form input[name="choice"]\') !== null', { timeout: 10_000 });

      return frame;
    }

    await Bun.sleep(100);
  }

  throw new Error("the card's frame never loaded");
}

/** Fleet p's combined preview, served by the dev server on `port` at /f/p/preview/. */
function previewAt(port: number): PreviewRecord {
  const server = { cmd: "stub", port, pid: process.pid, pidStarted: startedAt(process.pid) ?? null, unit: null, base: "/f/p/preview/", path: root, log: join(root, "x.log"), started: "", public: null, keeper: null, keeperStarted: null, keeperUnit: null, asleep: null, failed: null };

  return { fleet: "p", workspace: "preview", path: root, repo: root, server, updater: null, updaterStarted: null, include: [], exclude: [], merged: [], left: [], stack: null, stackFrom: null, stackGiven: null, commit: null, conflicts: [], error: null, updated: null, workers: [], ports: { combined: null, workers: {} } };
}

/** Pick `choice` on the frame's answer form, type `note` when given, and send it; the error the form shows once the
 * post settled ("" for none), without its Reload button. */
async function answer(frame: Frame, choice: string, note?: string): Promise<string> {
  await frame.waitForFunction(`document.querySelector('#dv-answer form input[name="choice"][value="${choice}"]') !== null`, { timeout: 10_000 });
  await frame.evaluate(`(() => {
    const pick = document.querySelector('#dv-answer input[name="choice"][value="${choice}"]');
    pick.checked = true;
    pick.dispatchEvent(new Event("change", { bubbles: true }));
    const note = ${JSON.stringify(note ?? null)};
    if (note !== null) {
      const box = document.querySelector('#dv-answer textarea[name="note"]');
      box.value = note;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.querySelector("#dv-answer form").requestSubmit();
    return true;
  })()`);

  const error = async (): Promise<string> =>
    String(await frame.evaluate('(() => { const e = document.querySelector("#dv-error")?.cloneNode(true); e?.querySelector("button")?.remove(); return e?.textContent?.trim() ?? ""; })()'));

  for (let i = 0; i < 100 && (await error()) === "" && readChat(root).length === 0; i += 1) await Bun.sleep(100);

  return error();
}

test.skipIf(!found)("Allow once on the manager's page, in another fleet's frame, grants: the frame sends the manager's page token", async () => {
  const { page, frame } = await managerOn("p-1a2b3c4d");
  expect(await frame.evaluate('document.querySelector(\'meta[name="fleet-page-token"]\') === null')).toBe(true);
  expect(await answer(frame, "allow-once")).toBe("");
  expect(readChat(root).map((m) => [m.stored["decision"], m.stored["text"]])).toEqual([["p-1a2b3c4d", "allow-once: Allow this call once"]]);
  expect(grants().map((g) => [g["op"], g["decision"], g["rule"]])).toEqual([["grant", "p-1a2b3c4d", RULE]]);
  expect(readFileSync(join(session, ".claude", "settings.local.json"), "utf8")).toContain(RULE);
  await page.close();
}, 60_000);

test.skipIf(!found)("Allow once and save this kind on the manager's page, in another fleet's frame, grants the call once", async () => {
  const { page, frame } = await managerOn("p-5e6f7a8b");
  expect(await answer(frame, "allow-kind")).toBe("");
  expect(readChat(root).map((m) => m.stored["decision"])).toEqual(["p-5e6f7a8b"]);
  expect(grants().map((g) => [g["op"], g["decision"], g["rule"]])).toEqual([["grant", "p-5e6f7a8b", RULE]]);
  await page.close();
}, 60_000);

test.skipIf(!found)("Add this rule on the manager's page, in another fleet's frame, adds the entry to the settings", async () => {
  const { page, frame } = await managerOn("r-forget");
  expect(await answer(frame, "add-rule")).toBe("");
  expect(readChat(root).map((m) => m.stored["decision"])).toEqual(["r-forget"]);
  expect(asObject(JSON.parse(readFileSync(target, "utf8")))).toEqual({ autoMode: { allow: ["$defaults", ENTRY] } });
  expect(grants().map((g) => [g["op"], g["decision"]])).toEqual([["rule", "r-forget"]]);
  await page.close();
}, 60_000);

test.skipIf(!found)("a token the hub never issued, in the page the frame is shown in, is the one the frame sends, and grants nothing", async () => {
  const { page, frame, posts } = await managerOn("p-1a2b3c4d");
  await page.evaluate(`(document.querySelector('meta[name="fleet-page-token"]').content = ${JSON.stringify(FORGED)}, true)`);
  expect(await answer(frame, "allow-once")).toBe(STALE);
  expect(await answered(posts)).toEqual([{ token: FORGED, status: 403 }]);
  expect([readChat(root), grants(), existsSync(join(session, ".claude", "settings.local.json"))]).toEqual([[], [], false]);
  await page.close();
}, 60_000);

test.skipIf(!found)("Allow once on a fleet's page opened before the hub restarted grants: the token outlives the hub", async () => {
  const page = await fleetOn("p-1a2b3c4d");
  await restart();
  expect(await answer(page, "allow-once")).toBe("");
  expect(grants().map((g) => [g["op"], g["decision"], g["rule"]])).toEqual([["grant", "p-1a2b3c4d", RULE]]);
  await page.close();
}, 60_000);

test.skipIf(!found)("Allow once in the manager's frame opened before the hub restarted grants", async () => {
  const { page, frame } = await managerOn("p-1a2b3c4d");
  await restart();
  expect(await answer(frame, "allow-once")).toBe("");
  expect(grants().map((g) => [g["op"], g["decision"], g["rule"]])).toEqual([["grant", "p-1a2b3c4d", RULE]]);
  await page.close();
}, 60_000);

/** The hub restarted with its token file gone: every page open before holds a token it no longer knows. */
async function restartForgetting(): Promise<void> {
  rmSync(join(base, "registry", "hub", "tokens.json"));
  await restart();
}

/** The answer form's pick and note in `frame`. */
async function draftIn(frame: Frame): Promise<string> {
  return String(await frame.evaluate('(() => (document.querySelector(\'#dv-answer input[name="choice"]:checked\')?.value ?? "") + "|" + (document.querySelector(\'#dv-answer textarea[name="note"]\')?.value ?? ""))()'));
}

test.skipIf(!found)("a stale page token on a fleet's page: the answer and note are kept, Reload reloads the page, and the draft is there after", async () => {
  const page = await fleetOn("p-1a2b3c4d");
  await restartForgetting();
  expect(await answer(page, "allow-once", "only this push")).toBe(STALE);
  expect(await page.evaluate('document.querySelector("#dv-reload")?.textContent ?? ""')).toBe("Reload");
  expect(await draftIn(page)).toBe("allow-once|only this push");
  await page.evaluate("(window.beforeReload = true)");
  await page.evaluate('(document.querySelector("#dv-reload").click(), true)');
  await page.waitForFunction('window.beforeReload === undefined && document.querySelector(\'#dv-answer input[name="choice"]:checked\') !== null', { timeout: 10_000 });
  expect(await draftIn(page)).toBe("allow-once|only this push");
  expect(await page.evaluate('document.querySelector("#dv-reload") === null')).toBe(true);
  expect(await answer(page, "allow-once", "only this push")).toBe("");
  expect(grants().map((g) => [g["op"], g["decision"]])).toEqual([["grant", "p-1a2b3c4d"]]);
  await page.close();
}, 60_000);

test.skipIf(!found)("a stale page token in the manager's frame: Reload reloads the manager's page, and the frame's draft is there after", async () => {
  const { page, frame } = await managerOn("p-1a2b3c4d");
  await restartForgetting();
  expect(await answer(frame, "allow-once", "only this push")).toBe(STALE);
  await page.evaluate("(window.beforeReload = true)");
  await frame.evaluate('(document.querySelector("#dv-reload").click(), true)');
  await page.waitForFunction("window.beforeReload === undefined", { timeout: 10_000 });
  const again = await cardFrame(page);
  await again.waitForFunction('document.querySelector(\'#dv-answer input[name="choice"]:checked\') !== null', { timeout: 10_000 });
  expect(await draftIn(again)).toBe("allow-once|only this push");
  expect(await answer(again, "allow-once", "only this push")).toBe("");
  expect(grants().map((g) => [g["op"], g["decision"]])).toEqual([["grant", "p-1a2b3c4d"]]);
  await page.close();
}, 60_000);

test.skipIf(!found)("an image picked on the manager's page, in another fleet's frame, is uploaded to that fleet: the frame sends the manager's page token", async () => {
  const { page, frame } = await managerOn("p-1a2b3c4d");
  await frame.evaluate(`(() => {
    const input = document.querySelector('#dv-answer .attach input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])], "shot.png", { type: "image/png" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await frame.waitForFunction('document.querySelector("#dv-answer .attach-tray img, #dv-answer .attach-error:not([hidden])") !== null', { timeout: 10_000 });
  expect(await frame.evaluate('document.querySelector("#dv-answer .attach-error")?.textContent ?? ""')).toBe("");
  const path = String(await frame.evaluate('document.querySelector("#dv-answer .attach-tray img").getAttribute("src")'));
  expect(path).toMatch(/^attachments\/[0-9a-f]{16}\.png$/u);
  expect(existsSync(join(root, path))).toBe(true);
  await page.close();
}, 60_000);

test.skipIf(!found)("a page on another port that frames a fleet's page reads no token from it: the frame's answer goes without one and is refused", async () => {
  if (browser === undefined) throw new Error("no browser");
  const html = `<!doctype html><meta charset="utf-8"><iframe src="${origin}/f/p/?embed=1#decision/p-1a2b3c4d" width="800" height="600"></iframe>`;
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }) });

  try {
    const page = await browser.newPage();
    const posts = chatPosts(page);
    await page.goto(`http://127.0.0.1:${String(other.port)}/`);
    const frame = await cardFrame(page);
    expect(await answer(frame, "allow-once")).toBe(STALE);
    expect(await answered(posts)).toEqual([{ token: null, status: 403 }]);
    expect([readChat(root), grants(), existsSync(join(session, ".claude", "settings.local.json"))]).toEqual([[], [], false]);
    await page.close();
  } finally {
    await other.stop(true);
  }
}, 60_000);

test.skipIf(!found)("a preview that registers a file of the fleet's DIR as a service worker over the fleet's page gets the hub's kill switch, so no worker sees its token", async () => {
  if (browser === undefined) throw new Error("no browser");
  writeFileSync(join(root, "sw.js"), SPY);
  const dev = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><p>the preview</p>", { headers: { "Content-Type": "text/html" } }) });
  writeFileSync(join(root, "preview.json"), JSON.stringify(recordJson(previewAt(dev.port ?? 0))));
  const context = await browser.createBrowserContext();

  try {
    const preview = await context.newPage();
    await preview.goto(`${origin}/f/p/preview/`);
    expect(await preview.evaluate("document.body.innerText")).toBe("the preview");
    await preview.evaluate(`navigator.serviceWorker.register("/f/p/sw.js", { scope: "/f/p/" }).then(() => true, () => false)`);
    expect(await settled(preview, "navigator.serviceWorker.getRegistrations().then((r) => r.length === 0)")).toBe(true);
    const page = await context.newPage();
    await page.goto(`${origin}/f/p/`);
    const seen = await page.evaluate(`JSON.stringify([document.documentElement.outerHTML.includes("SW SAW"), navigator.serviceWorker.controller === null, (document.querySelector('meta[name="fleet-page-token"]')?.content ?? "").length > 20])`);
    expect(JSON.parse(String(seen))).toEqual([false, true, true]);
  } finally {
    await context.close();
    await dev.stop(true);
  }
}, 60_000);

/** Whether `expression` is true in `page` within 20 s; a navigation under way (a worker reloading the page) is
 * waited out. */
async function settled(page: Frame, expression: string): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await page.evaluate(expression)) === true) return true;
    } catch {
      // the page is navigating
    }

    await Bun.sleep(100);
  }

  return false;
}

/** `act` run while a hub from before 1.9.61 holds the hub's port: a stand-in that answers each path of `served` with
 * its body, type and headers, whatever the request asks (a service worker's script included), and 404 else; the hub
 * started again after, on the same registry and port. */
async function onOldHub(served: Readonly<Record<string, readonly [string, string, Record<string, string>?]>>, act: () => Promise<void>): Promise<void> {
  if (options === undefined || running === undefined) throw new Error("no hub");
  await running.stop();
  running = undefined;

  const old = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: (req) => {
      const one = served[new URL(req.url).pathname];

      return one === undefined ? new Response("", { status: 404 }) : new Response(one[0], { headers: { "Content-Type": one[1], "Cache-Control": "no-store", ...one[2] } });
    },
  });

  try {
    await act();
  } finally {
    await old.stop(true);
    await startAgain();
  }
}

test.skipIf(!found)("a worker a hub from before 1.9.61 let register over a fleet's page is killed at its next update check: the page loads again, its token there, no worker", async () => {
  if (browser === undefined) throw new Error("no browser");
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    await onOldHub({ "/f/p/": ["<!doctype html><p>old</p>", "text/html"], "/f/p/sw.js": [SPY, "text/javascript"] }, async () => {
      await page.goto(`${origin}/f/p/`);
      expect(await page.evaluate(`navigator.serviceWorker.register("/f/p/sw.js", { scope: "/f/p/" }).then(async () => { await navigator.serviceWorker.ready; return "ok"; })`)).toBe("ok");
    });

    await page.goto(`${origin}/f/p/`);
    const healed = `navigator.serviceWorker.controller === null && !document.documentElement.outerHTML.includes("SW SAW") && (document.querySelector('meta[name="fleet-page-token"]')?.content ?? "").length > 20`;
    expect(await settled(page, healed)).toBe(true);
    expect(await settled(page, "navigator.serviceWorker.getRegistrations().then((r) => r.length === 0)")).toBe(true);
  } finally {
    await context.close();
  }
}, 60_000);

test.skipIf(!found)("a fleet's page unregisters a worker whose scope reaches past a preview's path, which its update cannot replace, and keeps a preview's own", async () => {
  if (browser === undefined) throw new Error("no browser");
  const context = await browser.createBrowserContext();
  const quiet = 'self.addEventListener("install", () => self.skipWaiting());';

  try {
    const page = await context.newPage();
    await onOldHub(
      {
        "/f/p/preview/": ["<!doctype html><p>old preview</p>", "text/html"],
        "/f/p/preview/wide.js": [quiet, "text/javascript", { "Service-Worker-Allowed": "/" }],
        "/f/p/preview/own.js": [quiet, "text/javascript"],
      },
      async () => {
        await page.goto(`${origin}/f/p/preview/`);

        const scopes = await page.evaluate(`Promise.all([
          navigator.serviceWorker.register("/f/p/preview/wide.js", { scope: "/f/" }),
          navigator.serviceWorker.register("/f/p/preview/own.js", { scope: "/f/p/preview/" }),
        ]).then(() => navigator.serviceWorker.getRegistrations()).then((r) => r.map((x) => new URL(x.scope).pathname).sort().join(" "))`);

        expect(scopes).toBe("/f/ /f/p/preview/");
      },
    );

    await page.goto(`${origin}/f/p/`);
    const left = 'navigator.serviceWorker.getRegistrations().then((r) => r.map((x) => new URL(x.scope).pathname).join(" ") === "/f/p/preview/")';
    expect(await settled(page, left)).toBe(true);
  } finally {
    await context.close();
  }
}, 60_000);

test.skipIf(!found)("a worker a preview registered over the origin before 1.9.61, with Service-Worker-Allowed: /, is killed at its next update while the preview still sends that header", async () => {
  if (browser === undefined) throw new Error("no browser");
  const quiet = 'self.addEventListener("install", () => self.skipWaiting());';
  const allowed = { "Service-Worker-Allowed": "/" };
  const html = "<!doctype html><p>the preview</p>";

  const dev = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/f/p/preview/wide.js" ? new Response(quiet, { headers: { "Content-Type": "text/javascript", ...allowed } }) : new Response(html, { headers: { "Content-Type": "text/html" } }),
  });

  writeFileSync(join(root, "preview.json"), JSON.stringify(recordJson(previewAt(dev.port ?? 0))));
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    await onOldHub({ "/f/p/preview/": [html, "text/html"], "/f/p/preview/wide.js": [quiet, "text/javascript", allowed] }, async () => {
      await page.goto(`${origin}/f/p/preview/`);
      expect(await page.evaluate(`navigator.serviceWorker.register("/f/p/preview/wide.js", { scope: "/f/" }).then(async () => { await navigator.serviceWorker.ready; return "ok"; })`)).toBe("ok");
    });

    await page.goto(`${origin}/f/p/preview/`);
    await page.evaluate('navigator.serviceWorker.getRegistration("/f/").then((r) => r?.update()).then(() => true, () => false)');
    expect(await settled(page, "navigator.serviceWorker.getRegistrations().then((r) => r.length === 0)")).toBe(true);
  } finally {
    await context.close();
    await dev.stop(true);
  }
}, 60_000);

test.skipIf(!found)("a fleet's page whose controller is a worker it unregisters loads again once, and that load has no worker and stays", async () => {
  if (browser === undefined) throw new Error("no browser");
  const claiming = 'self.addEventListener("install", () => self.skipWaiting());\nself.addEventListener("activate", (e) => e.waitUntil(clients.claim()));';
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    await onOldHub({ "/f/p/preview/": ["<!doctype html><p>old preview</p>", "text/html"], "/f/p/preview/wide.js": [claiming, "text/javascript", { "Service-Worker-Allowed": "/" }] }, async () => {
      await page.goto(`${origin}/f/p/preview/`);
      expect(await page.evaluate(`navigator.serviceWorker.register("/f/p/preview/wide.js", { scope: "/f/" }).then(async () => { await navigator.serviceWorker.ready; return "ok"; })`)).toBe("ok");
    });

    await page.goto(`${origin}/f/p/`);
    const fresh = `navigator.serviceWorker.controller === null && performance.getEntriesByType("navigation")[0]?.type === "reload" && (document.querySelector('meta[name="fleet-page-token"]')?.content ?? "").length > 20`;
    expect(await settled(page, fresh)).toBe(true);
    await page.evaluate("(window.stayed = true)");
    await Bun.sleep(1500);
    expect(await page.evaluate("window.stayed === true && navigator.serviceWorker.controller === null")).toBe(true);
    expect(await page.evaluate("navigator.serviceWorker.getRegistrations().then((r) => r.length)")).toBe(0);
  } finally {
    await context.close();
  }
}, 60_000);
