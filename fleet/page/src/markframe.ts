/**
 * The marks' half that runs inside a decision's evidence frame (sandboxed, with no same origin, so the page
 * reaches it only by postMessage). It runs beside the body's own scripts, which can post the same messages,
 * so everything it says is a claim the page checks, never a command: it reports a selection as blocks of
 * words with the text around each (the page confirms them against the body as it parsed it, and reads the
 * cells and headings itself); paints the marks it is told of as numbered `<mark>` elements, each found
 * again by `placeMark`; and tells the page of a tap on a mark (acted on only after a real one) and of
 * Escape (which closes the selection bar only). Keys pressed here send, save and open nothing.
 *
 * With the body's scripts held off by the frame's policy, this script runs alone in the frame, so it reads the
 * browser's own layout: a selection keeps only the words Luiz could see there (`seen`), and one with none
 * is refused with the reason. The page still checks what it is told against its own reading of the body.
 *
 * Messages, page to frame: `{annotPaint, marks}`, `{annotNow: kind}` (the selection now), `{annotClearSel}`.
 * Frame to page, each carrying `fleetFrame`, the render's token (a document the frame was navigated to does
 * not know it): `{annotReady}`, `{annotPlaced}`, `{annotNowSel, kind, anchor, refused?}`, `{annotTap, id}`,
 * `{annotEsc}`, `{annotGone}` (the frame is leaving this document), and the selection as it rests,
 * `{fleetSelect, text, rect, touch, anchor, refused?}`, `anchor` being `{blocks: [{exact, prefix, suffix}]}` of
 * visible words, `refused` why none of them is (`Unseen`). On the manager's page the fleet's embedded page
 * relays them, rebuilt.
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

/** Why words are not seen: not rendered, off the document or clipped away, too faint, too small, under another element, in a closed `<details>`. */
export type Unseen = "hidden" | "offscreen" | "faint" | "tiny" | "covered" | "closed";

/** Whether a word's box is cut away by an element that clips it, and whether it lies in a scroller's hidden part (it may be scrolled to). */
interface Clip {
  readonly cut: boolean;
  readonly scrolledOut: boolean;
}

/** A selection's visible words as blocks, or why it has none. */
type Seen = { readonly anchor: Anchor; readonly text: string | null } | { readonly refused: Unseen };

/** What the frame posts to the page. */
interface Said {
  readonly [key: string]: string | number | boolean | null | Anchor | SelBox | undefined;
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
 * The frame's script, run as its own source (`String(markFrame)`) with `placeMark`'s and the render's token: it
 * uses nothing outside itself.
 */
function markFrame(place: typeof placeMark, token: string): void {
  const BLOCK = "p,li,td,th,h1,h2,h3,h4,pre,dd,dt,caption,figcaption,blockquote";
  let touch = false;
  let marks: readonly Paint[] = [];
  const post = (data: Said): void => parent.postMessage({ ...data, fleetFrame: token }, "*");

  /* ---------------------------------------------------------------- what Luiz can see, by the browser's own layout */

  /* The faintest a word's ink may be (its alpha through every opacity above it), the least contrast with what is behind it, the smallest size. */
  const MIN_ALPHA = 0.1;
  const MIN_CONTRAST = 1.2;
  const MIN_PX = 4;
  /* The SVG elements a fill paints. */
  const FILLED = new Set(["rect", "circle", "ellipse", "path", "polygon", "polyline", "line"]);
  const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "OBJECT", "EMBED", "INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
  /* Boxes `overflow` and `contain: paint` do not apply to. */
  const UNCLIPPING = new Set(["inline", "contents", "table-row", "table-row-group", "table-header-group", "table-footer-group", "table-column", "table-column-group"]);
  const ink = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const colours = new Map<string, readonly number[] | null>();

  /* A computed colour as [r, g, b, a] (0–255, alpha 0–1), whatever its notation, drawn once on a pixel; null when it is not a colour (a paint server, none). */
  const rgba = (c: string): readonly number[] | null => {
    const known = colours.get(c);

    if (known !== undefined) return known;
    let out: readonly number[] | null = null;

    if (ink && c && c !== "none" && !c.startsWith("url(") && CSS.supports("color", c)) {
      ink.clearRect(0, 0, 1, 1);
      ink.fillStyle = "#000";
      ink.fillStyle = c;
      ink.fillRect(0, 0, 1, 1);
      const d = ink.getImageData(0, 0, 1, 1).data;
      out = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    }

    colours.set(c, out);

    return out;
  };

  /* `top` painted over `under` (opaque). */
  const over = (top: readonly number[], under: readonly number[]): number[] => {
    const a = top[3] ?? 1;

    return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (under[i] ?? 0) * (1 - a)).concat(1);
  };

  const luminance = (c: readonly number[]): number => {
    const lin = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);

    return 0.2126 * lin(c[0] ?? 0) + 0.7152 * lin(c[1] ?? 0) + 0.0722 * lin(c[2] ?? 0);
  };

  const contrast = (a: readonly number[], b: readonly number[]): number => {
    const x = luminance(a);
    const y = luminance(b);

    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /* What an element paints behind its content at a point: its background colour (a shape's fill in an SVG); null for a picture or gradient, which the page cannot read. */
  const ground = (el: Element): readonly number[] | null | "none" => {
    const cs = getComputedStyle(el);

    if (el instanceof SVGElement) return FILLED.has(el.tagName) ? (rgba(cs.fill) ?? "none") : "none";

    if (cs.backgroundImage !== "none") return null;

    return rgba(cs.backgroundColor) ?? "none";
  };

  /* The opacity an element's own paint is drawn with: its `opacity` and a filter's `opacity()`, through every element above it. */
  const opacityOf = (el: Element): number => {
    let a = 1;

    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      a *= Number(cs.opacity);

      for (const m of cs.filter.matchAll(/opacity\(([\d.]+)(%?)\)/gu)) a *= Number(m[1]) / (m[2] ? 100 : 1);
    }

    return a;
  };

  /* The element a text's box belongs to: its parent, or the nearest above it with a box of its own (`display: contents` has none). */
  const boxOf = (el: Element): Element => {
    let e: Element = el;

    while (getComputedStyle(e).display === "contents" && e.parentElement) e = e.parentElement;

    return e;
  };

  /* Why the text of `el` is never seen, whatever its place: not rendered, in a closed <details>, too small, its ink too faint. Kept for one reading of a selection (a <details> opens, the frame is resized). */
  const styleCache = new Map<Element, Unseen | "">();

  const styleUnseen = (el: Element): Unseen | "" => {
    const known = styleCache.get(el);

    if (known !== undefined) return known;
    const cs = getComputedStyle(el);
    const shut = el.closest("details:not([open])");
    const paint = el instanceof SVGElement ? cs.fill : cs.getPropertyValue("-webkit-text-fill-color") || cs.color;
    const c = rgba(paint);
    let why: Unseen | "" = "";

    if (shut && el.closest("summary")?.parentElement !== shut) why = "closed";
    else if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) why = "hidden";
    else if (parseFloat(cs.fontSize) < MIN_PX) why = "tiny";
    else if (el instanceof SVGElement ? paint === "none" || (c !== null && (c[3] ?? 0) * Number(cs.fillOpacity) * opacityOf(el) <= MIN_ALPHA) : !c || (c[3] ?? 0) * opacityOf(el) <= MIN_ALPHA) why = "faint";
    styleCache.set(el, why);

    return why;
  };

  /* Whether `r` is cut away by an element above `el` that clips what overflows it (`overflow: hidden` or `clip`, `contain: paint`), in either axis; and whether it lies in a scroller's hidden part, where it may be scrolled to. */
  const clipped = (el: Element, r: DOMRect): Clip => {
    let scrolledOut = false;

    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);

      if (UNCLIPPING.has(cs.display) || (e instanceof SVGElement && e.ownerSVGElement !== null)) continue;
      const paint = /\b(?:paint|strict|content)\b/u.test(cs.contain);
      const box = e.getBoundingClientRect();
      const left = box.left + e.clientLeft;
      const top = box.top + e.clientTop;
      const outX = r.right <= left || r.left >= left + e.clientWidth;
      const outY = r.bottom <= top || r.top >= top + e.clientHeight;
      const cutX = paint || cs.overflowX === "hidden" || cs.overflowX === "clip";
      const cutY = paint || cs.overflowY === "hidden" || cs.overflowY === "clip";

      if ((cutX && outX) || (cutY && outY)) return { cut: true, scrolledOut };

      if (e !== document.body && ((!cutX && cs.overflowX !== "visible" && outX) || (!cutY && cs.overflowY !== "visible" && outY))) scrolledOut = true;
    }

    return { cut: false, scrolledOut };
  };

  /* Where Luiz can bring the box `r` of `el`'s text by scrolling: a scroller (a code block, a wide table) that holds it in its
     scroll area stands for it, its own box being what he sees once scrolled; a box out of every scroll area stays as it is. */
  const reach = (el: Element, r: DOMRect): DOMRect => {
    let at = r;

    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const scrollsX = /^(?:auto|scroll)$/u.test(cs.overflowX);
      const scrollsY = /^(?:auto|scroll)$/u.test(cs.overflowY);

      if (!scrollsX && !scrollsY) continue;
      const box = e.getBoundingClientRect();
      const left = box.left + e.clientLeft - e.scrollLeft;
      const top = box.top + e.clientTop - e.scrollTop;
      const inX = at.right > left && at.left < left + (scrollsX ? e.scrollWidth : e.clientWidth);
      const inY = at.bottom > top && at.top < top + (scrollsY ? e.scrollHeight : e.clientHeight);

      if (inX && inY) at = box;
    }

    return at;
  };

  /* The colour behind a point of `el`'s text: what the elements under it paint, top down to the first opaque one, over the page's own ground. Null when one is a picture. */
  const behind = (stack: readonly Element[], el: Element): readonly number[] | null => {
    const layers: (readonly number[])[] = [];
    const chain: Element[] = [];

    for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
    const below = stack.length ? stack : chain;

    for (const e of below) {
      const g = ground(e);

      if (g === null) return null;

      if (g === "none" || (g[3] ?? 0) === 0) continue;
      layers.push(g);

      if ((g[3] ?? 0) >= 0.99) break;
    }

    let under: readonly number[] = [255, 255, 255, 1];

    for (const l of layers.reverse()) under = over(l, under);

    return under;
  };

  /* Whether an element paints over what is under it where it is hit: a picture, a control, a shape or a background not too faint to see. */
  const paints = (e: Element): boolean => {
    if (REPLACED.has(e.tagName)) return true;

    if (e instanceof SVGElement && !FILLED.has(e.tagName)) return e.tagName === "image" || e.tagName === "foreignObject";
    const g = ground(e);

    return g === null || (g !== "none" && (g[3] ?? 0) >= MIN_ALPHA);
  };

  /* Why the word in `node` from `a` to `b` is not seen; "" when it is. */
  const wordUnseen = (node: Text, a: number, b: number): Unseen | "" => {
    const el = node.parentElement;

    if (!el) return "hidden";
    const style = styleUnseen(el);

    if (style) return style;
    const r = document.createRange();
    r.setStart(node, a);
    r.setEnd(node, b);
    const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);

    if (!rects.length) return "hidden";
    const root = document.scrollingElement ?? document.documentElement;
    let why: Unseen | "" = "offscreen";

    for (const x of rects) {
      const on = reach(el, x);

      if (on.right + scrollX <= 0 || on.bottom + scrollY <= 0 || on.left + scrollX >= root.scrollWidth || on.top + scrollY >= root.scrollHeight) continue;
      const clip = clipped(el, x);

      if (clip.cut) continue;

      if (x.height < MIN_PX || x.width < 1) {
        why = "tiny";
        continue;
      }

      const cx = x.left + x.width / 2;
      const cy = x.top + x.height / 2;
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      const owner = boxOf(el);
      /* What is drawn over the word (faint layers it shows through) and under it, top down; the ancestors' grounds when it cannot be hit (scrolled out, out of the frame's view). */
      const above: (readonly number[])[] = [];
      let under: Element[] = [];

      if (inView && !clip.scrolledOut) {
        const hits = document.elementsFromPoint(cx, cy);
        let at = -1;

        for (const [i, e] of hits.entries()) {
          if (e === owner || (e instanceof SVGTextContentElement && e.contains(owner))) {
            at = i;
            break;
          }

          if (!paints(e)) continue;
          const g = REPLACED.has(e.tagName) ? null : ground(e);

          if (g === null || g === "none" || (g[3] ?? 0) >= 0.9) break;
          above.push(g);
        }

        if (at < 0) {
          why = "covered";
          continue;
        }

        under = hits.slice(at);
      }

      const cs = getComputedStyle(el);
      const c = rgba(el instanceof SVGElement ? cs.fill : cs.getPropertyValue("-webkit-text-fill-color") || cs.color);
      const back = behind(under, el);

      if (c && back) {
        let fg = over([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, (c[3] ?? 1) * opacityOf(el)], back);
        let bg = back;

        for (const l of above.toReversed()) {
          fg = over(l, fg);
          bg = over(l, bg);
        }

        if (contrast(fg, bg) < MIN_CONTRAST) {
          why = "faint";
          continue;
        }
      }

      return "";
    }

    return why;
  };

  /* Each hit test sees every element, as if each took the pointer (one that lets it through could still cover words). */
  const hitAll = (): (() => void) => {
    const s = document.createElement("style");
    s.textContent = "*,*::before,*::after{pointer-events:auto!important}";
    document.head.appendChild(s);

    return () => s.remove();
  };

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

  /*
   * The selection as blocks of the words Luiz can see, one per block it crosses (a cell, a paragraph, a list
   * item, a heading) and split where a word he cannot see falls, each with 32 characters of the text around
   * it; `text` the visible words joined, or null when every word was seen (the selection's own text stands).
   * Null when there is no selection; refused, with the reason, when none of its words is seen.
   */
  const seenSelection = (): Seen | null => {
    const s = getSelection();

    if (!s || !s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0);
    const t = texts();
    const a = offsetOf(r.startContainer, r.startOffset, t.list);
    const b = offsetOf(r.endContainer, r.endOffset, t.list);

    if (a < 0 || b <= a) return null;
    const runs: { blk: Element; start: number; end: number }[] = [];
    const unseen: { start: number; end: number }[] = [];
    let why: Unseen | "" = "";
    styleCache.clear();
    const done = hitAll();

    try {
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
        const from = Math.max(a, s0) - s0;
        const to = Math.min(b, e0) - s0;

        for (const m of x.node.data.slice(from, to).matchAll(/\S+/gu)) {
          const ws = from + m.index;
          const w = wordUnseen(x.node, ws, ws + m[0].length);

          if (!w) continue;
          why ||= w;
          unseen.push({ start: s0 + ws, end: s0 + ws + m[0].length });
        }
      }
    } finally {
      done();
    }

    const blocks: Block[] = [];

    for (const g of runs) {
      const cuts = unseen.filter((u) => u.end > g.start && u.start < g.end);
      let at = g.start;

      for (const piece of [...cuts, { start: g.end, end: g.end }]) {
        const x = t.text.slice(at, piece.start);
        const st = at + (x.length - x.replace(/^\s+/u, "").length);
        const en = piece.start - (x.length - x.replace(/\s+$/u, "").length);

        if (en > st) blocks.push({ exact: t.text.slice(st, en), prefix: t.text.slice(Math.max(0, st - 32), st), suffix: t.text.slice(en, en + 32) });
        at = Math.max(at, piece.end);
      }
    }

    if (!blocks.length) return { refused: why || "hidden" };

    return { anchor: { blocks }, text: unseen.length ? blocks.map((x) => x.exact).join("\n") : null };
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

    if (d.annotNow) {
      const seen = seenSelection();
      post({ annotNowSel: true, kind: d.annotNow, anchor: seen && "anchor" in seen ? seen.anchor : null, refused: seen && "refused" in seen ? seen.refused : undefined });
    }

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
      const seen = r ? seenSelection() : null;
      const rect = r ? { top: r.top, bottom: r.bottom, left: r.left, width: r.width } : null;

      if (seen && "refused" in seen) post({ fleetSelect: true, text: "", rect, touch, anchor: null, refused: seen.refused });
      else post({ fleetSelect: true, text: seen ? (seen.text ?? String(s)) : "", rect: seen ? rect : null, touch, anchor: seen ? seen.anchor : null });
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
  /* The frame leaving this document (a navigation): the page stops taking or sending anything here. */
  addEventListener("pagehide", () => post({ annotGone: true }));
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

/** The frame's marks script, as the text of a script element, with the render's token. */
export const markScript = (token: string): string => `(${String(markFrame)})(${String(placeMark)}, ${JSON.stringify(token)});`;
