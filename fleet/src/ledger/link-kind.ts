/**
 * A link's kind as people recognise it: the one rule set the CLI, the hub's view and the page share. Pure, with no
 * imports, so the page's browser bundle takes it as it is (fleet/page/src/core.ts imports this file).
 *
 * Kinds: `preview` (the fleet's live preview of the app), `prototype` (a throwaway sketch or round), `doc`
 * (a design note, a report, an artifact), `tool` (a page the user works in: marking, confirming gold),
 * `service` (a lab or infra endpoint). A row recorded before them says `dev` or `page`, and is read at
 * display time, never rewritten: a claude.ai artifact is a doc, an address with `/prototipo` or
 * `prototype` in it (or a title that says prototype) is a prototype, else `dev` reads as preview and
 * `page` (or a `file:` address) as doc.
 */

/** The kinds `link --kind` records. */
export const LINK_KINDS = ["preview", "prototype", "doc", "tool", "service"] as const;

/** The kinds a link recorded before them has; `--kind` still takes them, and they are read as one of {@link LINK_KINDS}. */
export const OLD_LINK_KINDS = ["dev", "page"] as const;

/** A kind as the user sees it. */
export type LinkKind = (typeof LINK_KINDS)[number];

const ARTIFACT_RE = /^https?:\/\/(?:www\.)?claude\.ai\/(?:code\/)?artifacts?\//iu;

const PROTOTYPE_URL_RE = /\/prot[oó]tipo|prototype/iu;

const PROTOTYPE_TITLE_RE = /\bprototypes?\b|\bprot[oó]tipos?\b/iu;

/** The kind of a link with stored `kind`, address `url` and `title`, as the user sees it. */
export function linkKind(kind: string | null | undefined, url: string, title: string | null | undefined): LinkKind {
  const known = LINK_KINDS.find((k) => k === kind);

  if (known !== undefined) return known;

  if (ARTIFACT_RE.test(url)) return "doc";

  if (PROTOTYPE_URL_RE.test(url) || PROTOTYPE_TITLE_RE.test(title ?? "")) return "prototype";

  return kind === "page" || url.toLowerCase().startsWith("file:") ? "doc" : "preview";
}
