/**
 * The plan's usage on a manager's page: the account whose session worked last, named, with a meter per
 * window, and below it a line per other account still inside a window. The rules are `fleet-core`'s
 * (`usageOf`, `usageOthersOf`, tests/page.test.mjs); this is what the page makes of them.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import { managerView } from "./fixtures.ts";

/** The page reads its own clock, so the windows are placed around it. */
const NOW = Date.now();

const S = (ms: number): number => Math.floor(ms / 1000);

const HOUR = 3600e3;

let dispose: (() => void) | undefined;

let root: HTMLElement | undefined;

afterEach(() => {
  dispose?.();
  root?.remove();
});

function mount(usage: Json): HTMLElement {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  // SAFETY: the stub answers the calls the page makes with `fetch` (none of them matter here); nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 404 })) as typeof fetch;
  const state = Core.parseState({ ...managerView(NOW), usage });

  if (!state) throw new Error("the fixture is not a state");
  const at = document.createElement("div");
  document.body.append(at);
  dispose = render(() => <App state={state} live={false} />, at);
  flush();
  root = at;

  return at;
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/gu, " ").trim();

test("the account in use is the reading, named; another account's full week is a line below it", () => {
  const page = mount({
    account: "home@example.com",
    seen: S(NOW - 60e3),
    five_hour: { used_percentage: 12, resets_at: S(NOW + 2 * HOUR), at: S(NOW - 60e3) },
    seven_day: { used_percentage: 30, resets_at: S(NOW + 50 * HOUR), at: S(NOW - 60e3) },
    others: [
      { account: "work@example.com", seen: S(NOW - 7 * HOUR), five_hour: { used_percentage: 41, resets_at: S(NOW - HOUR), at: 1 }, seven_day: { used_percentage: 100, resets_at: S(NOW + 90 * HOUR), at: 1 } },
    ],
  });

  const usage = page.querySelector("#usage-list");
  expect(text(usage?.querySelector(".usage-account"))).toBe("home@example.com");
  expect([...(usage?.querySelectorAll(".usage-row .figure") ?? [])].map(text)).toEqual(["12% used", "30% used"]);
  expect([...(usage?.querySelectorAll(".usage-other") ?? [])].map(text)).toEqual(["work@example.com: week 100%"]);
});

test("a reading from before accounts were kept says so, and with no other account there is no line for one", () => {
  const page = mount({ five_hour: { used_percentage: 40, resets_at: S(NOW + HOUR), at: S(NOW - 60e3) } });
  const usage = page.querySelector("#usage-list");
  expect(text(usage?.querySelector(".usage-account"))).toBe("Account not recorded");
  expect([...(usage?.querySelectorAll(".usage-row .figure") ?? [])].map(text)).toEqual(["40% used"]);
  expect(usage?.querySelectorAll(".usage-other").length).toBe(0);
});
