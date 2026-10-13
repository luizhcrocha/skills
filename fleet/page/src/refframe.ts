/**
 * The references' half that runs inside a decision's evidence frame (sandboxed, with no same origin, so the
 * page reaches it only by postMessage). The body is agent-written HTML made safe before it goes in
 * (safebody.ts), and nothing of it is rewritten as text: the frame's own script walks the text nodes the
 * parser made and puts a link, built with the DOM, around each reference the page told it of. It reads the
 * words with the page's own `refRuns` (its source, as the marks' script runs `placeMark`), so a reference is
 * the same thing in the body as anywhere on the page.
 *
 * The page reads the body's words first (`bodyRefs`, with no script run), finds the row each reference names
 * and tells the frame only those: the fleets a number may be named with, and per reference a number `n`, its
 * tip and its address. The link is a real one that opens a window of its own, as every link of a body does
 * (the frame may not take the page anywhere). A plain tap on it instead tells the page `{fleetRef: n}`, with the
 * render's token: a claim the page acts on only after a real tap in that frame, and only by going where the page
 * itself said `n` leads, so the frame never names an address.
 */
import type { JsonRecord } from "./core.ts";
import { refRuns, type KnownFleet } from "./refs.ts";

/** A reference as the frame is told of it: its number in the page's list, its tip, and the address its link opens in a window of its own. */
export interface FrameRef {
  readonly n: number;
  readonly tip: string;
  readonly href: string;
}

/** What the frame is told: the fleets a number may be named with, and each reference of the body the page found, by {@link refKey}. */
export interface FrameRefs {
  readonly fleets: readonly KnownFleet[];
  readonly known: { readonly [key: string]: FrameRef };
}

/** The references of a body: what its frame is told, and where each leads on this page, by its `n`. */
export interface BodyRefs {
  readonly told: FrameRefs;
  readonly leads: readonly string[];
}

/** Where a reference leads: on this page (`go`, what a tap follows), and as an address of its own (`href`), with its tip. */
export interface Lead {
  readonly go: string;
  readonly href: string;
  readonly tip: string;
}

/** The key a reference goes by between the page and the frame: the fleet named before it (none: ""), and its number or id. */
export const refKey = (fleet: string | null, num: string): string => (fleet ?? "") + "\u0000" + num;

/** The elements whose words are never a reference: a link of the body's own, code, a control, a drawing. */
export const UNLINKED = "a,code,pre,kbd,samp,script,style,textarea,button,select,option,svg,math";

/**
 * The references in the body `html` (made safe already), read as the frame will read them: text node by text
 * node, outside {@link UNLINKED}, with `refRuns` as it reads running words (a short word standing alone, `D1`, is none). `isId` says whether a word is a row's id in this ledger;
 * `lead` where a reference leads, or null when the page cannot find it (it stays text).
 */
export function bodyRefs(html: string, fleets: readonly KnownFleet[], isId: (word: string) => boolean, lead: (fleet: string | null, num: string) => Lead | null): BodyRefs {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const known: { [key: string]: FrameRef } = {};
  const leads: string[] = [];
  const missed = new Set<string>();

  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.parentElement?.closest(UNLINKED)) continue;

    for (const run of refRuns(node.nodeValue ?? "", fleets, isId)) {
      const key = run.kind === "ref" ? refKey(run.fleet, run.num) : "";

      if (run.kind !== "ref" || Object.hasOwn(known, key) || missed.has(key)) continue;
      const to = lead(run.fleet, run.num);

      if (to === null) {
        missed.add(key);
        continue;
      }

      known[key] = { n: leads.length, tip: to.tip, href: to.href };
      leads.push(to.go);
    }
  }

  return { told: { fleets, known }, leads };
}

/**
 * The frame's script, run as its own source (`String(refFrame)`) with `refRuns`'s, what the page told it and the
 * render's token: it uses nothing outside itself. It builds each link with the DOM (never from text), and
 * tells the page only the number of a link it made itself.
 */
function refFrame(runs: typeof refRuns, told: FrameRefs, token: string, unlinked: string): void {
  const made = new WeakMap<Element, number>();

  const known = (fleet: string | null, num: string): FrameRef | undefined => {
    const key = (fleet ?? "") + "\u0000" + num;

    return Object.hasOwn(told.known, key) ? told.known[key] : undefined;
  };

  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];

  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node instanceof Text && !node.parentElement?.closest(unlinked)) nodes.push(node);
  }

  for (const node of nodes) {
    const parts = runs(node.data, told.fleets, (word) => known(null, word) !== undefined);

    if (!parts.some((p) => p.kind === "ref" && known(p.fleet, p.num))) continue;
    const drawn = document.createDocumentFragment();

    for (const p of parts) {
      const ref = p.kind === "ref" ? known(p.fleet, p.num) : undefined;

      if (!ref) {
        drawn.append(p.text);
        continue;
      }

      const a = document.createElement("a");
      a.className = "dref";
      a.href = ref.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = ref.tip;
      a.textContent = p.text;
      made.set(a, ref.n);
      drawn.append(a);
    }

    node.replaceWith(drawn);
  }

  document.addEventListener("click", (e) => {
    const at = e.target instanceof Element ? e.target : null;
    const link = at?.closest("a");
    const n = link ? made.get(link) : undefined;

    /* A modified click opens the link the browser's way (a window of its own); a tap on a mark, or on a mark's pin (markframe.ts puts it after the mark, so inside the link the mark ends in), is the mark's. */
    if (n === undefined || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || at?.closest("mark.am, [data-pin]")) return;
    e.preventDefault();
    parent.postMessage({ fleetFrame: token, fleetRef: n }, "*");
  });
}

/** `value` as JSON in a script's text: no `<` of it can end the script or open a comment. */
const inScript = (value: FrameRefs | string): string => JSON.stringify(value).replace(/[<\u2028\u2029]/gu, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** The frame's references script, as the text of a script element, with what the page tells it and the render's token. */
export const refScript = (told: FrameRefs, token: string): string => `(${String(refFrame)})(${String(refRuns)}, ${inScript(told)}, ${inScript(token)}, ${inScript(UNLINKED)});`;

/** The frame's style of a reference's link, as the page's own (`.dref`). */
export const REF_CSS = "a.dref{font-weight:600;text-decoration:underline dotted;text-underline-offset:2px}";

/** The number of the reference a frame's message says was tapped (`{fleetRef: n}`); null for any other message. */
export function tappedRef(data: JsonRecord): number | null {
  const n = data["fleetRef"];

  return n === Number(n) && Number.isInteger(n) && n >= 0 ? n : null;
}
