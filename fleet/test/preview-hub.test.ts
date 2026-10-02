/**
 * The hub's way to a fleet's preview, against a stand-in dev server in this process: `/f/<fleet>/preview/…`
 * goes to the combined preview's server and `/f/<fleet>/preview/<worker>/…` to a per-worker one, with the
 * path kept for a server told its base and stripped for one at its root, `Host` rewritten, the WebSocket
 * (Vite's HMR, protocol `vite-hmr`) piped both ways; and `POST preview-workers` takes a worker in or out
 * under the chat's write policy. The dev server sees only the identity the hub verified: never a client's
 * own Tailscale-* headers.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { connect as connectH2, type ClientHttp2Session, type OutgoingHttpHeaders } from "node:http2";
import { join } from "node:path";
import { connect } from "node:tls";

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { readRecord, recordJson, type DevServer, type PreviewRecord } from "../src/preview/record.ts";
import { viewerOf } from "../src/hub/policy.ts";
import { previewSockets, proxiedIdentity, type SocketData } from "../src/hub/preview-proxy.ts";
import type { Certificate, CertificateSource } from "../src/hub/preview-tls.ts";
import { servePreviewPort } from "../src/hub/preview-serve.ts";
import { hubRecordPath, previewPortsPath, startHub, type Running } from "../src/hub/server.ts";
import { baseEnv, fleet, machine, selfSigned, tmp, type Environment, type Pem } from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;

let base: string;

let dir: string;

let env: Environment;

let hub: Running | undefined;

let hubPort: number;

/** What each stand-in server was asked. */
const asked: { readonly server: string; readonly path: string; readonly host: string; readonly method: string }[] = [];

/** The identity headers (Tailscale-*, X-Forwarded-For) each request to a stand-in server carried. */
const seen: Record<string, string>[] = [];

/** The proxy marker (`X-Forwarded-Prefix`) each request to a stand-in server carried, or null. */
const marks: (string | null)[] = [];

const stubs: ReturnType<typeof Bun.serve>[] = [];

const peers: Bun.Server<SocketData>[] = [];

const OWNER = "luiz@example.com";

/** A tailscale that knows no tailnet of its own, and says 100.101.1.2 is OWNER's machine and no one owns 100.90.3.4. */
const FAKE_TAILSCALE = `#!/bin/sh
case "$1 $2 $3" in
  "whois --json 100.101.1.2") printf '%s' '{"UserProfile": {"LoginName": "${OWNER}", "DisplayName": "Luiz"}}' ;;
  *) exit 1 ;;
esac
`;

/** The identity headers among `headers`: its Tailscale-* ones and X-Forwarded-For, keys lowercased. */
function identityOf(headers: Headers): { readonly [key: string]: string } {
  return Object.fromEntries([...headers.entries()].filter(([key]) => key.startsWith("tailscale-") || key === "x-forwarded-for"));
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const got = probe.port ?? 0;
  void probe.stop(true);

  return got;
}

/** The long polls a stand-in server holds (`/poll`), each answered once `release` is called. */
let held: Promise<void> = Promise.resolve();

let release: () => void = () => {};

/** Hold every `/poll` from now until `release` is called. */
function holdPolls(): void {
  held = new Promise((resolve) => {
    release = resolve;
  });
}

/** A stand-in dev server named `name`: answers with what it was asked, redirects `/old` to `/new`, holds `/poll`
 * as a long poll (`holdPolls`), answers `/body` with the body it was sent, echoes on a socket on the protocol it was
 * asked for, if any. */
function stub(name: string): number {
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      seen.push(identityOf(req.headers));
      marks.push(req.headers.get("x-forwarded-prefix"));

      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        asked.push({ server: name, path: `${url.pathname}${url.search}`, host: req.headers.get("host") ?? "", method: "WS" });

        const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const upgraded = protocol === undefined ? srv.upgrade(req, { data: undefined }) : srv.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": protocol } });

        return upgraded ? undefined : new Response("no", { status: 400 });
      }

      asked.push({ server: name, path: url.pathname, host: req.headers.get("host") ?? "", method: req.method });

      if (url.pathname.endsWith("/old")) return new Response(null, { status: 302, headers: { Location: "/new" } });

      if (url.pathname === "/poll") {
        await held;

        return new Response(`${name} polled`);
      }

      if (url.pathname === "/body") return new Response(`${name} ${req.method} ${(await req.text()).length}`, { headers: { Connection: "keep-alive", "Keep-Alive": "timeout=5" } });

      return new Response(`${name} ${req.method} ${url.pathname}`);
    },
    websocket: {
      message(ws, message) {
        ws.send(`${name} echo:${String(message)}`);
      },
    },
  });

  stubs.push(server);

  return server.port ?? 0;
}

function server(port: number, base$: string, public$: number | null = null): DevServer {
  return { cmd: "stub", port, pid: process.pid, base: base$, path: dir, log: join(dir, "x.log"), started: "", public: public$ };
}

function writeRecord(record: Partial<PreviewRecord>): void {
  const full: PreviewRecord = {
    fleet: "shop",
    workspace: "preview",
    path: dir,
    repo: dir,
    server: null,
    updater: null,
    include: [],
    exclude: [],
    merged: [],
    stack: null,
    stackFrom: null,
    stackGiven: null,
    commit: null,
    conflicts: [],
    error: null,
    updated: null,
    workers: [],
    ports: { combined: null, workers: {} },
    ...record,
  };

  writeFileSync(join(dir, "preview.json"), JSON.stringify(recordJson(full)));
}

const at = (path: string): string => `http://127.0.0.1:${hubPort}/f/shop${path}`;

beforeEach(async () => {
  base = tmp("fleet-preview-hub-");
  dir = join(base, "fleet");
  const tailscale = join(base, "tailscale");
  writeFileSync(tailscale, FAKE_TAILSCALE);
  chmodSync(tailscale, 0o755);
  env = baseEnv(join(base, "registry"), { TAILSCALE: tailscale });
  expect(fleet(["state", dir, "init", "--project", "shop", "--goal", "g", "--no-render"], env).code).toBe(0);
  const rows = { workspaces: [{ id: "a1", agent: "a1", path: join(base, "repo-a1"), repo: join(base, "repo"), base: "", added: "", status: "active" }] };
  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text());
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, ...rows }));
  expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
  hubPort = freePort();
  const started = await startHub({ port: hubPort, machine: machine(env), tailscale, peers: false, hosts: [], https: undefined }, () => {});

  if (started instanceof Error) throw started;
  hub = started;
  asked.length = 0;
  seen.length = 0;
  marks.length = 0;
});

afterEach(async () => {
  release();
  await hub?.stop();

  for (const s of stubs.splice(0)) void s.stop(true);

  for (const p of peers.splice(0)) void p.stop(true);
});

describe("the preview through the hub", () => {
  test("HTTP goes to the combined preview's server with its path and the server's own Host", async () => {
    const port = stub("combined");
    writeRecord({ server: server(port, "/f/shop/preview/") });
    const res = await fetch(at("/preview/src/main.tsx?v=1"), { headers: { "Accept-Encoding": "gzip" } });
    expect([res.status, await res.text()]).toEqual([200, "combined GET /f/shop/preview/src/main.tsx"]);
    expect(asked.at(-1)).toEqual({ server: "combined", path: "/f/shop/preview/src/main.tsx", host: `127.0.0.1:${port}`, method: "GET" });

    const bare = await fetch(at("/preview?x=1"), { redirect: "manual" });
    expect([bare.status, bare.headers.get("Location")]).toEqual([301, "/f/shop/preview/?x=1"]);
  });

  test("a per-worker preview has its own path, and a server at its root is asked without the prefix", async () => {
    const combined = stub("combined");
    const own = stub("a1");
    writeRecord({ server: server(combined, "/"), workers: [{ ...server(own, "/f/shop/preview/a1/"), worker: "a1" }] });
    expect(await (await fetch(at("/preview/a1/index.html"))).text()).toBe("a1 GET /f/shop/preview/a1/index.html");
    expect(await (await fetch(at("/preview/a2/index.html"))).text()).toBe("combined GET /a2/index.html");
    const moved = await fetch(at("/preview/old"), { redirect: "manual" });
    expect([moved.status, moved.headers.get("Location")]).toEqual([302, "/f/shop/preview/new"]);
  });

  test("the WebSocket is piped both ways, on the protocol the browser asked for", async () => {
    const port = stub("combined");
    writeRecord({ server: server(port, "/f/shop/preview/") });
    const socket = new WebSocket(`ws://127.0.0.1:${hubPort}/f/shop/preview/?token=t0k`, "vite-hmr");

    const got = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (e) => resolve(String(e.data)));
      socket.addEventListener("error", () => reject(new Error("socket failed")));
    });

    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    expect(socket.protocol).toBe("vite-hmr");
    socket.send("ping");
    expect(await got).toBe("combined echo:ping");
    expect(asked.find((a) => a.method === "WS")).toEqual({ server: "combined", path: "/f/shop/preview/?token=t0k", host: `127.0.0.1:${port}`, method: "WS" });
    socket.close();
  });

  test("a WebSocket that asks for no protocol is piped too", async () => {
    const port = stub("combined");
    writeRecord({ server: server(port, "/f/shop/preview/") });
    const socket = new WebSocket(`ws://127.0.0.1:${hubPort}/f/shop/preview/`);

    const got = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (e) => resolve(String(e.data)));
      socket.addEventListener("error", () => reject(new Error("socket failed")));
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("socket failed")));
    });
    expect(socket.protocol).toBe("");
    socket.send("ping");
    expect(await got).toBe("combined echo:ping");
    expect(asked.find((a) => a.method === "WS")).toEqual({ server: "combined", path: "/f/shop/preview/", host: `127.0.0.1:${port}`, method: "WS" });
    socket.close();
  });

  test("no preview is a 404, a stopped server a 502, and a write from another login is refused", async () => {
    expect((await fetch(at("/preview/"))).status).toBe(404);
    writeRecord({ server: { ...server(stub("combined"), "/f/shop/preview/"), pid: null } });
    const down = await fetch(at("/preview/"));
    expect(down.status).toBe(502);
    expect(await down.text()).toContain(`the preview's dev server is not running: \`fleet preview ${dir} start\``);

    writeRecord({ server: server(stub("combined"), "/f/shop/preview/") });
    const other = await fetch(at("/preview/api"), { method: "POST", headers: { "Tailscale-User-Login": "someone@else" }, body: "x" });
    expect(other.status).toBe(403);
    const mine = await fetch(at("/preview/api"), { method: "POST", body: "x" });
    expect(await mine.text()).toBe("combined POST /f/shop/preview/api");
  });
});

/** Forged identity: what any client may put on a request. */
const FORGED = { "Tailscale-User-Login": "mallory@example.com", "Tailscale-User-Name": "Mallory", "Tailscale-User-Profile-Pic": "http://x/m.png", "X-Forwarded-For": "1.2.3.4" };

/** What `tailscale serve` puts on a request it passes to the hub on loopback. */
const SERVED = { "Tailscale-User-Login": OWNER, "Tailscale-User-Name": "Luiz", "Tailscale-User-Profile-Pic": "http://x/l.png" };

/** A listener that hands each request to the hub as one from `ip` would come (a tailnet address this test
 * cannot connect from), WebSockets too, as the hub's own listener does; its port. */
function peerAt(ip: string): number {
  const listener = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: previewSockets,
    fetch(req, srv) {
      const running = hub;

      if (running === undefined) throw new Error("no hub");
      const headers = new Headers(req.headers);
      headers.set("Host", `127.0.0.1:${hubPort}`);

      return running.hub.fetch(new Request(req.url, { method: req.method, headers }), ip, () => {}, (data, answer) => srv.upgrade(req, { data, headers: answer }));
    },
  });

  peers.push(listener);

  return listener.port ?? 0;
}

describe("the identity a preview's dev server sees", () => {
  test("proxiedIdentity: Tailscale's headers on loopback, whois's login and the address from a peer, else none", async () => {
    const whois = (ip: string): Promise<string | undefined> => Promise.resolve(ip === "100.101.1.2" ? OWNER : undefined);

    const of = async (ip: string, sent: { readonly [key: string]: string }): Promise<{ readonly [key: string]: string }> => {
      const headers = new Headers(sent);

      return identityOf(proxiedIdentity(ip, await viewerOf(ip, (name) => headers.get(name), OWNER, whois, "100.69.1.1"), headers));
    };

    expect(await of("127.0.0.1", { ...SERVED, "X-Forwarded-For": "100.101.1.2", Accept: "*/*" })).toEqual({
      "tailscale-user-login": OWNER,
      "tailscale-user-name": "Luiz",
      "tailscale-user-profile-pic": "http://x/l.png",
      "x-forwarded-for": "100.101.1.2",
    });
    expect(await of("::1", { "Tailscale-User-Name": "Mallory", "X-Forwarded-For": "1.2.3.4" })).toEqual({});
    expect(await of("100.101.1.2", FORGED)).toEqual({ "tailscale-user-login": OWNER, "x-forwarded-for": "100.101.1.2" });
    expect(await of("::ffff:100.90.3.4", { ...FORGED, "Tailscale-User-Login": OWNER })).toEqual({ "x-forwarded-for": "100.90.3.4" });
    expect(await of("192.168.1.5", FORGED)).toEqual({ "x-forwarded-for": "192.168.1.5" });
  });

  test("a tailnet peer's forged Tailscale headers never reach it: it gets the login Tailscale gives that peer, or none", async () => {
    writeRecord({ server: server(stub("combined"), "/f/shop/preview/") });
    const owners = peerAt("100.101.1.2");
    const res = await fetch(`http://127.0.0.1:${owners}/f/shop/preview/api/me`, { headers: FORGED });
    expect(await res.text()).toBe("combined GET /f/shop/preview/api/me");
    expect(seen.at(-1)).toEqual({ "tailscale-user-login": OWNER, "x-forwarded-for": "100.101.1.2" });

    await fetch(`http://127.0.0.1:${peerAt("100.90.3.4")}/f/shop/preview/api/me`, { headers: { ...FORGED, "Tailscale-User-Login": OWNER } });
    expect(seen.at(-1)).toEqual({ "x-forwarded-for": "100.90.3.4" });
  });

  test("a request through tailscale serve keeps the identity it set; a plain local one carries none", async () => {
    writeRecord({ server: server(stub("combined"), "/f/shop/preview/") });
    await fetch(at("/preview/api/me"), { headers: SERVED });
    expect(seen.at(-1)).toEqual({ "tailscale-user-login": OWNER, "tailscale-user-name": "Luiz", "tailscale-user-profile-pic": "http://x/l.png" });
    await fetch(at("/preview/api/me"), { headers: { "Tailscale-User-Name": "Mallory", "Tailscale-User-Profile-Pic": "http://x/m.png" } });
    expect(seen.at(-1)).toEqual({});
    await fetch(at("/preview/api/me"));
    expect(seen.at(-1)).toEqual({});
  });

  test("the WebSocket carries the same identity: served, plain, and a forging peer", async () => {
    writeRecord({ server: server(stub("combined"), "/f/shop/preview/") });

    const opened = async (port: number, headers: { readonly [key: string]: string }): Promise<{ readonly [key: string]: string } | undefined> => {
      seen.length = 0;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/f/shop/preview/`, { protocols: ["vite-hmr"], headers });

      const echoed = new Promise<string>((resolve, reject) => {
        socket.addEventListener("message", (e) => resolve(String(e.data)));
        socket.addEventListener("error", () => reject(new Error("socket failed")));
      });

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("socket failed")));
      });
      socket.send("ping");
      expect(await echoed).toBe("combined echo:ping");
      socket.close();

      return seen.at(-1);
    };

    expect(await opened(hubPort, SERVED)).toEqual({ "tailscale-user-login": OWNER, "tailscale-user-name": "Luiz", "tailscale-user-profile-pic": "http://x/l.png" });
    expect(await opened(hubPort, {})).toEqual({});
    expect(await opened(peerAt("100.90.3.4"), { ...FORGED, "Tailscale-User-Login": OWNER })).toEqual({ "x-forwarded-for": "100.90.3.4" });
    expect(await opened(peerAt("100.101.1.2"), FORGED)).toEqual({ "tailscale-user-login": OWNER, "x-forwarded-for": "100.101.1.2" });
  });
});

describe("POST preview-workers", () => {
  const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(at("/preview-workers"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

  test("takes a worker out and back in, under the chat's write policy", async () => {
    writeRecord({});
    const out = await post(JSON.stringify({ worker: "a1", include: false }));
    expect([out.status, await out.json()]).toEqual([200, { include: [], exclude: ["a1"] }]);
    expect(readRecord(dir)?.exclude).toEqual(["a1"]);
    const back = await post(JSON.stringify({ worker: "a1", include: true }));
    expect(await back.json()).toEqual({ include: ["a1"], exclude: [] });

    expect((await post(JSON.stringify({ worker: "a1" }))).status).toBe(400);
    expect((await post(JSON.stringify({ worker: "zz", include: true }))).status).toBe(400);
    expect((await post(JSON.stringify({ worker: "a1", include: true }), { Origin: "http://evil.example" })).status).toBe(403);
    expect((await post(JSON.stringify({ worker: "a1", include: true }), { "Tailscale-User-Login": "someone@else" })).status).toBe(403);
    expect((await fetch(at("/preview-workers"), { method: "POST", body: "{}" })).status).toBe(415);
  });
});

/** A tailscale that says this machine is box.example.ts.net at 127.0.0.2 (a loopback address a test can
 * bind, standing in for its tailnet address), owned by OWNER, and that 100.101.1.2 is OWNER's machine. */
const TAILNET_TAILSCALE = `#!/bin/sh
case "$1 $2 $3" in
  "status --json "*) printf '%s' '${JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.example.ts.net.", TailscaleIPs: ["127.0.0.2"], UserID: 1 }, User: { "1": { LoginName: OWNER } }, Peer: {} })}' ;;
  "whois --json 100.101.1.2") printf '%s' '{"UserProfile": {"LoginName": "${OWNER}", "DisplayName": "Luiz"}}' ;;
  *) exit 1 ;;
esac
`;

describe("a preview at the root of a public port of its own", () => {
  let publicPort: number;

  /** The certificate the hub is given in these tests, for this machine's name and the addresses it listens on. */
  let pem: Pem;

  /** A source that hands out `pem` (or what `answers` hold, in turn), valid 60 days. */
  const sourceOf =
    (answers: (Certificate | Error)[] = []): CertificateSource =>
    () =>
      Promise.resolve(answers.shift() ?? { ...pem, notAfter: new Date(Date.now() + 60 * DAY) });

  /** The hub again, now on a machine whose tailnet address is 127.0.0.2, with this certificate source. */
  async function hubOnTailnet(certificate: CertificateSource = sourceOf()): Promise<Running> {
    await hub?.stop();
    const tailscale = join(base, "tailnet-tailscale");
    writeFileSync(tailscale, TAILNET_TAILSCALE);
    chmodSync(tailscale, 0o755);
    env = { ...env, TAILSCALE: tailscale };
    const started = await startHub({ port: hubPort, machine: machine(env), tailscale, peers: false, hosts: [], https: undefined, certificate }, () => {});

    if (started instanceof Error) throw started;
    hub = started;

    return started;
  }

  const rootAt = (host: string, path: string, port = publicPort): string => `https://${host}:${port}${path}`;

  /** A request over TLS that trusts `pem` alone. */
  const get = (url: string, init: RequestInit = {}): Promise<Response> => fetch(url, { ...init, tls: { ca: pem.cert } });

  /** The common name of the certificate served at `port`. */
  const servedName = (port: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
        resolve(String(socket.getPeerCertificate().subject.CN));
        socket.end();
      });

      socket.on("error", reject);
    });

  /** A wss socket to `port` at `path`, open, with `headers`. */
  async function wss(port: number, path: string, headers: { readonly [key: string]: string } = {}): Promise<WebSocket> {
    const socket = new WebSocket(`wss://127.0.0.1:${port}${path}`, { headers, tls: { ca: pem.cert } });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("socket failed")));
    });

    return socket;
  }

  /** What `socket` answers to `text`. */
  function echo(socket: WebSocket, text: string): Promise<string> {
    const got = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (e) => resolve(String(e.data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket failed")));
    });

    socket.send(text);

    return got;
  }

  /** An HTTP/2 connection to `host`:`port` that trusts `pem` alone; it fails when the server does not speak h2. */
  async function h2(port: number, host = "127.0.0.1"): Promise<ClientHttp2Session> {
    const session = connectH2(`https://${host}:${port}`, { ca: pem.cert });

    await new Promise<void>((resolve, reject) => {
      session.once("connect", () => resolve());
      session.once("error", reject);
    });

    return session;
  }

  /** What `session` answers for `path` (with `headers`, and `body` if any): its status and body, and how long it took. */
  function ask(session: ClientHttp2Session, path: string, init: { readonly method?: string; readonly headers?: OutgoingHttpHeaders; readonly body?: string } = {}): Promise<{ status: number; body: string; ms: number }> {
    const start = performance.now();

    return new Promise((resolve, reject) => {
      const stream = session.request({ ...init.headers, ":path": path, ":method": init.method ?? "GET" }, { endStream: init.body === undefined });
      let status = 0;
      let body = "";
      stream.setEncoding("utf8");
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => resolve({ status, body, ms: performance.now() - start }));
      stream.on("error", reject);

      if (init.body !== undefined) stream.end(init.body);
    });
  }

  /** Whether `url` answers at all: "answered", or "failed" when nothing there speaks HTTP. */
  const answers = (url: string): Promise<string> => fetch(url, { tls: { rejectUnauthorized: false } }).then(() => "answered", () => "failed");

  beforeAll(() => {
    pem = selfSigned(["box.example.ts.net", "127.0.0.1", "127.0.0.2"], "first");
  });

  beforeEach(() => {
    publicPort = freePort();
  });

  test("the hub serves it over TLS on loopback and the tailnet address, every path to the dev server at its root, with the proxy marker", async () => {
    const port = stub("root");
    writeRecord({ server: server(port, "/", publicPort) });
    const running = await hubOnTailnet();
    running.syncPreviews();

    const page = await get(rootAt("127.0.0.1", "/"));
    expect([page.status, await page.text()]).toEqual([200, "root GET /"]);
    expect(await (await get(rootAt("127.0.0.1", "/api/x?y=1"))).text()).toBe("root GET /api/x");
    expect(asked.at(-1)).toEqual({ server: "root", path: "/api/x", host: `127.0.0.1:${port}`, method: "GET" });
    expect(marks.at(-1)).toBe("/");
    expect(await (await get(rootAt("127.0.0.2", "/api/x"))).text()).toBe("root GET /api/x");
    expect(await (await get(rootAt("127.0.0.1", "/api/x"), { headers: { Host: `box.example.ts.net:${publicPort}` } })).text()).toBe("root GET /api/x");
    expect((await get(rootAt("127.0.0.1", "/"), { headers: { Host: "evil.example" } })).status).toBe(421);
    expect(await answers(`http://127.0.0.1:${publicPort}/`)).toBe("failed");
    expect(await answers(`http://127.0.0.2:${publicPort}/`)).toBe("failed");

    const socket = await wss(publicPort, "/api/sala?room=1");
    expect(await echo(socket, "ping")).toBe("root echo:ping");
    expect(asked.find((a) => a.method === "WS")).toEqual({ server: "root", path: "/api/sala?room=1", host: `127.0.0.1:${port}`, method: "WS" });
    expect(marks.at(-1)).toBe("/");
    socket.close();

    const state = JSON.parse(readFileSync(previewPortsPath(join(base, "registry")), "utf8"));
    expect(state.ports).toEqual([{ port: publicPort, fleet: "shop", worker: null, loopback: true, tailnet: "127.0.0.2", url: `https://box.example.ts.net:${publicPort}/`, error: null }]);
  });

  test("the public port speaks HTTP/2 (ALPN h2) on loopback and the tailnet address, and HTTP/1.1 to a client that does not", async () => {
    writeRecord({ server: server(stub("root"), "/", publicPort) });
    (await hubOnTailnet()).syncPreviews();

    for (const host of ["127.0.0.1", "127.0.0.2"]) {
      const session = await h2(publicPort, host);
      expect(session.alpnProtocol).toBe("h2");
      expect(await ask(session, "/api/x?y=1")).toMatchObject({ status: 200, body: "root GET /api/x" });
      expect(marks.at(-1)).toBe("/");
      session.close();
    }

    const session = await h2(publicPort);
    expect(await ask(session, "/body", { method: "POST", body: "x".repeat(100_000) })).toMatchObject({ status: 200, body: "root POST 100000" });
    expect((await ask(session, "/", { headers: { ":authority": "evil.example" } })).status).toBe(421);
    session.close();

    const plain = await get(rootAt("127.0.0.1", "/api/x"));
    expect([plain.status, await plain.text()]).toEqual([200, "root GET /api/x"]);
  });

  test("20 long polls held open and 10 quick requests on one connection: the quick ones answer at once", async () => {
    writeRecord({ server: server(stub("root"), "/", publicPort) });
    (await hubOnTailnet()).syncPreviews();
    holdPolls();
    const session = await h2(publicPort);
    const polls = Array.from({ length: 20 }, (_, i) => ask(session, `/poll?n=${i}`));
    await Bun.sleep(200);

    const quick = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(session, `/src/m${i}.ts`)));
    expect(quick.map((q) => q.body)).toEqual(Array.from({ length: 10 }, (_, i) => `root GET /src/m${i}.ts`));
    expect(Math.max(...quick.map((q) => q.ms))).toBeLessThan(500);
    expect(asked.filter((a) => a.path === "/poll")).toHaveLength(20);

    release();
    expect((await Promise.all(polls)).map((p) => p.body)).toEqual(Array.from({ length: 20 }, () => "root polled"));
    session.close();
  });

  test("HTTP and the wss socket carry the identity the hub verified: tailscale serve's on loopback, none for a plain local one", async () => {
    writeRecord({ server: server(stub("root"), "/", publicPort) });
    (await hubOnTailnet()).syncPreviews();

    expect(await (await get(rootAt("127.0.0.1", "/api/me"), { headers: SERVED })).text()).toBe("root GET /api/me");
    expect(seen.at(-1)).toEqual({ "tailscale-user-login": OWNER, "tailscale-user-name": "Luiz", "tailscale-user-profile-pic": "http://x/l.png" });
    await get(rootAt("127.0.0.1", "/api/me"), { headers: { "Tailscale-User-Name": "Mallory" } });
    expect(seen.at(-1)).toEqual({});

    seen.length = 0;
    const served = await wss(publicPort, "/api/sala", SERVED);
    expect(await echo(served, "hi")).toBe("root echo:hi");
    expect(asked.at(-1)?.method).toBe("WS");
    expect(seen.at(-1)).toEqual({ "tailscale-user-login": OWNER, "tailscale-user-name": "Luiz", "tailscale-user-profile-pic": "http://x/l.png" });
    served.close();
    const plain = await wss(publicPort, "/api/sala");
    expect(await echo(plain, "hi")).toBe("root echo:hi");
    expect(seen.at(-1)).toEqual({});
    plain.close();
  });

  test("a tailnet peer's forged Tailscale headers are replaced by the login Tailscale gives it, on h2 and the wss WebSocket", async () => {
    writeRecord({ workers: [{ ...server(stub("a1"), "/", publicPort), worker: "a1" }] });
    const running = await hubOnTailnet();
    running.syncPreviews();
    const slot = running.hub.rootedPreviews().find((p) => p.port === publicPort);
    expect(slot).toMatchObject({ port: publicPort, fleet: "shop", worker: "a1" });

    if (slot === undefined) throw new Error("no slot");
    const at = freePort();

    const listener = servePreviewPort("127.0.0.1", at, pem, (req, _ip, upgrade) => {
      const headers = new Headers(req.headers);
      headers.set("Host", `127.0.0.1:${publicPort}`);

      return running.hub.fetchRooted(new Request(req.url, { method: req.method, headers }), "100.101.1.2", slot, () => {}, upgrade);
    });

    try {
      const session = await h2(at);
      expect(await ask(session, "/api/me", { headers: FORGED })).toMatchObject({ status: 200, body: "a1 GET /api/me" });
      expect(seen.at(-1)).toEqual({ "tailscale-user-login": OWNER, "x-forwarded-for": "100.101.1.2" });
      session.close();

      const socket = await wss(at, "/api/sala", FORGED);
      expect(await echo(socket, "hi")).toBe("a1 echo:hi");
      expect(seen.at(-1)).toEqual({ "tailscale-user-login": OWNER, "x-forwarded-for": "100.101.1.2" });
      socket.close();
    } finally {
      await listener.stop(true);
    }
  });

  test("the listener goes when the preview stops and comes back with it, and after a hub restart", async () => {
    const port = stub("root");
    writeRecord({ server: server(port, "/", publicPort) });
    const first = await hubOnTailnet();
    first.syncPreviews();
    expect((await get(rootAt("127.0.0.1", "/"))).status).toBe(200);

    writeRecord({ server: { ...server(port, "/", publicPort), pid: null } });
    first.syncPreviews();
    expect(await answers(rootAt("127.0.0.1", "/"))).toBe("failed");

    writeRecord({ server: server(port, "/", publicPort) });
    first.syncPreviews();
    expect((await get(rootAt("127.0.0.1", "/"))).status).toBe(200);

    await hubOnTailnet();
    expect(await (await get(rootAt("127.0.0.1", "/again"))).text()).toBe("root GET /again");
  });

  test("without a certificate the hub opens no port, in http or otherwise, and says why in the preview's status", async () => {
    writeRecord({ server: server(stub("root"), "/", publicPort) });
    const running = await hubOnTailnet(sourceOf([new Error("your Tailscale account does not support getting TLS certs")]));
    running.syncPreviews();
    expect(await answers(`http://127.0.0.1:${publicPort}/`)).toBe("failed");
    expect(await answers(`https://127.0.0.1:${publicPort}/`)).toBe("failed");
    expect(await answers(`http://127.0.0.2:${publicPort}/`)).toBe("failed");
    expect((await fetch(`http://127.0.0.1:${hubPort}/api/fleets`)).status).toBe(200);

    const state = JSON.parse(readFileSync(previewPortsPath(join(base, "registry")), "utf8"));
    expect(state.ports).toEqual([
      {
        port: publicPort,
        fleet: "shop",
        worker: null,
        loopback: false,
        tailnet: null,
        url: null,
        error: "tailscale cert box.example.ts.net: your Tailscale account does not support getting TLS certs",
      },
    ]);

    const status = fleet(["preview", dir, "status"], env).stdout;
    expect(status).toContain(`https://box.example.ts.net:${publicPort}/`);
    expect(status).toContain(`the hub cannot serve https on port ${publicPort}: tailscale cert box.example.ts.net: your Tailscale account does not support getting TLS certs`);
    expect(status).not.toMatch(new RegExp(`http://[^ ]*:${publicPort}/`));
  });

  test("a renewal swaps the certificate on every preview port, keeps the open sockets, and leaves the hub's own port alone", async () => {
    const other = freePort();
    writeRecord({ server: server(stub("root"), "/", publicPort), workers: [{ ...server(stub("a1"), "/", other), worker: "a1" }] });
    const soon = { ...pem, notAfter: new Date(Date.now() + 2 * DAY) };
    const second = selfSigned(["box.example.ts.net", "127.0.0.1", "127.0.0.2"], "second");
    const running = await hubOnTailnet(sourceOf([soon, { ...second, notAfter: new Date(Date.now() + 60 * DAY) }]));
    running.syncPreviews();
    expect([await servedName(publicPort), await servedName(other)]).toEqual(["first", "first"]);
    const open = await wss(publicPort, "/api/sala");
    expect(await echo(open, "before")).toBe("root echo:before");

    await running.checkCertificate();
    running.syncPreviews();
    expect([await servedName(publicPort), await servedName(other)]).toEqual(["second", "second"]);
    expect(await echo(open, "after")).toBe("root echo:after");
    open.close();
    pem = second;
    expect(await (await get(rootAt("127.0.0.1", "/x", other))).text()).toBe("a1 GET /x");
    expect((await fetch(`http://127.0.0.1:${hubPort}/api/fleets`)).status).toBe(200);
  });

  test("a public port another process holds is reported in the preview's status, and the hub keeps running", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: publicPort, fetch: () => new Response("someone else") });

    try {
      writeRecord({ server: server(stub("root"), "/", publicPort) });
      const running = await hubOnTailnet();
      running.syncPreviews();
      expect((await fetch(`http://127.0.0.1:${hubPort}/api/fleets`)).status).toBe(200);
      const state = JSON.parse(readFileSync(previewPortsPath(join(base, "registry")), "utf8"));
      expect(state.ports[0]).toMatchObject({ port: publicPort, loopback: false });
      expect(String(state.ports[0].error)).toContain(`127.0.0.1:${publicPort}`);
      expect(readFileSync(hubRecordPath(join(base, "registry")), "utf8")).toContain(String(process.pid));

      const status = fleet(["preview", dir, "status"], env);
      expect(status.stdout).toContain(`https://box.example.ts.net:${publicPort}/`);
      expect(status.stdout).toContain(`the hub cannot serve https on port ${publicPort}`);
    } finally {
      void holder.stop(true);
    }
  });
});
