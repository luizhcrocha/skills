/** The page token in `doc`'s `<meta name="fleet-page-token">`, or "". */
const tokenIn = (doc: Document): string => doc.querySelector<HTMLMetaElement>('meta[name="fleet-page-token"]')?.content ?? "";

/** The page token the hub put in this page at its top-level load. A fleet's page shown in the manager's frame
 * (`?embed=1`) is served with none, so it sends the token of the page it is shown in, when that page has this
 * origin; a parent of another origin gives none. */
export function pageToken(): string {
  const own = tokenIn(document);

  if (own !== "" || window.parent === window) return own;

  try {
    return tokenIn(window.parent.document);
  } catch {
    return "";
  }
}

/** The headers of a chat post: JSON, and the page token (`pageToken`), which an answer that grants (allow-once,
 * allow-kind) or adds a rule (add-rule) needs (the hub's `grantRefusal`), as an image's upload does (`attach.ts`). */
export function chatHeaders(): Record<string, string> {
  const token = pageToken();

  return token === "" ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "X-Fleet-Page-Token": token };
}

/** Reload the page the user sees, for the token the hub holds now: the top-level one when this page is in a frame of
 * the same origin (the manager's, which holds the token this frame posts with), else this one. A draft is kept in
 * this browser across it. */
export function reloadTop(): void {
  let top: Window = window;

  try {
    if (window.top !== null && window.top !== window && window.top.location.origin === window.location.origin) top = window.top;
  } catch {
    // a top of another origin: reload this page
  }

  top.location.reload();
}
