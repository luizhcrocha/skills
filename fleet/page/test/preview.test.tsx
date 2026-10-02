/**
 * The fleet's live preview on the page (`fleet preview`): the Fleet view's block with the address, a box per
 * worker's workspace that posts `preview-workers` to take it in or out (and goes back when the hub refuses),
 * the conflicts with who touches each file, the dev server's build error; the Links view's entries; and a
 * state without a preview shows none. Run in happy-dom, through `takeState`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type View } from "./fixtures.ts";

const NOW = Date.now();

/** a4's own preview. */
const OWN: View = { worker: "a4", url: "preview/a4/", address: "https://box.tail.ts.net:7443/f/billing/preview/a4/", running: true, up: false, port: 5174, log: null };

const PREVIEW: View = {
  url: "preview/",
  address: "https://box.tail.ts.net:7443/f/billing/preview/",
  running: true,
  up: true,
  port: 5173,
  log: null,
  updater: true,
  every: 3,
  workers: [
    { id: "a2", name: "invoice-gen", status: "running", included: true, commit: "0123456789ab", change: "qkzwlnvo" },
    { id: "a4", name: "notes-impl", status: "running", included: false, commit: null, change: null },
  ],
  conflicts: [],
  error: null,
  updated: new Date(NOW - 60_000).toISOString(),
  per_worker: [OWN],
};

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

let posted: { url: string; body: string }[];

let answer: Response;

/** The fixture's fleet with this preview, or with none. */
function withPreview(preview: View | null): View {
  const view = coordinatorView(NOW);

  return preview === null ? view : { ...view, preview };
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "#fleet";
  posted = [];
  answer = new Response(JSON.stringify({ include: [], exclude: ["a2"] }), { status: 200 });
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a preview choice (recorded), anything else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "preview-workers") {
      posted.push({ url, body: String(init?.body) });

      return answer;
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(withPreview(PREVIEW));

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  flush();
});

afterEach(() => {
  dispose();
  root.remove();
});

const box = (worker: string): HTMLInputElement | null => root.querySelector(`#preview-workers input[data-worker="${worker}"]`);

test("the Fleet view's block: the address, a box per worker's workspace, who is merged", () => {
  const part = root.querySelector("#fleet #preview");
  expect(part?.querySelector("h2")?.textContent).toBe("Preview");
  expect(root.querySelector("#preview-link")?.getAttribute("href")).toBe("preview/");
  expect(part?.querySelector(".lane")?.textContent).toBe("https://box.tail.ts.net:7443/f/billing/preview/");
  expect(part?.querySelector(".pill")?.textContent).toBe("up");
  expect(box("a2")?.checked).toBe(true);
  expect(box("a4")?.checked).toBe(false);
  expect(box("a2")?.disabled).toBe(false);
  expect(root.querySelector("#preview-workers")?.textContent).toContain("qkzwlnvo");
  expect(root.querySelector("#preview-conflicts")).toBeNull();
  expect(root.querySelector("#preview-log")).toBeNull();
});

test("a box posts the choice to the hub; a refusal puts the box back and says why", async () => {
  box("a2")?.click();
  await Bun.sleep(0);
  flush();
  expect(posted).toEqual([{ url: "preview-workers", body: JSON.stringify({ worker: "a2", include: false }) }]);

  answer = new Response(JSON.stringify({ error: "only luiz@example.com can write here" }), { status: 403 });
  box("a4")?.click();
  await Bun.sleep(0);
  await Bun.sleep(0);
  flush();
  expect(box("a4")?.checked).toBe(false);
  expect(root.querySelector("#preview .deaf-line")?.textContent).toBe("only luiz@example.com can write here");
});

test("a reader who may not write sees the boxes and cannot change them", () => {
  page.m.setWrite({ ok: false, reason: "only luiz@example.com can write here" });
  flush();
  expect(box("a2")?.disabled).toBe(true);
  expect(box("a2")?.title).toBe("only luiz@example.com can write here");
});

test("conflicts name the files and the workers, and a build error shows the log's lines, live", () => {
  page.m.takeState(
    JSON.stringify(
      withPreview({
        ...PREVIEW,
        conflicts: [{ path: "src/invoices/total.ts", workers: ["a2", "a4"] }],
        log: "[vite] Internal server error: Unexpected token\n  src/invoices/total.ts:3:1",
      }),
    ),
  );
  flush();
  const conflicts = root.querySelector("#preview-conflicts");
  expect(conflicts?.querySelector("li")?.textContent).toBe("src/invoices/total.ts invoice-gen, notes-impl");
  expect(root.querySelector("#preview-log pre")?.textContent).toBe("[vite] Internal server error: Unexpected token\n  src/invoices/total.ts:3:1");
});

test("the Links view lists the combined preview and each worker's own", () => {
  location.hash = "#links";
  page.ui.route();
  flush();
  const links = [...root.querySelectorAll("#preview-links .link-title")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([
    ["Preview: every worker", "preview/"],
    ["Preview: notes-impl alone", "preview/a4/"],
  ]);
});

test("a fleet with no preview shows no block, and the ledger's dev command is no preview", () => {
  page.m.takeState(JSON.stringify({ ...withPreview(null), preview: { cmd: "npm run dev" } }));
  flush();
  expect(root.querySelector("#preview")).toBeNull();
  expect(root.querySelector("#preview-links")).toBeNull();
});

test("a root-mode preview links the https address the hub serves it at, and says when the hub cannot serve https there", () => {
  page.m.takeState(
    JSON.stringify(
      withPreview({
        ...PREVIEW,
        public: 7501,
        public_url: "https://box.example.ts.net:7501/",
        public_error: null,
        per_worker: [{ ...OWN, public: 7502, public_url: null, public_error: "tailscale cert box.example.ts.net: HTTPS is disabled" }],
      }),
    ),
  );
  flush();
  const own = root.querySelector("#preview-root-link");
  expect(own?.getAttribute("href")).toBe("https://box.example.ts.net:7501/");
  expect(own?.textContent).toBe("https://box.example.ts.net:7501/");
  expect(own?.getAttribute("title") ?? "").not.toContain("secure context");
  const links = [...root.querySelectorAll("#preview .preview-root-link")].map((a) => a.getAttribute("href"));
  expect(links).toEqual(["https://box.example.ts.net:7501/"]);
  expect(root.querySelector("#preview")?.textContent).toContain("The hub cannot serve https on port 7502: tailscale cert box.example.ts.net: HTTPS is disabled");
});

test("a preview that is not in root mode has no link of its own origin", () => {
  expect(root.querySelector("#preview .preview-root-link")).toBeNull();
});
