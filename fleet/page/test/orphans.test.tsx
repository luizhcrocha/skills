/**
 * Orphaned processes on a manager's page: one row per tree the hub found (pid, age, memory, its fleet or
 * session, the command, where it ran), and a Stop that posts the pid and its start back to the hub and says
 * what happened. A coordinator's page never shows the part.
 */
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core, type Json } from "../src/core.ts";
import { coordinatorView, managerView } from "./fixtures.ts";

const NOW = Date.now();

let dispose: (() => void) | undefined;

let root: HTMLElement | undefined;

let posted: { readonly url: string; readonly body: string; readonly token: string }[] = [];

afterEach(() => {
  dispose?.();
  root?.remove();
  posted = [];
});

const ORPHANS: Json = [
  { pid: 4242, started: 1_800_000_000.5, command: "node /x/node_modules/vitest/vitest.mjs run", age: 15.7 * 3600, rss: 3_800_000, cwd: "/repo/agent-tools/pkg", workspace: "/repo/agent-tools", session: "abc12345-0000", fleet: "tools" },
  { pid: 5151, started: 1_800_000_100, command: "chromium --headless=new", age: 3 * 3600, rss: 300_000, cwd: "", workspace: "", session: "", fleet: "" },
  { pid: 1, started: 1, command: "init", age: 1, rss: 1 },
];

function mount(view: Json, answer: Response = Response.json({ stopped: [4242, 4243, 4244], left: [] })): HTMLElement {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "#fleet";

  // SAFETY: the stub answers the page's fetch calls; only the URL and the body are read.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("orphans/stop")) {
      posted.push({ url, body: String(init?.body ?? ""), token: new Headers(init?.headers).get("X-Fleet-Stop-Token") ?? "" });

      return answer;
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const state = Core.parseState(view);

  if (!state) throw new Error("the fixture is not a state");
  const at = document.createElement("div");
  document.body.append(at);
  dispose = render(() => <App state={state} live={false} />, at);
  flush();
  root = at;

  return at;
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/gu, " ").trim();

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((wake) => setTimeout(wake, 0));
    flush();
  }
}

test("the manager's page lists each orphaned tree with its age, memory, fleet or session and command; a row that is no process is dropped", () => {
  const page = mount({ ...managerView(NOW), orphans: ORPHANS });
  const part = page.querySelector("#orphans");
  expect(part?.hasAttribute("hidden")).toBe(false);
  const rows = [...page.querySelectorAll(".orphan-row")];
  expect(rows.map((r) => r.getAttribute("data-pid"))).toEqual(["4242", "5151"]);
  expect(text(rows[0])).toContain("15 h 42 min");
  expect(text(rows[0])).toContain("3.6 GB");
  expect(text(rows[0])).toContain("tools");
  expect(text(rows[0])).toContain("vitest.mjs run");
  expect(text(rows[0])).toContain("/repo/agent-tools/pkg");
  expect(text(rows[1])).toContain("no fleet found");
  expect(text(part?.querySelector("h2"))).toBe("Orphaned processes 2");
});

test("Stop posts the pid and its start with the page's Stop token, and says what the hub did", async () => {
  const meta = document.createElement("meta");
  meta.name = "fleet-stop-token";
  meta.content = "t0ken";
  document.head.append(meta);
  const page = mount({ ...managerView(NOW), orphans: ORPHANS });
  const button = page.querySelector<HTMLButtonElement>('.orphan-row[data-pid="4242"] .orphan-stop');
  button?.click();
  await settle();
  expect(posted.map((p) => [p.url, JSON.parse(p.body), p.token])).toEqual([["orphans/stop", { pid: 4242, started: 1_800_000_000.5 }, "t0ken"]]);
  meta.remove();
  expect(text(page.querySelector('.orphan-row[data-pid="4242"] .orphan-said'))).toBe("Stopped 3 processes.");
});

test("a refused Stop shows the hub's reason", async () => {
  const page = mount({ ...managerView(NOW), orphans: ORPHANS }, Response.json({ error: "process 4242 is not the one the page showed (it started at another time); nothing was stopped" }, { status: 409 }));
  page.querySelector<HTMLButtonElement>('.orphan-row[data-pid="4242"] .orphan-stop')?.click();
  await settle();
  expect(text(page.querySelector('.orphan-row[data-pid="4242"] .orphan-said'))).toContain("nothing was stopped");
});

test("with none, and on a coordinator's page, the part stays hidden", () => {
  expect(mount(managerView(NOW)).querySelector("#orphans")?.hasAttribute("hidden")).toBe(true);
  dispose?.();
  root?.remove();
  expect(mount({ ...coordinatorView(NOW), orphans: ORPHANS }).querySelector("#orphans")?.hasAttribute("hidden")).toBe(true);
});
