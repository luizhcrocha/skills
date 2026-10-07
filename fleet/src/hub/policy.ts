/**
 * Who may write to a fleet's chat through the hub, and the checks a post passes before its body is
 * read (Python's `serve_dashboard.writer_refusal`, `hello` and `post_refusal`).
 *
 * The hub trusts the tailnet, not headers from the network. A request from loopback comes from this
 * machine (any local process could write chat.jsonl itself), and when it carries Tailscale's identity
 * headers it came through `tailscale serve`, which sets them. A request on the Tailscale address is
 * who `tailscale whois` says owns the machine it comes from. Only the login that owns this machine may
 * write; anyone else on the tailnet reads.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { asArray, asString, parseObject } from "../json.ts";
import { isLoopback, isTailnetIp } from "./tailnet.ts";

/** Most bytes a posted message may have: the session's chat watch prints each message into an agent's
 * context, and 256 KiB (about 64k tokens) is the most one message should cost. */
export const MAX_POST_BYTES = 256 * 1024;

/** What a 413 says of a post of `bytes`: how big it is, the most it may be, and what to do instead. */
export function tooBig(bytes: number): string {
  return `This message is ${Math.ceil(bytes / 1024)} KiB; the most a message can be is ${MAX_POST_BYTES / 1024} KiB. Shorten it, or put the long part in a file and give its path.`;
}

/** Who sent a request. */
export interface Viewer {
  /** Their tailnet login, when known. */
  readonly login: string | undefined;
  /** Whether the request comes from this machine and names no other login. */
  readonly local: boolean;
  /** The login `tailscale whois` gives the address of a peer that is not this machine: the only login the
   * hub takes as proven, since a local process can claim any header. */
  readonly peer: string | undefined;
}

/** Who sent a request from `ip` with these headers; `whois` asks Tailscale who owns a tailnet address, and
 * `self` is this machine's own tailnet address. */
export async function viewerOf(
  ip: string,
  header: (name: string) => string | null,
  owner: string | undefined,
  whois: (ip: string) => Promise<string | undefined>,
  self?: string,
): Promise<Viewer> {
  if (isLoopback(ip)) {
    const given = header("Tailscale-User-Login");

    return given === null || given === "" ? { login: owner, local: true, peer: undefined } : { login: given, local: false, peer: undefined };
  }

  const login = isTailnetIp(ip) ? await whois(ip) : undefined;

  return { login, local: false, peer: self !== undefined && ip.replace(/^::ffff:/, "") === self ? undefined : login };
}

/** Who a grant says gave it: `tailnet:<login>` for a peer Tailscale vouches for, else `local`. */
export function grantor(viewer: Viewer): string {
  return viewer.peer === undefined ? "local" : `tailnet:${viewer.peer}`;
}

/** Why `viewer` may not write, or undefined when they may. */
export function writerRefusal(owner: string | undefined, viewer: Viewer): string | undefined {
  if (viewer.local) return undefined;

  if (owner === undefined) return "chat is read-only on this address; open it on the machine that serves it";

  if ((viewer.login ?? "").toLowerCase() !== owner.toLowerCase()) return `only ${owner} can write here`;

  return undefined;
}

/** The stream's first event: whether this viewer may write, who they are, and the most bytes a post may have. */
export function hello(
  owner: string | undefined,
  viewer: Viewer,
): { readonly write: boolean; readonly reason?: string; readonly you?: string; readonly max_bytes: number } {
  const denied = writerRefusal(owner, viewer);
  const you = viewer.login === undefined ? {} : { you: viewer.login };

  return denied === undefined ? { write: true, ...you, max_bytes: MAX_POST_BYTES } : { write: false, reason: denied, ...you, max_bytes: MAX_POST_BYTES };
}

/** The hub's config, a file a person edits: `{"chat_origins": ["https://<host>:<port>", ...]}`, the pages
 * that may post to a fleet's chat from another origin. Read on each request, so an edit needs no restart. */
export function chatOriginsPath(home: string): string {
  return join(home, "hub", "config.json");
}

/** The origins the hub's config allows to post to a chat: each entry an exact `http(s)://host[:port]`, as a
 * browser sends it in `Origin` (lower case, no default port, no path); any other entry, and a file that is
 * not such a JSON object, allows nothing. */
export function parseChatOrigins(text: string | undefined): ReadonlySet<string> {
  const config = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));
  const allowed = new Set<string>();

  for (const entry of asArray(config?.["chat_origins"]) ?? []) {
    const origin = asString(entry);

    if (origin === undefined || !/^https?:\/\/[^/?#@*\s]+$/.test(origin) || !URL.canParse(origin)) continue;

    if (new URL(origin).origin === origin) allowed.add(origin);
  }

  return allowed;
}

/** Whether `origin` is this hub's own: http or https on a `host:port` it answers to. */
function sameOrigin(origin: string, hosts: ReadonlySet<string>): boolean {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(origin);

  return m !== null && (m[1] === "http" || m[1] === "https") && hosts.has((m[2] ?? "").toLowerCase());
}

/** The page a post comes from when it is not the hub's own but one `allowed` lists (the CORS origin to
 * answer it with), else undefined. */
export function allowedOrigin(hosts: ReadonlySet<string>, allowed: ReadonlySet<string>, header: (name: string) => string | null): string | undefined {
  const origin = header("Origin");

  return origin !== null && allowed.has(origin) && !sameOrigin(origin, hosts) ? origin : undefined;
}

/** Why a post is refused before its body is read, as [status, error], or undefined. `allowed` are the other
 * origins it may come from (a chat post's, from the hub's config); none for every other post. */
export function postRefusal(
  owner: string | undefined,
  viewer: Viewer,
  hosts: ReadonlySet<string>,
  header: (name: string) => string | null,
  allowed: ReadonlySet<string> = new Set(),
): readonly [number, string] | undefined {
  const denied = writerRefusal(owner, viewer);

  if (denied !== undefined) return [403, denied];

  if ((header("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") return [415, "send the message as application/json"];
  const origin = header("Origin");

  if (origin !== null && !sameOrigin(origin, hosts) && !allowed.has(origin)) return [403, "cross-origin post refused"];

  // A browser names the page of every cross-site post; one that says it is cross-site and names none is refused.
  const site = (header("Sec-Fetch-Site") ?? "").toLowerCase();

  if (origin === null && (site === "cross-site" || site === "same-site")) return [403, "cross-origin post refused"];

  const length = header("Content-Length") ?? "0";

  if (!/^\d+$/.test(length)) return [400, "bad Content-Length"];

  if (Number(length) > MAX_POST_BYTES) return [413, tooBig(Number(length))];

  return undefined;
}
