/**
 * What a decision's body may load and run, wherever it is shown: the dashboard's frame (a `<meta>` policy,
 * DecisionPage.tsx's `frameDoc`) and the file itself, served by itself (a response header; serve_dashboard.py
 * keeps the same strings). The body is agent-written HTML: none of its scripts, inline handlers (`onclick=`),
 * `javascript:` links, frames, objects or forms run. Its styles, the page's fonts, and its pictures (`data:`,
 * `blob:`, the page's own origin) load. Served by itself, a body is plain text besides ({@link servedBody}).
 */

/** A body served by itself runs without the page's origin, so nothing in it can act as the user. */
const BODY_SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

/**
 * The policy's directives. `script` is the one script source allowed (the frame's nonce, else `'none'`),
 * `origin` the source the page's pictures and fonts come from, `base` what a `<base>` may name.
 */
export function bodyPolicy(script: string, origin: string, base: string): string {
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    `img-src data: blob: ${origin}`,
    `font-src data: https://fonts.gstatic.com ${origin}`,
    "object-src 'none'",
    `base-uri ${base}`,
    "form-action 'none'",
  ].join("; ");
}

/** The header on `decisions/*` served by themselves: sandboxed, and no script at all. */
const BODY_POLICY = `${BODY_SANDBOX}; ${bodyPolicy("'none'", "'self'", "'none'")}`;

/** The types a file under `decisions/` keeps when served by itself: the pictures, fonts and media a body loads. */
const SHOWN = /^(?:image|font|audio|video)\//iu;

/**
 * A file under `decisions/` served by itself (`/f/<fleet>/decisions/<id>.html`): a body (HTML, or anything but a
 * picture, font or medium) as plain text, never sniffed, so nothing in it renders, runs or takes the tab
 * anywhere; a picture as itself. Both under {@link BODY_POLICY}. The page shows a body only in its own frame
 * (DecisionPage.tsx's `bodyDoc`), from the text it fetches there.
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
