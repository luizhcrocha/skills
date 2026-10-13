/**
 * References in words a fleet wrote ("D18", "G26", "Infra's d172, question 2", "read the bench design (d30)"):
 * a row of a ledger named so the reader need not remember it, shown as a link to that row wherever the page
 * shows the words. Two halves, and every place of the page goes through both:
 *
 * `refRuns` splits words into runs. A reference is a row's number (a capital and digits: a decision's D, A, I,
 * S, G, N or P, a standing approval's K, a link's L, a roadblock's R), a row's own id as written (`d30`,
 * `deploy-0067`) when `isId` says the fleet whose words they are has a row of exactly that id, or a number or
 * an id with a fleet named before it ("infra's", any case, a fleet's id or name this page knows; the number or
 * id then in any case). A question named after it ("question 2", "Q2") goes with it. Words in a longer word, a
 * path, a file name, a version, an address or code are never one, and a short word standing alone (`D1`, `s3`)
 * is one only in a decision's own words (`every`).
 *
 * `targetsOf` says which rows a reference names on this page (`RefTarget`), from what the page holds: its own
 * ledger's rows, and on a manager's page each fleet's as its summary carries them. An id is looked up only in
 * the ledger of the fleet whose words they are; a reference that names no row stays plain text.
 */
import { Core, type Coordinator, type JsonRecord, type State } from "./core.ts";

/** A run of words: plain text, or a row's number or id, the fleet named before it, and a question named after it. */
export type RefRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly num: string; readonly fleet: string | null; readonly question: number | null; readonly text: string };

/** A fleet this page knows: its id, and the names it may be called by. */
export interface KnownFleet {
  readonly id: string;
  readonly names: readonly string[];
}

/**
 * `text` as runs, each reference its own run; `fleets`: the fleets whose name may come before one; `isId`:
 * whether a word is a row's id in the ledger of the fleet whose words these are; `every`: whether a short word
 * standing alone (a letter and one digit: `D1`, `s3`) is a reference too. It is one only in a decision's own
 * words, where the page always linked a decision's number; anywhere else `D1`, `R2` and `S3` are a database, a
 * bucket and a store far more often than a row, and the machine issues no one-digit number. A short one with
 * its fleet named ("ui's G6") is a reference everywhere.
 *
 * A range or a list whose every part is a row's number or id ("D30-D32", "D62/D65", "D41/d69") is each part a
 * reference; a word after a slash is one nowhere else (a path). The page and a decision's body frame both run
 * it (the frame its own source), so it uses nothing outside itself.
 */
export function refRuns(text: string, fleets: readonly KnownFleet[] = [], isId: (word: string) => boolean = () => false, every = false): RefRun[] {
  /* A word that may be a row's number or id: a letter, then letters, digits, '_' or '-', ending in a letter or a
     digit. Not inside a longer word (in any script), a file name, a version, a query or an address. */
  const CANDIDATE = /(?<![\p{L}\p{N}\p{M}_.@#=?&-])([A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)(?![\p{L}\p{N}\p{M}_-]|\.[\p{L}\p{N}])/gu;
  /* A row's own number: a decision's, a standing approval's (K), a link's (L), a roadblock's (R). The one place
     that says what a number is: `isNumber` asks it. */
  const NUMBER = /^[DAISGPNKLR]\d+$/u;
  /* A short word: a letter and one digit. */
  const SHORT = /^[A-Za-z]\d$/u;
  /* The word just before a number, possibly possessive: "pipeline's ", "Infra ". */
  const FLEET_BEFORE = /([A-Za-z0-9][\w.@-]*?)(?:'s|’s)?\s+$/u;
  /* How far back a fleet's name is looked for: a name and its space are shorter, and the look stays the same
     work however long the words before are. */
  const NAME_SPAN = 80;
  /* A question named right after a number: ", question 2", " Q2". */
  const QUESTION_AFTER = /^,?\s+(?:question\s+|Q)(\d+)(?![A-Za-z0-9_])/iu;
  /* Words that are code or an address, where nothing is a reference: a fenced block (to its end, or the text's),
     inline code, a URL. */
  const SKIPPED = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gu;
  const skipped = [...text.matchAll(SKIPPED)].map((m) => [m.index, m.index + m[0].length] as const);

  /* The fleet `word` names, by its id or a name, any case. */
  const fleetNamed = (word: string): string | null => {
    const w = word.toLowerCase();

    return fleets.find((f) => f.id.toLowerCase() === w || f.names.some((n) => n.toLowerCase() === w))?.id ?? null;
  };

  /* Whether `word` is a row's number or id, short or not: an id holds a digit (a ledger has rows whose id is an ordinary word). */
  const row = (word: string): boolean => NUMBER.test(word) || (/\d/u.test(word) && isId(word));

  const out: RefRun[] = [];
  let at = 0;
  /* The last word that was a row's number or id: where it ended and the fleet it was read in, for the word a slash joins to it. */
  let listEnd = -1;
  let listFleet: string | null = null;

  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;
    const word = m[1] ?? "";
    const joined = text[start - 1] === "/";

    if (start < at || !/\d/u.test(word) || (joined && listEnd !== start - 1) || skipped.some(([from, to]) => start >= from && start < to)) continue;
    const back = Math.max(at, start - NAME_SPAN);
    const found = joined ? null : FLEET_BEFORE.exec(text.slice(back, start));
    /* A name the look cut in two is no name. */
    const before = found && !(found.index === 0 && back > at && /[\w.@-]/u.test(text[back - 1] ?? "")) ? found : null;
    const named = before ? fleetNamed(before[1] ?? "") : null;
    const fleet: string | null = joined ? listFleet : named;
    /* The word's parts: the ends of a range when each is a row's number or id, else the word itself, which with a fleet named is read in that fleet whatever it is. */
    const ends = row(word) ? [word] : word.split("-");
    const parts = ends.every(row) ? ends : named !== null ? [word] : [];
    let from = named !== null && before ? back + before.index : start;
    let part = start;

    for (const [i, num] of parts.entries()) {
      const stop = part + num.length;

      if (every || fleet !== null || !SHORT.test(num)) {
        const after = i === parts.length - 1 ? QUESTION_AFTER.exec(text.slice(stop)) : null;
        const end = stop + (after ? after[0].length : 0);

        if (from > at) out.push({ kind: "text", text: text.slice(at, from) });
        out.push({ kind: "ref", num, fleet, question: after ? Number(after[1]) : null, text: text.slice(from, end) });
        at = end;
      }

      part = stop + 1;
      from = part;
    }

    if (parts.length > 0) {
      listEnd = start + word.length;
      listFleet = fleet;
    }
  }

  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });

  return out;
}

/** Whether `word` is a row's own number standing alone, as {@link refRuns} reads one (short ones too). */
export const isNumber = (word: string): boolean => {
  const [run, ...rest] = refRuns(word, [], undefined, true);

  return rest.length === 0 && run?.kind === "ref" && run.num === word;
};

/** The kinds of row a reference may name. */
export type RefKind = "decision" | "approval" | "link" | "roadblock" | "step" | "milestone" | "worker" | "kept";

/** What each kind is called in a tip. */
export const KIND_WORD: Readonly<Record<RefKind, string>> = {
  decision: "decision",
  approval: "standing approval",
  link: "link",
  roadblock: "roadblock",
  step: "plan step",
  milestone: "milestone",
  worker: "worker",
  kept: "held for later",
};

/** A row a reference names, as this page knows it. */
export interface RefTarget {
  readonly kind: RefKind;
  /** The fleet that holds it, on a manager's page; null for the page's own ledger. */
  readonly fleet: string | null;
  /** Its id in its ledger; "" when the page knows only its number (another fleet's roadblock). */
  readonly id: string;
  /** Its number; "" when it has none (a plan step, a worker). */
  readonly num: string;
  readonly title: string;
  /** Where it stands, in a word or two ("open", "decided", "running"); "" when the page does not know. */
  readonly state: string;
  /** Its place on the page of the fleet that holds it. */
  readonly hash: string;
}

/** A ledger's rows a reference may name, by id and by number. */
export interface RefRows {
  readonly byId: ReadonlyMap<string, RefTarget>;
  readonly byNum: ReadonlyMap<string, RefTarget>;
}

/** An id the ledger takes (`fleet/src/ledger/validate.ts` `ID`), which is also what an address may hold. */
const ID = /^[A-Za-z0-9_.-]+$/u;

const NO_ROWS: RefRows = { byId: new Map(), byNum: new Map() };

/** `list` by id and by number: the first row of an id or a number names it, so the list's order is the kinds' order. */
function rowsOf(list: readonly RefTarget[]): RefRows {
  const byId = new Map<string, RefTarget>();
  const byNum = new Map<string, RefTarget>();

  for (const t of list) {
    if (t.id !== "" && !byId.has(t.id)) byId.set(t.id, t);

    if (t.num !== "" && !byNum.has(t.num)) byNum.set(t.num, t);
  }

  return { byId, byNum };
}

/** A link's place in the Links view: `link-<fleet>/<id>` (the manager's page lists every fleet's), `link-<id>` off the hub. */
export const linkAnchor = (l: { readonly fleet: string; readonly id: string }): string => "link-" + (l.fleet ? l.fleet + "/" : "") + l.id;

/** The links of `state` that `fleet` named (null: this page's own ledger), as rows. */
function linkRows(state: State, fleet: string | null): RefTarget[] {
  const theirs = new Set(state.coordinators.map((c) => c.id));

  return state.links.flatMap((l): RefTarget[] => {
    const holder = theirs.has(l.fleet) ? l.fleet : null;

    if (holder !== fleet || !ID.test(l.id) || (l.fleet !== "" && !/^[A-Za-z0-9_.@-]+$/u.test(l.fleet))) return [];

    return [{ kind: "link", fleet, id: l.id, num: l.ref ?? "", title: l.title, state: l.done ? "done" : "", hash: "#" + linkAnchor(l) }];
  });
}

/** The rows of this page's own ledger a reference may name: when two kinds share an id, a decision's comes first, then a link's, a roadblock's, an approval's, the plan's, a worker's, a kept note's. */
export function ownRows(state: State): RefRows {
  const ok = <T extends { readonly id: string }>(rows: readonly T[]): T[] => rows.filter((r) => ID.test(r.id));
  const steps = state.roadmap.flatMap((ms) => ms.steps);

  return rowsOf([
    ...ok(state.decisions).map((d): RefTarget => ({ kind: "decision", fleet: null, id: d.id, num: d.ref ?? "", title: d.title, state: d.status, hash: Core.decisionHref(d.id) })),
    ...linkRows(state, null),
    ...ok(state.roadblocks).map((r): RefTarget => ({ kind: "roadblock", fleet: null, id: r.id, num: r.ref ?? "", title: r.title, state: r.resolved ? "resolved" : "open", hash: "#roadblock-" + r.id })),
    ...ok(state.approvals).map((a): RefTarget => ({ kind: "approval", fleet: null, id: a.id, num: a.id, title: a.rule, state: a.status, hash: "#approval-" + a.id })),
    ...ok(steps).map((s): RefTarget => ({ kind: "step", fleet: null, id: s.id, num: "", title: s.title ?? "", state: s.status ?? "", hash: "#step-" + s.id })),
    ...ok(state.roadmap).map((ms): RefTarget => ({ kind: "milestone", fleet: null, id: ms.id, num: "", title: ms.title, state: "", hash: "#milestone-" + ms.id })),
    ...ok(state.agents).map((a): RefTarget => ({ kind: "worker", fleet: null, id: a.id, num: "", title: a.name === a.id ? a.task : a.name, state: a.status, hash: "#agent-" + a.id })),
    ...ok(state.kept).map((k): RefTarget => ({ kind: "kept", fleet: null, id: k.id, num: "", title: k.text, state: "", hash: "#kept-" + k.id })),
  ]);
}

/** A text field of an index row; "" when it is not text. */
const field = (row: JsonRecord, key: string): string => {
  const v = row[key];

  return v === String(v) ? v : "";
};

/** A fleet's decisions among the rows of its search index (`fleet/src/page/view.ts` `searchIndex`), closed ones too. */
function indexDecisions(fleet: string, index: readonly JsonRecord[]): RefTarget[] {
  return index.flatMap((x): RefTarget[] => {
    const id = /^#decision\/(.+)$/u.exec(field(x, "hash"))?.[1] ?? "";

    return x["group"] === "decisions" && ID.test(id) ? [{ kind: "decision", fleet, id, num: field(x, "ref"), title: field(x, "title"), state: field(x, "hint"), hash: Core.decisionHref(id) }] : [];
  });
}

/**
 * The rows of fleet `c` a reference may name on a manager's page, from what its summary carries: its decisions
 * (closed ones too), its links, its roadblocks by number (the index has no roadblock's id), its plan's steps and
 * its workers. Its standing approvals, milestones and kept notes are not carried, so they stay text.
 */
export function fleetRows(state: State, c: Pick<Coordinator, "id" | "index">): RefRows {
  const of = (group: string): JsonRecord[] => c.index.filter((x) => x["group"] === group);

  const byId = (kind: "step" | "worker", at: string, x: JsonRecord): RefTarget[] =>
    ID.test(field(x, "ref")) ? [{ kind, fleet: c.id, id: field(x, "ref"), num: "", title: field(x, "title"), state: field(x, "hint"), hash: at + field(x, "ref") }] : [];

  return rowsOf([
    ...indexDecisions(c.id, c.index),
    ...linkRows(state, c.id),
    ...of("roadblocks").map((x): RefTarget => ({ kind: "roadblock", fleet: c.id, id: "", num: field(x, "ref"), title: field(x, "title"), state: field(x, "hint"), hash: "#roadblocks" })),
    ...of("plan").flatMap((x) => byId("step", "#step-", x)),
    ...of("workers").flatMap((x) => byId("worker", "#agent-", x)),
  ]);
}

/** What a page holds of the ledgers a reference may name: its own rows, and on a manager's page each fleet's. */
export interface RefBook {
  readonly own: RefRows;
  /** Each fleet a manager's page serves. */
  readonly fleets: ReadonlyMap<string, RefRows>;
  /** The fleets the registry keeps but no longer serves: their decisions. */
  readonly stopped: ReadonlyMap<string, RefRows>;
  /** The fleet this page is, as the hub names it; "" when it is the manager's, or off the hub. */
  readonly here: string;
}

/** The book of `state`. */
export function refBook(state: State): RefBook {
  return {
    own: ownRows(state),
    fleets: new Map(state.coordinators.map((c) => [c.id, fleetRows(state, c)])),
    stopped: new Map((state.stopped ?? []).map((s) => [s.id, rowsOf(indexDecisions(s.id, s.index))])),
    here: state.role === "manager" ? "" : (state.fleet ?? ""),
  };
}

/** Whose words they are, as the book names ledgers: null for the page's own, else a fleet a manager's page serves. */
export function scopeOf(book: RefBook, fleet: string | null | undefined): string | null {
  return fleet && fleet !== book.here && book.fleets.has(fleet) ? fleet : null;
}

/** The rows of `scope` (null: the page's own ledger). */
export const rowsIn = (book: RefBook, scope: string | null): RefRows => (scope === null ? book.own : (book.fleets.get(scope) ?? NO_ROWS));

/** Whether `word` is a row's id in `scope`'s ledger, exactly as written: what `refRuns` asks of a word that is no number. */
export const isRowId = (book: RefBook, scope: string | null, word: string): boolean => rowsIn(book, scope).byId.has(word);

/** A word written as a decision's: its number (a decision kind's capital and digits), or the id the fleet gives one (`d172`). */
const DECISION = /^(?:[DAISGPN]|d)\d+$/u;

/** The row `word` names among `rows`, any case: by its number, else its id. */
function anyCase(rows: RefRows, word: string): RefTarget | undefined {
  const w = word.toLowerCase();
  const find = (map: ReadonlyMap<string, RefTarget>): RefTarget | undefined => [...map].find(([k]) => k.toLowerCase() === w)?.[1];

  return rows.byNum.get(word) ?? rows.byId.get(word) ?? find(rows.byNum) ?? find(rows.byId);
}

/**
 * The rows the reference `num` names, in words `scope` wrote (null: this page's own ledger), with `named` the
 * fleet said before it, if one was. Nothing when it names no row the page knows: it stays text.
 *
 * - With a fleet named ("infra's d172"): that fleet's row by number or id, any case, and nothing when its
 *   ledger, which the page holds, has no such row ("perf p95"). A fleet whose ledger the page does not hold (a
 *   fleet's page knows another only by name) still links when the word is written as a decision's (its number,
 *   or a `d172`): a decision of that fleet, which its own page opens by id or number or says it has not.
 * - An id, or a number of `scope`'s own ledger: that row, an id before a number.
 * - Any other number: on a manager's page, every ledger that holds it, this page's first; a number of the
 *   machine has one holder, an old one (from before the machine's numbers) may have several, each shown.
 */
export function targetsOf(book: RefBook, scope: string | null, named: string | null, num: string): readonly RefTarget[] {
  if (named !== null) {
    const fleet = named === book.here ? null : named;
    const held = fleet === null ? book.own : (book.fleets.get(fleet) ?? book.stopped.get(fleet));
    const found = held ? anyCase(held, num) : undefined;

    if (found) return [found];

    return fleet !== null && held === undefined && DECISION.test(num) ? [{ kind: "decision", fleet, id: num, num: "", title: "", state: "", hash: Core.decisionHref(num) }] : [];
  }

  const rows = rowsIn(book, scope);
  const mine = rows.byId.get(num) ?? rows.byNum.get(num);

  if (scope !== null && mine) return [mine];

  if (!isNumber(num)) return mine ? [mine] : [];
  const here = scope === null ? mine : (book.own.byId.get(num) ?? book.own.byNum.get(num));
  const others = [...book.fleets, ...book.stopped].flatMap(([, held]) => held.byNum.get(num) ?? []);

  return [...(here ? [here] : []), ...others];
}

/** What a page says of where it is, for a reference's address. */
export interface RefPlace {
  /** Whether this is a manager's page: it opens a fleet's decision itself, as `#decision/<fleet>/<id>`. */
  readonly manager: boolean;
  /** The manager's page's address; null when there is no manager. */
  readonly managerPage: string | null;
  /** A fleet's own page's address; null off the hub. */
  readonly fleetPage: ((fleet: string) => string) | null;
}

/**
 * The address a reference to `t` opens from this page: a row of this page's ledger, and a link (the manager's
 * Links view lists every fleet's), at its own place here; another fleet's decision on the manager's page
 * (`#decision/<fleet>/<id>`, from a fleet's page through the manager's address); another fleet's roadblock,
 * step or worker on that fleet's own page. Null when this page cannot reach it.
 */
export function refHref(t: RefTarget, place: RefPlace): string | null {
  if (t.fleet === null || t.kind === "link") return t.hash;

  if (t.kind !== "decision") return place.fleetPage ? place.fleetPage(t.fleet) + t.hash : null;
  const there = Core.decisionHref(t.fleet + "/" + t.id);

  if (place.manager) return there;

  return place.managerPage !== null ? place.managerPage + there : place.fleetPage ? place.fleetPage(t.fleet) + t.hash : null;
}

/** A tip's words cut to about 200 characters, and closed by one full stop. */
export function clipped(words: string): string {
  const t = words.trim().replace(/[.\s]+$/u, "");

  return ([...t].length > 200 ? [...t].slice(0, 200).join("").replace(/\s+\S*$/u, "") + "…" : t) + ".";
}

/** What a tip says of a row from what the book holds: its number or id, its title, the fleet that holds it, what it is and where it stands. */
export function targetTip(t: RefTarget): string {
  const head = [t.num || t.id, t.title].filter(Boolean).join(" ");
  const stands = [KIND_WORD[t.kind], t.state].filter(Boolean).join(", ");

  return clipped(`${head}${t.fleet ? `, in ${t.fleet}` : ""}: ${stands}`);
}
