/**
 * The hub's way to a fleet's preview: `/f/<fleet>/preview/…` to the combined preview's dev server and
 * `/f/<fleet>/preview/<worker>/…` to a per-worker one (a recorded per-worker preview's name wins over a
 * path of the combined one), HTTP and WebSocket both, so Vite's hot reload works through the hub, on its
 * Tailscale address and over `tailscale serve`'s https.
 *
 * Vite runs with its base at that path (`--base`), so the path goes to it as it is; its HMR client opens
 * its socket at the page's own origin under the base, which is this route. `Host` is rewritten to the dev
 * server's own address (Vite refuses a host it does not know, such as the tailnet name), and every request
 * and socket carries `X-Forwarded-Prefix` (the hub's path for the server, `/` for a root-mode preview on its
 * public port), the marker by which an app knows it came through a proxy and asks for a login. A dev server run at its root (base `/`) is asked for the path without the
 * prefix, and its redirects are put back under it.
 *
 * Who the request is from is the hub's word, never the client's: every `Tailscale-*` header and
 * `X-Forwarded-For` the client sent is dropped, and `proxiedIdentity` sets them from what the hub
 * verified. The dev server listens on loopback, where an app may trust `Tailscale-User-Login` as set by
 * `tailscale serve`; without this a tailnet peer could name any login by sending the header itself.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";

import { kept, restartCommand, serverStanding } from "../preview/sleep.ts";
import type { DevServer, PreviewRecord } from "../preview/record.ts";
import type { Viewer } from "./policy.ts";
import { isLoopback } from "./tailnet.ts";

/** What a proxied socket carries: where its other end is, and what the browser sent before that end opened. */
export interface SocketData {
  readonly url: string;
  readonly protocols: readonly string[];
  /** The headers the dev server's socket is opened with: the identity (`proxiedIdentity`) and the proxy marker. */
  readonly headers: Headers;
  readonly upstream: { socket: WebSocket | undefined; readonly queue: (string | Uint8Array)[] };
  /** Note a frame either way as use of the preview, for its idle sleep (the hub throttles the writes). */
  readonly active: () => void;
}

/** Upgrade the request being answered to a proxied socket, with these response headers; whether it was.
 * A `Headers`, since Bun 1.4.2's `server.upgrade` throws on an empty object (`{}`) but takes an empty `Headers`. */
export type Upgrade = (data: SocketData, headers: Headers) => boolean;

/** Where a preview path goes. */
export interface Target {
  readonly server: DevServer;
  /** The path the dev server is asked for. */
  readonly path: string;
  /** The hub's path for this dev server, `/f/<fleet>/preview/` or `…/preview/<worker>/`. */
  readonly prefix: string;
  /** The per-worker preview's worker, undefined for the combined one: whose last request the hub notes. */
  readonly worker: string | undefined;
}

/** A dev server asleep or still waking (`preview/sleep.ts`): the request wakes it and is answered "starting". */
export interface Waking {
  readonly waking: string | undefined;
}

/** A dev server that will not start again by itself: its keeper gave up on it (`failed`), or is gone (`unkept`). */
export interface Halted {
  readonly halted: "failed" | "unkept";
  readonly worker: string | undefined;
  readonly server: DevServer;
}

/** Where `/f/<fleet>/preview/<tail>` goes, or why it goes nowhere (status, words). */
export function previewTarget(record: PreviewRecord | undefined, fleet: string, tail: string): Target | Waking | Halted | readonly [number, string] {
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

  const now = server === null ? "stopped" : serverStanding(server);

  if (now === "asleep" || now === "waking") return { waking: own?.worker };

  if (server !== null && (now === "failed" || now === "unkept")) return { halted: now, worker: own?.worker, server };

  if (server === null || now !== "running") {
    return [502, own === undefined ? "the preview's dev server is not running: `fleet preview DIR start`" : `${own.worker}'s preview is not running: \`fleet preview DIR start --per-worker ${own.worker}\``];
  }

  return { server, path: (server.base === "/" ? "/" : server.base) + rest, prefix, worker: own?.worker };
}

/** Whether a request is only Vite's client asking whether its server is back (after its HMR socket closed):
 * it is no use of the preview, so it never wakes a sleeping server nor keeps one awake. */
export function isPing(req: Request): boolean {
  const accept = req.headers.get("Accept") ?? "";
  const protocols = req.headers.get("Sec-WebSocket-Protocol") ?? "";

  return accept.includes("text/x-vite-ping") || protocols.split(",").some((p) => p.trim() === "vite-ping");
}

/** The answer while a dev server sleeps or wakes: 503, a page that reloads itself every 2 s for a browser,
 * a line of JSON for anything else. */
export function startingPage(req: Request): Response {
  const headers = { "Cache-Control": "no-store", "Retry-After": "2" };

  if ((req.headers.get("Accept") ?? "").includes("text/html")) {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Starting…</title></head>' +
      '<body style="font:16px system-ui;margin:2em"><p>The preview was asleep and is starting… this page reloads itself.</p></body></html>';

    return new Response(req.method === "HEAD" ? null : html, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(JSON.stringify({ error: "the preview's dev server was asleep and is starting; ask again" }), { status: 503, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** The answer for a dev server that will not start again by itself (`halted`): 502, a page that says why,
 * shows the end of its log, and names the command that starts it again, and does not reload itself; a line
 * of JSON for anything but a browser. `root` is the fleet's DIR. */
export function haltedPage(req: Request, root: string, h: Halted): Response {
  const subject = h.worker === undefined ? "the preview" : `${h.worker}'s preview`;
  const again = restartCommand(root, h.worker, h.server);
  const log = h.halted === "failed" ? (h.server.failed?.log ?? "") : "";

  const said =
    h.halted === "failed"
      ? `The dev server of ${subject} couldn't start: ${h.server.failed?.why ?? "it stopped"} (${h.server.failed?.at ?? "?"}).`
      : `The keeper of ${subject} (pid ${h.server.keeper ?? "?"}) has stopped, so nothing starts its dev server again.`;

  const headers = { "Cache-Control": "no-store" };

  if ((req.headers.get("Accept") ?? "").includes("text/html")) {
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${h.halted === "failed" ? "Couldn't start" : "Preview stopped"}</title></head>` +
      `<body style="font:16px system-ui;margin:2em"><p>${escaped(said)}</p>` +
      (log === "" ? "" : `<p>The end of its log (${escaped(h.server.log)}):</p><pre style="white-space:pre-wrap">${escaped(log)}</pre>`) +
      `<p>To start it again, run:</p><pre>${escaped(again)}</pre></body></html>`;

    return new Response(req.method === "HEAD" ? null : html, { status: 502, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(JSON.stringify({ error: said, log, restart: again }), { status: 502, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

/** Whether a WebSocket frame is Vite's idle ping (`{"type":"ping"}`, every 30 s from an open tab): no use of
 * the preview, so an open tab alone never keeps its server awake. */
export function isPingFrame(data: string | ArrayBuffer | Uint8Array): boolean {
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return false;

  return data.length < 64 && /^\s*\{\s*"type"\s*:\s*"ping"\s*\}\s*$/.test(data);
}

/** Headers that belong to one connection, never passed on. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length", "accept-encoding"]);

/** Whether a request header says who the request is from, which only `proxiedIdentity` sets. */
export function isIdentity(key: string): boolean {
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
    if (kept(target.server)) return startingPage(req);

    return new Response(JSON.stringify({ error: `the preview's dev server did not answer on port ${target.server.port}: ${cause instanceof Error ? cause.message : String(cause)}` }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

/** Upgrade a WebSocket request for `target` (HMR) to a socket piped to the dev server's, opened with
 * `identity` (`proxiedIdentity`) and the proxy marker (`X-Forwarded-Prefix`), as an HTTP request is; each
 * frame but Vite's ping calls `active`. */
export function proxySocket(req: Request, target: Target, search: string, upgrade: Upgrade, identity: Headers, active: () => void = () => {}): Response | undefined {
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const headers = new Headers(identity);
  headers.set("X-Forwarded-Prefix", target.prefix);
  const data: SocketData = { url: `ws://127.0.0.1:${target.server.port}${target.path}${search}`, protocols, headers, upstream: { socket: undefined, queue: [] }, active };
  const first = protocols[0];

  if (upgrade(data, new Headers(first === undefined ? {} : { "Sec-WebSocket-Protocol": first }))) return undefined;

  return new Response(JSON.stringify({ error: "the WebSocket upgrade failed" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

/** Close the browser's socket when the dev server's closes (it went to sleep, or stopped): cleanly, with a
 * close frame, so Vite's client takes it as a close and does not poll the server back; the tab's next
 * request then gets the waking page. */
function closeBoth(ws: ServerWebSocket<SocketData>): void {
  try {
    ws.close(1001, "the preview's dev server went away");
  } catch {
    // already closed
  }
}

/** The hub's WebSocket handlers: each browser socket piped to its dev server's, both ways; every frame but
 * Vite's ping is use of the preview. */
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
      if (!isPingFrame(e.data)) ws.data.active();
      ws.send(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
    });

    up.addEventListener("close", () => closeBoth(ws));
    up.addEventListener("error", () => closeBoth(ws));
  },
  message(ws, message) {
    const up = ws.data.upstream.socket;

    if (!isPingFrame(message)) ws.data.active();

    if (up !== undefined && up.readyState === WebSocket.OPEN) up.send(message);
    else ws.data.upstream.queue.push(message);
  },
  close(ws) {
    const up = ws.data.upstream.socket;

    if (up !== undefined && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) up.close();
  },
};
