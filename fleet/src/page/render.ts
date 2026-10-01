/**
 * The page (Python's `render_dashboard.py`): `assets/dashboard.html` with `/*__STATE__*\/` replaced by the
 * view as one line of JSON (`<` escaped, so no markup opens inside the state script), as a full
 * document or as the bare fragment the Artifact tool takes. Byte for byte what Python writes.
 */
import { dirname, join } from "node:path";

import { makeDirs, readText, SKILL_DIR, writeText } from "../files.ts";
import { dumps, type JsonObject } from "../json.ts";

/** Where the page's template is. */
export const TEMPLATE = join(SKILL_DIR, "assets", "dashboard.html");

const PLACEHOLDER = "/*__STATE__*/";

/** The template, or undefined when it cannot be read. */
export function readTemplate(): string | undefined {
  return readText(TEMPLATE);
}

/** The fragment's opening title and link lines, which a full document moves into <head>, and the rest. */
export function splitHead(fragment: string): readonly [string, string] {
  const lines = fragment.split("\n");
  let n = 0;

  while (n < lines.length && /^\s*<(?:title|link|meta)/u.test(lines[n] ?? "")) n += 1;

  return [
    lines
      .slice(0, n)
      .map((line) => `${line}\n`)
      .join(""),
    lines.slice(n).join("\n"),
  ];
}

/** The page for `shown` (the view), a full document unless `fragment`; an error when the template has
 * no placeholder. */
export function pageHtml(template: string, shown: JsonObject, fragment: boolean): string | Error {
  if (!template.includes(PLACEHOLDER)) return new Error("template has no /*__STATE__*/ placeholder");
  const payload = dumps(shown, { ensureAscii: false }).replaceAll("<", "\\u003c");
  const html = template.replace(PLACEHOLDER, () => payload);

  if (fragment) return html;
  const [head, body] = splitHead(html);

  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    "<style>:root{padding-block:env(safe-area-inset-top,0) env(safe-area-inset-bottom,0)}" +
    "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n" +
    `${head}</head>\n<body>\n${body}\n</body>\n</html>\n`
  );
}

/** Write the page to `out`, making its directory. */
export function writePage(out: string, html: string): void {
  makeDirs(dirname(out));
  writeText(out, html);
}
