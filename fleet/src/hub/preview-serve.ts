/**
 * The listener of a root-mode preview's public port: HTTP/2 over TLS, so that a browser sends every request
 * of the page on one connection. Over HTTP/1.1 a browser opens at most 6 connections to an origin; an app that
 * keeps more long polls open than that (Electric's shape streams) leaves its module requests queued behind
 * them until a poll returns. Bun.serve speaks HTTP/1.1 only, so the port is `node:http2`'s secure server,
 * which negotiates h2 by ALPN and still answers HTTP/1.1 (`allowHTTP1`) to a client that does not speak it.
 *
 * Each request, h2 or HTTP/1.1, goes to `answer` as a web `Request` with the client's address, and its
 * `Response` is streamed back as it comes (a long poll is never buffered), without the headers HTTP/2 forbids.
 * A browser opens a WebSocket over HTTP/1.1 (the server offers no RFC 8441 extended CONNECT), so a WebSocket
 * arrives as an HTTP/1.1 upgrade: `answer` decides it as it does on the hub's own port (Host, identity), and
 * the socket is then piped, bytes both ways, to the dev server's, opened with the headers it chose.
 */
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse, type OutgoingHttpHeaders } from "node:http2";
import { connect, type Socket } from "node:net";

import { isIdentity, type SocketData, type Upgrade } from "./preview-proxy.ts";

/** What answers a request on the port: given it, the client's address, and the upgrade to a piped socket. */
export type Answer = (req: Request, ip: string, upgrade: Upgrade) => Promise<Response | undefined>;

/** A public port's listener. */
export interface PortListener {
  /** Stop taking connections; with `closeActive`, also end the open ones. */
  readonly stop: (closeActive?: boolean) => Promise<void>;
}

/** Response headers that belong to one HTTP/1.1 connection, which HTTP/2 forbids. */
const CONNECTION = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

/** Request headers the upgrade does not pass on as the client sent them: the dev server's own Host, and
 * the proxy marker, set from what `answer` chose. */
const REPLACED = new Set(["host", "x-forwarded-prefix"]);

/** The request `req` as a web `Request`, aborted when the client goes away. */
function requestOf(req: Http2ServerRequest, port: number, signal: AbortSignal): Request {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(":") || value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(key === "cookie" ? "; " : ", ") : value);
  }

  if (!headers.has("host") && req.authority !== undefined) headers.set("host", req.authority);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : bodyOf(req);

  return new Request(`https://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body, signal });
}

/** The body `req` is sending, read as the reader asks for it. */
function bodyOf(req: Http2ServerRequest): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Buffer> = req[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();

      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      req.destroy();
    },
  });
}

/** `res`'s headers as `writeHead` takes them; on HTTP/2 without the connection's own. */
function headersOf(res: Response, h2: boolean): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};

  res.headers.forEach((value, key) => {
    if (key === "set-cookie" || (h2 && CONNECTION.has(key))) return;
    out[key] = value;
  });

  const cookies = res.headers.getSetCookie();

  if (cookies.length > 0) out["set-cookie"] = cookies;

  return out;
}

/** Write `answer` to `res`, its body as it comes, and stop reading it when the client goes away. */
async function send(answer: Response, req: Http2ServerRequest, res: Http2ServerResponse): Promise<void> {
  res.writeHead(answer.status, headersOf(answer, req.httpVersionMajor === 2));

  if (answer.body === null || req.method === "HEAD") {
    res.end();

    return;
  }

  const reader = answer.body.getReader();
  const gone = (): void => void reader.cancel().catch(() => {});
  res.once("close", gone);

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve).once("close", resolve));
    }
  } catch {
    // the dev server or the client went away mid-answer
  } finally {
    res.off("close", gone);
    res.end();
  }
}

/** An answer that is not a socket, written raw on an HTTP/1.1 connection that asked to upgrade, and closed. */
async function refuseUpgrade(socket: Socket, answer: Response | undefined): Promise<void> {
  const res = answer ?? new Response(JSON.stringify({ error: "the WebSocket upgrade failed" }), { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } });
  const body = Buffer.from(await res.arrayBuffer());
  const lines = [`HTTP/1.1 ${res.status} ${res.statusText}`];

  res.headers.forEach((value, key) => {
    if (!CONNECTION.has(key) && key !== "content-length") lines.push(`${key}: ${value}`);
  });

  lines.push(`Content-Length: ${body.length}`, "Connection: close");
  socket.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body]));
}

/** Pipe the client's upgraded `socket` to the dev server's socket at `data.url`: the client's request as it
 * sent it, its identity and Host replaced by what the hub chose (`data.headers`), then bytes both ways. */
function pipeUpgrade(req: Http2ServerRequest, socket: Socket, head: Buffer, data: SocketData): void {
  const url = new URL(data.url);
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  const raw = req.rawHeaders;

  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = raw[i] ?? "";

    if (!REPLACED.has(key.toLowerCase()) && !isIdentity(key)) lines.push(`${key}: ${raw[i + 1] ?? ""}`);
  }

  data.headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  const upstream = connect(Number(url.port), url.hostname);

  upstream.once("connect", () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);

    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}

/** The JSON a request that threw is answered with, as the hub's own port does. */
function failed(cause: unknown): Response {
  return new Response(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }), { status: 500, headers: { "Content-Type": "application/json" } });
}

/** Why `hostname`:`port` cannot be bound: Bun's own error for it, since `node:net` reports it only later. */
function bindError(hostname: string, port: number): Error {
  try {
    Bun.listen({ hostname, port, socket: { data: () => {} } }).stop(true);

    return new Error("the port could not be bound");
  } catch (cause: unknown) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
}

/**
 * Serve `port` on `hostname` over TLS with `tls`, h2 and HTTP/1.1, every request and WebSocket to `answer`.
 * It throws when the port cannot be bound, as `Bun.serve` does.
 */
export function servePreviewPort(hostname: string, port: number, tls: { readonly cert: string; readonly key: string }, answer: Answer): PortListener {
  const sockets = new Set<Socket>();

  const server = createSecureServer({ cert: tls.cert, key: tls.key, allowHTTP1: true }, (req, res) => {
    const aborted = new AbortController();
    res.once("close", () => aborted.abort());
    const ip = req.socket.remoteAddress ?? "";

    void (async () => {
      let answered: Response | undefined;

      try {
        answered = await answer(requestOf(req, port, aborted.signal), ip, () => false);
      } catch (cause: unknown) {
        answered = failed(cause);
      }

      await send(answered ?? new Response(JSON.stringify({ error: "WebSockets open over HTTP/1.1 here" }), { status: 400, headers: { "Content-Type": "application/json" } }), req, res);
    })();
  });

  server.on("secureConnection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (req: Http2ServerRequest, socket: Socket, head: Buffer) => {
    let data: SocketData | undefined;
    const ip = socket.remoteAddress ?? "";
    socket.on("error", () => socket.destroy());

    void (async () => {
      let answered: Response | undefined;

      try {
        answered = await answer(requestOf(req, port, new AbortController().signal), ip, (chosen) => {
          data = chosen;

          return true;
        });
      } catch (cause: unknown) {
        answered = failed(cause);
      }

      if (data === undefined) await refuseUpgrade(socket, answered);
      else pipeUpgrade(req, socket, head, data);
    })();
  });

  server.on("error", () => {});
  server.listen(port, hostname);

  if (!server.listening) {
    server.close();

    throw bindError(hostname, port);
  }

  return {
    stop: (closeActive = false) => {
      server.close();

      if (closeActive) for (const socket of sockets) socket.destroy();

      return Promise.resolve();
    },
  };
}
