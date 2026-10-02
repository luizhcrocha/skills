/**
 * The hub's way to a fleet's preview: `/f/<fleet>/preview/…` to the combined preview's dev server and
 * `/f/<fleet>/preview/<worker>/…` to a per-worker one (a recorded per-worker preview's name wins over a
 * path of the combined one), HTTP and WebSocket both, so Vite's hot reload works through the hub, on its
 * Tailscale address and over `tailscale serve`'s https.
 *
 * Vite runs with its base at that path (`--base`), so the path goes to it as it is; its HMR client opens
 * its socket at the page's own origin under the base, which is this route. Two things are rewritten:
 * `Host`, to the dev server's own address (Vite refuses a host it does not know, such as the tailnet
 * name), and nothing else. A dev server run at its root (base `/`) is asked for the path without the
 * prefix, and its redirects are put back under it.
 *
 * Who the request is from is the hub's word, never the client's: every `Tailscale-*` header and
 * `X-Forwarded-For` the client sent is dropped, and `proxiedIdentity` sets them from what the hub
 * verified. The dev server listens on loopback, where an app may trust `Tailscale-User-Login` as set by
 * `tailscale serve`; without this a tailnet peer could name any login by sending the header itself.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";

import { isRunning } from "../preview/devserver.ts";
import type { DevServer, PreviewRecord } from "../preview/record.ts";
import type { Viewer } from "./policy.ts";
import { isLoopback } from "./tailnet.ts";

/** What a proxied socket carries: where its other end is, and what the browser sent before that end opened. */
export interface SocketData {
  readonly url: string;
  readonly protocols: readonly string[];
  /** The identity headers the dev server's socket is opened with (`proxiedIdentity`). */
  readonly headers: Headers;
  readonly upstream: { socket: WebSocket | undefined; readonly queue: (string | Uint8Array)[] };
}

/** Upgrade the request being answered to a proxied socket, with these response headers; whether it was. */
export type Upgrade = (data: SocketData, headers: Readonly<Record<string, string>>) => boolean;

/** Where a preview path goes. */
export interface Target {
  readonly server: DevServer;
  /** The path the dev server is asked for. */
  readonly path: string;
  /** The hub's path for this dev server, `/f/<fleet>/preview/` or `…/preview/<worker>/`. */
  readonly prefix: string;
}

/** Where `/f/<fleet>/preview/<tail>` goes, or why it goes nowhere (status, words). */
export function previewTarget(record: PreviewRecord | undefined, fleet: string, tail: string): Target | readonly [number, string] {
  if (record === undefined) return [404, "this fleet has no preview: `fleet preview DIR start` starts one"];
  const first = tail.split("/")[0] ?? "";
  let name = first;

  try {
    name = decodeURIComponent(first);
  } catch {
    // not a worker's name
  }

  const own = first === "" ? undefined : record.workers.find((w) => w.worker === name);
  const server = own ?? record.server;
  const prefix = own === undefined ? `/f/${encodeURIComponent(fleet)}/preview/` : `/f/${encodeURIComponent(fleet)}/preview/${first}/`;
  const rest = own === undefined ? tail : tail.slice(first.length + 1);

  if (server === null || server.pid === null || !isRunning(server.pid)) {
    return [502, own === undefined ? "the preview's dev server is not running: `fleet preview DIR start`" : `${own.worker}'s preview is not running: \`fleet preview DIR start --per-worker ${own.worker}\``];
  }

  return { server, path: (server.base === "/" ? "/" : server.base) + rest, prefix };
}

/** Headers that belong to one connection, never passed on. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length", "accept-encoding"]);

/** Whether a request header says who the request is from, which only `proxiedIdentity` sets. */
function isIdentity(key: string): boolean {
  const k = key.toLowerCase();

  return k.startsWith("tailscale-") || k === "x-forwarded-for";
}

/**
 * The identity headers a request from `ip`, made by `viewer` (`viewerOf`), carries to a dev server:
 * on loopback with Tailscale's login, the `Tailscale-*` headers (and `X-Forwarded-For`) that `tailscale
 * serve` set, the one way such a request has them; from any other address, `Tailscale-User-Login` as
 * `tailscale whois` gives it (none when it gives none) and `X-Forwarded-For` the address; on loopback
 * without a login, none.
 */
export function proxiedIdentity(ip: string, viewer: Viewer, sent: Headers): Headers {
  const headers = new Headers();

  if (isLoopback(ip)) {
    if (viewer.local) return headers;

    sent.forEach((value, key) => {
      if (isIdentity(key)) headers.set(key, value);
    });

    return headers;
  }

  if (viewer.login !== undefined) headers.set("Tailscale-User-Login", viewer.login);
  headers.set("X-Forwarded-For", ip.replace(/^::ffff:/, ""));

  return headers;
}

/** Ask the dev server for `target` as the browser asked the hub for it, with `identity` (`proxiedIdentity`)
 * for who asked; its answer, passed back. */
export async function proxyHttp(req: Request, target: Target, search: string, identity: Headers): Promise<Response> {
  const headers = new Headers();

  req.headers.forEach((value, key) => {
    if (!HOP.has(key.toLowerCase()) && !isIdentity(key)) headers.set(key, value);
  });

  identity.forEach((value, key) => headers.set(key, value));
  headers.set("Host", `127.0.0.1:${target.server.port}`);
  headers.set("X-Forwarded-Prefix", target.prefix);
  const init: RequestInit = { method: req.method, headers, redirect: "manual", signal: req.signal };

  if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();

  try {
    const upstream = await fetch(`http://127.0.0.1:${target.server.port}${target.path}${search}`, init);
    const passed = new Headers();

    upstream.headers.forEach((value, key) => {
      if (!HOP.has(key.toLowerCase()) && key.toLowerCase() !== "content-encoding") passed.append(key, value);
    });

    const location = passed.get("Location");

    if (location !== null && target.server.base === "/" && location.startsWith("/") && !location.startsWith("//")) passed.set("Location", target.prefix + location.slice(1));

    return new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: passed });
  } catch (cause: unknown) {
    return new Response(JSON.stringify({ error: `the preview's dev server did not answer on port ${target.server.port}: ${cause instanceof Error ? cause.message : String(cause)}` }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

/** Upgrade a WebSocket request for `target` (HMR) to a socket piped to the dev server's, opened with
 * `identity` (`proxiedIdentity`). */
export function proxySocket(req: Request, target: Target, search: string, upgrade: Upgrade, identity: Headers): Response | undefined {
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const data: SocketData = { url: `ws://127.0.0.1:${target.server.port}${target.path}${search}`, protocols, headers: identity, upstream: { socket: undefined, queue: [] } };
  const first = protocols[0];

  if (upgrade(data, first === undefined ? {} : { "Sec-WebSocket-Protocol": first })) return undefined;

  return new Response(JSON.stringify({ error: "the WebSocket upgrade failed" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function closeBoth(ws: ServerWebSocket<SocketData>): void {
  try {
    ws.close();
  } catch {
    // already closed
  }
}

/** The hub's WebSocket handlers: each browser socket piped to its dev server's, both ways. */
export const previewSockets: WebSocketHandler<SocketData> = {
  idleTimeout: 960,
  open(ws) {
    const up = new WebSocket(ws.data.url, { protocols: [...ws.data.protocols], headers: Object.fromEntries(ws.data.headers.entries()) });
    up.binaryType = "arraybuffer";
    ws.data.upstream.socket = up;

    up.addEventListener("open", () => {
      for (const m of ws.data.upstream.queue.splice(0)) up.send(m);
    });

    up.addEventListener("message", (e: MessageEvent<string | ArrayBuffer>) => {
      ws.send(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
    });

    up.addEventListener("close", () => closeBoth(ws));
    up.addEventListener("error", () => closeBoth(ws));
  },
  message(ws, message) {
    const up = ws.data.upstream.socket;

    if (up !== undefined && up.readyState === WebSocket.OPEN) up.send(message);
    else ws.data.upstream.queue.push(message);
  },
  close(ws) {
    const up = ws.data.upstream.socket;

    if (up !== undefined && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) up.close();
  },
};
