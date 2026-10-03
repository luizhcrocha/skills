/**
 * An action the user ran and that failed: its form offers Done and Failed, and Failed needs what happened,
 * posted as `Failed: <note>` tagged with the action. Answered so, the action leaves the user's list for
 * Waiting with a red "failed" pill, never Done, its page shows the note in the thread, and the fleet's
 * revision brings it back to the user. Run in happy-dom, through `takeState` and the form's own submit.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type Message, type View } from "./fixtures.ts";

const NOW = Date.now();

const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const ACTION: View = {
  id: "a1",
  ref: "A1",
  kind: "action",
  title: "Run the pipeline role cut",
  question: "Run the role cut on the pipeline.",
  why: "the cut feeds the next milestone",
  status: "open",
  blocking: false,
  asks: "user",
  opened: at(60),
  manual: "just cut --roles",
  options: [],
};

const FAILED: Message = { id: 7, at: at(10), from: "user", to: ["coordinator"], text: "Failed: just: recipe `cut` not found\nerror: Justfile does not contain recipe `cut`.", decision: "a1" };

/** A message as the stream carries it: plain JSON. */
const wire = (m: Message): Json => JSON.parse(JSON.stringify(m));

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

const posted: { text: string; decision?: string }[] = [];

/** The fixture's fleet with only these items. */
function viewWith(...decisions: View[]): View {
  return { ...coordinatorView(NOW), decisions, roadblocks: [] };
}

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted.length = 0;
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a post to chat, else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: { text: string; decision?: string } = JSON.parse(String(init?.body));
      posted.push(body);

      return new Response(JSON.stringify({ id: 99, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, decision: body.decision }), { status: 201 });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState(viewWith(ACTION));

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

function open(): void {
  location.hash = "#decision/a1";
  page.ui.route();
  flush();
}

const button = (name: string): HTMLButtonElement | null => root.querySelector<HTMLButtonElement>(`#dv-answer button[type="submit"][name="${name}"]`);

async function send(name: string, note: string): Promise<void> {
  const field = root.querySelector<HTMLTextAreaElement>('#dv-answer textarea[name="note"]');

  if (field) field.value = note;
  root.querySelector<HTMLFormElement>("#dv-answer form")?.requestSubmit(button(name));
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

const bucket = (name: string): HTMLButtonElement | null => root.querySelector(`#decision-seg button[data-bucket="${name}"]`);

const listed = (name: string): Element | null => {
  bucket(name)?.click();
  flush();

  return root.querySelector('#decision-list a[href="#decision/a1"]');
};

test("the form offers Done and Failed, its note empty", () => {
  open();
  expect([button("done")?.textContent?.trim(), button("failed")?.textContent?.trim()]).toEqual(["Done", "Failed"]);
  expect(root.querySelector<HTMLTextAreaElement>('#dv-answer textarea[name="note"]')?.value).toBe("");
});

test("Failed needs what happened, and posts it as Failed: tagged with the action", async () => {
  open();
  await send("failed", "  ");
  expect([posted, root.querySelector("#dv-error")?.textContent]).toEqual([[], "Say what happened: what you ran and what it said."]);
  await send("failed", "just: recipe `cut` not found\nerror: Justfile does not contain recipe `cut`.");
  expect(posted).toEqual([{ text: "Failed: just: recipe `cut` not found\nerror: Justfile does not contain recipe `cut`.", decision: "a1" }]);
});

test("Done still posts Done., with the note if one is given", async () => {
  open();
  await send("done", "");
  expect(posted).toEqual([{ text: "Done.", decision: "a1" }]);
});

test("answered Failed, it waits on the fleet with a red failed pill, never in Done", () => {
  page.ui.addMessage(wire(FAILED), false);
  flush();
  expect(listed("active")).toBeNull();
  expect(listed("done")).toBeNull();
  const row = listed("waiting");
  const pill = row?.querySelector(".pill.blocking");
  expect(pill?.textContent).toBe("failed: just: recipe `cut` not found");
});

test("held while the fleet fixes it, it still reads failed", () => {
  page.ui.addMessage(wire(FAILED), false);
  page.m.takeState(JSON.stringify(viewWith({ ...ACTION, held: "fixing the recipe", held_at: at(5) })));
  flush();
  expect(listed("waiting")?.querySelector(".pill.blocking")?.textContent).toBe("failed: just: recipe `cut` not found");
});

test("its page shows the failure note in the thread", () => {
  page.ui.addMessage(wire(FAILED), false);
  flush();
  open();
  /* The note is rendered as the chat renders text: the backticks become code. */
  const thread = root.querySelector("#dv-thread");
  expect(thread?.textContent).toContain("Failed: just: recipe cut not found");
  expect(thread?.textContent).toContain("error: Justfile does not contain recipe cut.");
});

test("revised with a fix, it is the user's again, no longer failed", () => {
  page.ui.addMessage(wire(FAILED), false);
  page.m.takeState(JSON.stringify(viewWith({ ...ACTION, revised: at(2), change: "the recipe is cut-roles", manual: "just cut-roles" })));
  flush();
  const row = listed("active");
  expect(row).not.toBeNull();
  expect(row?.querySelector(".pill.blocking")).toBeNull();
  expect(root.querySelector("#lead .lead-line")?.textContent).toBe("1 action waits on you.");
});
