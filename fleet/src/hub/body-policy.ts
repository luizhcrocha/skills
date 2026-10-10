/**
 * What a decision's body may load and run, wherever it is shown: the dashboard's frame (a `<meta>` policy,
 * DecisionPage.tsx's `frameDoc`) and the file itself, as the hub serves it (a response header). The body is
 * agent-written HTML: none of its scripts, inline handlers (`onclick=`), `javascript:` links, frames,
 * objects or forms run. Its styles, the page's fonts, and its pictures (`data:`, `blob:`, the hub) load.
 * Served by itself, a body is plain text besides ({@link servedBody}).
 */

/** A body served by itself runs without the hub's origin, so nothing in it can act as the user. */
export const BODY_SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

/**
 * The header on every other file of a fleet's DIR as the hub serves it (`/f/<fleet>/<path>` outside `decisions/`):
 * agents write there, so a file opened by itself (a body's link opens a window of its own) has no origin and runs
 * no script, whatever its type. The page is rendered from state.json, not read from DIR, and loads none of DIR's
 * files as a document: its state.json, the bodies' text and their pictures load the same under this header.
 */
export const FILE_POLICY = "sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * The header on a linked file (`/f/<fleet>/files/<path>`): a linked prototype may need its scripts, so they run,
 * but in a sandbox without `allow-same-origin`, whose origin is opaque: a post from it carries `Origin: null` and
 * the hub refuses it (`postRefusal`).
 */
export const LINKED_POLICY = BODY_SANDBOX;

/**
 * The policy's directives. `script` is the one script source allowed (the frame's nonce, else `'none'`),
 * `hub` the source the hub's pictures and fonts come from, `base` what a `<base>` may name.
 */
export function bodyPolicy(script: string, hub: string, base: string): string {
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    `img-src data: blob: ${hub}`,
    `font-src data: https://fonts.gstatic.com ${hub}`,
    "object-src 'none'",
    `base-uri ${base}`,
    "form-action 'none'",
  ].join("; ");
}

/** The header on `decisions/*` as the hub serves them: sandboxed, and no script at all. */
export const BODY_POLICY = `${BODY_SANDBOX}; ${bodyPolicy("'none'", "'self'", "'none'")}`;

/** The types a file under `decisions/` keeps as the hub serves it: the pictures, fonts and media a body loads. */
const SHOWN = /^(?:image|font|audio|video)\//iu;

/**
 * A file under `decisions/` as the hub serves it by itself (`/f/<fleet>/decisions/<id>.html`): a body (HTML, or
 * anything but a picture, font or medium) as plain text, never sniffed, so nothing in it renders, runs or takes
 * the tab anywhere; a picture as itself. Both under {@link BODY_POLICY}. The page shows a body only in its own
 * frame (DecisionPage.tsx's `bodyDoc`), from the text it fetches here.
 */
export function servedBody(bytes: ConstructorParameters<typeof Response>[0], type: string, headers: Record<string, string>): Response {
  return new Response(bytes, {
    headers: {
      ...headers,
      "Content-Type": SHOWN.test(type) ? type : "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": BODY_POLICY,
    },
  });
}
