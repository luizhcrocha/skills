/**
 * A decision's body as the page reads it itself (SPEC "Marks on a decision"). The frame runs the body's own
 * scripts next to the marks' script, so what it posts is a claim: the page parses the same document it gave
 * the frame (its srcdoc) with DOMParser, where no script runs, and checks the claim against that text. A
 * selection is confirmed only when each of its blocks occurs there with the text the frame says is around
 * it; the quote, its cells and where it was are then read from the page's own parse, not from the frame.
 *
 * Only words Luiz could see confirm. Text the parse holds but the frame does not show (a `hidden` or
 * `aria-hidden` element, an inline style or one of the body's own stylesheets that hides it, shrinks it to
 * nothing, moves it off screen or paints it in the background's colour) stays in `text`, so the text around
 * a block is counted as the frame counts it, but no block may fall on it. Whatever the page cannot work out
 * without running the body (an external stylesheet, a computed value) counts as hidden.
 */
import type { Json, JsonRecord, MarkQuote } from "./core.ts";
import { parseSelection, type Claimed } from "./marks.ts";

/** The elements a selection is cut into blocks by, as the frame cuts it (markframe.ts). */
const BLOCK = "p,li,td,th,h1,h2,h3,h4,pre,dd,dt,caption,figcaption,blockquote";

/** The characters of the body's text the frame keeps on each side of a block. */
const AROUND = 32;

/** A decision's body as the page read it: its text, as the frame reads its own, and the check of a selection. */
export interface BodyText {
  /** The body's text nodes (no script or style), joined: hidden ones too, as the frame counts them. */
  readonly text: string;
  /** The selection `claim` as a quote read from this body; null when a block of it is not there with the text around it. */
  readonly confirm: (claim: readonly Claimed[]) => MarkQuote | null;
}

/** A table cell, as a mark keeps it. */
type CellAt = { readonly table: string; readonly row: number; readonly rowLabel: string; readonly column: string; readonly head?: true };

const words = (n: Node | null | undefined): string => (n?.textContent ?? "").trim();

/* ------------------------------------------------------------------ what Luiz can see */

/** A CSS declaration: its property and value, lower-cased, `!important` dropped. */
type Decl = readonly [prop: string, value: string];

/** A style rule of one of the body's own sheets. */
interface Rule {
  readonly selector: string;
  readonly decls: readonly Decl[];
}

/** A colour as red, green, blue (0–255) and alpha (0–1). */
type Rgba = readonly [r: number, g: number, b: number, a: number];

/** Elements whose content the frame never shows as text Luiz can select. */
const UNSHOWN = new Set(["template", "noscript", "script", "style", "head", "title", "iframe", "object", "embed", "noembed", "noframes", "canvas", "video", "audio", "select", "datalist", "rp"]);

/** The SVG elements whose text an inline SVG draws (a figure's labels); the rest (`defs`, `symbol`, `mask`, `clipPath`, `pattern`, `marker`, `metadata`, a gradient or filter) draw none. */
const SVG_DRAWN = new Set(["svg", "g", "text", "tspan", "textPath", "a", "switch"]);

/** An SVG element's attributes that style it as the properties of the same name do (its presentation attributes), as far as the page reads them. */
const SVG_STYLED = ["display", "visibility", "opacity", "fill", "fill-opacity", "font-size", "transform", "clip-path", "mask", "filter"];

const XHTML = "http://www.w3.org/1999/xhtml";

const SVG = "http://www.w3.org/2000/svg";

/** Values that leave a property as its parent has it, or as the browser starts it. */
const KEEPS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** A value the page would have to compute to know. */
const COMPUTED = /\b(?:var|calc|env|attr|min|max|clamp|if|round|mod|rem|sign|abs|progress|anchor|anchor-size)\(/u;

/** Pseudo-elements: a rule on them styles generated content, not the element's own text (::first-line and ::first-letter do). */
const PSEUDO = /::?(?:before|after|marker|placeholder|selection|backdrop|file-selector-button|cue|grammar-error|spelling-error|target-text|highlight|part|slotted|details-content|view-transition|-webkit-|-moz-)/u;

/** At-rules whose rules count as always applying (a media query is not evaluated). */
const NESTS = new Set(["media", "supports", "layer", "container", "scope", "starting-style", "document", "-moz-document"]);

/** At-rules that hold no rule for an element. */
const SKIPS = new Set(["keyframes", "-webkit-keyframes", "font-face", "page", "property", "counter-style", "font-feature-values", "font-palette-values", "view-transition", "position-try"]);

/** CSS's named colours, as hex. */
const NAMED = new Map(
  (
    "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff " +
    "blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc " +
    "crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b " +
    "darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b " +
    "darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 " +
    "dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 " +
    "gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c " +
    "lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 " +
    "lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 " +
    "lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 " +
    "mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a " +
    "mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 " +
    "oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee " +
    "palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 " +
    "red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d " +
    "silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 " +
    "thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32"
  )
    .split(" ")
    .map((p): [string, string] => [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)]),
);

/** Text whose contrast with what is behind it is under this counts as painted in the background's colour. */
const MIN_CONTRAST = 1.2;

/** The smallest font, in CSS pixels, that counts as shown. */
const MIN_FONT_PX = 4;

/** CSS pixels per unit, roughly (a viewport unit as on a phone): enough to tell a font shrunk to nothing from a small one. */
const PX: ReadonlyMap<string, number> = new Map(
  Object.entries({ px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 37.8, mm: 3.78, q: 0.945, em: 15, rem: 15, ex: 7.5, ch: 7.5, cap: 10, ic: 15, lh: 22, rlh: 22, "%": 0.15, vw: 4, vh: 7, vmin: 4, vmax: 7, svw: 4, svh: 7, lvw: 4, lvh: 7, dvw: 4, dvh: 7 }),
);

/** `css` cut at each of the `stop` characters met outside strings, parentheses and brackets. */
function pieces(css: string, stop: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;

  for (let i = 0; i < css.length; i += 1) {
    const c = css.charAt(i);

    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if ((c === ")" || c === "]") && depth > 0) depth -= 1;
    else if (depth === 0 && stop.includes(c)) {
      out.push(css.slice(from, i));
      from = i + 1;
    }
  }

  out.push(css.slice(from));

  return out;
}

/** A declaration block's declarations; one with an escape in it (which the page does not decode) reads as `\`, which hides. */
function declsOf(block: string): Decl[] {
  const out: Decl[] = [];

  for (const text of pieces(block, ";")) {
    const at = text.indexOf(":");

    if (at < 0) continue;
    const prop = text.slice(0, at).trim().toLowerCase();
    const value = text.slice(at + 1).trim().replace(/!\s*important$/iu, "").trim().toLowerCase();

    out.push(text.includes("\\") && !prop.startsWith("--") ? ["\\", value] : [prop, value]);
  }

  return out;
}

/** Where the block opened at `open` (a `{`) closes, outside strings; the text's end when it does not. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  let quote = "";

  for (let j = open; j < text.length; j += 1) {
    const c = text.charAt(j);

    if (quote) {
      if (c === "\\") j += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;

      if (depth === 0) return j;
    }
  }

  return text.length;
}

/** The style rules of a sheet's text, added to `rules`; false when the page cannot read it all (an import, a nested rule, an unknown at-rule). */
function readSheet(css: string, rules: Rule[]): boolean {
  const text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, " ");
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);
    const prelude = pieces(rest, "{;")[0] ?? "";
    const open = i + prelude.length;

    if (text.charAt(open) !== "{") {
      if (/^\s*@import\b/iu.test(prelude)) return false;
      i = open + 1;

      continue;
    }

    const close = blockEnd(text, open);
    const body = text.slice(open + 1, close);
    const at = /^\s*@([\w-]+)/u.exec(prelude)?.[1]?.toLowerCase();
    i = close + 1;

    if (at !== undefined) {
      if (NESTS.has(at) ? !readSheet(body, rules) : !SKIPS.has(at)) return false;

      continue;
    }

    if (body.includes("{")) return false;
    rules.push({ selector: prelude.trim(), decls: declsOf(body) });
  }

  return true;
}

/** Whether `selector` styles `el` itself (not only its generated content); a selector the browser would drop styles nothing. */
function styles(el: Element, selector: string): boolean {
  return pieces(selector, ",").some((part) => {
    if (PSEUDO.test(part)) return false;

    try {
      return el.matches(part.replace(/::?first-(?:line|letter)\b/gu, "").trim() || "*");
    } catch {
      return false;
    }
  });
}

/** A number and its unit; null when `v` is not one. */
function lengthOf(v: string): { readonly n: number; readonly unit: string } | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/u.exec(v.trim());

  return m ? { n: Number(m[1]), unit: m[2] ?? "" } : null;
}

/** A length in CSS pixels, roughly; null when it is no length the page knows. */
function pxOf(v: string): number | null {
  const l = lengthOf(v);

  if (!l) return null;

  if (l.n === 0) return 0;
  const per = PX.get(l.unit);

  return per === undefined ? null : l.n * per;
}

/** A negative length among `v`'s, or one the page cannot work out. */
const pulledBack = (v: string): boolean => COMPUTED.test(v) || v.split(/\s+/u).some((w) => (pxOf(w) ?? 0) < 0);

/** The properties that hide whatever value other than `none` (or `normal`) they take. */
const HIDES_UNLESS_NONE = new Set(["clip-path", "filter", "mask", "mask-image", "-webkit-mask", "-webkit-mask-image", "transform", "translate", "scale", "animation", "animation-name", "content"]);

/** The properties that hide at a size of a pixel or less. */
const SIZES = new Set(["width", "height", "max-width", "max-height", "block-size", "inline-size", "max-block-size", "max-inline-size"]);

/** Whether one declaration alone hides an element's text (its colour aside, which needs what is behind it). */
function hidesAlone([prop, v]: Decl): boolean {
  if (prop === "\\") return true;

  if (KEEPS.has(v) || prop.startsWith("--")) return false;
  const computed = COMPUTED.test(v);

  if (HIDES_UNLESS_NONE.has(prop)) return v !== "none" && v !== "normal";

  if (SIZES.has(prop)) return computed || (pxOf(v) ?? 2) <= 1;

  switch (prop) {
    case "display":
      return computed || v === "none";
    case "visibility":
      return computed || v === "hidden" || v === "collapse";
    case "content-visibility":
      return computed || v === "hidden";
    case "opacity":
    case "fill-opacity": {
      const l = lengthOf(v);

      return !l || (l.unit === "%" ? l.n < 10 : l.n < 0.1);
    }

    case "font-size": {
      if (/^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|math)$/u.test(v)) return false;
      const px = pxOf(v);

      return px === null || px < MIN_FONT_PX;
    }

    case "clip":
      return v !== "auto";
    case "user-select":
    case "-webkit-user-select":
      return computed || v === "none";
    case "text-indent":
      return computed || (pxOf(v.split(/\s+/u)[0] ?? "") ?? 0) <= -100;
    case "letter-spacing":
      return computed || (pxOf(v) ?? 0) <= -3;
    default:
      return false;
  }
}

/** Positioned out of the frame: absolute or fixed, and pulled back by an offset or a margin. */
function offScreen(decls: readonly Decl[]): boolean {
  const placed = decls.some(([p, v]) => p === "position" && (v === "absolute" || v === "fixed" || COMPUTED.test(v)));

  return placed && decls.some(([p, v]) => /^(?:left|top|right|bottom|inset(?:-[\w-]+)?|margin(?:-[\w-]+)?)$/u.test(p) && pulledBack(v));
}

/** A hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa); null when `v` is not one. */
function hexColor(v: string): Rgba | null {
  const h = /^#([0-9a-f]{3,8})$/u.exec(v)?.[1];

  if (!h || h.length === 5 || h.length === 7) return null;
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;

  const at = (i: number): number => Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);

  return [at(0), at(1), at(2), full.length === 8 ? at(3) / 255 : 1];
}

/** An rgb()/rgba()/hsl()/hsla() colour; null when `v` is not one the page can read. */
function fnColor(v: string): Rgba | null {
  const m = /^(rgba?|hsla?)\((.*)\)$/u.exec(v);
  const parts = (m?.[2] ?? "").split(/[\s,/]+/u).filter((s) => s !== "");

  /* A channel as a number: a percentage of `scale`, else as written. */
  const num = (s: string | undefined, scale: number): number | null => {
    const l = s === undefined ? null : lengthOf(s.replace(/deg$/u, ""));

    if (!l || (l.unit !== "" && l.unit !== "%")) return null;

    return l.unit === "%" ? (l.n / 100) * scale : l.n;
  };

  const alpha = parts.length === 4 ? num(parts[3], 1) : 1;

  if (!m || parts.length < 3 || parts.length > 4 || alpha === null) return null;

  if (m[1]?.startsWith("rgb")) {
    const [r, g, b] = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];

    return r === null || g === null || b === null ? null : [r, g, b, alpha];
  }

  const [hue, s, l] = [num(parts[0], 360), num(parts[1], 1), num(parts[2], 1)];

  if (hue === null || s === null || l === null) return null;

  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;

    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };

  return [f(0), f(8), f(4), alpha];
}

/** Every colour `v` may be, a custom property read as any value it takes anywhere; null when one is none the page can read. */
function colorsOf(v: string, vars: ReadonlyMap<string, readonly string[]>, depth = 0): Rgba[] | null {
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/u.exec(v);

  if (ref) {
    const fallback = ref[2]?.trim();
    const values = [...(vars.get(ref[1] ?? "") ?? []), ...(fallback ? [fallback] : [])];

    if (depth > 8 || !values.length) return null;
    const out: Rgba[] = [];

    for (const x of values) {
      const c = colorsOf(x, vars, depth + 1);

      if (!c) return null;
      out.push(...c);
    }

    return out;
  }

  if (v === "transparent") return [[0, 0, 0, 0]];
  const named = NAMED.get(v);
  const one = named ? hexColor("#" + named) : (hexColor(v) ?? fnColor(v));

  return one ? [one] : null;
}

/** Words of a `background` shorthand that paint no colour. */
const NOT_PAINT = /^(?:none|repeat|no-repeat|repeat-x|repeat-y|space|round|scroll|fixed|local|border-box|padding-box|content-box|text|top|bottom|left|right|center|auto|cover|contain|\/)$/u;

/** The colours a `background` shorthand paints; null when it paints what the page cannot read (an image, a gradient). */
function backgroundsOf(v: string, vars: ReadonlyMap<string, readonly string[]>): Rgba[] | null {
  if (/(?:url|image|image-set|cross-fade|element|paint|gradient)\(/u.test(v)) return null;
  const whole = colorsOf(v, vars);

  if (whole) return whole;
  const out: Rgba[] = [];

  for (const w of pieces(v, " ")) {
    if (!w.trim() || NOT_PAINT.test(w.trim()) || lengthOf(w)) continue;
    const c = colorsOf(w.trim(), vars);

    if (!c) return null;
    out.push(...c);
  }

  return out.length ? out : [[0, 0, 0, 0]];
}

/** The first number of an SVG attribute (a list's first), in user units; null when it is not a plain number. */
function svgNumber(el: Element, name: string, absent: number | null = 0): number | null {
  const v = el.getAttribute(name);

  if (v === null) return absent;
  const first = v.trim().split(/[\s,]+/u)[0] ?? "";
  const l = lengthOf(first);

  return l && (l.unit === "" || l.unit === "px") ? l.n : null;
}

/** An opacity as a fraction from 0 to 1 (a number or a percentage); NaN when it is not one. */
function fraction(v: string): number {
  return Math.min(1, Math.max(0, v.endsWith("%") ? Number.parseFloat(v) / 100 : Number(v)));
}

/** Where an SVG label is anchored (its x and y); null when the page cannot read it. */
function pointOf(el: Element): readonly [x: number, y: number] | null {
  const x = svgNumber(el, "x");
  const y = svgNumber(el, "y");

  return x === null || y === null ? null : [x, y];
}

/** Whether a rect, circle or ellipse covers the point `p`, from its own attributes; false when the page cannot read them. */
function holds(backdrop: Element, [px, py]: readonly [number, number]): boolean {
  if (backdrop.localName === "rect") {
    const [x, y, w, h] = [svgNumber(backdrop, "x"), svgNumber(backdrop, "y"), svgNumber(backdrop, "width", null), svgNumber(backdrop, "height", null)];

    return x !== null && y !== null && w !== null && h !== null && px >= x && px <= x + w && py >= y && py <= y + h;
  }

  const [cx, cy] = [svgNumber(backdrop, "cx"), svgNumber(backdrop, "cy")];
  const [rx, ry] = backdrop.localName === "circle" ? [svgNumber(backdrop, "r", null), svgNumber(backdrop, "r", null)] : [svgNumber(backdrop, "rx", null), svgNumber(backdrop, "ry", null)];

  return cx !== null && cy !== null && rx !== null && ry !== null && rx > 0 && ry > 0 && ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
}

/** Whether two elements of one SVG are placed in the same coordinates: nothing that `moves` (a transform, a nested SVG) on either's way up to the element holding both. */
function sameSpace(a: Element, b: Element, moves: (e: Element) => boolean): boolean {
  for (const start of [a, b]) {
    const other = start === a ? b : a;

    for (let e: Element | null = start; e && !e.contains(other); e = e.parentElement) if (moves(e)) return false;
  }

  return true;
}

/** `top` painted over `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3] + under[3] * (1 - top[3]);

  const mix = (i: 0 | 1 | 2): number => (a === 0 ? 0 : (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a);

  return [mix(0), mix(1), mix(2), a];
}

/** WCAG's contrast ratio of two colours (their alpha left out). */
function contrast(x: Rgba, y: Rgba): number {
  const lum = (c: Rgba): number => {
    const lin = (n: number): number => {
      const s = Math.min(255, Math.max(0, n)) / 255;

      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };

  const [a, b] = [lum(x), lum(y)];

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The colours an element's text may be, or what is behind it: none the page can read (null), or the page's own theme, which the body did not touch. */
type Paint = Rgba[] | null | "theme";

/**
 * Whether the text directly in an element of `doc` is hidden from Luiz, read with no script run: by the
 * element or an ancestor (its tag, the `hidden` or `aria-hidden` attribute, an inline style, a rule of the
 * body's own `<style>` sheets), or by its colour against what is behind it. All of it is hidden when the
 * body has a sheet the page cannot read.
 */
function hiddenTest(doc: Document): (el: Element | null) => boolean {
  const rules: Rule[] = [];
  let readable = doc.body.querySelector('link[rel~="stylesheet" i]') === null;

  for (const s of doc.body.querySelectorAll("style")) readable = readSheet(s.textContent ?? "", rules) && readable;

  /* Each custom property's values anywhere: the head's theme, the body's sheets, inline styles. */
  const vars = new Map<string, string[]>();
  const all: Rule[] = [];

  for (const s of doc.querySelectorAll("style")) readSheet(s.textContent ?? "", all);

  for (const decls of [...all.map((r) => r.decls), ...[...doc.querySelectorAll("[style]")].map((el) => declsOf(el.getAttribute("style") ?? ""))]) {
    for (const [p, v] of decls) if (p.startsWith("--")) vars.set(p, [...(vars.get(p) ?? []), v]);
  }

  const declsCache = new Map<Element, readonly Decl[]>();

  /* An element's declarations: its sheets' rules in order, then the old colour attributes and its style attribute. */
  const declsFor = (el: Element): readonly Decl[] => {
    const known = declsCache.get(el);

    if (known) return known;
    const out: Decl[] = [];

    /* An SVG element's presentation attributes, under every rule; a unitless size is in pixels, and a transform that only moves it hides nothing. */
    if (el.namespaceURI === SVG) {
      for (const name of SVG_STYLED) {
        const v = el.getAttribute(name)?.trim().toLowerCase();

        if (v === undefined || (name === "transform" && /^(?:translate\(\s*[-+\d.e]+(?:[\s,]+[-+\d.e]+)?\s*\)\s*)*$/u.test(v))) continue;
        out.push([name, name === "font-size" && lengthOf(v)?.unit === "" ? v + "px" : v]);
      }
    }

    for (const r of rules) if (styles(el, r.selector)) out.push(...r.decls);
    const color = el.localName === "font" ? el.getAttribute("color") : null;
    const bg = el.getAttribute("bgcolor");

    if (color) out.push(["color", color.trim().toLowerCase()]);

    if (bg) out.push(["background-color", bg.trim().toLowerCase()]);
    out.push(...declsOf(el.getAttribute("style") ?? ""));
    declsCache.set(el, out);

    return out;
  };

  const boxCache = new Map<Element, boolean>();

  /* Hidden by itself or an ancestor, whatever its colour. */
  const boxHidden = (el: Element | null): boolean => {
    if (!el) return false;
    const known = boxCache.get(el);

    if (known !== undefined) return known;
    const d = declsFor(el);

    const self =
      UNSHOWN.has(el.localName) ||
      (el.namespaceURI !== XHTML && !(el.namespaceURI === SVG && SVG_DRAWN.has(el.localName))) ||
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
      (el.localName === "dialog" && !el.hasAttribute("open")) ||
      d.some(hidesAlone) ||
      offScreen(d);

    const hidden = self || boxHidden(el.parentElement);
    boxCache.set(el, hidden);

    return hidden;
  };

  /* The nearest element (`el`, then up) that sets one of `props`, and what it sets them to; null when none does. */
  const nearest = (el: Element, props: readonly string[]): { readonly at: Element; readonly values: readonly Decl[] } | null => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const values = declsFor(e).filter(([p, v]) => props.includes(p) && !KEEPS.has(v));

      if (values.length) return { at: e, values };
    }

    return null;
  };

  const theme = (name: string): Paint => (vars.has(name) ? colorsOf(`var(${name})`, vars) : "theme");

  /* Every colour the text may be: what its nearest colour says, else the page's text colour. An SVG's text is painted in its fill (black unless set; `currentColor` its colour). */
  const inks = (el: Element): Paint => {
    if (el.namespaceURI === SVG) {
      const fill = nearest(el, ["fill"]);

      if (!fill) return [[0, 0, 0, 1]];
      const out: Rgba[] = [];

      for (const [, v] of fill.values) {
        if (v === "currentcolor") return colorInks(el);
        const c = v === "none" ? [[0, 0, 0, 0] as const] : colorsOf(v, vars);

        if (!c) return null;
        out.push(...c);
      }

      return out;
    }

    return colorInks(el);
  };

  /* Every colour `color` makes the text: what the nearest colour says, else the page's text colour. */
  const colorInks = (el: Element): Paint => {
    const set = nearest(el, ["color", "-webkit-text-fill-color"]);

    if (!set) return theme("--text");
    const out: Rgba[] = [];

    for (const [, v] of set.values) {
      const c = v === "currentcolor" ? null : colorsOf(v, vars);

      if (!c) return null;
      out.push(...c);
    }

    return out;
  };

  /* The shapes an SVG label is drawn over, top down: each rect, circle or ellipse painted before it in its SVG
     whose area holds the label's anchor, both placed in the same coordinates (no transform or nested SVG between
     them); the colours each paints. Null when one paints what the page cannot read. A backdrop the page cannot place
     is not counted, so its label is read against what is behind the SVG, as before. */
  const moves = (e: Element): boolean => e.hasAttribute("transform") || e.localName === "svg" || declsFor(e).some(([p]) => /^(?:transform|translate|rotate|scale|x|y|width|height|cx|cy|r|rx|ry)$/u.test(p));

  const backdropsOf = (el: Element): Rgba[][] | null => {
    const label = el.closest("text");
    const svg = label?.closest("svg");

    if (!label || !svg) return [];
    const anchor = pointOf(el.localName === "tspan" && el.hasAttribute("x") && el.hasAttribute("y") ? el : label);

    if (!anchor) return [];
    const layers: Rgba[][] = [];

    for (const backdrop of svg.querySelectorAll("rect, circle, ellipse")) {
      if (!(backdrop.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING) || !holds(backdrop, anchor) || !sameSpace(backdrop, label, moves) || boxHidden(backdrop.parentElement)) continue;
      const d = declsFor(backdrop);

      if (d.some(hidesAlone)) continue;

      const fill = nearest(backdrop, ["fill"]);
      const alpha = [...(nearest(backdrop, ["fill-opacity"])?.values ?? []), ...d.filter(([p]) => p === "opacity")].reduce((a, [, v]) => a * fraction(v), 1);

      if (Number.isNaN(alpha)) return null;
      const paint: Rgba[] = fill ? [] : [[0, 0, 0, 1]];

      for (const [, v] of fill?.values ?? []) {
        const c: Paint = v === "none" ? [[0, 0, 0, 0]] : v === "currentcolor" ? colorInks(backdrop) : colorsOf(v, vars);

        if (c === null || c === "theme") return null;
        paint.push(...c);
      }

      layers.unshift(paint.map(([r, g, b, a]): Rgba => [r, g, b, a * alpha]));
    }

    return layers;
  };

  /* Every colour behind the text: the shapes an SVG label is drawn over, then the backgrounds from it up to the first opaque one, over the page's card. */
  const grounds = (el: Element): Paint => {
    const backdrops = el.namespaceURI === SVG ? backdropsOf(el) : [];

    if (backdrops === null) return null;
    const layers: Rgba[][] = [];

    for (const layer of backdrops) {
      layers.push(layer);

      if (layer.every((c) => c[3] >= 1)) break;
    }

    for (let e: Element | null = layers.at(-1)?.every((c) => c[3] >= 1) ? null : el; e; ) {
      const set = nearest(e, ["background", "background-color"]);

      if (!set) break;
      const layer: Rgba[] = [];

      for (const [p, v] of set.values) {
        const c = p === "background" ? backgroundsOf(v, vars) : colorsOf(v, vars);

        if (!c) return null;
        layer.push(...c);
      }

      layers.push(layer);

      if (layer.every((c) => c[3] >= 1)) break;
      e = set.at.parentElement;
    }

    const card = theme("--card");

    if (!layers.length) return card;
    let under: Rgba[] = [];

    if (!layers.at(-1)?.every((c) => c[3] >= 1)) {
      if (card === null || card === "theme") return null;
      under = card;
    }

    for (const layer of layers.toReversed()) {
      under = under.length ? layer.flatMap((top) => under.map((u) => over(top, u))) : layer;

      if (under.length > 64) return null;
    }

    return under;
  };

  const textCache = new Map<Element, boolean>();

  /* Painted in what is behind it: too little contrast, or colours the page cannot read; the page's own theme against itself is seen. */
  const blends = (el: Element): boolean => {
    const ink = inks(el);
    const ground = grounds(el);

    if (ink === "theme" && ground === "theme") return false;

    if (ink === null || ground === null || ink === "theme" || ground === "theme") return true;

    return ink.some((c) => ground.some((g) => contrast(over(c, g), g) < MIN_CONTRAST));
  };

  return (el) => {
    if (!el) return true;
    const known = textCache.get(el);

    if (known !== undefined) return known;
    const hidden = !readable || boxHidden(el) || blends(el);
    textCache.set(el, hidden);

    return hidden;
  };
}


/** Read `srcdoc` (the frame's whole document) as the frame shows it, with no script run. */
export function readBody(srcdoc: string): BodyText {
  const doc = new DOMParser().parseFromString(srcdoc, "text/html");
  const list: { node: Text; start: number; hidden: boolean }[] = [];
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const hiddenIn = hiddenTest(doc);
  let pos = 0;

  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!(n instanceof Text) || /^(SCRIPT|STYLE)$/u.test(n.parentNode?.nodeName ?? "")) continue;
    list.push({ node: n, start: pos, hidden: /\S/u.test(n.data) && hiddenIn(n.parentElement) });
    pos += n.data.length;
  }

  const text = list.map((t) => t.node.data).join("");

  const nodeAt = (at: number): Text | null => list.find((t) => at >= t.start && at < t.start + t.node.data.length)?.node ?? null;

  /* Whether any word from `start` to `end` is in text Luiz cannot see. */
  const unseen = (start: number, end: number): boolean => list.some((t) => t.hidden && t.start < end && t.start + t.node.data.length > start && /\S/u.test(t.node.data.slice(Math.max(0, start - t.start), end - t.start)));

  /* Where `exact` is, in words Luiz can see, with exactly `prefix` before it and `suffix` after it, as the frame cuts them; -1 when nowhere. */
  const find = (b: Claimed): number => {
    for (let i = text.indexOf(b.exact); i >= 0; i = text.indexOf(b.exact, i + 1)) {
      const end = i + b.exact.length;

      if (text.slice(Math.max(0, i - AROUND), i) === b.prefix && text.slice(end, end + AROUND) === b.suffix && !unseen(i, end)) return i;
    }

    return -1;
  };

  /* A table's own children by tag, its rows and a row's cells, read from the elements (not the table APIs, so any DOM reads them alike). */
  const childOf = (el: Element, tag: string): Element | null => [...el.children].find((c) => c.tagName === tag) ?? null;

  const rowsOf = (table: Element): Element[] => [...table.querySelectorAll("tr")].filter((r) => r.closest("table") === table);

  const cellsOf = (tr: Element | null | undefined): Element[] => (tr ? [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH") : []);

  /* A table's header row: its head's first row, a row the page marks `head`, else a first row of only header cells (as the frame's table script finds it). */
  const headRow = (table: Element, rows: readonly Element[]): Element | null => {
    const thead = childOf(table, "THEAD");
    const first = rows[0];
    const firstCells = cellsOf(first);

    const inHead = thead ? rows.find((r) => r.parentElement === thead) : undefined;

    return inHead ?? rows.find((r) => r.classList.contains("head")) ?? (first && firstCells.length && firstCells.every((c) => c.tagName === "TH") ? first : null);
  };

  const before = (a: Node, b: Node): boolean => a === b || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  /* The heading above `el` (or `el` itself), among `tags`. */
  const headingOf = (el: Element, tags: string): string => {
    let name = "";

    for (const h of doc.body.querySelectorAll(tags)) if (before(h, el)) name = words(h);

    return name;
  };

  const tableName = (table: Element): string => {
    const caption = childOf(table, "CAPTION");

    return caption ? words(caption) : headingOf(table, "h1,h2,h3,h4");
  };

  const cellOf = (td: Element): CellAt | null => {
    const tr = td.parentElement;
    const table = td.closest("table");

    if (!tr || tr.tagName !== "TR" || !table) return null;
    const rows = rowsOf(table);
    const head = headRow(table, rows);
    const index = cellsOf(tr).indexOf(td);
    const isHead = tr === head || tr.parentElement?.tagName === "THEAD";
    const named = cellsOf(head)[index];
    const column = named ? words(named) : (td.getAttribute("data-label") ?? "column " + String(index + 1));
    const body = rows.filter((r) => r !== head && r.parentElement?.tagName !== "THEAD");
    const cell = { table: tableName(table), row: isHead ? 0 : body.indexOf(tr) + 1, rowLabel: words(cellsOf(tr)[0]), column };

    return isHead ? { ...cell, head: true } : cell;
  };

  const confirm = (claim: readonly Claimed[]): MarkQuote | null => {
    const blocks: JsonRecord[] = [];
    const cells: CellAt[] = [];
    let first: Element | null = null;

    for (const b of claim) {
      const at = find(b);
      const el = at < 0 ? null : (nodeAt(at)?.parentElement ?? null);

      if (!el) return null;
      const blk = el.closest(BLOCK) ?? el;
      const cell = blk.tagName === "TD" || blk.tagName === "TH" ? cellOf(blk) : null;
      const block = { exact: b.exact, prefix: b.prefix, suffix: b.suffix };
      first ??= blk;

      if (cell) cells.push(cell);
      blocks.push(cell ? { ...block, cell } : block);
    }

    let where: Json;

    if (cells.length) {
      const rows: number[] = [];
      const cols: string[] = [];

      for (const c of cells) {
        if (!c.head && !rows.includes(c.row)) rows.push(c.row);

        if (!cols.includes(c.column)) cols.push(c.column);
      }

      where = { table: { name: cells[0]?.table ?? "", rows, cols } };
    } else {
      where = first ? { tag: first.tagName.toLowerCase(), section: headingOf(first, "h1,h2,h3"), label: first.getAttribute("data-label") ?? "", row: 0 } : null;
    }

    return parseSelection({ blocks, where });
  };

  return { text, confirm };
}
