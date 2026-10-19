/**
 * Whether a session watches the preview's marks: a reviewer's picasso mark reaches a coordinator only through a
 * live `picasso watch` of a session that owns the page's page-id. `fleet preview start` and `status` read
 * `picasso status` (`$PICASSO`, else on PATH) and say when none does, with the commands that arm one; they never
 * arm it, since a watch belongs to the session that reads it. No picasso, or no sidecar: nothing to say.
 * A preview served under the hub's address carries the hub's page-id, which every fleet and dashboard on the hub
 * shares: claiming it would take every fleet's marks, so the warning says root mode is needed instead. It stays
 * silent with routing off while a watch runs (it hears every mark), and while no tab has the preview open: a
 * fleet that never opens it for marks hears nothing.
 */
import { spawnSync } from "node:child_process";

import * as Option from "effect/Option";

import { asArray, asBoolean, asNumber, asObject, asString, parseJson, type JsonObject } from "../json.ts";

/** The page-id picasso gives an origin with no label in the popup: its host, made id-safe (picasso's `pageIdOf`). */
export function pageIdOf(url: string): string {
  return new URL(url).host.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "page";
}

/** The page-id of `address`: a connected tab's on the same origin (it carries a popup label), else the derived one. */
export function pageIdFor(status: JsonObject, address: string): string {
  const origin = new URL(address).origin;
  const tab = (asArray(status["tabs"]) ?? []).map(asObject).find((t) => URL.canParse(asString(t?.["url"]) ?? "") && new URL(asString(t?.["url"]) ?? "").origin === origin);

  return asString(tab?.["pageId"]) ?? pageIdOf(address);
}

/** Whether a present session with a running watch hears `pageId`: it claims it (or acted on it lately), or
 * routing is off and every watch hears every mark. */
export function watched(status: JsonObject, pageId: string): boolean {
  const routing = asObject(status["routing"]);
  const routed = asBoolean(routing?.["on"]) === true;

  return (asArray(routing?.["sessions"]) ?? []).map(asObject).some((s) => {
    if (asBoolean(s?.["present"]) !== true || (asNumber(s?.["watches"]) ?? 0) <= 0) return false;
    const owns = [...(asArray(s?.["claims"]) ?? []), ...(asArray(s?.["implicit"]) ?? [])].some((c) => asString(c) === pageId);

    return owns || !routed;
  });
}

/** Whether a connected tab shows `address` or a page under it (same origin, its path a prefix). */
export function openIn(status: JsonObject, address: string): boolean {
  const at = new URL(address);

  return (asArray(status["tabs"]) ?? []).map(asObject).some((t) => {
    const url = asString(t?.["url"]) ?? "";

    return URL.canParse(url) && new URL(url).origin === at.origin && new URL(url).pathname.startsWith(at.pathname);
  });
}

/** Where the reviewer opens the preview: an address of its own (root mode), or one under the hub's, shared. */
export type PreviewAt = { readonly kind: "own"; readonly url: string } | { readonly kind: "shared"; readonly url: string; readonly dir: string };

/** The warning for a preview that no live watch hears, or undefined (watched, or picasso absent; under the hub's
 * address, also with no tab open on it, or with routing off and a watch running). */
export function watchWarning(env: (name: string) => string | undefined, at: PreviewAt): string | undefined {
  const address = at.url;

  if (!URL.canParse(address)) return undefined;
  const bin = env("PICASSO") || "picasso";
  const done = spawnSync(bin, ["status"], { encoding: "utf8", timeout: 5000 });

  if (done.error !== undefined || done.status !== 0) return undefined;
  const status = asObject(Option.getOrUndefined(parseJson(done.stdout)));

  if (status === undefined || status["ok"] !== true) return undefined;
  const id = pageIdFor(status, address);

  if (at.kind === "shared") {
    const routed = asBoolean(asObject(status["routing"])?.["on"]) === true;

    if (!openIn(status, address) || (!routed && watched(status, id))) return undefined;

    return `preview: a mark dropped on ${address} carries page-id ${id}, which every fleet and dashboard on the hub shares, so no watch can take this preview's marks alone; to route them, serve it in root mode: \`fleet preview ${at.dir} set --root\`, then stop and start the preview\n`;
  }

  if (watched(status, id)) return undefined;

  return `preview: no live picasso watch hears page-id ${id}, so a mark dropped on ${address} reaches no session; the coordinator arms one from its own session: \`picasso claim ${id}\`, then invoke the picasso skill, whose push delivers each batch with no timeout; without push, \`picasso watch --page-id ${id} --timeout 600\` in the background, rearmed on every exit, a timeout included (\`--after <cursor>\` from the last batch)\n`;
}
