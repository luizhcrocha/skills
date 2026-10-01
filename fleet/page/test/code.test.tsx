/**
 * Code in the page's text (happy-dom, through the stream's own handlers): a `--manual` in the format shows
 * its prose apart from its command, an old one-command `--manual` is one sh block and an old sentence stays
 * as it was; each block copies exactly its own text, by the clipboard or by selecting it; a block keeps its
 * node through a state update that does not change it; a chat message's code, mentions, and text that looks
 * like HTML.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { agentsOf, codeChat, codeView, LEGACY_MANUAL, type Message } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const MODAL = "with-env {…} { modal volume delete -y cr-lab-hf-cache; modal volume list }";

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

/** What the page wrote to the clipboard. */
let clipboard: string[] = [];

/** Whether the page may use the clipboard, as a secure context may. */
let secure = true;

/** What `document.execCommand("copy")` copied: the selection at that moment. */
let execCopied: string[] = [];

const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  clipboard = [];
  execCopied = [];
  secure = true;
  Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => secure });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    get: () => ({
      writeText: async (text: string) => {
        clipboard.push(text);
      },
    }),
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (cmd: string) => {
      if (cmd !== "copy") return false;
      execCopied.push(String(getSelection() ?? ""));

      return true;
    },
  });
  // SAFETY: the stub answers the calls the page makes with `fetch`; nothing else of `typeof fetch` is used.
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 404 })) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(codeView(NOW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();

  for (const m of codeChat(NOW)) page.ui.addMessage(wire(m), false);
  page.m.setConn("live");
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

/** Open decision `id`'s page. */
function open(id: string): void {
  location.hash = "#decision/" + id;
  page.ui.route();
  flush();
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("Luiz's Modal example: the prose in paragraphs, the command alone in a nu block with its label", () => {
  open("a8");
  const rich = root.querySelector("#dv-answer .manual-rich");
  const paras = [...(rich?.querySelectorAll(":scope > p") ?? [])].map((p) => p.textContent);
  const block = rich?.querySelector("figure.code");

  expect(paras).toEqual(["From the repo's devenv shell (modal is on its PATH), in nushell:", "The list afterwards should not show cr-lab-hf-cache."]);
  expect(rich?.querySelector(":scope > p code.ic")?.textContent).toBe("cr-lab-hf-cache");
  expect(block?.getAttribute("data-lang")).toBe("nu");
  expect(block?.querySelector(".code-lang")?.textContent).toBe("nu");
  expect(block?.querySelector("pre code")?.textContent).toBe(MODAL);
  expect([...(block?.querySelectorAll("pre code span") ?? [])].map((s) => `${s.className}:${String(s.textContent)}`)).toContain("t-attr:-y");
  expect(block?.querySelector(".code-wrap")?.getAttribute("aria-pressed")).toBe("false");
  expect(block?.querySelector("pre")?.classList.contains("wrap")).toBe(false);
});

test("an old one-command --manual is one sh block; an old sentence is shown as it always was", () => {
  open("a9");
  expect(root.querySelector("#dv-answer figure.code")?.getAttribute("data-lang")).toBe("sh");
  expect(root.querySelector("#dv-answer figure.code pre code")?.textContent).toBe(LEGACY_MANUAL);

  open("a10");
  expect(root.querySelector("#dv-answer figure.code")).toBeNull();
  expect(root.querySelector("#dv-answer pre.manual")?.textContent).toBe("Open the Stripe dashboard, Developers, Webhooks, and roll the secret.");
});

test("Copy writes exactly the block's text to the clipboard, and says Copied for a moment", async () => {
  open("a8");
  const button = root.querySelector<HTMLButtonElement>("#dv-answer .code-copy");
  button?.click();
  await tick();
  flush();

  expect(clipboard).toEqual([MODAL]);
  expect(button?.textContent).toBe("Copied");
  expect(execCopied).toEqual([]);
});

test("without the clipboard (plain http), Copy selects the block's code and copies the selection", async () => {
  secure = false;
  open("a8");
  root.querySelector<HTMLButtonElement>("#dv-answer .code-copy")?.click();
  await tick();
  flush();

  expect(clipboard).toEqual([]);
  expect(execCopied).toEqual([MODAL]);
  expect(String(getSelection())).toBe(MODAL);
});

test("each block has its own button, and copies its own text", async () => {
  open("a8");
  const blocks = [...root.querySelectorAll("figure.code")];
  const roadblock = [...root.querySelectorAll("#roadblock-list figure.code")];

  expect(blocks.length).toBeGreaterThan(1);
  expect(roadblock.length).toBe(1);
  roadblock[0]?.querySelector<HTMLButtonElement>(".code-copy")?.click();
  await tick();
  expect(clipboard).toEqual(["modal volume list | where name =~ hf"]);
});

test("a block keeps its node, its wrap switch and its Copied through a state update that leaves it as it was", async () => {
  open("a8");
  const block = root.querySelector("#dv-answer figure.code");
  block?.querySelector<HTMLButtonElement>(".code-wrap")?.click();
  block?.querySelector<HTMLButtonElement>(".code-copy")?.click();
  await tick();
  flush();
  const view = codeView(NOW);
  page.m.takeState(JSON.stringify({ ...view, agents: agentsOf(view).map((a) => (a["id"] === "a2" ? { ...a, tokens: 1 } : a)) }));
  flush();

  expect(root.querySelector("#dv-answer figure.code")).toBe(block ?? null);
  expect(block?.querySelector("pre")?.classList.contains("wrap")).toBe(true);
  expect(block?.querySelector(".code-copy")?.textContent).toBe("Copied");
});

test("a chat message's code is a block in the bubble; its mentions stay chips; text that looks like HTML stays text", () => {
  const code = root.querySelector('#chat-log article[data-id="6"] figure.code');
  const html = root.querySelector('#chat-log article[data-id="7"] .msg-text');

  expect(code?.querySelector("pre code")?.textContent).toBe("modal volume list | where name =~ hf | get name");
  expect(root.querySelector('#chat-log article[data-id="6"] p code.ic')?.textContent).toBe("modal volume list");
  expect(root.querySelector('#chat-log article[data-id="3"] .mention')?.textContent).toBe("@invoice-gen");
  expect(root.querySelector('#chat-log article[data-id="3"] .msg-text')?.textContent).toBe("@invoice-gen keep the totals in cents");
  expect(html?.textContent).toBe("<b>not bold</b> and <script>alert(1)</script>");
  expect(html?.querySelector("b, script")).toBeNull();
});
