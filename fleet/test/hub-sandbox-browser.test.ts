/**
 * The hub's files of a fleet's DIR, opened as top-level windows in headless Chromium against a real hub: an
 * agent's HTML file (a body's link opens one in a window of its own) runs no script and has no origin, so it
 * cannot post to the chat as the user; a linked prototype under `files/` runs its scripts, but with an opaque
 * origin whose posts the hub refuses. The page itself still runs, goes live and posts. Skipped when no Chromium
 * (FLEET_CHROMIUM, or chromium on the PATH) or no puppeteer-core (fleet/page's, installed by `just test-page`).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { readChat } from "../src/chat/store.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import { baseEnv, machine, tmp } from "./support.ts";

/** The part of puppeteer-core this test drives. */
interface Page {
  goto(url: string): Promise<object | null>;
  title(): Promise<string>;
  /** An expression evaluated in the page (DevTools runs it whatever the page's policy), as a string or number. */
  evaluate(expression: string): Promise<string | number | null>;
  waitForFunction(expression: string, options?: { readonly timeout?: number }): Promise<object>;
  close(): Promise<void>;
}

interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

interface Puppeteer {
  launch(options: { readonly executablePath: string; readonly headless: boolean; readonly args: readonly string[]; readonly env: Readonly<Record<string, string | undefined>> }): Promise<Browser>;
}

const PUPPETEER = join(import.meta.dir, "..", "page", "node_modules", "puppeteer-core");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium) && existsSync(PUPPETEER);

/** Every way a script tries to post as the user, each outcome written into the title once all have settled. */
const POSTS = `<script>
const url = "/f/p/chat";
const json = JSON.stringify({ text: "from an agent's file" });
const tries = [
  fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: json }).then((r) => "cors " + r.status),
  fetch(url, { method: "POST", mode: "no-cors", credentials: "include", headers: { "Content-Type": "application/json" }, body: json }).then((r) => "no-cors " + r.type),
  Promise.resolve().then(() => "beacon " + navigator.sendBeacon(url, new Blob([json], { type: "text/plain" }))),
];
Promise.allSettled(tries).then((all) => { document.title = "tried: " + all.map((t) => t.status === "fulfilled" ? t.value : "refused").join(", "); });
</script>`;

let browser: Browser | undefined;

let running: Running | undefined;

let root = "";

let origin = "";

/** A new tab of the test's browser. */
async function tab(): Promise<Page> {
  if (browser === undefined) throw new Error("no browser");

  return browser.newPage();
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
  const base = tmp("fleet-hub-sandbox-");
  root = join(base, "p", "coordinator");
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "proto"), { recursive: true });
  const env = baseEnv(join(base, "registry"));
  const links = [{ id: "l1", url: `file://${join(root, "proto", "proto.html")}`, title: "Prototype", kind: "doc" }];
  const state = { project: "p", goal: "g", status: "running", now: "n", started: "2026-01-01T00:00:00+00:00", roadmap: [], agents: [], roadblocks: [], events: [], decisions: [], links };
  writeFileSync(join(root, "state.json"), JSON.stringify(state));
  writeFileSync(join(root, "notes", "evil.html"), `<!doctype html><title>agent's file</title><p id="shown">An agent's page</p>${POSTS}`);
  writeFileSync(join(root, "proto", "proto.html"), `<!doctype html><title>prototype</title><p>A prototype</p>${POSTS}`);
  machine(env).registry.register(root, "u", process.pid, "2026-01-01T00:00:00+00:00");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  const got = await startHub({ port, machine: machine(env), tailscale: join(base, "no-tailscale"), peers: false, hosts: [], https: undefined }, () => {});

  if (got instanceof Error) throw got;
  running = got;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.skipIf(!found)("an agent's HTML file opened by itself runs no script, has no origin, and posts nothing", async () => {
  const page = await tab();
  await page.goto(`${origin}/f/p/notes/evil.html`);
  await sleep(1500);
  expect([await page.title(), await page.evaluate('document.querySelector("#shown").textContent'), await page.evaluate("window.origin")]).toEqual([
    "agent's file",
    "An agent's page",
    "null",
  ]);
  expect(readChat(root)).toEqual([]);
  await page.close();
});

test.skipIf(!found)("a linked prototype runs its scripts with an opaque origin, and the hub refuses every post it tries", async () => {
  const page = await tab();
  await page.goto(`${origin}/f/p/files/proto/proto.html`);
  await page.waitForFunction('document.title.startsWith("tried: ")', { timeout: 10_000 });
  await sleep(500);
  expect([await page.title(), await page.evaluate("window.origin")]).toEqual(["tried: refused, no-cors opaque, beacon true", "null"]);
  expect(readChat(root)).toEqual([]);
  await page.close();
});

test.skipIf(!found)("the page itself runs with the hub's origin: it goes live and its post is taken", async () => {
  const page = await tab();
  await page.goto(`${origin}/f/p/`);
  await page.waitForFunction('document.querySelector("#conn")?.textContent === "Live"', { timeout: 10_000 });
  const status = await page.evaluate('fetch("chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "from the page" }) }).then((r) => r.status)');

  expect([status, readChat(root).map((m) => m.stored["text"])]).toEqual([201, ["from the page"]]);
  await page.close();
});
