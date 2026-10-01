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

/** Most bytes a posted message may have. */
export const MAX_POST_BYTES = 16 * 1024;

/** Who sent a request. */
export interface Viewer {
  /** Their tailnet login, when known. */
  readonly login: string | undefined;
  /** Whether the request comes from this machine and names no other login. */
  readonly local: boolean;
}

/** Who sent a request from `ip` with these headers; `whois` asks Tailscale who owns a tailnet address. */
export async function viewerOf(
  ip: string,
  header: (name: string) => string | null,
  owner: string | undefined,
  whois: (ip: string) => Promise<string | undefined>,
): Promise<Viewer> {
  if (isLoopback(ip)) {
    const given = header("Tailscale-User-Login");

    return given === null || given === "" ? { login: owner, local: true } : { login: given, local: false };
  }

  return { login: isTailnetIp(ip) ? await whois(ip) : undefined, local: false };
}

/** Why `viewer` may not write, or undefined when they may. */
export function writerRefusal(owner: string | undefined, viewer: Viewer): string | undefined {
  if (viewer.local) return undefined;

  if (owner === undefined) return "chat is read-only on this address; open it on the machine that serves it";

  if ((viewer.login ?? "").toLowerCase() !== owner.toLowerCase()) return `only ${owner} can write here`;

  return undefined;
}

/** The stream's first event: whether this viewer may write, and who they are. */
export function hello(owner: string | undefined, viewer: Viewer): { readonly write: boolean; readonly reason?: string; readonly you?: string } {
  const denied = writerRefusal(owner, viewer);
  const you = viewer.login === undefined ? {} : { you: viewer.login };

  return denied === undefined ? { write: true, ...you } : { write: false, reason: denied, ...you };
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

  if (Number(length) > MAX_POST_BYTES) return [413, `a message is at most ${MAX_POST_BYTES / 1024} KiB`];

  return undefined;
}
