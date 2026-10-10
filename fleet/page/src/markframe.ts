/**
 * The marks' half that runs inside a decision's evidence frame (sandboxed, with no same origin, so the page
 * reaches it only by postMessage). It runs beside the body's own scripts, which can post the same messages,
 * so everything it says is a claim the page checks, never a command: it reports a selection as blocks of
 * words with the text around each (the page confirms them against the body as it parsed it, and reads the
 * cells and headings itself); paints the marks it is told of as numbered `<mark>` elements, each found
 * again by `placeMark`; and tells the page of a tap on a mark (acted on only after a real one) and of
 * Escape (which closes the selection bar only). Keys pressed here send, save and open nothing.
 *
 * Messages, page to frame: `{annotPaint, marks}`, `{annotNow: kind}` (the selection now), `{annotClearSel}`.
 * Frame to page: `{annotReady}`, `{annotPlaced}`, `{annotNowSel, kind, anchor}`, `{annotTap, id}`,
 * `{annotEsc}`, and the selection as it rests, `{fleetSelect, text, rect, touch, anchor}`, `anchor` being
 * `{blocks: [{exact, prefix, suffix}]}`. On the manager's page the fleet's embedded page relays them, rebuilt.
 */
import { placeMark } from "./marks.ts";

/** A mark as the page tells the frame of it. */
interface Paint {
  readonly id: string;
  readonly n: number;
  readonly kind: string;
  readonly blocks: readonly Block[];
  readonly done: boolean;
  readonly active: boolean;
  readonly show: boolean;
}

/** One block of a selection, with the body's text around it. */
interface Block {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

/** A selection as the frame reads it: its blocks. */
interface Anchor {
  readonly blocks: readonly Block[];
}

/** What the frame posts to the page. */
interface Said {
  readonly [key: string]: string | number | boolean | null | Anchor | SelBox;
}

/** A selection's box in the frame's viewport. */
interface SelBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

/** The body's text nodes (no script or style), each with where it starts in the body's text, and that text. */
interface BodyText {
  readonly list: { node: Text; start: number }[];
  readonly text: string;
}

/** A message the page posts to the frame. */
interface FrameCommand {
  readonly annotPaint?: boolean;
  readonly marks?: readonly Paint[];
  readonly annotNow?: string;
  readonly annotClearSel?: boolean;
}

/**
 * The frame's script, run as its own source (`String(markFrame)`) with `placeMark`'s: it uses nothing
 * outside itself.
 */
function markFrame(place: typeof placeMark): void {
  const BLOCK = "p,li,td,th,h1,h2,h3,h4,pre,dd,dt,caption,figcaption,blockquote";
  let touch = false;
  let marks: readonly Paint[] = [];
  const post = (data: Said): void => parent.postMessage(data, "*");

  /* The body's text nodes (no script or style), each with where it starts in the body's text. */
  const texts = (): BodyText => {
    const list: { node: Text; start: number }[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let pos = 0;

    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!(n instanceof Text) || /^(SCRIPT|STYLE)$/u.test(n.parentNode?.nodeName ?? "")) continue;
      list.push({ node: n, start: pos });
      pos += n.data.length;
    }

    return { list, text: list.map((t) => t.node.data).join("") };
  };

  const offsetOf = (container: Node, offset: number, list: { node: Text; start: number }[]): number => {
    if (container instanceof Text) {
      const hit = list.find((t) => t.node === container);

      return hit ? hit.start + offset : -1;
    }

    const r = document.createRange();
    r.setStart(document.body, 0);
    r.setEnd(container, offset);
    const pre = r.cloneContents();

    for (const s of pre.querySelectorAll("script,style")) s.remove();

    return (pre.textContent ?? "").length;
  };

  /* The selection as blocks, one per block it crosses (a cell, a paragraph, a list item, a heading), each with 32 characters of the text around it. */
  const anchorOfSelection = (): Anchor | null => {
    const s = getSelection();

    if (!s || !s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0);
    const t = texts();
    const a = offsetOf(r.startContainer, r.startOffset, t.list);
    const b = offsetOf(r.endContainer, r.endOffset, t.list);

    if (a < 0 || b <= a) return null;
    const runs: { blk: Element; start: number; end: number }[] = [];

    for (const x of t.list) {
      const s0 = x.start;
      const e0 = s0 + x.node.data.length;

      if (e0 <= a || s0 >= b) continue;
      const el = x.node.parentElement;
      const blk = el?.closest(BLOCK) ?? el;

      if (!blk) continue;
      const cur = runs.at(-1);

      if (cur && cur.blk === blk) cur.end = Math.min(b, e0);
      else runs.push({ blk, start: Math.max(a, s0), end: Math.min(b, e0) });
    }

    const blocks: Block[] = [];

    for (const g of runs) {
      const x = t.text.slice(g.start, g.end);
      const st = g.start + (x.length - x.replace(/^\s+/u, "").length);
      const en = g.end - (x.length - x.replace(/\s+$/u, "").length);

      if (en > st) blocks.push({ exact: t.text.slice(st, en), prefix: t.text.slice(Math.max(0, st - 32), st), suffix: t.text.slice(en, en + 32) });
    }

    return blocks.length ? { blocks } : null;
  };

  const unpaint = (): void => {
    const ms = [...document.querySelectorAll("mark.am")];

    for (const m of ms.reverse()) {
      while (m.firstChild) m.parentNode?.insertBefore(m.firstChild, m);
      m.remove();
    }

    document.body.normalize();
  };

  /* Wrap the body's text from `start` to `end` in <mark>s (one per text node it crosses), the first with the mark's number. */
  const wrap = (start: number, end: number, m: Paint, first: boolean): void => {
    const cuts: { node: Text; a: number; b: number }[] = [];

    for (const { node, start: s } of texts().list) {
      const e = s + node.data.length;

      if (e <= start || s >= end || (!/\S/u.test(node.data) && /^(TABLE|TBODY|THEAD|TR|UL|OL)$/u.test(node.parentNode?.nodeName ?? ""))) continue;
      cuts.push({ node, a: Math.max(start, s) - s, b: Math.min(end, e) - s });
    }

    cuts.forEach(({ node, a, b }, i) => {
      const mid = a > 0 ? node.splitText(a) : node;

      if (b - a < mid.data.length) mid.splitText(b - a);
      const el = document.createElement("mark");
      el.className = "am k-" + m.kind + (m.done ? " done" : "") + (m.active ? " on" : "");
      el.setAttribute("data-id", m.id);

      if (first && i === 0) {
        el.setAttribute("data-n", String(m.n));
        el.classList.add("first");
      }

      mid.parentNode?.insertBefore(el, mid);
      el.appendChild(mid);
    });
  };

  /* The selection as offsets in the body's text, to put back after the marks are painted again under it. */
  const keepSelection = (): (() => void) => {
    const s = getSelection();

    if (!s || !s.rangeCount || s.isCollapsed) return () => undefined;
    const r = s.getRangeAt(0);
    const before = texts().list;
    const a = offsetOf(r.startContainer, r.startOffset, before);
    const b = offsetOf(r.endContainer, r.endOffset, before);

    return () => {
      const after = texts().list;

      const at = (o: number): { node: Text; start: number } | undefined => after.find((t) => o >= t.start && o <= t.start + t.node.data.length);

      const x = at(a);
      const y = at(b);

      if (a < 0 || b <= a || !x || !y) return;
      const back = document.createRange();
      back.setStart(x.node, a - x.start);
      back.setEnd(y.node, b - y.start);
      s.removeAllRanges();
      s.addRange(back);
    };
  };

  const paint = (list: readonly Paint[] | undefined): void => {
    marks = list ?? marks;
    const restore = keepSelection();
    unpaint();
    const text = texts().text;
    const spots: { m: Paint; start: number; end: number; first: boolean }[] = [];

    for (const m of marks) if (m.show) place(m.blocks, text).spans.forEach((sp, i) => spots.push({ m, start: sp.start, end: sp.end, first: i === 0 }));

    for (const x of spots) wrap(x.start, x.end, x.m, x.first);
    restore();
    post({ annotPlaced: true });
  };

  addEventListener("message", (e: MessageEvent<FrameCommand | null>) => {
    const d = e.data;

    if (e.source !== parent || !d) return;

    if (d.annotPaint) paint(d.marks);

    if (d.annotNow) post({ annotNowSel: true, kind: d.annotNow, anchor: anchorOfSelection() });

    if (d.annotClearSel) getSelection()?.removeAllRanges();
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      touch = e.pointerType === "touch" || e.pointerType === "pen";
    },
    true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = getSelection();
      const r = s && s.rangeCount && !s.isCollapsed ? s.getRangeAt(0).getBoundingClientRect() : null;
      post({ fleetSelect: true, text: r ? String(s) : "", rect: r ? { top: r.top, bottom: r.bottom, left: r.left, width: r.width } : null, touch, anchor: r ? anchorOfSelection() : null });
    }, 180);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") post({ annotEsc: true });
  });
  document.addEventListener("click", (e) => {
    const m = e.target instanceof Element ? e.target.closest("mark.am") : null;
    const s = getSelection();

    if (m && (!s || s.isCollapsed)) {
      e.preventDefault();
      post({ annotTap: true, id: m.getAttribute("data-id") });
    }
  });
  post({ annotReady: true });
}

/** The frame's marks styles: each kind's highlight, an answered mark faded, the one being edited outlined, the number on its first piece. */
export const MARK_CSS = `mark.am{color:inherit;border-radius:3px;padding:1px 0;cursor:pointer;-webkit-tap-highlight-color:transparent}
mark.am.k-comment{background:color-mix(in srgb,var(--accent) 22%,transparent);box-shadow:inset 0 -2px var(--accent)}
mark.am.k-delete{background:color-mix(in srgb,var(--critical) 16%,transparent);text-decoration:line-through;text-decoration-color:var(--critical);text-decoration-thickness:2px}
mark.am.k-replace{background:color-mix(in srgb,var(--you) 22%,transparent);box-shadow:inset 0 -2px var(--you)}
mark.am.k-question{background:color-mix(in srgb,var(--run) 20%,transparent);box-shadow:inset 0 -2px var(--run)}
mark.am.done{background:transparent;box-shadow:inset 0 -1px var(--faint);text-decoration-color:var(--faint)}
mark.am.on{outline:2px solid var(--text);outline-offset:1px}
mark.am.first::before{content:attr(data-n);display:inline-grid;place-items:center;min-width:1.25em;height:1.25em;margin-right:2px;border-radius:999px;font:700 .68rem/1 "Archivo",system-ui,sans-serif;vertical-align:.25em;color:var(--card);background:var(--accent);text-decoration:none;-webkit-user-select:none;user-select:none}
mark.am.k-delete.first::before{background:var(--critical)}mark.am.k-replace.first::before{background:var(--you)}mark.am.k-question.first::before{background:var(--run)}mark.am.done.first::before{background:var(--faint)}`;

/** The frame's marks script, as the text of a script element. */
export const markScript = (): string => `(${String(markFrame)})(${String(placeMark)});`;
