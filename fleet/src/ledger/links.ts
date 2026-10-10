/**
 * What a link is to the user (Python's `links.py`): its kind as people recognise it, where it can be
 * reached from, and the hub path a `file://` link is served at.
 *
 * Kinds: `preview` (the fleet's live preview of the app), `prototype` (a throwaway sketch or round), `doc`
 * (a design note, a report, an artifact), `tool` (a page the user works in: marking, confirming gold),
 * `service` (a lab or infra endpoint). A row recorded before them says `dev` or `page`, and is read at
 * display time, never rewritten: a claude.ai artifact is a doc, an address with `/prototipo` or
 * `prototype` in it (or a title that says prototype) is a prototype, else `dev` reads as preview and
 * `page` as doc.
 */
import { basename, dirname, join, normalize, relative, sep } from "node:path";

import { splitUrl } from "../page/url.ts";

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

/** Where a link can be reached from: this machine or the tailnet (`machine`, probed), elsewhere (`external`, never
 * probed), or a file on this machine (`file`). */
export type Reach = "machine" | "external" | "file";

/** Whether `host` is this machine or a host of its tailnet. */
export function onTailnet(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();

  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || h.endsWith(".ts.net")) return true;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/u.exec(h);

  if (ip === null) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];

  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

/** Where `url` can be reached from. */
export function reachOf(url: string): Reach {
  const parts = splitUrl(url);

  if (parts.scheme === "file") return "file";

  return (parts.scheme === "http" || parts.scheme === "https") && onTailnet(parts.hostname) ? "machine" : "external";
}

/** The path a `file://` address names, normalised (`a/../b` is `b`); undefined for any other address or a remote host. */
export function filePathOf(url: string): string | undefined {
  const m = /^file:\/\/([^/]*)(\/[^?#]*)/iu.exec(url);

  if (m === null || !["", "localhost"].includes((m[1] ?? "").toLowerCase())) return undefined;

  try {
    return normalize(decodeURIComponent(m[2] ?? ""));
  } catch {
    return undefined;
  }
}

/** Where a fleet's files may be served from: its state dir, DIR's parent when that is a session's scratchpad or
 * a directory of its own under the state home (`~/.local/state/<name>`), else DIR itself. */
export function filesRoot(dir: string, env: (name: string) => string | undefined): string {
  const parent = dirname(dir);
  const given = env("XDG_STATE_HOME");
  const stateHome = given !== undefined && given !== "" ? given : join(env("HOME") ?? "", ".local", "state");

  return basename(parent) === "scratchpad" || (parent.startsWith(stateHome + sep) && parent !== stateHome) ? parent : dir;
}

/** `path` relative to `root`, its parts URI-encoded, when it lies under `root` with no part hidden (`.git`, `.env`);
 * undefined otherwise. */
export function servedRel(root: string, path: string): string | undefined {
  const rel = relative(root, path);

  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  const parts = rel.split(sep);

  if (parts.some((p) => p === "" || p.startsWith("."))) return undefined;

  return parts.map((p) => encodeURIComponent(p)).join("/");
}
