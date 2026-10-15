/**
 * An answer that grants, given on the manager's page to another fleet's card, in headless Chromium against a real
 * hub: the manager's page shows the card as that fleet's own page in a frame (`?embed=1`), which the hub serves
 * without the page token (only a top-level load gets one), so the frame sends the token of the page it is shown in.
 * Allow once, Allow once and save this kind, and Add this rule each go through; the frame's own document still
 * holds no token. Skipped when no Chromium (FLEET_CHROMIUM, or chromium on the PATH) or no puppeteer-core
 * (fleet/page's, installed by `just test-page`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { readChat } from "../src/chat/store.ts";
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

interface Page extends Frame {
  goto(url: string): Promise<object | null>;
  frames(): Frame[];
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

const CALL = "git push --force origin HEAD:main";

const RULE = `Bash(${CALL})`;

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
  if (options === undefined || running === undefined) throw new Error("no hub");
  await running.stop();
  running = undefined;
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

/** The manager's page open on fleet p's card `id`, and the frame that shows it once its answer form is there. */
async function managerOn(id: string): Promise<{ readonly page: Page; readonly frame: Frame }> {
  if (browser === undefined) throw new Error("no browser");
  const page = await browser.newPage();
  await page.goto(`${origin}/f/manager/#decision/p/${id}`);

  return { page, frame: await cardFrame(page) };
}

/** The frame the manager's page shows fleet p's card in, once its answer form is there. */
async function cardFrame(page: Page): Promise<Frame> {
  await page.waitForFunction('document.querySelector("#dv-embed") !== null', { timeout: 10_000 });

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

test.skipIf(!found)("a token the hub never issued, in the page the frame is shown in, grants nothing", async () => {
  const { page, frame } = await managerOn("p-1a2b3c4d");
  await page.evaluate('(document.querySelector(\'meta[name="fleet-page-token"]\').content = "forged-" + "x".repeat(25), true)');
  expect(await answer(frame, "allow-once")).toBe("the page token is missing or stale: reload the fleet's page and answer again");
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

const STALE = "the page token is missing or stale: reload the fleet's page and answer again";

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
