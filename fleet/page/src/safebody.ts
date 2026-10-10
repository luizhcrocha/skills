/**
 * A decision's body made fit for its frame (SPEC "The body runs no script"). The body is agent-written HTML, so it
 * is cut down to an allowlist by DOMPurify, which knows the parser's mutation tricks: what a decision shows
 * (text, tables, code, lists, headings, details, pictures from `data:` or the hub, a show-me SVG, classes and
 * styles) stays; whatever runs, loads a document or takes a window elsewhere goes, and every link opens a
 * window of its own. DOMPurify reads the body with scripting off, while the frame parses with it on, so the
 * result is parsed again the way the frame will parse it, in a hidden scripted frame of its own where
 * nothing can act (no origin, no source allowed but its own script), and a body that comes back holding
 * something forbidden, or changed by the second parse, is not shown: its plain text is, under a notice.
 */
import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";

import type { Json, JsonRecord } from "./core.ts";

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** A body cut to the allowlist and checked against a second parse: the only kind the frame takes. */
export type SafeBody = string & { readonly __safeBody: unique symbol };

/** Elements no body keeps: they run, load a document, submit, change the base or the parse (`noscript`, `math`, `template`), or navigate (`meta`). */
export const FORBIDDEN = ["script", "meta", "base", "form", "noscript", "math", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "link", "portal", "fencedframe", "noembed", "noframes", "xmp", "plaintext"] as const;

/** Attributes no body keeps, beyond DOMPurify's own refusals (every `on*` handler among them). */
const FORBIDDEN_ATTR = ["action", "formaction", "srcdoc", "ping", "http-equiv", "srcset", "shadowrootmode", "shadowroot"];

const CONFIG: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: [...FORBIDDEN],
  FORBID_ATTR: FORBIDDEN_ATTR,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  /* A body that opens with its own `<style>` keeps it: read in a body, not moved to a head and lost. */
  FORCE_BODY: true,
};

/** The URL attributes of a picture, which may name `data:` or the hub only. */
const PICTURE_SRC = new Map([
  ["img", ["src"]],
  ["image", ["href", "xlink:href"]],
  ["source", ["src"]],
  ["video", ["src", "poster"]],
  ["audio", ["src"]],
  ["track", ["src"]],
]);

let purifier: Purifier | null = null;

/** What an `id` or `name` that would clobber a DOM property (`open`, `forms`, `action`) becomes: DOMPurify drops it. */
export const NAMED_PREFIX = "user-content-";

/** Whether `name` as an element's `id` or `name` would shadow a property of the document or of a form, as DOMPurify judges it. */
function clobbers(name: string): boolean {
  return name !== "" && (name in document || name in document.createElement("form"));
}

/** Where the body's relative addresses point: the page's `decisions/`, as the frame's `<base>` says. */
let hubBase = "";

/** The one DOMPurify instance, with the body's own rules as hooks. */
function purify(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);

  /* An `id` or `name` DOMPurify would drop as a clobber (`id="open"`) is kept under NAMED_PREFIX, and a `#<it>`
     link (HTML or SVG) with it, so the body's own anchors still meet: the rename depends on the name alone. */
  p.addHook("uponSanitizeAttribute", (_node, data) => {
    const v = data.attrValue;

    if ((data.attrName === "id" || data.attrName === "name") && clobbers(v)) data.attrValue = NAMED_PREFIX + v;
    else if ((data.attrName === "href" || data.attrName === "xlink:href") && v.startsWith("#") && clobbers(v.slice(1))) data.attrValue = "#" + NAMED_PREFIX + v.slice(1);
  });

  p.addHook("afterSanitizeAttributes", (node) => {
    const name = node.localName;

    /* Every link, HTML or SVG, opens a window of its own: an SVG link does not take the <base>'s target. */
    if (name === "a" || name === "area") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }

    for (const attr of PICTURE_SRC.get(name) ?? []) {
      const v = node.getAttribute(attr);

      if (v !== null && !pictureAllowed(v)) node.removeAttribute(attr);
    }
  });

  purifier = p;

  return p;
}

/** Whether a picture may load from `v`: a `data:` image, or the hub (the page's origin). */
function pictureAllowed(v: string): boolean {
  if (/^\s*data:image\//iu.test(v)) return true;

  try {
    const base = new URL(hubBase || "decisions/", location.href);

    return new URL(v, base).origin === base.origin;
  } catch {
    return false;
  }
}

/** The body cut to the allowlist; `base` is where its relative addresses point (the frame's `<base>`). Not yet checked: see {@link safeBody}. */
export function sanitise(html: string, base: string): string {
  hubBase = base;

  return purify().sanitize(html, CONFIG);
}

/** A script for the check's frame: parse `html` as the body's frame will (a fragment in a `<body>`, scripting on) and post what is wrong with it to the page, with `tok`. */
const CHECK = `function(html,tok,forbidden){var out=[];try{var r=document.createRange();r.selectNodeContents(document.body);var f=r.createContextualFragment(html);var all=f.querySelectorAll("*");for(var i=0;i<all.length;i++){var el=all[i],n=el.localName.toLowerCase();if(forbidden.indexOf(n)>=0)out.push("<"+n+">");if(el.shadowRoot)out.push(n+" with a shadow root");if((n==="a"||n==="area")&&el.getAttribute("target")!=="_blank")out.push(n+" without target=_blank");for(var j=0;j<el.attributes.length;j++){var a=el.attributes[j],k=a.name.toLowerCase(),v=a.value.replace(/[\\u0000-\\u0020\\u007f-\\u00a0]+/g,"").toLowerCase();if(k.indexOf("on")===0)out.push(n+"["+k+"]");if(/^(?:javascript|vbscript):|^data:text\\/html/.test(v))out.push(n+"["+k+"] "+v.slice(0,20))}}var b=document.createElement("body");b.appendChild(f);if(b.innerHTML!==html)out.push("changed by a second parse")}catch(e){out.push("the check failed: "+e)}parent.postMessage({fleetBodyCheck:tok,problems:out},"*")}`;

/** How long the check may take before the body counts as unsafe. */
const CHECK_MS = 8000;

/** A token or nonce: 16 random bytes, base64. */
const fresh = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

/** `s` as a JavaScript string literal that no `</script>` or comment in it can end. */
const literal = (s: string): string => JSON.stringify(s).replace(/[<\u2028\u2029]/gu, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/**
 * What is wrong with `clean` once parsed as the body's frame parses it, in a hidden frame of its own (sandboxed
 * without an origin, under a policy that lets only its own script run): a forbidden element, a handler, a
 * `javascript:` address, a link not opening a window of its own, or a parse that changes it; empty when nothing is.
 */
export function reparse(clean: string): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const nonce = fresh();
    const tok = fresh();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.hidden = true;

    const done = (problems: readonly string[]): void => {
      clearTimeout(timer);
      removeEventListener("message", heard);
      frame.remove();
      resolve(problems);
    };

    const heard = (e: MessageEvent<Json>): void => {
      const d = e.data;

      if (e.source !== frame.contentWindow || e.source === null || !isRecord(d) || d["fleetBodyCheck"] !== tok) return;
      const p = d["problems"];
      const said = Array.isArray(p) ? p.filter((x): x is string => x === String(x)) : [];

      done(Array.isArray(p) && said.length === p.length ? said : ["an answer the page cannot read"]);
    };

    const timer = setTimeout(() => done(["the check did not answer"]), CHECK_MS);
    addEventListener("message", heard);
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'"></head><body><script nonce="${nonce}">(${CHECK})(${literal(clean)},${literal(tok)},${JSON.stringify(FORBIDDEN)})</script></body></html>`;
    document.body.appendChild(frame);
  });
}

const esc = (s: string): string => s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The body's text, read with no script run, for a body that cannot be shown. */
export function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const el of doc.querySelectorAll("script, style, template")) el.remove();

  return (doc.body.textContent ?? "").replace(/\n{3,}/gu, "\n\n").trim();
}

/** What the frame shows for a body that could not be shown safely: a notice, then its plain text. */
export function refusedBody(html: string): SafeBody {
  // SAFETY: the notice is the page's own words and the text is escaped: nothing of the body's markup is in it.
  return `<p class="callout">This decision's body could not be shown safely. Its text:</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(plainText(html))}</pre>` as SafeBody;
}

/**
 * The body as its frame may show it: cut to the allowlist ({@link sanitise}), then parsed again as the frame
 * will parse it ({@link reparse}); when that parse holds anything forbidden, the notice and the plain text
 * ({@link refusedBody}) instead. `check` stands in for the second parse in a test.
 */
export async function safeBody(html: string, base: string, check: (clean: string) => Promise<readonly string[]> = reparse): Promise<SafeBody> {
  const clean = sanitise(html, base);
  const problems = await check(clean);

  if (problems.length > 0) {
    console.warn("fleet: a decision's body was not shown:", problems.join("; "));

    return refusedBody(html);
  }

  // SAFETY: `clean` is DOMPurify's output, and its second parse, as the frame parses it, found nothing forbidden.
  return clean as SafeBody;
}
