/**
 * The most a message can be: every composer that posts to `chat` (the chat's, a side chat's, a decision's
 * answer, a grilling's) weighs the JSON body it would send against the limit the stream's `hello` gave
 * (`max_bytes`), and over it says so on its own error line and keeps the text, sending nothing; a 413 from
 * the server shows the server's words the same way. The box on a fleet's decision in the manager's frame
 * is `embed.test.tsx`'s.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorChat, coordinatorView, type Message } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const LIMIT = 256 * 1024;

/** 299,000 bytes of text: over the limit, as Luiz's 78 KB was over the old one; with the body around it, 293 KiB. */
const LONG = "x".repeat(299_000);

const TOO_BIG = (kib: number): string => `This message is ${kib} KiB; the most a message can be is 256 KiB. Shorten it, or put the long part in a file and give its path.`;

const SERVER_SAYS = TOO_BIG(293);

const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

/** The bodies posted to `chat`. */
const posted: string[] = [];

/** What `chat` answers: taken, or the server's 413. */
let answer: "taken" | "too big" = "taken";

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted.length = 0;
  answer = "taken";
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "chat") {
      posted.push(String(init?.body));

      if (answer === "too big") return new Response(JSON.stringify({ error: SERVER_SAYS }), { status: 413 });
      const body: { text: string } = JSON.parse(String(init?.body));

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
  page.m.setConn("live");
  page.m.setMaxBytes(LIMIT);
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

/** Type `text` into `field` as the viewer does. */
function typeIn(field: HTMLTextAreaElement, text: string): void {
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function field(selector: string): HTMLTextAreaElement {
  const el = root.querySelector<HTMLTextAreaElement>(selector);

  if (!el) throw new Error("no " + selector);

  return el;
}

/** The chat's composer: write `text` (in a new side chat when `side`) and press Enter. */
async function sendInChat(text: string, side = false): Promise<HTMLTextAreaElement> {
  if (side) page.m.setFocus("new");
  flush();
  const say = field("#say");
  typeIn(say, text);
  say.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();

  return say;
}

const chatError = (): string => (root.querySelector<HTMLElement>("#chat-error")?.hidden ? "" : (root.querySelector("#chat-error")?.textContent ?? ""));

/** A decision's answer: a choice and `text` as its note, sent. */
async function answerD1(text: string): Promise<HTMLTextAreaElement> {
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  const choice = root.querySelector<HTMLInputElement>('#dv-answer input[name="choice"]');

  if (choice) choice.checked = true;
  const note = field('#dv-answer textarea[name="note"]');
  typeIn(note, text);
  root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit();
  await settle();

  return note;
}

/** A grilling's first question answered with `text` as the viewer's own, sent. */
async function answerG1(text: string): Promise<HTMLTextAreaElement> {
  location.hash = "#decision/g1";
  page.ui.route();
  flush();
  const own = field('#dv-answer textarea[name="q1-text"]');
  typeIn(own, text);
  root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit();
  await settle();

  return own;
}

const formError = (): string => (root.querySelector<HTMLElement>("#dv-error")?.hidden ? "" : (root.querySelector("#dv-error")?.textContent ?? ""));

test("a chat message over the limit is not sent: the composer says how big it is, and keeps it", async () => {
  const say = await sendInChat(LONG);
  expect(posted).toEqual([]);
  expect(chatError()).toBe(TOO_BIG(293));
  expect(say.value).toBe(LONG);
  const draft = Object.keys(localStorage).find((k) => k.endsWith("chat-draft"));
  expect(JSON.parse(localStorage.getItem(draft ?? "") ?? "null")).toBe(LONG);
});

test("a side chat's message over the limit is not sent, and stays in the composer", async () => {
  const say = await sendInChat(LONG, true);
  expect(posted).toEqual([]);
  expect(chatError()).toBe(TOO_BIG(293));
  expect(say.value).toBe(LONG);
});

test("a message under the limit is sent as before, a 78 KB one too", async () => {
  const say = await sendInChat("y".repeat(78_000));
  expect(posted.length).toBe(1);
  expect(chatError()).toBe("");
  expect(say.value).toBe("");
});

test("the weight is the body's UTF-8 bytes, not its characters", async () => {
  /* 99,700 characters of three bytes each: 299,100 bytes. */
  const say = await sendInChat("€".repeat(99_700));
  expect(posted).toEqual([]);
  expect(chatError()).toBe(TOO_BIG(293));
  expect(say.value.length).toBe(99_700);
});

test("with no limit from the server (no hello yet) the page sends, and the server's 413 shows on the composer", async () => {
  page.m.setMaxBytes(undefined);
  answer = "too big";
  const say = await sendInChat(LONG);
  expect(posted.length).toBe(1);
  expect(chatError()).toBe(SERVER_SAYS);
  expect(say.value).toBe(LONG);
});

test("a decision's answer over the limit is not sent: its form says so and keeps the note", async () => {
  const note = await answerD1(LONG);
  expect(posted).toEqual([]);
  expect(formError()).toBe(TOO_BIG(293));
  expect(note.value).toBe(LONG);
});

test("a decision's answer the server refuses as too big shows the server's words and keeps the note", async () => {
  answer = "too big";
  const note = await answerD1("short");
  expect(posted.length).toBe(1);
  expect(formError()).toBe(SERVER_SAYS);
  expect(note.value).toBe("short");
});

test("a grilling's answer over the limit is not sent: its form says so and keeps the answer", async () => {
  const own = await answerG1(LONG);
  expect(posted).toEqual([]);
  expect(formError()).toBe(TOO_BIG(293));
  expect(own.value).toBe(LONG);
});

test("a grilling's answer the server refuses as too big shows the server's words", async () => {
  answer = "too big";
  const own = await answerG1("my own answer");
  expect(posted.length).toBe(1);
  expect(formError()).toBe(SERVER_SAYS);
  expect(own.value).toBe("my own answer");
});
