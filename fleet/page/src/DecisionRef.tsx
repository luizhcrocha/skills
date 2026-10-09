/**
 * A decision's number in an item's words, as a link to that decision: on hover or focus a tip says its title,
 * where it stands, its answer and when it was decided (and the question it names, for a grilling), and a tap on
 * a phone opens it. A bare number this page cannot find stays plain text. Another fleet's ("Infra's d172") always
 * links, to `#decision/<fleet>/<id>` on the manager's page, and its tip is read when first wanted from that
 * fleet's ledger through the hub (`f/<fleet>/state.json`), kept for this page load.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import { Show, type JSX } from "@solidjs/web";

import { usePage } from "./bits.tsx";
import { Core, type Approval, type Decision, type Json } from "./core.ts";
import { fullTime } from "./format.ts";

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

/** A tip's words cut to about 200 characters, and closed by one full stop. */
function clipped(text: string): string {
  const t = text.trim().replace(/[.\s]+$/u, "");

  return ([...t].length > 200 ? [...t].slice(0, 200).join("").replace(/\s+\S*$/u, "") + "…" : t) + ".";
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
  const named = question === null ? "" : ` (question ${String(question)})`;

  return d.status === "decided" ? `${head}${named}: ${state}: ${clipped(String(d.answer ?? d.resolution ?? ""))}` : `${head}${named}: ${state}.`;
}

/** A standing approval's number (K3) as a link to it on the Decisions view, its rule and state on hover. */
function ApprovalRef(props: { readonly approval: Approval; readonly text: string }): JSX.Element {
  const id = "dref-" + String((tips += 1));
  const [shown, setShown] = createSignal(false);
  const a = (): Approval => props.approval;

  const tip = (): string =>
    `${a().id} standing approval: ${clipped(a().rule).replace(/\.$/u, "")}; ${a().status === "revoked" ? `revoked ${fullTime(a().revoked)}` : `given ${fullTime(a().added)}`}.`;

  return (
    <span class="dref-wrap" onMouseEnter={() => setShown(true)} onMouseLeave={() => setShown(false)} onFocusIn={() => setShown(true)} onFocusOut={() => setShown(false)}>
      <a class="dref" href={"#approval-" + a().id} aria-describedby={shown() ? id : undefined} data-ref={a().id}>
        {props.text}
      </a>
      <Show when={shown()}>
        <span class="dref-tip" id={id} role="tooltip">
          {tip()}
        </span>
      </Show>
    </span>
  );
}

/** Decision number `num` (of `fleet`, when named; question `question`, when named) as a link, its words `text`;
 * a K number of this page is its standing approval. */
export function DecisionRef(props: { readonly num: string; readonly fleet: string | null; readonly question: number | null; readonly text: string }): JSX.Element {
  const { m } = usePage();

  const approval = createMemo((): Approval | undefined =>
    props.fleet === null && /^K\d+$/u.test(props.num) ? m.state.approvals.find((a) => a.id === props.num) : undefined,
  );

  return (
    <Show when={approval()} fallback={<NumberRef {...props} />}>
      {(a) => <ApprovalRef approval={a()} text={props.text} />}
    </Show>
  );
}

/** A decision's number as a link (see the module's comment). */
function NumberRef(props: { readonly num: string; readonly fleet: string | null; readonly question: number | null; readonly text: string }): JSX.Element {
  const { m } = usePage();
  const [shown, setShown] = createSignal(false);
  const [fetched, setFetched] = createSignal<Decision | null | undefined>(undefined);
  const id = "dref-" + String((tips += 1));

  /* The decision of this page, or the fleet's as the manager's page holds it (its open ones). */
  const local = createMemo((): Decision | undefined => {
    const fleet = props.fleet;

    if (fleet === null) return named(m.state.decisions, props.num);

    return named(m.state.coordinators.find((c) => c.id === fleet)?.decisions ?? [], props.num);
  });

  const href = createMemo((): string | null => {
    const fleet = props.fleet;

    if (fleet === null) return local() ? Core.decisionHref(local()?.id ?? "") : null;
    const target = Core.decisionHref(fleet + "/" + (fetched()?.id ?? local()?.id ?? props.num));

    if (m.state.role === "manager") return target;
    const manager = m.managerPage();

    return manager ? manager + target : m.hubRoot() ? m.fleetPage(fleet) + Core.decisionHref(props.num) : null;
  });

  const tip = (): string => {
    const d = fetched() ?? local();

    if (d) return tipOf(d, props.question, props.fleet);

    return fetched() === null ? `${props.num}, in ${String(props.fleet)}: not found in its ledger.` : `${props.num}, in ${String(props.fleet)}: reading its ledger…`;
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
    const fleet = props.fleet;

    /* Another fleet's: read from its ledger once, for what the manager's page does not hold (a closed one, a grilling's questions). */
    if (fleet !== null && fetched() === undefined && m.hubRoot()) {
      void decisionsOf(fleet, m.fleetPage(fleet) + "state.json").then((rows) => setFetched(rows ? (named(rows, props.num) ?? null) : null));
    }
  };

  return (
    <Show when={href()} fallback={props.text}>
      {(h) => (
        <span class="dref-wrap" onMouseEnter={show} onMouseLeave={() => setShown(false)} onFocusIn={show} onFocusOut={() => setShown(false)}>
          <a class="dref" href={h()} target={h().startsWith("#") ? undefined : "_top"} aria-describedby={shown() ? id : undefined} data-ref={props.num}>
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
