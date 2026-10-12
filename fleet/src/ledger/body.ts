/**
 * A decision's or grilling's `--body FILE`: the page shows an HTML fragment, through DOMPurify. A Markdown
 * file (`.md`, `.markdown`) is converted to HTML when it is recorded (GitHub-flavoured: tables, fenced
 * code, lists); any other file is copied as written, and one that reads as Markdown gets a warning.
 */
import { Marked } from "marked";

const MARKDOWN_FILE = /\.(md|markdown)$/i;

const markdown = new Marked({ gfm: true, async: false });

/** Whether `path` names a Markdown file, converted on the way in. */
export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE.test(path);
}

/** `text` as the HTML fragment the page shows. */
export function markdownToHtml(text: string): string {
  return markdown.parse(text, { async: false });
}

/** Whether `text` reads as Markdown: a line opening with a `#` heading or `**`, or a pipe table's header and rule. */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  return lines.some(
    (line, i) =>
      /^#{1,6}\s/.test(line) ||
      line.startsWith("**") ||
      (line.startsWith("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(lines[i + 1] ?? "")),
  );
}

/** The warning for a non-Markdown file whose text reads as Markdown, or undefined. */
export function markdownWarning(path: string, text: string): string | undefined {
  if (isMarkdownFile(path) || !looksLikeMarkdown(text)) return undefined;

  return (
    `state: the body ${path} reads as Markdown (a # heading, ** or a pipe table), but --body takes an HTML fragment, ` +
    "so the page would show the marks raw. Name the file .md and it is converted to HTML, or write it as HTML."
  );
}
