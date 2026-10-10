/**
 * The Links view's parts: the filter bar (active, inactive or all; a kind; on the manager's page, a fleet) and
 * one row per link, with its kind's badge, its plain title, the fleet, what the user does there, whether it
 * answers and when that was checked, and its port or host.
 */
import { createSignal } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { PillAs, RefTag, usePage } from "./bits.tsx";
import { Core, type Link, type LinkKind } from "./core.ts";
import { clock } from "./format.ts";
import { hrefOf, inactiveWhy, KIND_NAME, KINDS, placeOf, plainTitle, roundOf, type Arranged, type Showing } from "./links.ts";

const ICON_PATHS: Readonly<Record<LinkKind, string>> = {
  preview: "M2.5 4.5h11v7h-11z M6 14h4 M7 7l3 1.5L7 10z",
  prototype: "M3 13l1-3 6.5-6.5 2 2L6 12z M9.5 4.5l2 2",
  tool: "M10.5 2.5a3 3 0 0 0-3.2 4L3 10.8 5.2 13l4.3-4.3a3 3 0 0 0 4-3.2l-1.8 1.8-1.8-.4-.4-1.8z",
  doc: "M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12 M6 8h4 M6 10.5h4",
  service: "M3 3.5h10v3.5H3z M3 9h10v3.5H3z M5 5.25h.01 M5 10.75h.01",
};

/** A kind's icon. */
function KindIcon(props: { readonly kind: LinkKind }): JSX.Element {
  return (
    <svg class="kind-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={ICON_PATHS[props.kind]} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** A kind's badge: its icon and its name. */
export function KindBadge(props: { readonly kind: LinkKind }): JSX.Element {
  return (
    <span class={"kind-badge kind-" + props.kind}>
      <KindIcon kind={props.kind} />
      {KIND_NAME[props.kind][0]}
    </span>
  );
}

/** Whether a link answers: its dot, and in words. */
interface Status {
  readonly dot: "up" | "down" | "none";
  readonly words: string;
}

/** Whether a link answers, in words: "up · checked 20:31", "down since 18:02", "only on this machine". */
function statusOf(l: Link): Status {
  if (l.reach === "file") {
    if (!l.up) return { dot: "down", words: "file missing" };

    return l.file ? { dot: "up", words: "file, opens through the hub" } : { dot: "none", words: "only on this machine" };
  }

  if (l.reach === "external") return { dot: "none", words: "elsewhere, not checked" };

  if (l.up) return { dot: "up", words: l.checked ? `up · checked ${clock(l.checked)}` : "up" };

  return { dot: "down", words: l.state_since ? `down since ${clock(l.state_since)}` : l.checked ? `down · checked ${clock(l.checked)}` : "down" };
}

/** One link: its kind, its plain title, the fleet, what the user does there, whether it answers, its port or host. */
export function LinkRow(props: { readonly link: Link }): JSX.Element {
  const { m } = usePage();
  const l = (): Link => props.link;
  const why = (): string => inactiveWhy(l());
  const status = () => statusOf(l());
  const round = (): string => (l().kind === "prototype" ? roundOf(l().title) : "");
  /* The decision it serves: on the manager's page, a fleet's link names its fleet's decision (shown while open);
     any other names this ledger's. */
  const own = (): boolean => !m.state.coordinators.some((c) => c.id === l().fleet);
  const served = () => (own() ? m.decisionById(l().decision) : m.decisionAnywhere(`${l().fleet}/${l().decision}`));

  return (
    <div class={"block link-row kind-" + l().kind + (why() ? " inactive" : "")} data-link={l().id} data-fleet={l().fleet}>
      <div class="block-head">
        <KindBadge kind={l().kind} />
        <RefTag of={l()} />
        <a class="link-title" href={hrefOf(l())} target="_blank" rel="noopener" title={l().url}>
          {plainTitle(l().title)}
        </a>
        <Show when={round()}>
          <PillAs cls="plain round" text={round()} />
        </Show>
        <Show when={m.managed() && l().fleet}>
          <PillAs cls="plain" text={l().fleet} />
        </Show>
      </div>
      <Show when={l().for}>
        <p class="link-for">
          <span class="muted">For you:</span> {l().for}
        </p>
      </Show>
      <p class="link-status">
        <span class={"link-dot is-" + status().dot} aria-hidden="true" />
        <span class="status-words">{status().words}</span>
        <Show when={why() && why() !== "down" && why() !== "file missing"}>
          <span class="status-words">· {why()}</span>
        </Show>
        <span class="link-place">
          {placeOf(l())} {KIND_NAME[l().kind][0].toLowerCase()}
        </span>
      </p>
      <Show when={l().reach === "file" && !l().file}>
        <p class="meta lane">{l().url.replace(/^file:\/\//u, "")}</p>
      </Show>
      <Show when={l().note}>
        <p class="detail">{l().note}</p>
      </Show>
      <Show when={l().decision ? served() : undefined}>
        {(d) => (
          <a class="block-link" href={Core.decisionHref(own() ? d().id : `${l().fleet}/${l().decision}`)}>
            For {d().ref ? d().ref + ": " : ""}
            {d().title}
          </a>
        )}
      </Show>
    </div>
  );
}

/** A group of links under a heading, in one card. */
export function LinkGroup(props: { readonly id: string; readonly title: string; readonly note?: string; readonly links: readonly Link[] }): JSX.Element {
  return (
    <div class="part link-group" id={props.id}>
      <h2>
        {props.title} <span class="n">{props.links.length}</span>
      </h2>
      <Show when={props.note}>
        <p class="muted part-note">{props.note}</p>
      </Show>
      <div class="card">
        <For each={props.links} keyed={(l) => l.fleet + "/" + l.id}>
          {(l) => <LinkRow link={l()} />}
        </For>
      </div>
    </div>
  );
}

/** The filters the viewer keeps: what state, which kind, which fleet. */
export interface LinkFilters {
  readonly showing: () => Showing;
  readonly kind: () => LinkKind | "";
  readonly fleet: () => string;
  readonly setShowing: (v: Showing) => void;
  readonly setKind: (v: LinkKind | "") => void;
  readonly setFleet: (v: string) => void;
}

/** The Links view's filters, kept in the viewer's preferences. */
export function linkFilters(): LinkFilters {
  const { m } = usePage();
  const read = (key: string, fallback: string): string => String(m.prefs.get(key, fallback));
  const showingOf = (v: string): Showing => (v === "inactive" || v === "all" ? v : "active");
  const kindOf = (v: string): LinkKind | "" => KINDS.find((k) => k === v) ?? "";
  const [showing, setShowing] = createSignal<Showing>(showingOf(read("links-showing", "active")));
  const [kind, setKind] = createSignal<LinkKind | "">(kindOf(read("links-kind", "")));
  const [fleet, setFleet] = createSignal(read("links-fleet", ""));

  return {
    showing,
    kind,
    fleet,
    setShowing: (v) => {
      setShowing(v);
      m.prefs.set("links-showing", v);
    },
    setKind: (v) => {
      setKind(v);
      m.prefs.set("links-kind", v);
    },
    setFleet: (v) => {
      setFleet(v);
      m.prefs.set("links-fleet", v);
    },
  };
}

/** The filter bar: Active, Inactive, All; a kind; on the manager's page, a fleet. */
export function LinkFilterBar(props: { readonly f: LinkFilters; readonly arranged: Arranged; readonly kinds: readonly (readonly [LinkKind, number])[]; readonly fleets: readonly string[] }): JSX.Element {
  const { m } = usePage();

  const states: readonly (readonly [Showing, string])[] = [
    ["active", "Active"],
    ["inactive", "Inactive"],
    ["all", "All"],
  ];

  const countOf = (s: Showing): number => (s === "active" ? props.arranged.counts.active : s === "inactive" ? props.arranged.counts.inactive : props.arranged.counts.active + props.arranged.counts.inactive);

  return (
    <div class="link-filters" id="link-filters">
      <div class="seg" role="group" aria-label="Show links">
        <For each={states} keyed={(s) => s[0]}>
          {(s) => (
            <button type="button" data-showing={s()[0]} aria-pressed={props.f.showing() === s()[0] ? "true" : "false"} onClick={() => props.f.setShowing(s()[0])}>
              {s()[1]} <span class="n">{countOf(s()[0])}</span>
            </button>
          )}
        </For>
      </div>
      <div class="seg small scopes" role="group" aria-label="Kind of link">
        <button type="button" data-kind="" aria-pressed={props.f.kind() === "" ? "true" : "false"} onClick={() => props.f.setKind("")}>
          Every kind
        </button>
        <For each={props.kinds} keyed={(k) => k[0]}>
          {(k) => (
            <button type="button" data-kind={k()[0]} aria-pressed={props.f.kind() === k()[0] ? "true" : "false"} onClick={() => props.f.setKind(props.f.kind() === k()[0] ? "" : k()[0])}>
              <KindIcon kind={k()[0]} /> {KIND_NAME[k()[0]][1]} <span class="n">{k()[1]}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={m.managed() && props.fleets.length > 1}>
        <label class="link-fleet">
          <span class="muted">Fleet</span>
          <select id="link-fleet" value={props.f.fleet()} onChange={(e) => props.f.setFleet(e.currentTarget.value)}>
            <option value="">Every fleet</option>
            <For each={props.fleets} keyed={(id) => id}>
              {(id) => <option value={id()}>{id()}</option>}
            </For>
          </select>
        </label>
      </Show>
    </div>
  );
}
