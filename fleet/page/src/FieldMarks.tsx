/**
 * Comments on the words the dashboard draws on a decision's page, in its own DOM (fields.ts): where a
 * selection falls (the field element around it) and its claim, and the marked words highlighted where they
 * are found again, by field and context, with the CSS Custom Highlight API, each with its pin: a footnote
 * number raised over the end of its words in a layer over the page, taking no room in the text. The marks to paint come from the inbox (Marks.tsx) on this page, or, inside the manager's frame,
 * from the manager's page, which a tap on a pin is told back to.
 */
import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";

import { claimOf, type FieldClaim } from "./fields.ts";
import type { MarkStatus } from "./inbox.ts";
import { placeMark } from "./marks.ts";

/** A mark on a field as it is painted: its thread's id, number, kind, words, and where its thread stands. */
export interface FieldPaint {
  readonly id: string;
  readonly n: number;
  readonly field: string;
  readonly kind: string;
  readonly blocks: readonly { readonly exact: string; readonly prefix: string; readonly suffix: string }[];
  readonly status: MarkStatus;
  readonly unread: boolean;
  readonly active: boolean;
}

const [paints, setPaints] = createSignal<readonly FieldPaint[]>([]);

/** The field marks painted on this page now. */
export const fieldPaints = paints;

/** Paint these field marks on this page (none: clear them). */
export const setFieldPaints = (list: readonly FieldPaint[]): void => void setPaints(list);

/** Where a tap on a field's pin goes. */
export interface FieldTapSlot {
  current: ((id: string) => void) | null;
}

/** What a tap on a field's pin does: opens its thread (on this page), or tells the manager's page (inside its frame). */
export const fieldTap: FieldTapSlot = { current: null };

/** What a long-press, the context menu or the Delete key on a field's pin does: deletes (or withdraws) its comment. */
export const fieldDelete: FieldTapSlot = { current: null };

/** The field element a selection's range lies in, both its ends inside the same one, on the decision's page; null when none. */
export function fieldOf(range: Range): HTMLElement | null {
  const at = (n: Node): HTMLElement | null => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>("#decision [data-field]") ?? null;
  const a = at(range.startContainer);

  return a && a === at(range.endContainer) ? a : null;
}

/**
 * The text nodes of a field's own words, in order. A reference's tip (DecisionRef.tsx `.dref-tip`) stands in
 * the field while it shows, and is the page's words about a row, never the field's: a mark claims and is found
 * again in the field's words alone, tip or no tip.
 */
function ownTexts(el: Element): Text[] {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];

  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n instanceof Text && !n.parentElement?.closest(".dref-tip")) out.push(n);
  }

  return out;
}

/** A field's own words ({@link ownTexts}). */
const fieldText = (el: Element): string =>
  ownTexts(el)
    .map((n) => n.data)
    .join("");

/** How many of the field's own characters lie before the point (`node`, `offset`). */
function offsetIn(el: Element, node: Node, offset: number): number {
  const before = document.createRange();
  before.setStart(el, 0);
  before.setEnd(node, offset);

  return ownTexts(el).reduce((n, t) => n + (t === node ? offset : before.comparePoint(t, t.length) <= 0 ? t.length : 0), 0);
}

/** The claim of `range`, inside field element `el`: its words within the field's text, with their context. */
export function claimIn(el: HTMLElement, range: Range): FieldClaim | null {
  return claimOf(el.dataset["field"] ?? "", fieldText(el), offsetIn(el, range.startContainer, range.startOffset), offsetIn(el, range.endContainer, range.endOffset));
}

/** Ranges over `el`'s own text ({@link fieldText}) from `start` to `end` (offsets in it). */
function rangeIn(el: Element, start: number, end: number): Range | null {
  const r = document.createRange();
  let at = 0;
  let begun = false;

  for (const n of ownTexts(el)) {
    const len = n.data.length;

    if (!begun && start < at + len) {
      r.setStart(n, start - at);
      begun = true;
    }

    if (begun && end <= at + len) {
      r.setEnd(n, end - at);

      return r;
    }

    at += len;
  }

  return null;
}

/** A field mark's pin: a footnote number, its number drawn by CSS. */
function pinOf(p: FieldPaint): HTMLElement {
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "fd-pin st-" + p.status + (p.unread ? " unread" : "") + (p.active ? " on" : "");
  pin.dataset["id"] = p.id;
  pin.dataset["n"] = String(p.n);
  pin.dataset["of"] = p.field;
  pin.setAttribute("aria-label", `Comment ${String(p.n)}, ${p.status}`);

  return pin;
}

/** The layer the field pins float in, over the page: they take no room in its text. */
function layer(): HTMLElement {
  const known = document.getElementById("fd-pins");

  if (known) return known;
  const el = document.createElement("div");
  el.id = "fd-pins";
  el.className = "fd-pins";
  document.body.appendChild(el);

  return el;
}

/**
 * The field marks' words highlighted where each is found again in its field (the CSS Custom Highlight API:
 * the page's DOM, which Solid owns, is left as it is), and each one's pin a footnote number raised over the
 * end of its words, in a layer over the page: it takes no room, so the text wraps as it did, and it is kept
 * inside its field. Painted again as the page changes or is resized.
 */
export function FieldHighlights(): JSX.Element {
  const [tick, setTick] = createSignal(0);
  const highlights = globalThis.CSS?.highlights;

  if (!("MutationObserver" in globalThis)) return null;
  let frame = 0;

  const again = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setTick(tick() + 1));
  };

  const watch = new MutationObserver(again);

  /* The page's decision, once it is in the document (this is drawn inside it, before it is placed). */
  const observe = (): void => {
    const root = document.getElementById("decision");

    if (root) watch.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  };

  const onTap = (e: MouseEvent): void => {
    const pin = e.target instanceof Element ? e.target.closest<HTMLElement>("#fd-pins .fd-pin") : null;

    if (!pin) return;
    e.preventDefault();
    e.stopPropagation();

    if (deleted) {
      deleted = false;

      return;
    }

    fieldTap.current?.(pin.dataset["id"] ?? "");
  };

  /*
   * A press held on a pin (600 ms, acted on as it is let go, so the release is Luiz's activation the
   * manager's page can check), its context menu (a mouse's: its press is the activation) or the Delete key on
   * it deletes its comment; the click its release makes opens nothing.
   */
  let hold: { readonly pin: HTMLElement; readonly at: number } | null = null;
  let deleted = false;
  const pinAt = (e: Event): HTMLElement | null => (e.target instanceof Element ? e.target.closest<HTMLElement>("#fd-pins .fd-pin") : null);

  const onHold = (e: PointerEvent): void => {
    const pin = pinAt(e);

    deleted = false;
    hold = pin ? { pin, at: Date.now() } : null;
  };

  const onLift = (): void => {
    const held = hold;
    hold = null;

    if (!held || Date.now() - held.at < 600) return;
    deleted = true;
    fieldDelete.current?.(held.pin.dataset["id"] ?? "");
  };

  const onMenu = (e: MouseEvent): void => {
    const pin = pinAt(e);

    if (!pin) return;
    e.preventDefault();

    /* A finger's long-press menu: the release acts (onLift), not this. */
    if (e instanceof PointerEvent && e.pointerType !== "mouse") return;
    fieldDelete.current?.(pin.dataset["id"] ?? "");
  };

  const onKey = (e: KeyboardEvent): void => {
    const pin = pinAt(e);

    if (!pin || (e.key !== "Delete" && e.key !== "Backspace")) return;
    e.preventDefault();
    fieldDelete.current?.(pin.dataset["id"] ?? "");
  };

  onSettled(observe);
  document.addEventListener("click", onTap, true);
  document.addEventListener("pointerdown", onHold, true);
  document.addEventListener("pointerup", onLift, true);
  document.addEventListener("touchend", onLift, true);
  document.addEventListener("contextmenu", onMenu, true);
  document.addEventListener("keydown", onKey, true);
  addEventListener("resize", again);
  onCleanup(() => {
    watch.disconnect();
    cancelAnimationFrame(frame);
    document.removeEventListener("click", onTap, true);
    document.removeEventListener("pointerdown", onHold, true);
    document.removeEventListener("pointerup", onLift, true);
    document.removeEventListener("touchend", onLift, true);
    document.removeEventListener("contextmenu", onMenu, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", again);
    document.getElementById("fd-pins")?.remove();

    for (const k of KINDS) highlights?.delete("fd-" + k);
  });

  createEffect(
    () => ({ list: paints(), at: tick() }),
    (s) => {
      const by = new Map<string, Range[]>();
      const pins = layer();
      pins.replaceChildren();

      for (const p of s.list) {
        const el = document.querySelector(`#decision [data-field="${CSS.escape(p.field)}"]`);

        if (!el) continue;
        const ranges = placeMark(p.blocks, fieldText(el)).spans.flatMap((sp) => rangeIn(el, sp.start, sp.end) ?? []);
        by.set(p.kind, [...(by.get(p.kind) ?? []), ...ranges]);
        const end = [...(ranges.at(-1)?.getClientRects() ?? [])].filter((r) => r.width > 0).at(-1);

        if (!end) continue;
        /* Raised over the end of the words, its right edge at theirs, kept inside the field. */
        const pin = pinOf(p);
        pins.appendChild(pin);
        /* The field's own box, or (one drawn as `display: contents`, with none) its contents'. */
        const whole = document.createRange();
        whole.selectNodeContents(el);
        const own = el.getBoundingClientRect();
        const box = own.width > 0 ? own : whole.getBoundingClientRect();
        const w = pin.offsetWidth;
        const h = pin.offsetHeight;
        const left = Math.min(Math.max(end.right - w, box.left), box.right - w);
        pin.style.left = String(Math.round(left + scrollX)) + "px";
        pin.style.top = String(Math.round(end.top + 4 - h + scrollY)) + "px";
      }

      if (highlights && "Highlight" in globalThis) {
        for (const k of KINDS) {
          const rs = by.get(k) ?? [];

          if (rs.length) highlights.set("fd-" + k, new Highlight(...rs));
          else highlights.delete("fd-" + k);
        }
      }
    },
  );

  return null;
}

/** The kinds a field mark is highlighted as. */
const KINDS = ["comment", "delete", "replace", "question"] as const;
