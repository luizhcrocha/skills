/**
 * Where the chat sits, in happy-dom, on the manager's page: docked beside the page from DOCK_MIN_PX up
 * (the shell's two columns, the page not inert), an overlay with a scrim below it that a click on the
 * scrim closes, and page.css's media queries at the same width as the model's. Overflow and overlap in a
 * real layout are `dock-browser.test.ts`'s.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import type { DetachedWindowAPI } from "happy-dom";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import { DOCK_MIN_PX, type Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { managerView } from "./fixtures.ts";

/** happy-dom's handle on the window the tests run in. */
declare const happyDOM: DetachedWindowAPI;

const NOW = Date.now();

const CSS = readFileSync(join(import.meta.dir, "..", "src", "page.css"), "utf8");

let page: { m: Model; ui: Ui };

let dispose: (() => void) | undefined;

let root: HTMLElement;

let style: HTMLStyleElement;

/** The manager's page in a window `width` px wide, with page.css, the chat live and opened. */
function open(width: number): void {
  happyDOM.setViewport({ width, height: 900 });
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  history.replaceState(null, "", "/f/manager/");
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, else not found.
  globalThis.fetch = (async (input: string | URL | Request) => new Response(String(input) === "skills" ? JSON.stringify({ skills: [], builtins: false }) : "{}", { status: String(input) === "skills" ? 200 : 404 })) as typeof fetch;
  style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(managerView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  flush();
  page.ui.openChat();
  flush();
}

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  dispose?.();
  root.remove();
  style.remove();
  document.documentElement.classList.remove("chat-open");
  history.replaceState(null, "", "/f/billing/");
  happyDOM.setViewport({ width: 1280, height: 900 });
});

const el = (id: string): HTMLElement => {
  const found = document.getElementById(id);

  if (!found) throw new Error("no #" + id);

  return found;
};

test("at 960 px the chat docks beside the page: two columns, the page not inert, no scrim", () => {
  open(960);
  expect(page.m.docked()).toBe(true);
  expect(el("shell").classList.contains("chat-collapsed")).toBe(false);
  expect(getComputedStyle(el("shell")).display).toBe("grid");
  expect(el("chat").classList.contains("open")).toBe(false);
  expect(el("app").inert).toBe(false);
  expect(el("masthead").inert).toBe(false);
  expect(document.documentElement.classList.contains("chat-open")).toBe(false);
  expect(document.getElementById("chat-scrim")?.hidden ?? true).toBe(true);
});

test("at 800 px the chat is a sheet over the page, behind a scrim that closes it", () => {
  open(800);
  expect(page.m.docked()).toBe(false);
  expect(el("chat").classList.contains("open")).toBe(true);
  expect(el("app").inert).toBe(true);
  const scrim = el("chat-scrim");
  expect(scrim.hidden).toBe(false);
  scrim.click();
  flush();
  expect(page.m.chatOpen()).toBe(false);
  expect(el("app").inert).toBe(false);
  expect(scrim.hidden).toBe(true);
});

test("page.css docks the chat at the model's width, and lays out the overlay below it", () => {
  const mins = [...CSS.matchAll(/@media[^{]*\(min-width: (\d+(?:\.\d+)?)px\)/gu)].map((x) => Number(x[1]));
  const maxes = [...CSS.matchAll(/@media[^{]*\(max-width: (\d+(?:\.\d+)?)px\)/gu)].flatMap((x) => (x[1] === "759.98" ? [] : [Number(x[1])]));
  expect(mins).toEqual([DOCK_MIN_PX]);
  expect(maxes.length).toBeGreaterThan(0);
  expect(new Set(maxes)).toEqual(new Set([DOCK_MIN_PX - 0.02]));
  expect(CSS).toContain("--chat-w: clamp(360px, 30vw, 440px)");
  /* At the docked width the chat is at its least, and the page keeps a readable column beside it. */
  expect(Math.max(360, Math.min(440, DOCK_MIN_PX * 0.3))).toBe(360);
  expect(DOCK_MIN_PX - 360).toBeGreaterThanOrEqual(560);
});
