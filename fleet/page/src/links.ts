/**
 * The Links view's rules, apart from the DOM: which links are active, which need the user, how they are
 * grouped by kind, and the small words a row shows (its round, its port or host, its plain title).
 *
 * A link is inactive when the fleet marked it done, when the decision it serves is closed, when its server
 * does not answer, or when its file is gone. One the hub is still checking stays active. One that needs the user is active and serves an open decision or
 * says what the user does there (`--for`).
 */
import type { Link, LinkKind } from "./core.ts";

/** The kinds, in the order the view groups them. */
export const KINDS: readonly LinkKind[] = ["preview", "prototype", "tool", "doc", "service"];

/** A kind's name on its badge, and its group's heading. */
export const KIND_NAME: Readonly<Record<LinkKind, readonly [string, string]>> = {
  preview: ["Preview", "Live previews"],
  prototype: ["Prototype", "Prototypes"],
  tool: ["Tool", "Tools"],
  doc: ["Doc", "Docs"],
  service: ["Service", "Services"],
};

/** What the state filter keeps. */
export type Showing = "active" | "inactive" | "all";

/** Why a link is inactive, in a few words; empty when it is active. */
export function inactiveWhy(l: Link): string {
  if (l.done) return "done";

  if (l.decision_status === "decided" || l.decision_status === "withdrawn") return "its decision is closed";

  if (l.reach === "machine" && !l.up && !l.checking) return "down";

  if (l.reach === "file" && !l.up) return "file missing";

  return "";
}

/** Whether a link is in use. */
export const isActive = (l: Link): boolean => inactiveWhy(l) === "";

/** Whether an active link waits on the user: it serves an open decision, or says what the user does there. */
export const needsYou = (l: Link): boolean => isActive(l) && (l.decision_status === "open" || l.for !== "");

/** The round a prototype's title names ("round 14", "rodada 3"), as "round N". */
export function roundOf(title: string): string {
  const m = /\b(?:round|rodada)\s+(\d+(?:\.\d+)*)/iu.exec(title);

  return m === null ? "" : `round ${m[1] ?? ""}`;
}

/** A worker's id in parentheses ("(b286)", "(a191)"), which means nothing to the user. */
const WORKER_TAG = /\s*\((?:[a-z]{1,2}\d{1,4})(?:,\s*[a-z]{1,2}\d{1,4})*\)/gu;

/** The title without the worker ids an older row carries. */
export const plainTitle = (title: string): string => title.replace(WORKER_TAG, "").trim() || title;

/** Where a link points, small: its port on this machine (":7501"), its host elsewhere, "file" for a file. */
export function placeOf(l: Link): string {
  if (l.reach === "file") return "file";
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d+))?/iu.exec(l.url);

  if (m === null) return "";

  if (l.reach === "machine") return m[2] ? `:${m[2]}` : (m[1] ?? "");

  return (m[1] ?? "").replace(/^www\./u, "");
}

/** The address a row opens: a file the hub serves at its path, else the link's own. */
export const hrefOf = (l: Link): string => (l.reach === "file" && l.file ? l.file : l.url);

/** The links as the view lays them out, after the fleet, kind and state filters. */
export interface Arranged {
  /** Active links that wait on the user. */
  readonly needs: readonly Link[];
  /** The other active links, by kind (the kinds with none left out). */
  readonly groups: readonly (readonly [LinkKind, readonly Link[]])[];
  /** The inactive ones, by kind. */
  readonly inactive: readonly (readonly [LinkKind, readonly Link[]])[];
  /** How many links pass the fleet and kind filters, active and inactive. */
  readonly counts: { readonly active: number; readonly inactive: number };
}

function byKind(list: readonly Link[]): (readonly [LinkKind, readonly Link[]])[] {
  return KINDS.flatMap((k) => {
    const ls = list.filter((l) => l.kind === k);

    return ls.length > 0 ? [[k, ls] as const] : [];
  });
}

/** `links` narrowed to `fleet` and `kind` ("" for every one) and laid out for `showing`. */
export function arrange(links: readonly Link[], showing: Showing, kind: LinkKind | "", fleet: string): Arranged {
  const kept = links.filter((l) => (fleet === "" || l.fleet === fleet) && (kind === "" || l.kind === kind));
  const active = kept.filter(isActive);
  const inactive = kept.filter((l) => !isActive(l));
  const needs = active.filter(needsYou);
  const rest = active.filter((l) => !needsYou(l));

  return {
    needs: showing === "inactive" ? [] : needs,
    groups: showing === "inactive" ? [] : byKind(rest),
    inactive: showing === "active" ? [] : byKind(inactive),
    counts: { active: active.length, inactive: inactive.length },
  };
}
