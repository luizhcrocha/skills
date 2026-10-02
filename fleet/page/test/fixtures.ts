/**
 * Real-shaped views of a coordinator's fleet and of a manager (what `view()` sends the page), and a
 * conversation, with every time relative to `now` so "5 min ago" reads the same on every run.
 */
import type { JsonRecord } from "../src/core.ts";

/** A view as the page receives it: plain JSON. */
export type View = JsonRecord;

/** The workers of a view, in its order. */
export function agentsOf(view: View): View[] {
  const rows = view["agents"];

  return Array.isArray(rows) ? rows.filter((a): a is View => a !== null && Object(a) === a && !Array.isArray(a)) : [];
}

/** A chat message as the server stores it. */
export interface Message {
  readonly id: number;
  readonly at: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly text: string;
  readonly re?: number;
  readonly decision?: string;
  readonly author?: string;
  readonly parts?: readonly { readonly text: string; readonly mention?: string }[];
  readonly quote?: { readonly text: string; readonly from: string };
  readonly side?: number;
}

const MIN = 60_000;

/** The ISO time `minutes` before `now`. */
function before(now: number, minutes: number): string {
  return new Date(now - minutes * MIN).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** The agents of the coordinator's fleet. */
function agents(now: number): View[] {
  return [
    { id: "a1", name: "research-stripe", status: "done", task: "Research Stripe's invoice API and its webhooks", skill: "research", model: "sonnet", milestone: "m1", lane: [], tokens: 182_400, duration_ms: 1_260_000, rounds: 1, brief: "Read Stripe's docs on invoices and webhooks; write docs/research/stripe.md.\nDone when: the file lists every event we need.", report: "Wrote docs/research/stripe.md: 9 events, 3 caveats.", updated: before(now, 140) },
    { id: "a2", name: "invoice-gen", status: "running", task: "Generate invoices from the ledger and post them to Stripe", skill: "tdd", model: "opus", milestone: "m2", lane: ["src/invoices/", "test/invoices/"], tokens: 96_000, duration_ms: 2_400_000, rounds: 2, brief: "Implement the invoice generator.", report: "Round 1: generator and its tests; now the Stripe adapter.", updated: before(now, 6), active: before(now, 1), beat: { tool: "Edit", event: "PostToolUse" } },
    { id: "a3", name: "stripe.adapter", status: "blocked", task: "Adapt the Stripe client to the new API version", skill: "tdd", model: "opus", milestone: "m2", lane: ["src/stripe/"], tokens: 41_250, duration_ms: 900_000, rounds: 1, brief: "Move the client to API 2026-09.", report: "Blocked: needs the restricted key.", updated: before(now, 25), active: before(now, 31) },
    { id: "a4", name: "notes-impl", status: "running", task: "Notes on an invoice, shown to the customer", skill: "none", model: "sonnet", milestone: "m2", lane: ["src/notes/"], tokens: 12_800, duration_ms: 300_000, rounds: 1, brief: "Add notes.", report: "", updated: before(now, 3), active: before(now, 2) },
    { id: "a5", name: "docs-pass", status: "queued", task: "Document the invoice flow", skill: "technical-writing", model: "sonnet", milestone: "m3", lane: ["docs/"], tokens: 0, duration_ms: 0, rounds: 1, brief: "", report: "", updated: before(now, 1) },
    { id: "a6", name: "perf-check", status: "failed", task: "Measure the generator on 10k rows", skill: "none", model: "haiku", milestone: "m3", lane: [], tokens: 5_100, duration_ms: 60_000, rounds: 1, brief: "", report: "Crashed: out of memory.", updated: before(now, 50) },
  ];
}

/** A coordinator's view, as the hub sends it under `/f/billing/`. */
export function coordinatorView(now: number): View {
  return {
    project: "Billing: invoices from the ledger",
    goal: "Invoices generated from the ledger and posted to Stripe, with notes, documented, by Friday.",
    status: "running",
    now: "Two workers on milestone 2; D1 waits on you for the rounding rule.",
    now_at: before(now, 4),
    started: before(now, 300),
    updated: before(now, 1),
    role: "coordinator",
    fleet: "billing",
    fleets: ["billing", "infra", "site"],
    manager: { id: "manager", url: "/", session: "mgr" },
    roadmap: [
      { id: "m1", title: "Research", steps: [{ id: "s1", title: "Stripe's invoice API", status: "done", agent: "a1" }] },
      { id: "m2", title: "Generate and post", steps: [
        { id: "s2", title: "Invoice generator", status: "current", agent: "a2" },
        { id: "s3", title: "Stripe adapter", status: "blocked", agent: "a3" },
        { id: "s4", title: "Notes on invoices", status: "current", agent: "a4" },
      ] },
      { id: "m3", title: "Ship", steps: [{ id: "s5", title: "Document the flow", status: "pending", agent: "a5" }, { id: "s6", title: "Load check", status: "pending" }] },
    ],
    agents: agents(now),
    roadblocks: [
      { id: "r1", ref: "R1", title: "No restricted Stripe key", severity: "critical", needs: "a restricted key in 1Password", since: before(now, 30), resolved: false, agent: "a3", detail: "The adapter cannot call the 2026-09 API without a restricted key.", decision: "s1" },
      { id: "r2", ref: "R2", title: "Flaky webhook test", severity: "warning", needs: "a retry in the harness", since: before(now, 90), resolved: true, detail: "Fixed by a retry." },
    ],
    decisions: [
      { id: "d1", ref: "D1", kind: "decision", title: "Rounding rule for totals", question: "How should invoice totals round: per line or on the total?", status: "open", blocking: true, asks: "user", opened: before(now, 40), why: "the generator's totals", milestone: "m2", step: "s2", agent: "a2", recommend: "b", reason: "Stripe rounds on the total; matching it avoids one-cent drift.", options: [
        { id: "a", label: "Round each line", consequence: "Lines add up exactly; the total may differ from Stripe's by a cent." },
        { id: "b", label: "Round the total", consequence: "Matches Stripe; a line may show a fraction." },
      ] },
      { id: "s1", ref: "S1", kind: "secret", title: "Stripe restricted key", question: "Where is the restricted Stripe key?", status: "open", blocking: true, asks: "user", opened: before(now, 30), secret: "STRIPE_RESTRICTED_KEY", manual: "op item create --vault Employee ...", options: [] },
      { id: "i1", ref: "I1", kind: "input", title: "Invoice footer text", question: "What should every invoice's footer say?", status: "open", blocking: false, asks: "user", opened: before(now, 20), why: "the PDF template", options: [] },
      { id: "g1", ref: "G1", kind: "grill", title: "The notes feature", question: "Questions on the notes feature", status: "open", blocking: false, asks: "user", opened: before(now, 15), options: [], questions: [
        { id: "q1", title: "Who sees a note?", body: "A note can be shown to the customer or kept internal.", recommend: "Both, with a toggle", reason: "Support asked for internal notes.", status: "open", asked: before(now, 15) },
        { id: "q2", title: "Max length?", body: "How long may a note be?", recommend: "500 characters", status: "answered", answer: "500", asked: before(now, 15) },
      ] },
      { id: "a7", ref: "A1", kind: "action", title: "Enable test mode webhooks", question: "Turn on test-mode webhooks in the Stripe dashboard.", status: "decided", answer: "Done.", resolution: "Webhooks arrive.", blocking: false, asks: "user", opened: before(now, 200), closed: before(now, 180), options: [] },
    ],
    events: [
      { at: before(now, 290), kind: "spawned", agent: "a1", text: "research-stripe started" },
      { at: before(now, 140), kind: "integrated", agent: "a1", text: "Stripe research merged" },
      { at: before(now, 60), kind: "spawned", agent: "a2", text: "invoice-gen started" },
      { at: before(now, 40), kind: "asked", text: "D1: rounding rule", decision: "d1" },
      { at: before(now, 30), kind: "blocked", agent: "a3", text: "Needs the restricted key", decision: "s1" },
      { at: before(now, 10), kind: "message", text: "Status: generator tests pass." },
    ],
    links: [
      { id: "l1", ref: "L1", kind: "page", title: "Invoice preview", url: "https://example.ts.net:8443/preview/", up: true, fleet: "billing", note: "The generated PDF of the sample ledger.", decision: "i1" },
      { id: "l2", ref: "L2", kind: "dev", title: "API dev server", url: "http://127.0.0.1:5173/", up: false, fleet: "billing", note: "", decision: "" },
    ],
    found: [{ url: "https://example.ts.net:9000/", up: true, fleet: "", cwd: "/home/me/repos/site", command: "vite", port: 9000 }],
    kept: [{ id: "k1", text: "Credit notes, once invoices ship.", at: before(now, 100) }],
    coordinators: [],
    spent: { output: 210_000, input: 4_100_000, cached: 3_700_000, answers: 312 },
    chat: { on: true, seen: 3, unread: 0, since: "" },
  };
}

/** A manager's view, as the hub sends it at `/f/manager/`. */
export function managerView(now: number): View {
  const fleet = (id: string, extra: View): View => ({
    id, url: `f/${id}/`, session: id, dir: `/tmp/${id}`, name: id, project: id, goal: `The ${id} work`, status: "running", now: "", updated: before(now, 2),
    tokens: 0, spent: null, chat: { on: true, seen: 0, unread: 0, since: "" }, active: before(now, 1), now_at: before(now, 3), roadblocks: 0, index: [], silent: [],
    decisions: [], workers: {}, lanes: [], ...extra,
  });

  return {
    project: "Luiz's fleets",
    goal: "Ship billing, keep infra green, launch the site.",
    status: "running",
    now: "billing waits on D1; infra runs its nightly check.",
    now_at: before(now, 5),
    started: before(now, 600),
    updated: before(now, 1),
    role: "manager",
    roadmap: [{ id: "m1", title: "This week", steps: [{ id: "w1", title: "Billing to staging", status: "current", agent: "billing" }, { id: "w2", title: "Site launch", status: "pending" }] }],
    agents: [],
    roadblocks: [],
    decisions: [
      { id: "d9", ref: "D1", kind: "decision", title: "Which fleet gets the gate first", question: "Billing and infra both want the heavy check: who goes first?", status: "open", blocking: false, asks: "user", opened: before(now, 12), options: [{ id: "a", label: "Billing", consequence: "Infra waits an hour." }, { id: "b", label: "Infra", consequence: "Billing waits an hour." }] },
    ],
    events: [
      { at: before(now, 50), kind: "message", text: "billing started milestone 2" },
      { at: before(now, 12), kind: "asked", text: "D1: the gate", decision: "d9" },
    ],
    links: [{ id: "l1", ref: "L1", kind: "page", title: "Invoice preview", url: "https://example.ts.net:8443/preview/", up: true, fleet: "billing", note: "", decision: "" }],
    found: [],
    kept: [],
    coordinators: [
      fleet("billing", { project: "Billing: invoices from the ledger", now: "Two workers on milestone 2", tokens: 337_550, roadblocks: 1, workers: { running: 2, blocked: 1, done: 1, queued: 1, failed: 1 }, lanes: ["src/invoices/", "src/notes/", "src/stripe/"],
        spent: { output: 210_000, input: 4_100_000, cached: 3_700_000, answers: 312 },
        decisions: [{ id: "d1", ref: "D1", kind: "decision", title: "Rounding rule for totals", question: "Per line or on the total?", why: "", blocking: true, asks: "user", opened: before(now, 40), revised: null, answered: null }],
        index: [{ group: "decisions", ref: "D1", title: "Rounding rule for totals", sub: "Per line or on the total?", hint: "open", hash: "#decision/d1" }] }),
      fleet("infra", { project: "Infra", now: "Nightly check running", tokens: 54_000, workers: { running: 1, done: 4 }, lanes: ["nix/"], chat: { on: false, seen: 4, unread: 2, since: before(now, 25) } }),
      fleet("site", { project: "Site", status: "paused", now: "", tokens: 0, workers: {}, active: before(now, 80) }),
    ],
    usage: {
      account: "luiz@example.com",
      seen: Math.floor((now - 3 * MIN) / 1000),
      five_hour: { used_percentage: 62, resets_at: Math.floor((now + 95 * MIN) / 1000), at: Math.floor((now - 3 * MIN) / 1000) },
      seven_day: { used_percentage: 81, resets_at: Math.floor((now + 3 * 24 * 60 * MIN) / 1000), at: Math.floor((now - 3 * MIN) / 1000) },
      others: [{ account: "work@example.com", seen: Math.floor((now - 7 * 60 * MIN) / 1000), seven_day: { used_percentage: 100, resets_at: Math.floor((now + 2 * 24 * 60 * MIN) / 1000), at: Math.floor((now - 7 * 60 * MIN) / 1000) } }],
    },
    gate: { fleet: "infra", what: "nix flake check", since: before(now, 8) },
    spent: { output: 40_000, input: 900_000, cached: 800_000, answers: 51 },
    chat: { on: true, seen: 2, unread: 0, since: "" },
  };
}

/** The coordinator's conversation. */
export function coordinatorChat(now: number): Message[] {
  return [
    { id: 1, at: before(now, 45), from: "user", to: ["coordinator"], text: "How is billing going?", author: "luiz@example.com" },
    { id: 2, at: before(now, 44), from: "coordinator", to: ["user"], text: "Two workers on milestone 2. The rounding rule (D1) is yours.", re: 1 },
    { id: 3, at: before(now, 20), from: "user", to: ["a2"], text: "@invoice-gen keep the totals in cents", parts: [{ text: "@invoice-gen", mention: "a2" }, { text: " keep the totals in cents" }] },
    { id: 4, at: before(now, 18), from: "a2", to: ["user"], text: "Will do: every amount is an integer of cents now.", re: 3 },
    { id: 5, at: before(now, 5), from: "coordinator", to: ["user"], text: "The adapter is blocked on the restricted key (S1)." },
  ];
}

/** The manager's conversation. */
export function managerChat(now: number): Message[] {
  return [
    { id: 1, at: before(now, 30), from: "user", to: ["manager"], text: "Which fleet needs me?" },
    { id: 2, at: before(now, 29), from: "manager", to: ["user"], text: "billing: D1, the rounding rule. infra is not reading its chat.", re: 1 },
  ];
}

/**
 * The coordinator's view for the chat's screenshots and tests: the fleet's view with D18 answered on the
 * page and held by the fleet, its answer in the conversation, and the host having read up to #12.
 */
export function chatView(now: number): View {
  const view = coordinatorView(now);
  const decisions = Array.isArray(view["decisions"]) ? view["decisions"] : [];

  return {
    ...view,
    decisions: [
      ...decisions,
      { id: "d18", ref: "D18", kind: "decision", title: "Load check on the full ledger", question: "Run the 10k-row load check now, or after the cost work?", status: "open", held: "Re-run after the cost improvements work is done: the load check waits for it.", held_at: before(now, 114), blocking: false, asks: "user", opened: before(now, 200), options: [{ id: "a", label: "Now", consequence: "Measures today's generator." }, { id: "b", label: "Skip it", consequence: "No numbers before release." }] },
    ],
    chat: { on: true, seen: 12, unread: 0, since: "" },
  };
}

/**
 * A day and a half of the coordinator's conversation, as Luiz reads it on his phone: an exchange the day
 * before, a worker's report and its follow-up, a side chat on a quote, a decision's answer with the
 * coordinator's acknowledgement, a long status, a reply to the report an hour later, and a message not
 * read yet.
 */
export function chatConversation(now: number): Message[] {
  const report = "Round 2 done: the generator writes every invoice of the sample ledger (412 rows) in 1.8 s. Totals are integer cents; three lines round differently from Stripe, listed in docs/invoices/rounding.md.";

  return [
    { id: 1, at: before(now, 1160), from: "user", to: ["coordinator"], text: "Before you stop for the day: what is left on milestone 2?", author: "luiz@example.com" },
    { id: 2, at: before(now, 1159), from: "coordinator", to: ["user"], text: "The generator and the notes. The adapter waits on S1, the restricted key.", re: 1 },
    { id: 3, at: before(now, 1157), from: "coordinator", to: ["user"], text: "invoice-gen keeps running overnight; its tests are green so far." },
    { id: 4, at: before(now, 168), from: "a2", to: ["user", "coordinator"], text: report },
    { id: 5, at: before(now, 167), from: "a2", to: ["user", "coordinator"], text: "Next: the Stripe adapter, once S1 is in." },
    { id: 6, at: before(now, 150), from: "user", to: ["coordinator"], text: "Is that true for credit notes too?", author: "luiz@example.com", side: 6, quote: { text: "Stripe rounds on the total; matching it avoids one-cent drift.", from: "D1 Rounding rule for totals" } },
    { id: 7, at: before(now, 149), from: "coordinator", to: ["user"], text: "Yes: a credit note is totalled the same way.", re: 6, side: 6 },
    { id: 8, at: before(now, 115), from: "user", to: ["coordinator"], text: "None of these: Re-run after the cost improvements work is done", author: "luiz@example.com", decision: "d18" },
    { id: 9, at: before(now, 114), from: "coordinator", to: ["user"], text: "Recorded D18: the load check waits for the cost work, and I re-run it the day that lands.", re: 8 },
    {
      id: 10,
      at: before(now, 80),
      from: "coordinator",
      to: ["user"],
      text: "Where things stand.\n\nMilestone 2: invoice-gen has the generator and its tests merged; notes-impl is halfway through the notes, the customer-facing part first. stripe.adapter is still blocked on S1, so the Stripe side waits.\n\nMilestone 3: docs-pass is queued behind the notes. perf-check crashed out of memory on 10k rows; that is the load check D18 put off, so it stays failed until the cost work lands.\n\nNothing else waits on you.",
    },
    { id: 11, at: before(now, 40), from: "user", to: ["a2"], text: "@invoice-gen which three lines? Put them in the PR description too.", author: "luiz@example.com", re: 4, parts: [{ text: "@invoice-gen", mention: "a2" }, { text: " which three lines? Put them in the PR description too." }] },
    { id: 12, at: before(now, 38), from: "a2", to: ["user"], text: "Lines 88, 214 and 390, each a half-cent tie. They are in the PR description now.", re: 11 },
    { id: 13, at: before(now, 10), from: "user", to: ["coordinator"], text: "Thanks. Tell me when the adapter is unblocked.", author: "luiz@example.com" },
  ];
}

/** Luiz's Modal clean-up (2026-10-01), as `--manual` is written now: prose, then the command in a `nu` block. */
export const MODAL_MANUAL = [
  "From the repo's devenv shell (modal is on its PATH), in nushell:",
  "",
  "```nu",
  "with-env {…} { modal volume delete -y cr-lab-hf-cache; modal volume list }",
  "```",
  "",
  "The list afterwards should not show `cr-lab-hf-cache`.",
].join("\n");

/** An old `--manual`: one command, no fence, as DASHBOARD.md's example wrote it. */
export const LEGACY_MANUAL = "cd servers/billing; secretspec set STRIPE_TEST_KEY";

/** Fleet infra-coordinator's A22 (d66, 2026-10-02), as a coordinator wrote it: four nushell command lines, no fence. */
export const A22_MANUAL = [
  "op run --env-file=/home/luizrocha/.local/state/infra-coordinator/deploy.env -- sh -c 'psql \"$NEON_APP_URL\" -X -f /tmp/b168/ca1116-dryrun.sql'",
  "op run --env-file=/home/luizrocha/.local/state/infra-coordinator/deploy.env -- sh -c 'psql \"$NEON_APP_URL\" -X -A -t -q -f /tmp/b168/ca1116-ids.sql' | save -f /tmp/b168/ca1116-ids.txt",
  "open /tmp/b168/ca1116-ids.txt | lines | length",
  "cd ~/repos/coelhorocha/custom-mcp-servers/servers/case-analysis; secretspec run -- sh -c 'for id in $(cat /tmp/b168/ca1116-ids.txt); do node tasks/reprocess.ts --prod --file \"$id\" || echo \"FAILED $id\"; done'",
].join("\n");

/**
 * The coordinator's view for the code blocks' tests and screenshots: an action with Luiz's Modal clean-up
 * in the format (A2), an action with an old one-command `--manual` (A3), one whose old `--manual` is a
 * sentence (A4), and a roadblock whose detail carries a block.
 */
export function codeView(now: number): View {
  const view = coordinatorView(now);
  const decisions = Array.isArray(view["decisions"]) ? view["decisions"] : [];
  const roadblocks = Array.isArray(view["roadblocks"]) ? view["roadblocks"] : [];

  return {
    ...view,
    decisions: [
      ...decisions,
      { id: "a8", ref: "A2", kind: "action", title: "Delete the lab's HF cache volume", question: "Delete the `cr-lab-hf-cache` volume on Modal?", why: "It holds 40 GB of stale weights; the lab re-downloads what it needs.", status: "open", blocking: false, asks: "user", opened: before(now, 12), manual: MODAL_MANUAL, options: [] },
      { id: "a9", ref: "A3", kind: "action", title: "Set the Stripe test key", question: "Set the Stripe test key in the billing server's secrets.", status: "open", blocking: false, asks: "user", opened: before(now, 11), manual: LEGACY_MANUAL, options: [] },
      { id: "a10", ref: "A4", kind: "action", title: "Rotate the webhook secret", question: "Rotate the webhook secret.", status: "open", blocking: false, asks: "user", opened: before(now, 10), manual: "Open the Stripe dashboard, Developers, Webhooks, and roll the secret.", options: [] },
    ],
    roadblocks: [...roadblocks, { id: "r3", ref: "R3", title: "Lab volume full", severity: "warning", needs: "the old cache deleted (A2)", since: before(now, 12), resolved: false, detail: "The volume is at 98%:\n\n```nu\nmodal volume list | where name =~ hf\n```", decision: "a8" }],
  };
}

/** The coordinator's conversation with a worker's message that carries a command in a block, and a message that looks like HTML. */
export function codeChat(now: number): Message[] {
  return [
    ...coordinatorChat(now),
    { id: 6, at: before(now, 3), from: "a2", to: ["user"], text: "Checked the volume with `modal volume list`:\n\n```nu\nmodal volume list | where name =~ hf | get name\n```\n\nOnly `cr-lab-hf-cache` matches." },
    { id: 7, at: before(now, 2), from: "user", to: ["coordinator"], text: "<b>not bold</b> and <script>alert(1)</script>", author: "luiz@example.com" },
  ];
}
