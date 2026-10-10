/**
 * The finder's record pane, pure: what the highlighted row stands for, read from the page's state as it is
 * now. A decision says its question, its options with the recommended one, its status and who it is for; a
 * worker its status, task and lane; a message the one before and after it in its own conversation; a plan
 * step its milestone and status; a link its address and whether it answers; the rest what their row knows.
 * A place the state no longer holds keeps the words its row had.
 */
import { Core, type Decision, type FindRow, type Go, type Message, type State } from "./core.ts";
import { groupOf } from "./find.ts";

/** A status said as a pill: its words and the pill's class (running, blocked, open, done, failed...). */
export interface Tone {
  readonly text: string;
  readonly tone: string;
}

/** A fact of the record: a label and its value. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** An option of a decision. */
export interface Choice {
  readonly id: string;
  readonly label: string;
  readonly recommended: boolean;
}

/** A line of a message's context; `hit`, the message found. */
export interface Line {
  readonly id: number;
  readonly who: string;
  readonly text: string;
  readonly hit: boolean;
}

/** What the pane shows of a row. */
export interface RowRecord {
  /** The kind, as a heading ("Decision", "Worker", "Plan step"). */
  readonly kind: string;
  readonly ref: string;
  readonly title: string;
  readonly pills: readonly Tone[];
  /** The record's first line: a decision's question, a worker's task, a roadblock's detail. */
  readonly lead: string;
  readonly options: readonly Choice[];
  readonly facts: readonly Fact[];
  readonly thread: readonly Line[];
  /** The Ctrl/⌘+Enter action in words; null when it does what Enter does. */
  readonly second: string | null;
}

const one = (t: string | null | undefined): string => String(t ?? "").replace(/\s+/gu, " ").trim();

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Facts with a value, in order. */
const factsOf = (pairs: readonly (readonly [string, string | null | undefined])[]): Fact[] => pairs.flatMap(([label, v]) => (one(v) ? [{ label, value: one(v) }] : []));

/** Ctrl/⌘+Enter in words: a new tab where it opens one Enter does not. */
function secondOf(go: Go): string | null {
  if (go.kind === "message") return null;

  if (go.kind === "url") return /^https?:/u.test(go.url) ? null : "New tab";

  return "New tab";
}

/** The decision a finder row's id names: this page's, or a fleet's ("<fleet>/<id>") as the manager holds it. */
export type DecisionNamed = (id: string) => Decision | undefined;

/** The decision `id` names in `state`, found by going through its lists. */
export function decisionOf(state: Partial<State>, id: string): Decision | undefined {
  const theirs = Core.parseFleetDecision(id);

  if (!theirs) return state.decisions?.find((d) => d.id === id);
  const fleet = state.coordinators?.find((c) => c.id === theirs.fleet);

  return fleet?.decisions.find((d) => d.id === theirs.id) ?? state.decisions?.find((d) => d.id === theirs.id && d.fleet === theirs.fleet);
}

/** What the row says alone, for a place the state does not describe further. */
function plain(row: FindRow, kind: string): RowRecord {
  return { kind, ref: row.ref, title: row.title, pills: row.hint ? [{ text: row.hint, tone: row.hint }] : [], lead: row.sub, options: [], facts: [], thread: [], second: secondOf(row.go) };
}

/** A kind's heading where its one word is not enough. */
const KIND_HEADINGS: ReadonlyMap<string, string> = new Map([
  ["plan", "Plan step"],
  ["log", "Log event"],
]);

/** The record of finder row `row`, from `state` and the chat's `messages` as they are now; `named` finds a decision (the page's own index, else a pass through the lists). */
export function recordOf(row: FindRow, state: Partial<State>, messages: Iterable<Message> | null | undefined, named: DecisionNamed = (id) => decisionOf(state, id)): RowRecord {
  const base = plain(row, KIND_HEADINGS.get(row.group) ?? cap(groupOf(row.group).one));
  const name = (id: string | null | undefined): string => (id ? (state.agents?.find((a) => a.id === id)?.name ?? id) : "");
  const go = row.go;

  if (go.kind === "decision") {
    const d = named(go.id);

    if (!d) return { ...base, kind: "Decision" };
    const open = d.status === "open";
    const pills: Tone[] = [{ text: d.status, tone: d.status }];

    if (open && d.blocking) pills.push({ text: "blocking", tone: "blocking" });

    if (d.held) pills.push({ text: "held", tone: "held" });
    const qs = d.questions ?? [];

    return {
      ...base,
      kind: cap(Core.kindWord(d.kind)),
      ref: d.ref ?? row.ref,
      title: one(d.title),
      pills,
      lead: one(d.question),
      options: d.options.map((o) => ({ id: o.id, label: one(o.label), recommended: o.id === d.recommend })),
      facts: factsOf([
        ["For", Core.isNotice(d) ? "" : d.asks === "manager" ? "the manager" : "you"],
        ["Fleet", d.fleet],
        ["Raised by", name(d.agent)],
        ["Recommended", d.recommend && !d.options.length ? d.recommend : ""],
        ["Why", d.reason],
        ["Questions", qs.length ? `${String(qs.length)}, ${String(qs.filter((q) => q.status === "open").length)} open` : ""],
        ["Answer", open || Core.isNotice(d) ? "" : d.answer || d.resolution],
        ["Done under", d.under],
        ["Undo", d.undo],
        ["Held", d.held],
      ]),
    };
  }

  if (go.kind === "worker") {
    const a = state.agents?.find((x) => x.id === go.id);

    if (!a) return base;

    return {
      ...base,
      title: a.name,
      pills: a.status ? [{ text: a.status, tone: a.status }] : [],
      lead: one(a.task),
      facts: factsOf([
        ["Lane", a.lane.length ? a.lane.join(", ") : "none"],
        ["Milestone", state.roadmap?.find((m) => m.id === a.milestone)?.title ?? a.milestone],
        ["Model", a.model],
        ["Skill", a.skill],
      ]),
    };
  }

  if (go.kind === "message") {
    const all = [...(messages ?? [])].filter((m) => m.side === go.side).sort((a, b) => a.id - b.id);
    const at = all.findIndex((m) => m.id === go.id);

    if (at === -1) return base;
    const who = (m: Message): string => (m.from === "user" ? m.author || "you" : name(m.from));

    return {
      ...base,
      kind: "Message",
      lead: "",
      facts: factsOf([["Side chat", go.side === null ? "" : "#" + String(go.side)]]),
      thread: all.slice(Math.max(0, at - 1), at + 2).map((m) => ({ id: m.id, who: who(m), text: one(m.text), hit: m.id === go.id })),
    };
  }

  if (row.group === "plan") {
    const [mid = "", sid = ""] = row.key.slice(2).split("/");
    const ms = state.roadmap?.find((m) => m.id === mid);
    const st = ms?.steps.find((s) => s.id === sid);

    if (!ms || !st) return base;

    return { ...base, title: one(st.title), pills: st.status ? [{ text: st.status, tone: st.status }] : [], lead: "", facts: factsOf([["Milestone", ms.title], ["Worker", name(st.agent)]]) };
  }

  if (row.group === "links") {
    const l = state.links?.find((x) => "u:" + x.url === row.key);

    if (!l) return base;

    return {
      ...base,
      pills: l.reach !== "machine" ? [] : l.checking ? [{ text: "checking…", tone: "open" }] : [l.up ? { text: "up", tone: "done" } : { text: "down", tone: "failed" }],
      lead: one(l.for || l.note),
      facts: factsOf([["Address", l.url], ["Answers", l.reach === "machine" ? (l.checking ? "checking…" : l.up ? "yes" : "no") : l.reach === "file" ? "a file on this machine" : "not checked"], ["Kind", l.kind], ["Fleet", l.fleet]]),
    };
  }

  if (row.group === "roadblocks") {
    const r = state.roadblocks?.find((x) => "r:" + (x.id || x.ref || x.title) === row.key);

    if (!r) return base;

    return {
      ...base,
      pills: [r.resolved ? { text: "resolved", tone: "done" } : { text: "open", tone: "open" }, ...(r.severity ? [{ text: r.severity, tone: r.severity }] : [])],
      lead: one(r.detail),
      facts: factsOf([["Needs", r.needs], ["Worker", name(r.agent)]]),
    };
  }

  if (row.group === "coordinators") {
    const c = state.coordinators?.find((x) => "f:" + x.id === row.key);

    if (!c) return base;

    return { ...base, pills: c.status ? [{ text: c.status, tone: c.status }] : [], lead: one(c.now), facts: factsOf([["Goal", c.goal], ["Page", c.url]]) };
  }

  return { ...base, pills: [], lead: row.sub, facts: factsOf([["Where", row.hint]]) };
}
