/**
 * A permission: a call auto mode refused, which the user lets through once or denies. Its page shows the
 * call as code with its cause, the rule and the file the hub writes it into, then the two options and a
 * note; the answer posts as the options word it, and the hub's refusal shows on the form. Run in happy-dom,
 * through `takeState` and the form's own submit.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";

import { App } from "../src/App.tsx";
import { Core } from "../src/core.ts";
import type { Model } from "../src/model.ts";
import type { Ui } from "../src/ui.ts";
import { coordinatorView, type View } from "./fixtures.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

const CALL = "git push --force origin HEAD:main 2>&1";

const RULE = `Bash(${CALL})`;

const FILE = "/home/me/repos/billing/.claude/settings.local.json";

const PERMISSION: View = {
  id: "p-1a2b3c4d",
  ref: "P1",
  kind: "permission",
  title: "Force-push main",
  question: "Let invoice-gen's refused call run once?",
  why: "auto mode refused it",
  status: "open",
  blocking: true,
  asks: "user",
  agent: "a2",
  opened: new Date(NOW - 5 * 60_000).toISOString(),
  recommend: null,
  refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "[Git Destructive]", root: "/home/me/repos/billing", agent_id: "agent-7f" },
  options: [
    { id: "allow-once", label: "Allow this call once", consequence: `the hub adds ${RULE} to ${FILE}; the plugin hook removes it once the call has run, or at the first tool call of the session after 30 minutes` },
    { id: "deny", label: "Deny", consequence: "the worker stays stopped; your note goes to it" },
  ],
};

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

const posted: { text: string; decision?: string; rule?: string }[] = [];

/** What the hub answers a post with: 201 and the message, or a status and its error. */
interface HubAnswer {
  readonly status: number;
  readonly error?: string;
}

let answer: HubAnswer = { status: 201 };

beforeEach(() => {
  Object.assign(globalThis, { FleetCore: Core });
  localStorage.clear();
  location.hash = "";
  posted.length = 0;
  answer = { status: 201 };
  // SAFETY: the stub answers the calls the page makes with `fetch`: the skills list, a post to chat, else not found.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url === "skills") return new Response(JSON.stringify({ skills: [], builtins: false }), { status: 200 });

    if (url === "chat") {
      const body: { text: string; decision?: string; rule?: string } = JSON.parse(String(init?.body));
      posted.push(body);

      return answer.status === 201
        ? new Response(JSON.stringify({ id: 99, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: body.text, decision: body.decision }), { status: 201 })
        : new Response(JSON.stringify({ error: answer.error }), { status: answer.status });
    }

    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  show(PERMISSION);
});

/** Render the page with `item` as its one decision, open on it. */
function show(item: View): void {
  root = document.createElement("div");
  document.body.append(root);
  const state = Core.parseState({ ...coordinatorView(NOW), decisions: [item], roadblocks: [] });

  if (!state) throw new Error("the fixture is not a state");
  dispose = render(() => <App state={state} live={false} expose={(p) => (page = p)} />, root);
  flush();
  page.m.setConn("live");
  location.hash = "#decision/p-1a2b3c4d";
  page.ui.route();
  flush();
}

afterEach(() => {
  dispose();
  root.remove();
});

const form = (): HTMLFormElement | null => root.querySelector<HTMLFormElement>("#dv-answer form");

async function send(choice: string | undefined, note = ""): Promise<void> {
  const pick = choice === undefined ? null : root.querySelector<HTMLInputElement>(`#dv-answer input[name="choice"][value="${choice}"]`);

  if (pick) pick.checked = true;
  const field = root.querySelector<HTMLTextAreaElement>('#dv-answer textarea[name="note"]');

  if (field) field.value = note;
  form()?.requestSubmit();
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

test("the refused call shows as code, with its cause, the rule and the file it goes into", () => {
  const call = root.querySelector("#dv-answer .refused figure.code");
  expect([call?.getAttribute("data-lang"), call?.querySelector("code")?.textContent]).toEqual(["sh", CALL]);
  const facts = [...root.querySelectorAll("#dv-answer .refused dl > *")].map((e) => e.textContent);
  expect(facts).toEqual(["Refused because", "[Git Destructive]", "Rule", RULE, "Goes into", FILE]);
  expect([...root.querySelectorAll('#dv-answer input[name="choice"]')].map((i) => i.getAttribute("value"))).toEqual(["allow-once", "deny"]);
  expect(root.querySelector('#dv-answer textarea[name="note"]')).not.toBeNull();
});

test("a refused Agent call shows its input as JSON, and the grants file the hook reads, not the settings", async () => {
  const spawn = { description: "prod count", prompt: "SELECT 1;\nreport", subagent_type: "general-purpose" };
  const call = JSON.stringify(spawn);
  const rule = `Agent(${call})`;
  dispose();
  root.remove();
  show({ ...PERMISSION, refusal: { tool: "Agent", call, rule, cause: "[Production Reads]", root: "/home/me/repos/billing", agent_id: null } });
  const shown = root.querySelector("#dv-answer .refused figure.code");
  expect([shown?.getAttribute("data-lang"), shown?.querySelector("code")?.textContent]).toEqual(["json", JSON.stringify(spawn, null, 2)]);
  const facts = [...root.querySelectorAll("#dv-answer .refused dl > *")].map((e) => e.textContent);
  expect(facts).toEqual(["Refused because", "[Production Reads]", "Let through by", "the plugin's PreToolUse hook (auto mode ignores Agent allow rules in the settings)", "Goes into", "/home/me/repos/billing/.claude/tstack-grants.json"]);
  await send("allow-once");
  expect(posted).toEqual([{ text: "allow-once: Allow this call once", decision: "p-1a2b3c4d", rule }]);
});

test("an answer is the option as it reads, with the note after it; none picked asks for one", async () => {
  await send(undefined);
  expect([posted, root.querySelector("#dv-error")?.textContent]).toEqual([[], "Pick one option."]);
  await send("deny", "not on main; push a branch");
  expect(posted).toEqual([{ text: "deny: Deny\nnot on main; push a branch", decision: "p-1a2b3c4d", rule: RULE }]);
});

test("the hub's refusal to grant shows on the form", async () => {
  answer = { status: 409, error: "the permission's root /tmp/x is no session of this fleet (no heartbeat has it as its cwd)" };
  await send("allow-once");
  expect(posted).toEqual([{ text: "allow-once: Allow this call once", decision: "p-1a2b3c4d", rule: RULE }]);
  expect(root.querySelector("#dv-error")?.textContent).toContain("no session of this fleet");
});

test("a permission is counted and named as one", () => {
  expect(Core.kindCount([{ kind: "permission" }])).toBe("1 permission waits");
});
