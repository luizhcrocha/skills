/**
 * The page updates in place: a `state` event that changes one worker leaves every other row's DOM as it
 * was, and what the viewer has open, chosen or typed survives it; a chat message is appended without
 * rebuilding the conversation. Also the composer's "/" list of skills. Run in happy-dom, through the same
 * paths the stream takes (`takeState` for `state`, `addMessage` for `chat`).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { agentsOf, coordinatorChat, coordinatorView, type Message, type View } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const SKILLS = [
  { name: "tstack:tdd", description: "Test-first development.", hint: "[what to fix]", source: "plugin" },
  { name: "tstack:research", description: "Investigate a question.", hint: "<question>", source: "plugin" },
  { name: "deploy", description: "Deploy the site.", hint: "", source: "project" },
];

/** What the page posts to `chat`, as these tests read it. */
interface Said {
  readonly text: string;
}

/** A message as the stream carries it: plain JSON. */
const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

/** What the page has posted to `chat` so far. */
const chatPosts = (): Said[] => posted.flatMap((p): Said[] => (p.url === "chat" ? [JSON.parse(p.body)] : []));

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

const posted: { url: string; body: string }[] = [];

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted.length = 0;
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` (such as `preconnect`) is used.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    posted.push({ url, body: String(init?.body ?? "") });

    if (url === "skills") return new Response(JSON.stringify({ skills: SKILLS, builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: Said = JSON.parse(String(init?.body));

      return new Response(JSON.stringify({ id: 99, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(coordinatorView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of coordinatorChat(NOW)) page.ui.addMessage(wire(m), false);
  /* The chat as the stream leaves it after its hello. */
  page.m.setConn("live");
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

/** The view with worker `id` changed by `change`. */
function changed(id: string, change: (a: View) => View): View {
  const view = coordinatorView(NOW);

  return { ...view, agents: agentsOf(view).map((a) => (a["id"] === id ? change(a) : a)) };
}

/** A `state` event: what the stream's handler does with its data. */
function stateEvent(view: View): void {
  page.m.takeState(JSON.stringify(view));
  flush();
}

const row = (id: string): HTMLElement | null => root.querySelector(`#agent-${id}`);

test("a state that changes one worker keeps every other row's node, and changes that row in place", () => {
  const before = ["a1", "a2", "a3", "a4", "a5", "a6"].map(row);
  const tokensCell = row("a2")?.querySelector(".c-tokens");
  const strips = [...root.querySelectorAll("#roadmap-list .milestone")];

  expect(before.every(Boolean)).toBe(true);
  stateEvent(changed("a2", (a) => ({ ...a, tokens: 123_456, task: "Generate invoices, round 2" })));

  const after = ["a1", "a2", "a3", "a4", "a5", "a6"].map(row);
  after.forEach((el, i) => expect(el).toBe(before[i] ?? null));
  expect(row("a2")?.querySelector(".c-tokens")).toBe(tokensCell ?? null);
  expect(tokensCell?.textContent).toBe("123,456");
  expect(row("a2")?.querySelector(".c-task")?.textContent).toBe("Generate invoices, round 2");
  expect([...root.querySelectorAll("#roadmap-list .milestone")]).toEqual(strips);
});

test("a new worker adds one row; a removed one takes only its row", () => {
  const before = ["a1", "a2", "a3"].map(row);
  const view = coordinatorView(NOW);
  const agents = agentsOf(view).filter((a) => a["id"] !== "a6");
  stateEvent({ ...view, agents: [...agents, { id: "a7", name: "late-one", status: "queued", task: "Later", lane: [], milestone: "m3" }] });

  expect(["a1", "a2", "a3"].map(row)).toEqual(before);
  expect(row("a6")).toBeNull();
  expect(row("a7")).not.toBeNull();
});

test("an open worker sheet stays open, on the same nodes, through a state update", () => {
  page.ui.openWorker("a2");
  flush();
  const dialog = root.querySelector<HTMLDialogElement>("#worker");
  const heading = dialog?.querySelector("#worker-name");

  expect(dialog?.open).toBe(true);
  expect(heading?.textContent).toBe("invoice-gen");
  stateEvent(changed("a2", (a) => ({ ...a, status: "blocked" })));

  expect(dialog?.open).toBe(true);
  expect(dialog?.querySelector("#worker-name")).toBe(heading ?? null);
  expect(dialog?.querySelector(".sheet-head .pill")?.textContent).toBe("blocked");
});

test("the switcher keeps its selection and its options through a state update", () => {
  const select = root.querySelector<HTMLSelectElement>("#switch select");
  const options = [...(select?.options ?? [])];

  expect(select?.value).toBe("/f/billing/");
  stateEvent(changed("a1", (a) => ({ ...a, tokens: 1 })));

  expect(root.querySelector("#switch select")).toBe(select ?? null);
  expect([...(select?.options ?? [])]).toEqual(options);
  expect(select?.value).toBe("/f/billing/");
});

test("a typed chat draft, its caret and focus survive a state update", () => {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  say.focus();
  say.value = "half a thought about the rounding";
  say.dispatchEvent(new Event("input", { bubbles: true }));
  say.setSelectionRange(4, 4);
  flush();
  stateEvent(changed("a3", (a) => ({ ...a, status: "running" })));

  expect(root.querySelector("#say")).toBe(say);
  expect(say.value).toBe("half a thought about the rounding");
  expect(say.selectionStart).toBe(4);
  expect(document.activeElement).toBe(say);
  expect(localStorage.getItem("fleet:/f/billing/chat-draft")).toBe(JSON.stringify("half a thought about the rounding"));
});

test("a worker filter's choice and an open notifications panel survive a state update", () => {
  const status = root.querySelector<HTMLSelectElement>("#f-status");

  if (!status) throw new Error("no filter");
  status.value = "running";
  status.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  page.ui.setPanelOpen(true);
  flush();
  expect(root.querySelectorAll("#fleet-table tr.row").length).toBe(2);
  stateEvent(changed("a5", (a) => ({ ...a, tokens: 10 })));

  expect(status.value).toBe("running");
  expect(root.querySelectorAll("#fleet-table tr.row").length).toBe(2);
  expect(root.querySelector<HTMLElement>("#panel")?.hidden).toBe(false);
});

test("an expanded brief and an open <details> stay open through a state update", () => {
  root.querySelector<HTMLButtonElement>('#agent-a2 .expand')?.click();
  flush();
  const detail = root.querySelector("#agent-a2 + tr.detail");
  location.hash = "#decision/g1";
  page.ui.route();
  flush();
  const details = root.querySelector<HTMLDetailsElement>("#dv-answer details.gq-done");

  if (!details) throw new Error("no settled questions");
  details.open = true;
  stateEvent(changed("a2", (a) => ({ ...a, report: "Round 2 done." })));

  expect(root.querySelector("#agent-a2 + tr.detail")).toBe(detail);
  expect(root.querySelector("#dv-answer details.gq-done")).toBe(details);
  expect(details.open).toBe(true);
});

test("a half-written answer on a decision's page survives a state update", () => {
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  const note = root.querySelector<HTMLTextAreaElement>('#dv-answer textarea[name="note"]');
  const pick = root.querySelector<HTMLInputElement>('#dv-answer input[value="b"]');

  if (!note || !pick) throw new Error("no form");
  note.value = "cents everywhere";
  pick.checked = true;
  stateEvent(changed("a2", (a) => ({ ...a, tokens: 5 })));

  expect(root.querySelector('#dv-answer textarea[name="note"]')).toBe(note);
  expect(note.value).toBe("cents everywhere");
  expect(pick.checked).toBe(true);
});

test("a chat message is appended: the conversation's nodes stay, one article is added", () => {
  const articles = [...root.querySelectorAll("#chat-log article.msg")];
  const threads = [...root.querySelectorAll("#chat-log > li")];

  expect(articles.length).toBe(5);
  page.ui.addMessage({ id: 6, at: new Date(NOW).toISOString(), from: "a3", to: ["user"], text: "Key found." }, true);
  flush();

  const now = [...root.querySelectorAll("#chat-log article.msg")];
  expect(now.length).toBe(6);
  articles.forEach((a) => expect(now).toContain(a));
  threads.forEach((t) => expect(t.isConnected).toBe(true));
  expect(now.at(-1)?.textContent).toContain("Key found.");
});

test("a reply joins its thread without rebuilding it", () => {
  const thread = root.querySelector("#chat-log article.msg[data-id='5']")?.closest("li.thread");
  const root5 = root.querySelector("#chat-log article.msg[data-id='5']");
  page.ui.addMessage({ id: 7, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: "On it.", re: 5 }, true);
  flush();

  expect(root.querySelector("#chat-log article.msg[data-id='5']")).toBe(root5 ?? null);
  expect(root.querySelector("#chat-log article.msg[data-id='7']")?.closest("li.thread")).toBe(thread ?? null);
});

/** Type `text` into the composer with the caret at its end. */
async function type(text: string): Promise<HTMLTextAreaElement> {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  say.focus();
  say.value = text;
  say.setSelectionRange(text.length, text.length);
  say.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  flush();

  return say;
}

const listed = (): string[] => [...root.querySelectorAll("#mentions li .m-name")].map((li) => li.textContent ?? "");

const key = (say: HTMLTextAreaElement, k: string): void => {
  say.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  flush();
};

test("a leading / lists the session's skills, narrowed as it is typed", async () => {
  await type("/");
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(false);
  expect(listed()).toEqual(["tstack:tdd", "tstack:research", "deploy"]);
  expect(root.querySelector("#mentions li .faint")?.textContent).toBe("[what to fix]");

  await type("/res");
  expect(listed()).toEqual(["tstack:research"]);
  await type("/dep");
  expect(listed()).toEqual(["deploy"]);
  await type("/zzz");
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(true);
  await type("say /tdd");
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(true);
});

test("arrows move through the skills, Enter or Tab puts one in, Escape closes the list", async () => {
  let say = await type("/tst");
  expect(listed()).toEqual(["tstack:tdd", "tstack:research"]);
  key(say, "ArrowDown");
  expect(root.querySelector('#mentions li[aria-selected="true"] .m-name')?.textContent).toBe("tstack:research");
  key(say, "ArrowDown");
  expect(root.querySelector('#mentions li[aria-selected="true"] .m-name')?.textContent).toBe("tstack:tdd");
  key(say, "ArrowUp");
  key(say, "Enter");
  expect(say.value).toBe("/tstack:research ");
  expect(say.selectionStart).toBe("/tstack:research ".length);
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(true);
  expect(posted.filter((p) => p.url === "chat")).toEqual([]);

  say = await type("/de");
  key(say, "Tab");
  expect(say.value).toBe("/deploy ");

  say = await type("/t");
  key(say, "Escape");
  expect(root.querySelector<HTMLElement>("#mentions")?.hidden).toBe(true);
});

test("a /command is sent as typed, arguments and all; an unknown one too", async () => {
  let say = await type("/tst");
  key(say, "Enter");
  say.value += "fix the parser";
  say.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  key(say, "Enter");
  await new Promise((r) => setTimeout(r, 0));
  flush();

  const sent = chatPosts();
  expect(sent).toEqual([{ text: "/tstack:tdd fix the parser" }]);
  expect(say.value).toBe("");
  expect(root.querySelector("#chat-log article.msg[data-id='99'] .msg-text")?.textContent).toBe("/tstack:tdd fix the parser");

  say = await type("/not-a-skill now");
  key(say, "Enter");
  await new Promise((r) => setTimeout(r, 0));
  expect(chatPosts().map((p) => p.text)).toContain("/not-a-skill now");
});

test("the notification settings sit behind the gear, folded into one line, and the choice is kept", () => {
  page.ui.setPanelOpen(true);
  flush();
  expect(root.querySelector("#n-prefs")).toBeNull();
  expect(root.querySelector("#n-summary")?.textContent).toBe("to me · sound important · toasts all · alerts off");
  root.querySelector<HTMLButtonElement>("#n-gear")?.click();
  flush();
  expect(root.querySelector("#n-prefs")).not.toBeNull();
  expect(localStorage.getItem("fleet:/f/billing/n-settings-open")).toBe("true");
  root.querySelector<HTMLButtonElement>('#n-prefs [aria-label="Sound"] button:first-child')?.click();
  flush();
  expect(localStorage.getItem("fleet:/f/billing/n-sound")).toBe(JSON.stringify("off"));
  expect(root.querySelector("#bell")?.classList.contains("muted")).toBe(true);
});
