/**
 * "Not listening": a fleet whose host does not read its chat while the user's messages wait, said in the stuck
 * band from what the hub gives (the view's `deaf`, fleet/src/wake.ts): since when, how many wait, when the
 * hub woke the session, where it stands, and "Wake now", which the hub may hold for a while. On the fleet's
 * own page and, for each fleet, on the manager's. Run in happy-dom, through `takeState`. A time of day reads as every other on the page does
 * (`clock`, the viewer's own format).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Deaf, type Json } from "../src/core.ts";
import { clock } from "../src/format.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, managerView, type View } from "./fixtures.ts";

const NOW = Date.now();

/** A stamp `min` minutes before now, to the second. */
const before = (min: number): string => new Date(NOW - min * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const hhmm = (iso: string): string => iso.slice(11, 16);

const SINCE = before(50);

const DEAF: View = { since: SINCE, unread: 2, first: 369, woken: [before(48), before(38)], end: null, why: null, held: null, again: null };

const MINUTE = "you woke it less than a minute ago";

const UNREAD = "the session has not read the last wake yet: another would queue behind it";

/** The hub's `deaf` with `more` over it, as the page reads it. */
function deafWith(more: View = {}): Deaf {
  const parsed = Core.deafOf({ ...DEAF, ...more });

  if (!parsed) throw new Error("no deaf");

  return parsed;
}

const CHAT: View = { on: false, seen: 368, unread: 2, since: SINCE };

let posted: { readonly url: string; readonly method: string; readonly type: string; readonly body: string }[] = [];

let answer: () => Response;

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

function show(view: View, conn: "live" | "unavailable" = "live"): void {
  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn(conn);
  flush();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((wake) => setTimeout(wake, 0));
    flush();
  }
}

const words = (sel: string): string[] => [...root.querySelectorAll(sel)].map((l) => (l.textContent ?? "").replace(/\s+/gu, " ").trim());

const button = (fleet = "here"): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>(`[data-deaf="${fleet}"] .wake-now`);

/** A manager's view whose fleet `infra` is as `deaf` says. */
function managerWith(deaf: Json): View {
  const view = managerView(NOW);
  const fleets = Array.isArray(view["coordinators"]) ? view["coordinators"] : [];

  return { ...view, coordinators: fleets.map((c) => (Object(c) === c && !Array.isArray(c) && c !== null && c["id"] === "infra" ? { ...c, chat: CHAT, deaf } : c)) };
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted = [];
  dispose = () => {};

  answer = () => Response.json({ woken: true, fleet: "infra", at: before(0) });
  // SAFETY: the stub answers the page's fetch calls; only the URL, the method, the type and the body are read.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url !== "wake") return new Response("{}", { status: 404 });
    posted.push({ url, method: init?.method ?? "GET", type: new Headers(init?.headers).get("Content-Type") ?? "", body: String(init?.body ?? "") });

    return answer();
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  dispose();
  root.remove();
});

test("the words: since when, how many wait and the oldest, when it was woken, and how it ended", () => {
  const said = (more: View = {}): string => Core.deafWords(deafWith(more), hhmm);
  const head = `Not listening since ${hhmm(SINCE)}: 2 messages wait (#369…).`;
  const woken = `Woken ${hhmm(before(48))}, ${hhmm(before(38))}.`;
  expect(said()).toBe(`${head} ${woken}`);
  expect(said({ woken: [] })).toBe(head);
  expect(said({ unread: 1, woken: [] })).toBe(`Not listening since ${hhmm(SINCE)}: 1 message waits (#369).`);
  expect(said({ woken: [before(48), before(38), before(8)], end: "spent" })).toBe(
    `${head} Woken ${hhmm(before(48))}, ${hhmm(before(38))}, ${hhmm(before(8))}. The session did not answer 3 wakes: at its usage limit or gone. Open it in a terminal.`,
  );
  expect(said({ end: "gone", woken: [] })).toBe(`${head} The session is gone. Open it in a terminal.`);
  expect(said({ end: "limit" })).toBe(`${head} ${woken} The session is at its usage limit. Open it in a terminal.`);
  expect(said({ end: "failed", why: "the session's socket refused the connection", woken: [] })).toBe(`${head} The session could not be woken (the session's socket refused the connection). Open it in a terminal.`);
  expect(said({ end: "something new" })).toBe(`${head} ${woken}`);
});

test("a session that is gone says why when the hub does", () => {
  const said = (more: View): string => Core.deafWords(deafWith({ woken: [], ...more }), hhmm);
  const head = `Not listening since ${hhmm(SINCE)}: 2 messages wait (#369…).`;
  expect(said({ end: "gone" })).toBe(`${head} The session is gone. Open it in a terminal.`);
  expect(said({ end: "gone", why: "its process no longer runs" })).toBe(`${head} The session is gone (its process no longer runs). Open it in a terminal.`);
  expect(said({ end: "gone", why: "another process has its pid (123)" })).toBe(`${head} The session is gone (another process has its pid (123)). Open it in a terminal.`);
});

test("where it stands while the hub still waits: the last wake not read; an end the page does not know says nothing", () => {
  const said = (more: View): string => Core.deafWords(deafWith(more), hhmm);
  const head = `Not listening since ${hhmm(SINCE)}: 2 messages wait (#369…).`;
  const woken = `Woken ${hhmm(before(48))}, ${hhmm(before(38))}.`;
  expect(said({ end: "queued" })).toBe(`${head} ${woken} The session has not read the last wake. Open it in a terminal.`);
  expect([said({ end: "unknown", why: "ps failed: exit 1" }), said({ end: "busy" })]).toEqual([`${head} ${woken}`, `${head} ${woken}`]);
});

test("how the button stands: held until a time it says how long is left, held with no time it is off, else it can be pressed", () => {
  const at = Date.parse("2026-10-12T14:00:00Z");
  const stands = (more: View): ReturnType<typeof Core.wakeButton> => Core.wakeButton(deafWith(more), at);
  const free = { disabled: false, label: "Wake now", title: "" };
  expect(stands({})).toEqual(free);
  expect(stands({ held: MINUTE, again: "2026-10-12T14:00:42Z" })).toEqual({ disabled: true, label: "Wake now (in 42 s)", title: MINUTE });
  expect(stands({ held: MINUTE, again: "2026-10-12T14:00:59.200Z" })).toEqual({ disabled: true, label: "Wake now (in 1 min)", title: MINUTE });
  expect(stands({ held: MINUTE, again: "2026-10-12T14:00:00.300Z" })).toEqual({ disabled: true, label: "Wake now (in 1 s)", title: MINUTE });
  expect(stands({ held: "3 wakes in the last hour, the most a fleet is written", again: "2026-10-12T14:01:00Z" }).label).toBe("Wake now (in 1 min)");
  expect(stands({ held: "3 wakes in the last hour, the most a fleet is written", again: "2026-10-12T14:12:01Z" }).label).toBe("Wake now (in 13 min)");
  expect(stands({ held: MINUTE, again: "2026-10-12T14:00:00Z" })).toEqual(free);
  expect(stands({ held: MINUTE, again: "2026-10-12T13:59:10Z" })).toEqual(free);
  expect(stands({ held: UNREAD })).toEqual({ disabled: true, label: "Wake now", title: UNREAD });
});

test("a fleet's own page says it first, in the stuck band, in place of the bare chat-not-read line", () => {
  show({ ...coordinatorView(NOW), decisions: [], chat: CHAT, deaf: DEAF });
  expect(words('#lead .stuck [data-deaf="here"]')).toEqual([`Not listening since ${clock(SINCE)}: 2 messages wait (#369…). Woken ${clock(before(48))}, ${clock(before(38))}. Wake now`]);
  expect(button()?.disabled).toBe(false);
  expect(words('#lead .stuck [data-deaf="here"] a')).toEqual([]);
  expect(words("#lead .stuck li").filter((l) => l.includes("chat not read"))).toEqual([]);
});

test("the manager's page says it for each such fleet, with a link to the fleet's page", () => {
  show(managerWith(DEAF));
  expect(words('#lead .stuck [data-deaf="infra"]')).toEqual([`infra: Not listening since ${clock(SINCE)}: 2 messages wait (#369…). Woken ${clock(before(48))}, ${clock(before(38))}. Wake now`]);
  expect(words('#lead .stuck [data-deaf="infra"] a')).toEqual(["infra"]);
  expect(words("#lead .stuck li").filter((l) => l.includes("chat not read"))).toEqual([]);
});

test("it shows as soon as the hub gives it: a message that waits two minutes is said, though the chat-not-read line waits five", () => {
  const fresh = { ...DEAF, since: before(2), woken: [] };
  show({ ...coordinatorView(NOW), decisions: [], chat: { ...CHAT, since: before(2) } });
  expect(words("#lead .stuck li").filter((l) => /listening|not read/u.test(l))).toEqual([]);
  page.m.takeState(JSON.stringify({ ...coordinatorView(NOW), decisions: [], chat: { ...CHAT, since: before(2) }, deaf: fresh, updated: new Date(NOW + 1000).toISOString() }));
  flush();
  expect(words('#lead .stuck [data-deaf="here"]')).toEqual([`Not listening since ${clock(before(2))}: 2 messages wait (#369…). Wake now`]);
});

test("without the key the page says what it said before: chat not read", () => {
  const view = managerWith(null);
  show(view);
  expect(Core.parseState(view)?.coordinators.find((c) => c.id === "infra")?.deaf).toBeNull();
  expect(words("#lead .stuck li")).toEqual(["infra 2 messages from you unread: chat not read, 50 min ago. The coordinator is not reading; tell it in its session."]);
  expect(words(".wake-now")).toEqual([]);
});

test("Wake now posts to the hub: nothing named on the fleet's own page, the fleet named on the manager's", async () => {
  show({ ...coordinatorView(NOW), decisions: [], chat: CHAT, deaf: DEAF });
  button()?.click();
  await settle();
  expect(posted).toEqual([{ url: "wake", method: "POST", type: "application/json", body: "{}" }]);
  expect(words("#lead .stuck .wake-said")).toEqual(["Woken now."]);
  dispose();
  root.replaceChildren();
  posted = [];
  show(managerWith(DEAF));
  button("infra")?.click();
  await settle();
  expect(posted).toEqual([{ url: "wake", method: "POST", type: "application/json", body: '{"fleet":"infra"}' }]);
});

test("a refusal shows the hub's reason, and the button stays", async () => {
  answer = () => Response.json({ error: "could not wake infra: the session's socket refused the connection" }, { status: 502 });
  show(managerWith(DEAF));
  button("infra")?.click();
  await settle();
  expect(words("#lead .stuck .wake-said")).toEqual(["could not wake infra: the session's socket refused the connection"]);
  expect(button("infra")?.disabled).toBe(false);
});

test("a wake the hub holds: the button is off and says how long is left, with the hub's reason as its title", async () => {
  show(managerWith({ ...DEAF, held: MINUTE, again: before(-5) }));
  expect([button("infra")?.disabled, button("infra")?.textContent, button("infra")?.title]).toEqual([true, "Wake now (in 5 min)", MINUTE]);
  expect(words('#lead .stuck [data-deaf="infra"]')).toEqual([`infra: Not listening since ${clock(SINCE)}: 2 messages wait (#369…). Woken ${clock(before(48))}, ${clock(before(38))}. Wake now (in 5 min)`]);
  button("infra")?.click();
  await settle();
  expect(posted).toEqual([]);
});

test("a hold whose time is past leaves the button as it was", async () => {
  show(managerWith({ ...DEAF, held: MINUTE, again: before(1) }));
  expect([button("infra")?.disabled, button("infra")?.textContent, button("infra")?.title]).toEqual([false, "Wake now", ""]);
  button("infra")?.click();
  await settle();
  expect(posted.map((p) => p.body)).toEqual(['{"fleet":"infra"}']);
});

test("a hold no time ends: the button is off, the hub's reason its title; a viewer who may not tell the hub reads that reason first", () => {
  show(managerWith({ ...DEAF, end: "queued", held: UNREAD }));
  expect([button("infra")?.disabled, button("infra")?.textContent, button("infra")?.title]).toEqual([true, "Wake now", UNREAD]);
  dispose();
  root.replaceChildren();
  show(managerWith({ ...DEAF, end: "queued", held: UNREAD }), "unavailable");
  expect([button("infra")?.disabled, button("infra")?.title]).toEqual([true, "This copy of the page has no server to send this to."]);
});

test("a wake the hub held when it was asked (429) shows the hub's words, and the button stays", async () => {
  answer = () => Response.json({ error: "not woken: you woke it less than a minute ago", again: before(-1) }, { status: 429 });
  show(managerWith(DEAF));
  button("infra")?.click();
  await settle();
  expect(posted.map((p) => p.body)).toEqual(['{"fleet":"infra"}']);
  expect(words("#lead .stuck .wake-said")).toEqual(["not woken: you woke it less than a minute ago"]);
  expect(button("infra")?.disabled).toBe(false);
});

test("a session that is gone has no button; a copy of the page that cannot reach the hub has it disabled", async () => {
  show(managerWith({ ...DEAF, end: "gone", why: "its process no longer runs", woken: [] }));
  expect(words('#lead .stuck [data-deaf="infra"]')).toEqual([`infra: Not listening since ${clock(SINCE)}: 2 messages wait (#369…). The session is gone (its process no longer runs). Open it in a terminal.`]);
  expect(words(".wake-now")).toEqual([]);
  dispose();
  root.replaceChildren();
  show(managerWith(DEAF), "unavailable");
  expect([button("infra")?.disabled, button("infra")?.title]).toEqual([true, "This copy of the page has no server to send this to."]);
  button("infra")?.click();
  await settle();
  expect(posted).toEqual([]);
});

test("a key that is no such record is none", () => {
  for (const deaf of [undefined, null, "deaf", { unread: 2 }, { since: SINCE }, { since: SINCE, first: "369" }] as const) expect(Core.deafOf(deaf)).toBeNull();
  expect(Core.deafOf({ since: SINCE, first: 369, woken: [before(3), 7, null] })).toEqual({ since: SINCE, unread: 0, first: 369, woken: [before(3)], end: "", why: "", held: "", again: "" });
  expect(Core.deafOf({ ...DEAF, end: "queued", held: MINUTE, again: before(-1) })).toMatchObject({ end: "queued", held: MINUTE, again: before(-1) });
  expect(Core.deafOf({ ...DEAF, held: 7, again: false })).toMatchObject({ held: "", again: "" });
});
