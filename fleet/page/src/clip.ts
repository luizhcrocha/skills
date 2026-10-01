/**
 * Copying text to the clipboard from a click: `navigator.clipboard.writeText`, called inside the click's
 * handler, and where that is missing or refused (a page served over plain http on the LAN is not a secure
 * context) the text selected on the page and copied the old way, or left selected for the viewer to copy.
 */

/** How a copy ended: copied, or only selected (the viewer copies it). */
export type Copied = "copied" | "selected";

/** Select `el`'s text on the page, and copy it the old way; "selected" when the browser refused. */
export function selectAndCopy(el: Node | null): Copied {
  const sel = getSelection();

  if (el && sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  try {
    return document.execCommand("copy") ? "copied" : "selected";
  } catch {
    return "selected";
  }
}

/**
 * Copy `text`, from inside a click handler: the clipboard when the page may use it, else `fallback` (what
 * selects the text on the page and copies it). `done` hears how it ended.
 */
export function copyText(text: string, fallback: () => Copied, done: (how: Copied) => void): void {
  const clip = window.isSecureContext ? navigator.clipboard : undefined;

  if (!clip) {
    done(fallback());

    return;
  }

  clip.writeText(text).then(
    () => done("copied"),
    () => done(fallback()),
  );
}
