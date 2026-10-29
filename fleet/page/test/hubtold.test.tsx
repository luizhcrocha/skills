/**
 * What only a hub says of a fleet, whole, in the stuck band: a change of host (the view's `takeover`,
 * fleet/src/takeover.ts). On the fleet's own page and, for each fleet, on the manager's, where the line opens
 * with the fleet's name. A `blind` key is no longer read: nothing gives it. Run in happy-dom. A time of day reads as every other on the page does (`clock`).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import { clock } from "../src/format.ts";
import { coordinatorView, managerView, type View } from "./fixtures.ts";

const NOW = Date.now();

/** A stamp `min` minutes before now, to the second. */
const before = (min: number): string => new Date(NOW - min * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const hhmm = (iso: string): string => iso.slice(11, 16);

const TAKEOVER: View = { id: 12, at: before(7), by: { pid: 222, started: before(15), session: "sess-new" }, from: { pid: 111, started: before(300), session: "sess-old" } };

let dispose: () => void;

let root: HTMLElement;

function show(view: View): void {
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} />, root);
  flush();
}

const told = (kind: string): string[] => [...root.querySelectorAll(`.stuck li[data-told="${kind}"]`)].map((l) => (l.textContent ?? "").replace(/\s+/gu, " ").trim());

/** A manager's view whose fleet `infra` has `more`. */
function managerWith(more: View): View {
  const view = managerView(NOW);
  const fleets = Array.isArray(view["coordinators"]) ? view["coordinators"] : [];

  return { ...view, coordinators: fleets.map((c) => (Object(c) === c && !Array.isArray(c) && c !== null && c["id"] === "infra" ? { ...c, ...more } : c)) };
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";

  dispose = () => {};

  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  dispose();
  root.remove();
});

test("a change of host, in words: when, who took the fleet from whom with each pid and start, the command, and what to do about it", () => {
  const parsed = Core.takeoverOf(TAKEOVER);

  if (!parsed) throw new Error("no takeover");
  expect(Core.takeoverWords(parsed, hhmm)).toBe(
    `The host changed at ${hhmm(before(7))}: session sess-new (pid 222, started ${hhmm(before(15))}) took this fleet over from session sess-old (pid 111, started ${hhmm(before(300))}), which was running, ` +
      "with fleet serve --take-over. If you did not ask for that, say so in the chat. This stays until the new host has read your next message.",
  );
  const bare = Core.takeoverOf({ at: before(7), by: { pid: 222, started: null, session: null }, from: { pid: 111 } });

  if (!bare) throw new Error("no takeover");
  expect(Core.takeoverWords(bare, hhmm)).toContain("session not recorded (pid 222) took this fleet over from session not recorded (pid 111), which was running");
  expect([Core.takeoverOf(null), Core.takeoverOf({ at: before(7) }), Core.takeoverOf({ at: before(7), by: { pid: "x" }, from: { pid: 1 } })]).toEqual([null, null, null]);
});

test("on the fleet's own page it is a line of the stuck band, and is not there when the hub says nothing", () => {
  show(coordinatorView(NOW));
  expect(told("takeover")).toEqual([]);
  dispose();
  show({ ...coordinatorView(NOW), takeover: TAKEOVER, blind: { since: before(9), what: "chat", why: "" } });
  expect(told("takeover")).toEqual([Core.takeoverWords(Core.takeoverOf(TAKEOVER) ?? { at: "", by: { pid: 0, started: "", session: "" }, from: { pid: 0, started: "", session: "" } }, clock)]);
  expect(root.querySelectorAll(".stuck li[data-told]").length).toBe(1);
  expect(told("takeover")[0]).toContain("session sess-new (pid 222");
  expect(root.querySelector(".stuck h3")?.textContent).toBe("Stuck");
});

test("on the manager's page the line opens with the fleet's name, a link to its page", () => {
  show(managerWith({ takeover: TAKEOVER }));
  expect(told("takeover")[0]?.startsWith(`infra: The host changed at ${clock(before(7))}: session sess-new (pid 222, `)).toBe(true);
  const links = [...root.querySelectorAll<HTMLAnchorElement>('.stuck li[data-fleet="infra"] a')].map((a) => a.textContent);
  expect(links).toEqual(["infra"]);
});
