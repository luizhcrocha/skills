/**
 * A permission: a call auto mode refused, which the user lets through once or denies. Its page shows the
 * cause, the rule and the file the hub writes it into, then the exact call as code, unfolded and wrapped,
 * directly above the two options and a note; the answer posts as the options word it, and the hub's refusal shows on the form. Run in happy-dom,
 * through `takeState` and the form's own submit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const ROOT = "/home/me/repos/billing";

const FILE = `${ROOT}/.claude/settings.local.json`;

const REFUSAL = { tool: "Bash", call: CALL, rule: RULE, cause: "[Git Destructive]", root: "/home/me/repos/billing", agent_id: "agent-7f" };

const PERMISSION: View = {
  id: "p-1a2b3c4d",
  ref: "P1",
  kind: "permission",
  title: "Allow invoice-gen to run `git push --force origin HEAD:main 2>&1`?",
  question: "Let invoice-gen's refused call run once?",
  why: "auto mode refused it",
  status: "open",
  blocking: true,
  asks: "user",
  agent: "a2",
  opened: new Date(NOW - 5 * 60_000).toISOString(),
  recommend: null,
  refusal: REFUSAL,
  options: [
    {
      id: "allow-once",
      label: "Allow this call once",
      consequence: "the worker runs exactly the call shown above, once, and nothing like it after: the one-time grant goes once it is used, or after 30 minutes",
    },
    { id: "deny", label: "Deny", consequence: "the worker stays stopped; your note goes to it" },
  ],
};

let page: { m: Model; ui: Ui };

let dispose: () => void;

let root: HTMLElement;

const posted: { text: string; decision?: string; rule?: string; rules?: string[]; root?: string; runs?: string[] }[] = [];

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
      const body: { text: string; decision?: string; rule?: string; rules?: string[]; root?: string; runs?: string[] } = JSON.parse(String(init?.body));
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
  // A copy: the page's store reconciles a state update into the rows it was given, and the fixtures are shared.
  const state = Core.parseState({ ...coordinatorView(NOW), decisions: [structuredClone(item)], roadblocks: [] });

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

const exact = (): Element | null => root.querySelector("#dv-answer [data-exact-call]");

test("the refused call shows with its cause in plain words, the rule and the file it goes into", () => {
  const facts = [...root.querySelectorAll("#dv-answer .refused dl > *")].map((e) => e.textContent);
  expect(facts).toEqual(["Auto mode stopped it because", "it can erase work in git: history or changes not yet saved ([Git Destructive])", "Rule", RULE, "Goes into", FILE]);
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
  const shown = exact()?.querySelector("figure.code");
  expect([shown?.getAttribute("data-lang"), shown?.querySelector("code")?.textContent]).toEqual(["json", JSON.stringify(spawn, null, 2)]);
  const facts = [...root.querySelectorAll("#dv-answer .refused dl > *")].map((e) => e.textContent);
  expect(facts).toEqual(["Auto mode stopped it because", "it reads live production data ([Production Reads])", "Let through by", "the plugin's PreToolUse hook (auto mode ignores Agent allow rules in the settings)", "Goes into", "/home/me/repos/billing/.claude/tstack-grants.json"]);
  await send("allow-once");
  expect(posted).toEqual([{ text: "allow-once: Allow this call once", decision: "p-1a2b3c4d", rule, root: ROOT }]);
});

test("the exact call shows with no click: unfolded, wrapped, in monospace, directly above the answer buttons", () => {
  const block = exact();
  expect(root.querySelector("#dv-answer details")).toBeNull();
  expect(block?.querySelector("h3")?.textContent).toBe("The exact call you allow");
  const code = block?.querySelector("figure.code");
  expect([code?.getAttribute("data-lang"), code?.querySelector("pre code")?.textContent]).toEqual(["sh", CALL]);
  expect([code?.querySelector("pre")?.classList.contains("wrap"), code?.querySelector(".code-wrap")?.getAttribute("aria-pressed")]).toEqual([true, "true"]);
  expect(block?.nextElementSibling?.tagName).toBe("FIELDSET");
  expect(block?.nextElementSibling?.querySelector('input[value="allow-once"]')).not.toBeNull();
  // The plain words stay above it, and the Allow option says it runs that call.
  const ask = root.querySelector(".dv-ask");
  expect(ask !== null && block?.compareDocumentPosition(ask)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  expect(root.querySelector('#dv-answer label.option:has(input[value="allow-once"])')?.textContent).toContain("runs exactly the call shown above, once");
});

test("an answer is the option as it reads, with the note after it; none picked asks for one", async () => {
  await send(undefined);
  expect([posted, root.querySelector("#dv-error")?.textContent]).toEqual([[], "Pick one option."]);
  await send("deny", "not on main; push a branch");
  expect(posted).toEqual([{ text: "deny: Deny\nnot on main; push a branch", decision: "p-1a2b3c4d", rule: RULE, root: ROOT }]);
});

test("the hub's refusal to grant shows on the form", async () => {
  answer = { status: 409, error: "the permission's root /tmp/x is no session of this fleet (no heartbeat has it as its cwd)" };
  await send("allow-once");
  expect(posted).toEqual([{ text: "allow-once: Allow this call once", decision: "p-1a2b3c4d", rule: RULE, root: ROOT }]);
  expect(root.querySelector("#dv-error")?.textContent).toContain("no session of this fleet");
});

test("a permission is counted and named as one", () => {
  expect(Core.kindCount([{ kind: "permission" }])).toBe("1 permission waits");
});

const banner = (): Element | null => root.querySelector("#dv-info [data-explain]");

test("before the coordinator explains it, the page says it waits for that, above the call, and the answer still works", async () => {
  expect(banner()?.querySelector("h3")?.textContent).toBe("Waiting for the coordinator to explain this request");
  expect(banner()?.textContent).not.toContain("answer now");
  const call = exact();
  expect(call !== null && banner()?.compareDocumentPosition(call)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  await send("deny", "not now");
  expect(posted).toEqual([{ text: "deny: Deny\nnot now", decision: "p-1a2b3c4d", rule: RULE, root: ROOT }]);
});

test("the coordinator's explanation replaces the banner: its why, its recommendation and reason", () => {
  dispose();
  root.remove();
  const why = "The push replaces main with the worker's branch; two commits from yesterday would be lost.";
  show({ ...PERMISSION, why, recommend: "deny", reason: "push a branch and open a review instead", revised: new Date(NOW - 60_000).toISOString() });
  expect(banner()).toBeNull();
  expect(root.querySelector(".dv-why-text")?.textContent).toContain(why);
  expect(root.querySelector(".dv-rec-pick")?.textContent).toBe("deny: Deny");
  expect(root.querySelector(".dv-rec-why")?.textContent).toContain("push a branch");
});

test("a permission asked before its call ran says so, in place of a cause", () => {
  dispose();
  root.remove();
  show({ ...PERMISSION, title: "Push the release to main?", why: "It replaces main with the release branch.", recommend: "allow-once", reason: "the gate passed", refusal: { tool: "Bash", call: CALL, rule: RULE, cause: "", root: ROOT, agent_id: null } });
  const facts = [...root.querySelectorAll("#dv-answer .refused dl > *")].map((e) => e.textContent);
  expect(facts).toEqual(["Asked before running", "nothing has been tried: the fleet runs it only once you allow it", "Rule", RULE, "Goes into", FILE]);
  expect(banner()).toBeNull();
  expect(exact()?.querySelector("pre code")?.textContent).toBe(CALL);
});

test("several calls show numbered, each in full, and one answer sends every rule and the folder shown", async () => {
  const calls = ["tasks/build-worker", "tasks/migrate-db --env production", "cd servers/api && tasks/deploy-worker --approve-migrations"];
  const [first = "", ...more] = calls;
  const rules = calls.map((call) => `Bash(${call})`);
  dispose();
  root.remove();
  show({
    ...PERMISSION,
    recommend: "allow-once",
    reason: "the gate passed",
    refusal: { tool: "Bash", call: first, rule: rules[0] ?? "", cause: "", root: ROOT, agent_id: null, more },
    options: [
      { id: "allow-once", label: "Allow these 3 calls, once each", consequence: "the fleet runs exactly the 3 calls shown above, once each" },
      { id: "deny", label: "Deny", consequence: "the fleet does not run any of them; your note goes to it" },
    ],
  });
  const block = exact();
  expect(block?.querySelector("h3")?.textContent).toBe("The 3 exact calls you allow, once each");
  expect(block?.querySelector("ol.exact-calls")?.children.length).toBe(3);
  expect([...(block?.querySelectorAll("ol.exact-calls > li pre code") ?? [])].map((c) => c.textContent)).toEqual(calls);
  expect(block?.nextElementSibling?.tagName).toBe("FIELDSET");
  const facts = [...root.querySelectorAll("#dv-answer .refused dl > *")].map((e) => e.textContent);
  expect(facts.slice(2, 4)).toEqual(["Rules", "one exact rule for each of the 3 calls below, Bash(<the call>)"]);
  await send("allow-once");
  expect(posted).toEqual([{ text: "allow-once: Allow these 3 calls, once each", decision: "p-1a2b3c4d", rule: rules[0] ?? "", root: ROOT, rules }]);
});

/** The fleet changes the item while the page has it open, as a state update brings it. */
async function becomes(item: View): Promise<void> {
  page.m.takeState(JSON.stringify({ ...coordinatorView(NOW), decisions: [item], roadblocks: [] }));
  flush();
  await new Promise((r) => setTimeout(r, 0));
  flush();
}

const picked = (): string[] => [...root.querySelectorAll<HTMLInputElement>('#dv-answer input[name="choice"]')].flatMap((el) => (el.checked ? [el.value] : []));

function pick(choice: string): void {
  const input = root.querySelector<HTMLInputElement>(`#dv-answer input[name="choice"][value="${choice}"]`);

  if (!input) throw new Error(`no option ${choice}`);
  input.checked = true;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("a permission that changes under a picked answer", () => {
  const OTHER = "bash /srv/tasks/deploy.sh --env production";
  const swapped = (over: Partial<View> = {}): View => ({ ...PERMISSION, refusal: { tool: "Bash", call: OTHER, rule: `Bash(${OTHER})`, cause: "[Git Destructive]", root: ROOT, agent_id: "agent-7f" }, ...over });

  test("the call swapped in place clears the pick and says so; Send then posts nothing", async () => {
    pick("allow-once");
    expect([picked(), root.querySelector("#dv-moved")]).toEqual([["allow-once"], null]);
    await becomes(swapped({ revised: new Date(NOW).toISOString(), change: "the call" }));
    expect(exact()?.querySelector("pre code")?.textContent).toBe(OTHER);
    expect(picked()).toEqual([]);
    expect(root.querySelector("#dv-moved")?.textContent).toContain("This changed while you had it open. Read it again: the call, its folder or a file it runs is not what you saw, and your choice was cleared.");
    expect(form()?.hasAttribute("data-moved")).toBe(true);
    form()?.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
    flush();
    expect([posted, root.querySelector("#dv-error")?.textContent]).toEqual([[], "Pick one option."]);
    // Picked again, after reading it, the answer names the call now shown.
    await send("allow-once");
    expect(posted).toEqual([{ text: "allow-once: Allow this call once", decision: "p-1a2b3c4d", rule: `Bash(${OTHER})`, root: ROOT }]);
  });

  test("a row an agent rewrote with no revision stamp clears it all the same: the call, the folder, a bound file", async () => {
    for (const next of [
      swapped(),
      { ...PERMISSION, refusal: { ...REFUSAL, root: "/home/me/repos/elsewhere" } },
      { ...PERMISSION, refusal: { ...REFUSAL, runs: [`1 ${"a".repeat(64)} /srv/tasks/deploy.sh`] } },
    ]) {
      await becomes(PERMISSION);
      pick("allow-once");
      await becomes(next);
      expect(picked()).toEqual([]);
      expect(root.querySelector("#dv-moved")).not.toBeNull();
    }
  });

  test("the same item again, and a pick with nothing changed, are left alone", async () => {
    pick("allow-once");
    await becomes({ ...PERMISSION });
    expect([picked(), root.querySelector("#dv-moved")]).toEqual([["allow-once"], null]);
  });
});

describe("what a call runs", () => {
  const SHA = "3fa2".repeat(16);

  test("a call bound to a script names the file and its sha256, a call found by name says its content is not bound, and the answer sends what was shown", async () => {
    const calls = ["bash /srv/tasks/build.sh", "wrangler deploy --env production"];
    const runs = [`1 ${SHA} /srv/tasks/build.sh`];
    dispose();
    root.remove();
    show({ ...PERMISSION, refusal: { tool: "Bash", call: calls[0] ?? "", rule: `Bash(${calls[0] ?? ""})`, cause: "", root: ROOT, agent_id: null, more: calls.slice(1), runs } });
    const items = [...(exact()?.querySelectorAll("ol.exact-calls > li") ?? [])];
    expect(items.map((li) => li.querySelector(".call-runs")?.textContent)).toEqual([
      "Runs this file: /srv/tasks/build.sh (sha256 3fa23fa23fa2). The grant holds only while the file stays as it is now.",
      "The file's content is not bound: this grant is for the command as written, and what the command runs is found when it runs.",
    ]);
    await send("allow-once");
    expect(posted[0]?.runs).toEqual(runs);
  });

  test("one call with no script says so too, and sends no files", async () => {
    expect(exact()?.querySelector(".call-runs[data-unbound]")).not.toBeNull();
    await send("allow-once");
    expect(posted[0] !== undefined && "runs" in posted[0]).toBe(false);
  });

  test("a call at the 2,000-character limit shows whole, and the sheet wraps every call with no way to unwrap or scroll it sideways", async () => {
    const long = `wrangler deploy ${"--var KEY:value ".repeat(124)}`.slice(0, 2000);
    dispose();
    root.remove();
    show({ ...PERMISSION, refusal: { ...REFUSAL, call: long, rule: `Bash(${long})` } });
    expect(exact()?.querySelector("pre code")?.textContent).toBe(long);
    const css = await Bun.file(new URL("../src/page.css", import.meta.url)).text();
    expect(css).toContain(".exact-call .code-pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: visible; max-height: none; }");
    expect(css).toContain(".exact-call .code-wrap { display: none; }");
    expect(css).toContain(".call-runs { margin: 0; font-size: var(--fs-s); color: var(--muted); overflow-wrap: anywhere; }");
  });
});
