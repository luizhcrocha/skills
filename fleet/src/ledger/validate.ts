/**
 * The final check every write passes (Python's `render_dashboard.validate` and `decisions.validate`): the
 * statuses, the ids, the names a mention must tell apart, what steps, roadblocks and decisions point at.
 * It fills the defaults it checks, so an older ledger comes out complete after one command. The first
 * fault refuses the write, worded as Python words it.
 */
import { invalid, type Refusal } from "../errors.ts";
import { pyStr } from "../json.ts";
import type { Ledger } from "./model.ts";

/** The fleet's statuses. */
export const STATUSES = ["blocked", "done", "paused", "running"] as const;

/** A worker's statuses. */
export const AGENT_STATUSES = ["blocked", "done", "failed", "queued", "running", "stopped"] as const;

/** A step's statuses. */
export const STEP_STATUSES = ["blocked", "current", "done", "pending"] as const;

/** The kinds of decision the Python twin has too: the ones `show` and the CLI's choices name. */
export const SHARED_KINDS = ["decision", "input", "secret", "action", "grill", "notice"] as const;

/** What asks the user to choose or give: what a standing approval may come from, and what counts toward the advisor rule. */
export const CHOICE_KINDS = ["decision", "input", "grill"] as const;

/** Another fleet's decision, as an approval row stores it: `FLEET/DECISION`. */
export const ELSEWHERE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** A standing approval's statuses. */
export const APPROVAL_STATUSES = ["active", "revoked"] as const;

/** The kinds of decision; `permission` is TypeScript's alone (SPEC.md, Permission grants). */
export const KINDS = [...SHARED_KINDS, "permission"] as const;

/** A decision's statuses. */
export const DECISION_STATUSES = ["open", "decided", "withdrawn"] as const;

/** A grilling question's statuses. */
export const QUESTION_STATUSES = ["open", "answered", "dropped"] as const;

/** How a fleet's workers share the repository (`set --workspaces`): a jj workspace each, or one working copy. */
export const WORKSPACE_MODES = ["isolated", "shared"] as const;

/** Who looks at a decision first. */
export const ASKS = ["user", "manager"] as const;

/** An id: letters, digits, `_`, `.`, `-`. */
export const ID = /^[A-Za-z0-9_.-]+$/;

const RESERVED = new Set(["user", "coordinator"]);

function list(values: readonly string[]): string {
  return `[${values.map((v) => pyStr(v)).join(", ")}]`;
}

function has(values: readonly string[], value: string | undefined): boolean {
  return value !== undefined && values.includes(value);
}

function controlled(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;

    if (code < 32 || (code >= 127 && code < 160) || char === "\u2028" || char === "\u2029") return true;
  }

  return false;
}

/** Why worker `id` cannot be called `name` in `ledger` (a control character, a chat participant's name,
 * another worker's id or name), or undefined when it can; worded as {@link validate} words it. */
export function nameRefusal(ledger: Ledger, id: string, name: string): string | undefined {
  if (controlled(name)) return `agent ${id} name has a control character`;
  const label = name.toLowerCase();

  if (RESERVED.has(label)) return `agent ${id} cannot be called '${label}': that name is a chat participant`;
  const other = ledger.agents.find((a) => a.id !== id && (a.id.toLowerCase() === label || a.name.toLowerCase() === label));

  return other === undefined ? undefined : `agent ${id} is called '${label}', which is also agent ${other.id}; a mention could not tell them apart`;
}

/** The first fault in `ledger`, or undefined when it holds (the defaults are then filled). */
export function validate(ledger: Ledger): Refusal | undefined {
  if (!has(STATUSES, ledger.status)) return invalid(`status '${ledger.status}' not in ${list(STATUSES)}`);

  if (ledger.workspace_mode !== undefined && !has(WORKSPACE_MODES, ledger.workspace_mode)) {
    return invalid(`workspace_mode '${ledger.workspace_mode}' not in ${list(WORKSPACE_MODES)}`);
  }

  const ids = new Set<string>();

  for (const a of ledger.agents) {
    if (!has(AGENT_STATUSES, a.status)) {
      return invalid(`agent ${a.id} status '${a.status}' not in ${list(AGENT_STATUSES)}`);
    }

    if (ids.has(a.id)) return invalid(`duplicate agent id '${a.id}'`);

    if (!ID.test(a.id)) {
      return invalid(`agent id ${pyStr(a.id)} should be letters, digits, '_', '.', or '-', so it can be mentioned in the chat`);
    }

    if (controlled(a.name)) return invalid(`agent ${a.id} name has a control character`);
    ids.add(a.id);
    a.tokens ??= 0;
    a.duration_ms ??= 0;
    a.skill ??= "none";
    a.model ??= "opus";
    a.brief ??= "";
    a.report ??= "";
    a.rounds ??= 1;
  }

  const taken = new Map<string, string>();

  for (const a of ledger.agents) {
    for (const label of new Set([a.id.toLowerCase(), a.name.toLowerCase()])) {
      if (RESERVED.has(label)) return invalid(`agent ${a.id} cannot be called '${label}': that name is a chat participant`);
      const other = taken.get(label);

      if (other !== undefined) {
        return invalid(`agent ${a.id} is called '${label}', which is also agent ${other}; a mention could not tell them apart`);
      }

      taken.set(label, a.id);
    }
  }

  const manager = ledger.role === "manager";

  for (const m of ledger.roadmap) {
    for (const s of m.steps) {
      if (!has(STEP_STATUSES, s.status)) return invalid(`step ${s.id} status not in ${list(STEP_STATUSES)}`);

      // A manager's step names the coordinator whose turn it is, and coordinators come and go.
      if (s.agent !== undefined && s.agent !== null && s.agent !== "" && !ids.has(s.agent) && !manager) {
        return invalid(`step ${s.id} points at unknown agent '${s.agent}'`);
      }
    }
  }

  return validateDecisions(ledger);
}

function validateDecisions(ledger: Ledger): Refusal | undefined {
  ledger.decisions ??= [];
  const rows = ledger.decisions;
  const ids = new Set<string>();

  for (const d of rows) {
    if (!ID.test(d.id)) return invalid(`decision id ${pyStr(d.id)} should be letters, digits, '_', '.', or '-'`);

    if (ids.has(d.id)) return invalid(`duplicate decision id '${d.id}'`);

    if (rows.some((o) => o !== d && o.ref === d.id)) {
      return invalid(`decision id '${d.id}' is another decision's number; pick another id`);
    }

    if (!has(KINDS, d.kind)) return invalid(`decision ${d.id} kind '${d.kind}' not in ${list(KINDS)}`);

    if (!has(DECISION_STATUSES, d.status)) {
      return invalid(`decision ${d.id} status '${d.status}' not in ${list(DECISION_STATUSES)}`);
    }

    d.options ??= [];

    if (d.kind === "grill") {
      d.questions ??= [];

      if (!d.questions.every((q) => has(QUESTION_STATUSES, q.status))) {
        return invalid(`grilling ${d.id} has a question without id, title, or a status in ${list(QUESTION_STATUSES)}`);
      }
    }

    ids.add(d.id);
    d.asks ??= "user";

    if (!has(ASKS, d.asks)) return invalid(`decision ${d.id} asks '${d.asks}', not one of ${list(ASKS)}`);
    d.blocking ??= false;
    d.page ??= true;
    d.body ??= false;
    d.why ??= null;
    d.recommend ??= null;
    d.reason ??= null;
    d.secret ??= null;
    d.manual ??= null;
    d.agent ??= null;
    d.supersedes ??= null;
    d.change ??= null;
    d.step ??= null;
    d.milestone ??= null;
    d.answer ??= null;
    d.resolution ??= null;
    d.revised ??= null;
    d.closed ??= null;

    if ((d.held !== undefined && d.held !== null) || (d.held_at !== undefined && d.held_at !== null)) {
      if (d.held === undefined || d.held === null || d.held === "" || d.held_at === undefined || d.held_at === null) {
        return invalid(`decision ${d.id} is held without its reason and when (held, held_at)`);
      }

      if (d.status !== "open") return invalid(`decision ${d.id} is ${d.status} and still held`);
    }
  }

  for (const d of rows) {
    if (d.supersedes !== undefined && d.supersedes !== null && d.supersedes !== "" && !ids.has(d.supersedes)) {
      return invalid(`decision ${d.id} supersedes unknown decision '${d.supersedes}'`);
    }
  }

  for (const r of ledger.roadblocks) {
    if (r.decision !== undefined && r.decision !== null && r.decision !== "" && !ids.has(r.decision)) {
      return invalid(`roadblock ${r.id} points at unknown decision '${r.decision}'`);
    }
  }

  return validateApprovals(ledger, ids);
}

/** approvals[] (the standing approvals the user gave once) and the notices done under them. */
function validateApprovals(ledger: Ledger, decisions: ReadonlySet<string>): Refusal | undefined {
  const approvals = new Set<string>();

  for (const a of ledger.approvals ?? []) {
    if ([a.id, a.rule, a.by, a.ref, a.added, a.status].some((v) => v === "")) {
      return invalid(`approval ${a.id === "" ? "?" : a.id} needs id, rule, by, ref, added and status`);
    }

    if (!/^K[0-9]+$/u.test(a.id)) return invalid(`approval id ${pyStr(a.id)} should be K and a number`);

    if (approvals.has(a.id)) return invalid(`duplicate approval id '${a.id}'`);

    if (!has(APPROVAL_STATUSES, a.status)) return invalid(`approval ${a.id} status '${a.status}' not in ${list(APPROVAL_STATUSES)}`);

    if (a.ref.includes("/") && !ELSEWHERE.test(a.ref)) return invalid(`approval ${a.id} comes from ${pyStr(a.ref)}: another fleet's decision is FLEET/DECISION`);

    if (!a.ref.includes("/") && !decisions.has(a.ref)) return invalid(`approval ${a.id} comes from unknown decision '${a.ref}'`);

    if (a.question !== undefined && !/^q[0-9]+$/u.test(a.question)) return invalid(`approval ${a.id}'s question ${pyStr(a.question)} should be q and a number`);
    approvals.add(a.id);
  }

  for (const d of ledger.decisions ?? []) {
    if (d.kind !== "notice") continue;

    if (d.under === undefined || !approvals.has(d.under)) return invalid(`notice ${d.id} is done under unknown approval '${d.under ?? "None"}'`);

    if (d.undo === undefined || d.undo.trim() === "") return invalid(`notice ${d.id} says no way to undo it (undo)`);
  }

  return undefined;
}
