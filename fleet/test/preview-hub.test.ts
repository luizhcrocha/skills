/**
 * The hub's way to a fleet's preview, against a stand-in dev server in this process: `/f/<fleet>/preview/…`
 * goes to the combined preview's server and `/f/<fleet>/preview/<worker>/…` to a per-worker one, with the
 * path kept for a server told its base and stripped for one at its root, `Host` rewritten, the WebSocket
 * (Vite's HMR, protocol `vite-hmr`) piped both ways; and `POST preview-workers` takes a worker in or out
 * under the chat's write policy.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readRecord, recordJson, type DevServer, type PreviewRecord } from "../src/preview/record.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import { baseEnv, fleet, machine, tmp, type Environment } from "./support.ts";

let base: string;

let dir: string;

let env: Environment;

let hub: Running | undefined;

let hubPort: number;

/** What each stand-in server was asked. */
const asked: { readonly server: string; readonly path: string; readonly host: string; readonly method: string }[] = [];

const stubs: ReturnType<typeof Bun.serve>[] = [];

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
  env = baseEnv(join(base, "registry"), { TAILSCALE: join(base, "no-tailscale") });
  expect(fleet(["state", dir, "init", "--project", "shop", "--goal", "g", "--no-render"], env).code).toBe(0);
  const rows = { workspaces: [{ id: "a1", agent: "a1", path: join(base, "repo-a1"), repo: join(base, "repo"), base: "", added: "", status: "active" }] };
  const state = JSON.parse(await Bun.file(join(dir, "state.json")).text());
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, ...rows }));
  expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
  hubPort = freePort();
  const started = await startHub({ port: hubPort, machine: machine(env), tailscale: join(base, "no-tailscale"), peers: false, hosts: [], https: undefined }, () => {});

  if (started instanceof Error) throw started;
  hub = started;
  asked.length = 0;
});

afterEach(async () => {
  await hub?.stop();

  for (const s of stubs.splice(0)) void s.stop(true);
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
