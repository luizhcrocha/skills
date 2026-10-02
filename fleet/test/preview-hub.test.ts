/**
 * The hub's way to a fleet's preview, against a stand-in dev server in this process: `/f/<fleet>/preview/…`
 * goes to the combined preview's server and `/f/<fleet>/preview/<worker>/…` to a per-worker one, with the
 * path kept for a server told its base and stripped for one at its root, `Host` rewritten, the WebSocket
 * (Vite's HMR, protocol `vite-hmr`) piped both ways; and `POST preview-workers` takes a worker in or out
 * under the chat's write policy. The dev server sees only the identity the hub verified: never a client's
 * own Tailscale-* headers.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readRecord, recordJson, type DevServer, type PreviewRecord } from "../src/preview/record.ts";
import { viewerOf } from "../src/hub/policy.ts";
import { previewSockets, proxiedIdentity, type SocketData } from "../src/hub/preview-proxy.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import { baseEnv, fleet, machine, tmp, type Environment } from "./support.ts";

let base: string;

let dir: string;

let env: Environment;

let hub: Running | undefined;

let hubPort: number;

/** What each stand-in server was asked. */
const asked: { readonly server: string; readonly path: string; readonly host: string; readonly method: string }[] = [];

/** The identity headers (Tailscale-*, X-Forwarded-For) each request to a stand-in server carried. */
const seen: Record<string, string>[] = [];

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

/** A stand-in dev server named `name`: answers with what it was asked, redirects `/old` to `/new`, echoes on a socket. */
function stub(name: string): number {
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      seen.push(identityOf(req.headers));

      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        asked.push({ server: name, path: `${url.pathname}${url.search}`, host: req.headers.get("host") ?? "", method: "WS" });

        return srv.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": "vite-hmr" } }) ? undefined : new Response("no", { status: 400 });
      }

      asked.push({ server: name, path: url.pathname, host: req.headers.get("host") ?? "", method: req.method });

      if (url.pathname.endsWith("/old")) return new Response(null, { status: 302, headers: { Location: "/new" } });

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

function server(port: number, base$: string): DevServer {
  return { cmd: "stub", port, pid: process.pid, base: base$, path: dir, log: join(dir, "x.log"), started: "" };
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
    commit: null,
    conflicts: [],
    error: null,
    updated: null,
    workers: [],
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
});

afterEach(async () => {
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
