/**
 * Who may write through the preview server (Python's `serve_dashboard.writer_refusal`).
 *
 * It trusts the tailnet, not headers from the network. A request from loopback comes from this
 * machine (any local process could write chat.jsonl itself), and when it carries Tailscale's identity
 * headers it came through `tailscale serve`, which sets them. A request on the Tailscale address is
 * who `tailscale whois` says owns the machine it comes from. Only the login that owns this machine may
 * write; anyone else on the tailnet reads.
 */
import { isLoopback, isTailnetIp } from "./tailnet.ts";

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

/** Why `viewer` may not write, or undefined when they may. */
export function writerRefusal(owner: string | undefined, viewer: Viewer): string | undefined {
  if (viewer.local) return undefined;

  if (owner === undefined) return "chat is read-only on this address; open it on the machine that serves it";

  if ((viewer.login ?? "").toLowerCase() !== owner.toLowerCase()) return `only ${owner} can write here`;

  return undefined;
}
