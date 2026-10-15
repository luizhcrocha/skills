/**
 * An image pasted into the chat's composer or a decision's answer (happy-dom): uploaded to the hub's
 * `attachments` with the page token, shown under the field until sent, sent as the message's `images`, and shown
 * in the message as a thumbnail that opens full size.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { pastedImages, type Carried } from "../src/attach.ts";
import { inboxOpener } from "../src/BatchCard.tsx";
import { draftsKey } from "../src/marks.ts";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { chatConversation, chatView, type Message } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

beforeAll(() => setSystemTime(new Date(NOW)));

afterAll(() => setSystemTime());

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

/** Each request the page made: where, its headers and its body. */
let sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];

const PATH = "attachments/0123456789abcdef.png";

/** The path the stub hub gives the i-th upload: the first is PATH, each later one its own. */
const pathOf = (i: number): string => (i === 0 ? PATH : `attachments/${i.toString(16).padStart(16, "a")}.png`);

/** Uploads so far, and a promise each upload waits on before it is answered (a test holds them). */
let uploads = 0;

let held: Promise<void> | null = null;

/** Whether the stub hub refuses an upload for a stale page token, as it does after it replaced the token. */
let stale = false;

const STALE = "the page token is missing or stale: reload the fleet's page and answer again";

/** A chat post's body, as the stub hub reads it. */
interface ChatBody {
  readonly text?: Json;
  readonly images?: Json;
  readonly marks?: Json;
  readonly side?: Json;
  readonly quote?: Json;
  readonly opens?: Json;
}

/** How the stub hub answers the n-th chat post (from 0), when a test says; else it stores it as #99. */
let chatReply: ((n: number, body: ChatBody) => Response) | null = null;

let chats = 0;

const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  sent = [];
  uploads = 0;
  held = null;
  stale = false;
  chatReply = null;
  chats = 0;
  document.head.querySelector('meta[name="fleet-page-token"]')?.remove();
  const meta = document.createElement("meta");
  meta.name = "fleet-page-token";
  meta.content = "tok";
  document.head.append(meta);
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body });

    if (url === "attachments") {
      const i = uploads++;

      if (held) await held;

      if (stale) return new Response(JSON.stringify({ error: STALE, reload: true }), { status: 403 });

      return new Response(JSON.stringify({ path: pathOf(i) }), { status: 201 });
    }

    if (url === "chat" && init?.method === "POST") {
      const body: ChatBody = JSON.parse(String(init.body));
      const n = chats++;

      if (chatReply) return chatReply(n, body);

      return new Response(JSON.stringify({ id: 99, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, re: null, parts: [{ text: body.text }], images: body.images, marks: body.marks }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  mount();
});

/** Render the page, with the chat's conversation, live. */
function mount(): void {
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(chatView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of chatConversation(NOW)) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
}

afterEach(() => {
  dispose();
  root.remove();
  history.replaceState(null, "", "/f/billing/");
});

/** A paste of `files` (and `text`) on `el`, as a browser sends it. */
function paste(el: Element, files: File[], text = ""): Event {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  const data = { getData: (t: string) => (t === "text/plain" ? text : ""), items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), files };
  Object.defineProperty(e, "clipboardData", { value: data });
  el.dispatchEvent(e);

  return e;
}

const png = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "image.png", { type: "image/png" });

/** Let the uploads' promises settle, then Solid's updates. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

test("pastedImages takes a paste's image files, and none when it carries text (an office app's picture of its text)", () => {
  const f = png();
  const data = (text: string): Carried => ({ getData: () => text, items: [{ kind: "file", type: "image/png", getAsFile: () => f }], files: [] });
  expect(pastedImages(data(""))).toEqual([f]);
  expect(pastedImages(data("words"))).toEqual([]);
  expect(pastedImages(null)).toEqual([]);
});

test("an image pasted into the composer is uploaded with the page token, shown under it, and sent as the message's images", async () => {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  const e = paste(say, [png()]);
  expect(e.defaultPrevented).toBe(true);
  await settle();
  const upload = sent.find((s) => s.url === "attachments");
  expect(upload?.headers).toEqual({ "content-type": "image/png", "x-fleet-page-token": "tok" });
  expect(root.querySelector("#say-images img")?.getAttribute("src")).toBe(PATH);
  expect(root.querySelector<HTMLButtonElement>("#send")?.disabled).toBe(false);

  page.ui.send();
  await settle();
  const post = sent.find((s) => s.url === "chat");
  expect(JSON.parse(String(post?.body))).toEqual({ text: "", images: [PATH] });
  expect(root.querySelector("#say-images img")).toBeNull();
  const shown = root.querySelector('article.msg[data-id="99"] .msg-images a');
  expect([shown?.getAttribute("href"), shown?.getAttribute("target"), shown?.querySelector("img")?.getAttribute("src")]).toEqual([PATH, "_blank", PATH]);
});

test("a paste of text is the browser's; a refused image says why under the composer and sends nothing", async () => {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  expect(paste(say, [png()], "words").defaultPrevented).toBe(false);
  const svg = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
  expect(paste(say, [svg]).defaultPrevented).toBe(true);
  await settle();
  expect(sent.filter((s) => s.url === "attachments")).toEqual([]);
  expect(root.querySelector("#say-images .attach-error")?.textContent).toBe("Only a PNG, JPEG, WebP or GIF image can be attached.");
  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
  paste(say, [big]);
  await settle();
  expect(root.querySelector("#say-images .attach-error")?.textContent).toBe("This image is 10241 KiB; the most an image can be is 10 MB.");
  expect(sent.filter((s) => s.url === "attachments")).toEqual([]);
});

test("the attach button takes an image from a file picker, for a phone whose paste gives no file", async () => {
  const input = root.querySelector<HTMLInputElement>("#say-attach input[type=file]");
  expect(input?.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp,image/gif");
  Object.defineProperty(input, "files", { value: [png()], configurable: true });
  input?.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(root.querySelector("#say-images img")?.getAttribute("src")).toBe(PATH);
});

test("an image pasted into a decision's answer note rides with the answer", async () => {
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  const note = root.querySelector<HTMLTextAreaElement>('#dv-answer textarea[name="note"]');

  if (!note) throw new Error("no answer note");
  paste(note, [png()]);
  await settle();
  expect(note.closest("form")?.querySelector(".attach-tray img")?.getAttribute("src")).toBe(PATH);
  note.closest("form")?.querySelector<HTMLInputElement>('input[name="choice"]')?.click();
  note.value = "see the screen";
  note.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  const post = sent.find((s) => s.url === "chat");
  const body: { readonly images?: Json } = JSON.parse(String(post?.body));
  expect(body.images).toEqual([PATH]);
});

/** Count the page's reloads while `act` runs, instead of reloading the test's window. */
async function reloadsIn(act: () => Promise<void>): Promise<number> {
  let reloads = 0;
  Object.defineProperty(location, "reload", { value: () => void (reloads += 1), configurable: true });

  try {
    await act();
  } finally {
    Reflect.deleteProperty(location, "reload");
  }

  return reloads;
}

test("an image refused for a stale page token shows the answer form's Reload under the composer, which keeps the draft and loads the page again", async () => {
  stale = true;
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  say.value = "look at this";
  say.dispatchEvent(new Event("input", { bubbles: true }));
  paste(say, [png()]);
  await settle();
  expect(root.querySelector("#say-images .attach-error")?.firstChild?.textContent).toBe(STALE);
  const button = root.querySelector<HTMLButtonElement>("#say-images .attach-error button.dv-reload");
  expect(button?.textContent).toBe("Reload");
  expect(await reloadsIn(async () => button?.click())).toBe(1);
  expect(localStorage.getItem("fleet:/f/billing/chat-draft")).toBe(JSON.stringify("look at this"));

  // Another image, taken, clears the refusal and its Reload.
  stale = false;
  paste(say, [png()]);
  await settle();
  expect([root.querySelector("#say-images .attach-error")?.hasAttribute("hidden"), root.querySelector("#say-images .dv-reload")]).toEqual([true, null]);
});

test("an image refused for a stale page token in a decision's answer: its Reload saves the answer's draft first", async () => {
  stale = true;
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  const note = root.querySelector<HTMLTextAreaElement>('#dv-answer textarea[name="note"]');

  if (!note) throw new Error("no answer note");
  note.value = "the second screen";
  paste(note, [png()]);
  await settle();
  const button = note.closest("form")?.querySelector<HTMLButtonElement>(".attach-tray .dv-reload");
  expect(button?.textContent).toBe("Reload");
  expect(await reloadsIn(async () => button?.click())).toBe(1);
  const draft = Object.keys(localStorage).find((k) => k.startsWith("fleet:/f/billing/dv-draft:d1:"));
  expect(JSON.parse(localStorage.getItem(draft ?? "") ?? "{}")).toMatchObject({ note: "the second screen" });
});

test("an image refused for another reason shows no Reload", async () => {
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  paste(say, [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })]);
  await settle();
  expect([root.querySelector("#say-images .attach-error")?.textContent, root.querySelector("#say-images .dv-reload")]).toEqual(["Only a PNG, JPEG, WebP or GIF image can be attached.", null]);
});

/** Open the decision's inbox on thread `key`, as a tap on its row does. */
function openThread(key: string): void {
  inboxOpener.current?.("#decision/d1", null);
  flush();
  root.querySelector<HTMLButtonElement>(`#mk-threads .mk-row[data-thread="${key}"]`)?.click();
  flush();
}

/** The batch a send of the decision's marks posted: each item's number, comment and images. */
function sentItems(): Json[] {
  const post = sent.find((s) => s.url === "chat");
  const body: { readonly marks?: { readonly items?: readonly { readonly n?: Json; readonly comment?: Json; readonly images?: Json }[] } } = JSON.parse(String(post?.body ?? "{}"));

  return (body.marks?.items ?? []).map((i) => [i.n ?? null, i.comment ?? null, i.images ?? null]);
}

test("an image pasted into a decision's thread box goes with its message, on its item in the batch", async () => {
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  openThread("page");
  const box = root.querySelector<HTMLTextAreaElement>("#mk-box");

  if (!box) throw new Error("no thread box");
  expect(paste(box, [png()]).defaultPrevented).toBe(true);
  await settle();
  expect(root.querySelector("#mk-box-images img")?.getAttribute("src")).toBe(PATH);
  expect(root.querySelector("#mk-box-attach input[type=file]")).not.toBeNull();
  box.value = "this screen";
  root.querySelector<HTMLButtonElement>("#mk-box-now")?.click();
  await settle();
  expect(sentItems()).toEqual([[1, "this screen", [PATH]]]);
  expect(root.querySelector("#mk-box-images img")).toBeNull();
});

test("an image pasted into a comment's box goes with the comment, and editing the comment keeps it", async () => {
  /* The page is served at /f/billing/: its drafts are kept under that fleet. */
  localStorage.setItem(draftsKey("billing", "d1"), JSON.stringify({ items: [{ n: 1, kind: "general", comment: "see this" }], msgs: [] }));
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  openThread("m:1");
  root.querySelector<HTMLButtonElement>("#mk-panel .mk-edit")?.click();
  flush();
  const text = root.querySelector<HTMLTextAreaElement>("#mk-text");

  if (!text) throw new Error("no comment box");
  expect(text.value).toBe("see this");
  expect(paste(text, [png()]).defaultPrevented).toBe(true);
  await settle();
  expect(root.querySelector("#mk-text-images img")?.getAttribute("src")).toBe(PATH);
  expect(root.querySelector("#mk-text-attach input[type=file]")).not.toBeNull();
  root.querySelector<HTMLButtonElement>("#mk-save")?.click();
  flush();
  openThread("m:1");
  root.querySelector<HTMLButtonElement>("#mk-panel .mk-edit")?.click();
  flush();
  expect(root.querySelector("#mk-text-images img")?.getAttribute("src")).toBe(PATH);
  root.querySelector<HTMLButtonElement>("#mk-sendnow")?.click();
  await settle();
  expect(sentItems()).toEqual([[1, "see this", [PATH]]]);
  expect(root.querySelector('article.msg[data-id="99"] .batch-card .msg-images img')?.getAttribute("src")).toBe(PATH);
});

test("a reply in a waiting comment's thread takes no more images than the comment has room for: the 9th is refused with a plain message", async () => {
  const seven = Array.from({ length: 7 }, (_, i) => `attachments/${"b".repeat(15)}${String(i)}.png`);
  localStorage.setItem(draftsKey("billing", "d1"), JSON.stringify({ items: [{ n: 1, kind: "general", comment: "see this", images: seven }], msgs: [] }));
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  openThread("m:1");
  const box = root.querySelector<HTMLTextAreaElement>("#mk-box");

  if (!box) throw new Error("no thread box");
  paste(box, [png(), png()]);
  await settle();
  expect([...root.querySelectorAll("#mk-box-images img")].map((i) => i.getAttribute("src"))).toEqual([PATH]);
  expect(root.querySelector("#mk-box-images .attach-error")?.textContent).toBe("8 images at most go together; 7 are there already.");
  expect(uploads).toBe(1);
  box.value = "and this";
  root.querySelector<HTMLButtonElement>("#mk-box-now")?.click();
  await settle();
  expect(sentItems()).toEqual([[1, "see this\nand this", [...seven, PATH]]]);
});

test("an upload still running when the thread changes lands in no thread", async () => {
  localStorage.setItem(draftsKey("billing", "d1"), JSON.stringify({ items: [{ n: 1, kind: "general", comment: "see this" }], msgs: [] }));
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  openThread("page");
  const box = root.querySelector<HTMLTextAreaElement>("#mk-box");

  if (!box) throw new Error("no thread box");
  let answer = (): void => undefined;
  held = new Promise((r) => (answer = r));
  paste(box, [png()]);
  await settle();
  expect(root.querySelector("#mk-box-images .attach-busy")).not.toBeNull();
  openThread("m:1");
  answer();
  await settle();
  expect([root.querySelector("#mk-box-images img") === null, root.querySelector("#mk-box-images .attach-busy") === null]).toEqual([true, true]);
  openThread("page");
  await settle();
  expect(root.querySelector("#mk-box-images img") === null).toBe(true);
});

test("on a peer hub's fleet the page has no attach button, and a paste of an image is the browser's", async () => {
  dispose();
  root.remove();
  history.replaceState(null, "", "/f/billing@box/");
  mount();
  const say = root.querySelector<HTMLTextAreaElement>("#say");

  if (!say) throw new Error("no composer");
  expect([root.querySelector("#say-attach") === null, root.querySelector(".attach-btn") === null]).toEqual([true, true]);
  expect(paste(say, [png()]).defaultPrevented).toBe(false);
  await settle();
  expect(sent.filter((s) => s.url === "attachments")).toEqual([]);
});

test("the attach control is a button a keyboard reaches, and it opens the file picker", () => {
  const button = root.querySelector<HTMLButtonElement>("#say-attach button");
  const input = root.querySelector<HTMLInputElement>("#say-attach input[type=file]");

  if (!button || !input) throw new Error("no attach button");
  let picked = 0;
  input.click = () => {
    picked++;
  };

  expect([button.type, button.disabled, button.getAttribute("aria-label"), input.tabIndex]).toEqual(["button", false, "Attach an image", -1]);
  button.click();
  expect(picked).toBe(1);
});

test("an image may stand in for a comment's words: saved and sent with no comment", async () => {
  localStorage.setItem(draftsKey("billing", "d1"), JSON.stringify({ items: [{ n: 1, kind: "general", comment: "see this" }], msgs: [] }));
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  openThread("m:1");
  root.querySelector<HTMLButtonElement>("#mk-panel .mk-edit")?.click();
  flush();
  const text = root.querySelector<HTMLTextAreaElement>("#mk-text");

  if (!text) throw new Error("no comment box");
  text.value = "";
  text.dispatchEvent(new Event("input", { bubbles: true }));
  paste(text, [png()]);
  await settle();
  root.querySelector<HTMLButtonElement>("#mk-sendnow")?.click();
  await settle();
  expect(root.querySelector("#mk-composer .mk-problem")?.textContent ?? "").toBe("");
  expect(sentItems()).toEqual([[1, null, [PATH]]]);
});

test("an image may stand in for a reply's words in a thread box", async () => {
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  openThread("page");
  const box = root.querySelector<HTMLTextAreaElement>("#mk-box");

  if (!box) throw new Error("no thread box");
  paste(box, [png()]);
  await settle();
  root.querySelector<HTMLButtonElement>("#mk-box-now")?.click();
  await settle();
  expect(sentItems()).toEqual([[1, null, [PATH]]]);
});

test("images added to one field in separate pastes stop at 8: the 9th is refused", async () => {
  const composer = root.querySelector<HTMLTextAreaElement>("#say");

  if (!composer) throw new Error("no composer");
  paste(composer, [png(), png(), png(), png(), png()]);
  await settle();
  paste(composer, [png(), png(), png(), png()]);
  await settle();
  expect([root.querySelectorAll("#say-images img").length, uploads]).toEqual([8, 8]);
  expect(root.querySelector("#say-images .attach-error")?.textContent).toBe("8 images at most go together.");
});

/** A new side chat on decision d1's words, as a waiting message names it. */
const NEW_SIDE = { _tag: "new", key: "n1", quote: { text: "Stripe rounds on the total", from: "D1 Rounding rule for totals" } };

/** A new side chat's words waiting on decision d1, in two posts' worth of images (6 and 6, 12 in all). */
const twoRuns = (): string => {
  const imgs = (from: number): string[] => Array.from({ length: 6 }, (_, i) => `attachments/${(from + i).toString(16).padStart(16, "c")}.png`);

  return JSON.stringify({ items: [], msgs: [{ key: "k1", to: NEW_SIDE, text: "first", images: imgs(0) }, { key: "k2", to: NEW_SIDE, text: "second", images: imgs(6) }] });
};

/** Each chat post's side chat, quote and open key, in order. */
const chatPosts = (): Json[] =>
  sent.flatMap((s) => {
    if (s.url !== "chat") return [];
    const body: ChatBody = JSON.parse(String(s.body));

    return [[body.side ?? null, body.quote === undefined ? null : "quote", body.opens ?? null]];
  });

/** Where the waiting words of decision d1 go now, by key. */
const waiting = (): Json[] => {
  const kept: { readonly msgs?: readonly { readonly key: string; readonly to: Json }[] } = JSON.parse(localStorage.getItem(draftsKey("billing", "d1")) ?? "{}");

  return (kept.msgs ?? []).map((m) => [m.key, m.to]);
};

/** The side chats the stub hub opened, by open key, how many it opened, and what it stored: each post's side chat and words. */
let opened = new Map<string, number>();

let opens = 0;

let stored: Json[] = [];

/** A stub hub that keeps a side chat's open key as the hub does: a post with `side: "new"` opens side chat 120 (the next
 * one 121, …), unless a post with its open key opened one: it joins that. Post `lose` is stored, but its answer never
 * reaches the page. */
const joining =
  (lose = -1) =>
  (n: number, body: ChatBody): Response => {
    const key = body.opens === undefined ? "" : String(body.opens);
    const side = body.side === "new" ? (opened.get(key) ?? 120 + opens++) : Number(body.side);

    if (body.side === "new" && key) opened.set(key, side);
    stored.push([side, body.text ?? null]);

    if (n === lose) throw new TypeError("Failed to fetch");

    return new Response(JSON.stringify({ id: 200 + n, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text ?? "", side }), { status: 201 });
  };

/** Open decision d1 with `words` waiting, the stub hub keeping side chats by open key. */
const openD1 = (words: string, lose = -1): void => {
  opened = new Map();
  opens = 0;
  stored = [];
  localStorage.setItem(draftsKey("billing", "d1"), words);
  location.hash = "#decision/d1";
  page.ui.route();
  flush();
  chatReply = joining(lose);
};

test("closing the tab with more than 8 images waiting in a new side chat sends every run at once, with its open key, and the hub joins them into one side chat", async () => {
  openD1(twoRuns());
  Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });

  try {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await settle();
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }

  expect(chatPosts()).toEqual([
    ["new", "quote", "n1"],
    ["new", "quote", "n1"],
  ]);
  expect(stored).toEqual([
    [120, "first"],
    [120, "second"],
  ]);
  expect(waiting()).toEqual([]);
  expect(root.querySelector("#mk-card")?.textContent).toContain("Sent: 2 to billing (you left the page).");
});

test("words left waiting for a new side chat, on a reload days later, join the side chat their key opened", async () => {
  openD1(JSON.stringify({ items: [], msgs: [{ key: "k2", to: NEW_SIDE, text: "second" }] }));
  opened.set("n1", 120);
  root.querySelector<HTMLButtonElement>("#mk-now")?.click();
  await settle();
  expect(chatPosts()).toEqual([["new", "quote", "n1"]]);
  expect(stored).toEqual([[120, "second"]]);
  expect(waiting()).toEqual([]);
});

test("a retry after the opener's answer was lost joins the side chat it opened, and the toast counts only what was sent", async () => {
  openD1(twoRuns(), 0);
  root.querySelector<HTMLButtonElement>("#mk-now")?.click();
  await settle();
  expect(chatPosts()).toEqual([["new", "quote", "n1"]]);
  expect(waiting()).toEqual([
    ["k1", NEW_SIDE],
    ["k2", NEW_SIDE],
  ]);
  expect(root.querySelector("#mk-card")?.textContent).not.toContain("Sent:");
  root.querySelector<HTMLButtonElement>("#mk-now")?.click();
  await settle();
  expect(chatPosts()).toEqual([
    ["new", "quote", "n1"],
    ["new", "quote", "n1"],
    ["new", "quote", "n1"],
  ]);
  /* The first try was stored before its answer was lost: its words are there twice, in the one side chat. */
  expect(stored).toEqual([
    [120, "first"],
    [120, "first"],
    [120, "second"],
  ]);
  expect(waiting()).toEqual([]);
});

test("a run that failed after the side chat opened waits in that side chat, and its retry goes there", async () => {
  openD1(twoRuns());
  chatReply = (n, body) => (n === 0 ? joining()(n, body) : new Response(JSON.stringify({ error: "busy" }), { status: 503 }));
  root.querySelector<HTMLButtonElement>("#mk-now")?.click();
  await settle();
  expect(chatPosts()).toEqual([
    ["new", "quote", "n1"],
    ["new", "quote", "n1"],
  ]);
  expect(waiting()).toEqual([["k2", { _tag: "side", id: 120 }]]);
  expect(root.querySelector("#mk-card")?.textContent).toContain("Sent: 1 to billing.");
  chatReply = joining();
  root.querySelector<HTMLButtonElement>("#mk-now")?.click();
  await settle();
  expect(chatPosts().at(-1)).toEqual([120, null, null]);
  expect(stored).toEqual([
    [120, "first"],
    [120, "second"],
  ]);
  expect(waiting()).toEqual([]);
});
