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

/** Why a post is refused before its body is read, as [status, error], or undefined. */
export function postRefusal(
  owner: string | undefined,
  viewer: Viewer,
  hosts: ReadonlySet<string>,
  header: (name: string) => string | null,
): readonly [number, string] | undefined {
  const denied = writerRefusal(owner, viewer);

  if (denied !== undefined) return [403, denied];

  if ((header("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") return [415, "send the message as application/json"];
  const origin = header("Origin");

  if (origin !== null) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(origin);

    if (m === null || (m[1] !== "http" && m[1] !== "https") || !hosts.has((m[2] ?? "").toLowerCase())) return [403, "cross-origin post refused"];
  }

  const length = header("Content-Length") ?? "0";

  if (!/^\d+$/.test(length)) return [400, "bad Content-Length"];

  if (Number(length) > MAX_POST_BYTES) return [413, tooBig(Number(length))];

  return undefined;
}
