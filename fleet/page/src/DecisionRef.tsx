/**
 * A reference in words a fleet wrote (refs.ts), as a link to the row it names: a decision's number or id to its
 * page, a standing approval's, a link's, a roadblock's, a plan step's or a kept note's to its place in its
 * view, a worker's to its sheet. On hover or focus a tip says what it is and where it stands (a decision's
 * title, its answer and when it was decided, and the question it names, for a grilling), and a tap on a phone
 * opens it. One this page cannot find stays plain text; on a manager's page a number names the fleet that
 * holds it, served or kept. Another fleet's decision ("Infra's d172") links to `#decision/<fleet>/<id>` on the
 * manager's page, and its tip is read when first wanted from that fleet's ledger through the hub
 * (`f/<fleet>/state.json`), kept for this page load.
 *
 * Two readings (`every`). A decision's own words (its question, why, an option's consequence, a reason: where
 * the page always linked a decision's number) link every number: a one-digit one too, and one several ledgers
 * hold once for each ("D29 in infra · D29 in agent-tools"). Everywhere else a short word standing alone (`D1`,
 * `s3`) and a number several ledgers hold stay text: in running words `D1` is a database far more often than a
 * decision, and a row of choices in the middle of a sentence reads as noise.
 *
 * `Refs` is words with their references linked; `RefsBeside` only the links, for words that are themselves a
 * row's tap target (a link in a link is no HTML); `Rich` draws its words through the same two.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { usePage } from "./bits.tsx";
import { Core, type Approval, type Decision, type Json } from "./core.ts";
import { fullTime } from "./format.ts";
import type { Model } from "./model.ts";
import { clipped, isRowId, refHref, refRuns, scopeOf, targetsOf, targetTip, type RefPlace, type RefRun, type RefTarget } from "./refs.ts";

let tips = 0;

/** Each fleet's decisions as its ledger holds them, fetched once a page load; null when it cannot be read. */
const ledgers = new Map<string, Promise<readonly Decision[] | null>>();

/** A response's JSON, or null when it is not ok. */
async function jsonOf(res: Response): Promise<Json | null> {
  if (!res.ok) return null;

  // SAFETY: the hub serves the fleet's state.json as it is, JSON; parseState checks its shape.
  return (await res.json()) as Json;
}

/** Fleet `fleet`'s decisions, read from `url` (its state.json) once. */
function decisionsOf(fleet: string, url: string): Promise<readonly Decision[] | null> {
  const held = ledgers.get(fleet);

  if (held) return held;

  const read = fetch(url, { cache: "no-store" })
    .then(jsonOf)
    .then((state) => {
      const parsed = state === null ? null : Core.parseState(state);

      return parsed ? parsed.decisions : null;
    })
    .catch(() => null);

  ledgers.set(fleet, read);

  return read;
}

/** The decision `num` names among `rows`: by its number, else its id, any case. */
function named(rows: readonly Decision[], num: string): Decision | undefined {
  const n = num.toLowerCase();

  return rows.find((d) => d.ref?.toLowerCase() === n) ?? rows.find((d) => d.id.toLowerCase() === n);
}

/**
 * What the tip says of decision `d`: its number and title, where it stands and when, and its answer; for a
 * question it names that a grilling holds, that question's title and answer instead of the whole answer.
 */
export function tipOf(d: Decision, question: number | null, fleet: string | null): string {
  const head = `${d.ref ?? d.id} ${d.title}${fleet ? `, in ${fleet}` : ""}`;
  const when = d.closed ? ` ${fullTime(d.closed)}` : "";
  const state = d.status === "decided" ? `decided${when}` : d.status === "withdrawn" ? `withdrawn${when}` : "still open";
  const q = question === null ? undefined : d.questions?.find((x) => x.id === "q" + String(question));

  if (q) return `${head}: ${state}. Question ${String(question)}, ${String(q.title ?? "")}: ${clipped(String(q.answer ?? q.status ?? "open"))}`;
  const asked = question === null ? "" : ` (question ${String(question)})`;

  return d.status === "decided" ? `${head}${asked}: ${state}: ${clipped(String(d.answer ?? d.resolution ?? ""))}` : `${head}${asked}: ${state}.`;
}

/** What the tip says of standing approval `a`: its rule, and when it was given or revoked. */
const approvalTip = (a: Approval): string =>
  `${a.id} standing approval: ${clipped(a.rule).replace(/\.$/u, "")}; ${a.status === "revoked" ? `revoked ${fullTime(a.revoked)}` : `given ${fullTime(a.added)}`}.`;

/** What this page's own ledger says of the row `t` names, in a tip: a decision's answer, an approval's rule; any other row's from the book. */
export function heldTip(m: Model, t: RefTarget, question: number | null): string {
  const a = t.kind === "approval" && t.fleet === null ? m.state.approvals.find((x) => x.id === t.id) : undefined;
  const d = t.kind === "decision" && t.fleet === null ? m.decisionById(t.id) : undefined;

  return a ? approvalTip(a) : d ? tipOf(d, question, null) : targetTip(t);
}

/** How this page says where it is, for a reference's address (`refHref`). */
export const placeOf = (m: Model): RefPlace => ({ manager: m.state.role === "manager", managerPage: m.managerPage(), fleetPage: m.hubRoot() ? m.fleetPage : null });

/** A reference in a run of words, and whose words they are. */
export interface RefPiece {
  readonly num: string;
  /** The fleet named before it; null when none was. */
  readonly fleet: string | null;
  readonly question: number | null;
  /** The fleet whose words these are, on a manager's page; null for this page's own ledger. */
  readonly scope: string | null;
  /** Whether the words link every number (a decision's own words; see the module's comment). */
  readonly every: boolean;
}

/** A text's references as read for drawing: its runs, whose words they are, and how they were read. */
interface Read {
  readonly scope: string | null;
  readonly every: boolean;
  readonly runs: readonly RefRun[];
}

/** What draws a text's references: `text` as runs, in the words of `fleet` (a fleet a manager's page serves; anyone else's are the page's own), every number with `every`. */
export function useRefs(): (text: string, fleet?: string | null, every?: boolean) => Read {
  const { m } = usePage();

  return (text, fleet, every = false) => {
    const scope = scopeOf(m.book(), fleet);

    return { scope, every, runs: refRuns(text, m.knownFleets(), (word) => isRowId(m.book(), scope, word), every) };
  };
}

/** The reference of a run, with whose words it is in and how they were read; undefined for plain words. */
export const pieceOf = (run: RefRun, read: Pick<Read, "scope" | "every">): RefPiece | undefined =>
  run.kind === "ref" ? { num: run.num, fleet: run.fleet, question: run.question, scope: read.scope, every: read.every } : undefined;

/** The one row a reference names in running words; undefined when it names none, or several (a number several ledgers hold stays text there). */
export function oneTarget(m: Model, scope: string | null, fleet: string | null, num: string): RefTarget | undefined {
  const named = targetsOf(m.book(), scope, fleet, num);

  return named.length === 1 ? named[0] : undefined;
}

/** `text` with each reference in it as a link; `fleet`: whose words they are, on a manager's page. */
export function Refs(props: { readonly text: string | null | undefined; readonly fleet?: string | null | undefined }): JSX.Element {
  const read = useRefs();
  const drawn = createMemo(() => read(props.text ?? "", props.fleet));

  return (
    <For each={drawn().runs} keyed={false}>
      {(r) => (
        <Show when={pieceOf(r(), drawn())} fallback={r().text}>
          {(p) => <ItemRef num={p().num} fleet={p().fleet} scope={p().scope} question={p().question} text={r().text} />}
        </Show>
      )}
    </For>
  );
}

/** The references some words name, each once, as links by themselves: whether there is any, and the links. */
export interface Beside {
  readonly any: () => boolean;
  readonly view: () => JSX.Element;
}

/**
 * The references `text` names, each once, as links by themselves: beside words that are a tap target of their
 * own (a row's title that opens the row), where a link inside would be a link in a link. None when it names
 * none the page can find.
 */
export function refsBeside(text: () => string | null | undefined, fleet: () => string | null | undefined = () => null): Beside {
  const { m } = usePage();
  const read = useRefs();

  const found = createMemo(() => {
    const { scope, runs } = read(text() ?? "", fleet());
    const seen = new Set<string>();

    return runs.flatMap((r) => {
      if (r.kind !== "ref" || seen.has(r.text) || !oneTarget(m, scope, r.fleet, r.num)) return [];
      seen.add(r.text);

      return [{ run: r, scope }];
    });
  });

  return {
    any: () => found().length > 0,
    view: () => (
      <Show when={found().length}>
        <span class="refs-beside">
          <For each={found()} keyed={false}>
            {(f, i) => (
              <>
                {i > 0 ? " " : ""}
                <ItemRef num={f().run.num} fleet={f().run.fleet} scope={f().scope} question={f().run.question} text={f().run.text} />
              </>
            )}
          </For>
        </span>
      </Show>
    ),
  };
}

/** {@link refsBeside}, as a component. */
export function RefsBeside(props: { readonly text: string | null | undefined; readonly fleet?: string | null | undefined }): JSX.Element {
  return refsBeside(
    () => props.text,
    () => props.fleet,
  ).view();
}

/** A decision's number in this page's own words, as a link to it (a place that names one decision, not words). */
export function DecisionRef(props: { readonly num: string; readonly fleet: string | null; readonly question: number | null; readonly text: string }): JSX.Element {
  return <ItemRef num={props.num} fleet={props.fleet} scope={null} question={props.question} text={props.text} every />;
}

/**
 * The reference `num` (of `fleet`, when one was named before it; question `question`, when named) in words
 * `scope` wrote, its words `text`: a link to the row it names, plain words when none does. When several
 * ledgers hold the number: each holder's with `every`, plain words without.
 */
export function ItemRef(props: {
  readonly num: string;
  readonly fleet: string | null;
  readonly scope: string | null;
  readonly question: number | null;
  readonly text: string;
  readonly every?: boolean;
}): JSX.Element {
  const { m } = usePage();

  const targets = createMemo((): readonly RefTarget[] => {
    const named = targetsOf(m.book(), props.scope, props.fleet, props.num);

    return named.length > 1 && props.every !== true ? [] : named;
  });

  const each = (): JSX.Element => (
    <span class="dref-choices">
      <For each={targets()} keyed={false}>
        {(t, i) => (
          <>
            {i > 0 ? " · " : ""}
            <TargetRef target={t()} num={props.num} question={props.question} text={t().fleet === null ? `${props.num} here` : `${props.num} in ${String(t().fleet)}`} />
          </>
        )}
      </For>
    </span>
  );

  return (
    <Show when={targets().length > 1} fallback={<Show when={targets()[0]} fallback={props.text}>{(t) => <TargetRef target={t()} num={props.num} question={props.question} text={props.text} />}</Show>}>
      {each()}
    </Show>
  );
}

/** A row a reference names, as a link (see the module's comment). */
function TargetRef(props: { readonly target: RefTarget; readonly num: string; readonly question: number | null; readonly text: string }): JSX.Element {
  const { m } = usePage();
  const [shown, setShown] = createSignal(false);
  const [fetched, setFetched] = createSignal<Decision | null | undefined>(undefined);
  const id = "dref-" + String((tips += 1));
  const t = (): RefTarget => props.target;
  /** Another fleet's decision: the page may hold it only in part (its open ones), so its ledger says the rest. */
  const theirs = (): string | null => (t().kind === "decision" ? t().fleet : null);

  /* The decision of this page, or the fleet's as the manager's page holds it (its open ones). */
  const local = createMemo((): Decision | undefined => {
    if (t().kind !== "decision") return undefined;
    const fleet = t().fleet;

    if (fleet === null) return m.decisionById(t().id);

    return named(m.state.coordinators.find((c) => c.id === fleet)?.decisions ?? [], t().id);
  });

  const href = createMemo((): string | null =>
    refHref(theirs() === null ? t() : { ...t(), id: fetched()?.id ?? local()?.id ?? t().id }, placeOf(m)),
  );

  const tip = (): string => {
    const d = fetched() ?? local();

    if (d) return tipOf(d, props.question, t().fleet);

    if (theirs() === null || t().title) return heldTip(m, t(), props.question);

    return fetched() === null ? `${props.num}, in ${String(theirs())}: not found in its ledger.` : `${props.num}, in ${String(theirs())}: reading its ledger…`;
  };

  /* The tip kept on screen as its words come (a fleet's are read after it shows): moved left when it would run
     past the right edge (a link at a line's end, a phone). */
  const [tipEl, setTipEl] = createSignal<HTMLElement>();

  createEffect(
    () => [tipEl(), tip()] as const,
    ([el]) => {
      if (!el) return;
      el.style.left = "";
      setTimeout(() => {
        const over = el.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);

        if (over > 0) el.style.left = `${String(-Math.ceil(over))}px`;
      }, 0);
    },
  );

  const show = (): void => {
    setShown(true);
    const fleet = theirs();

    /* Another fleet's: read from its ledger once, for what the manager's page does not hold (a closed one, a grilling's questions). */
    if (fleet !== null && fetched() === undefined && m.hubRoot()) {
      void decisionsOf(fleet, m.fleetPage(fleet) + "state.json").then((rows) => setFetched(rows ? (named(rows, t().id) ?? null) : null));
    }
  };

  return (
    <Show when={href()} fallback={props.text}>
      {(h) => (
        <span class="dref-wrap" onMouseEnter={show} onMouseLeave={() => setShown(false)} onFocusIn={show} onFocusOut={() => setShown(false)}>
          <a
            class="dref"
            href={h()}
            target={h().startsWith("#") ? undefined : "_top"}
            aria-describedby={shown() ? id : undefined}
            data-ref={props.num}
            data-agent={t().kind === "worker" && t().fleet === null && m.person(t().id) ? t().id : undefined}
          >
            {props.text}
          </a>
          <Show when={shown()}>
            <span class="dref-tip" id={id} role="tooltip" ref={setTipEl}>
              {tip()}
            </span>
          </Show>
        </span>
      )}
    </Show>
  );
}
