/**
 * `fleet preview serve`: the preview path alone, at the hub's port and paths, so previews outlive the hub.
 * `/f/<fleet>/preview/…` reaches a stand-in dev server, a WebSocket is piped, a service worker's script off a
 * preview's path is the kill switch, each request stamps `DIR/preview/<w>.seen` for the keeper, and nothing
 * else of the hub (its page, ledger, chat) is served.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recordJson, type DevServer, type PreviewRecord } from "../src/preview/record.ts";
import { seenPath } from "../src/preview/sleep.ts";
import { startedAt } from "../src/preview/tracked.ts";
import { startPreviewServer, type PreviewServerOptions, type PreviewServing } from "../src/hub/preview-server.ts";
import { baseEnv, fleet, machine, tmp, type Environment } from "./support.ts";

let base: string;

let dir: string;

let env: Environment;

let serving: PreviewServing | undefined;

let port: number;

const stubs: ReturnType<typeof Bun.serve>[] = [];

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const got = probe.port ?? 0;
  void probe.stop(true);

  return got;
}

/** A stand-in dev server named `name`: answers with what it was asked, echoes on a socket. */
function stub(name: string): number {
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);

      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") return srv.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": "vite-hmr" } }) ? undefined : new Response("no", { status: 400 });

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

function devServer(at: number, base$: string, path: string): DevServer {
  return {
    cmd: "stub",
    port: at,
    pid: process.pid,
    pidStarted: startedAt(process.pid) ?? null,
    unit: null,
    base: base$,
    path,
    log: join(path, "x.log"),
    started: "",
    public: null,
    keeper: null,
    keeperStarted: null,
    keeperUnit: null,
    asleep: null,
    failed: null,
  };
}

function writeRecord(root: string, fleetName: string, given: Partial<PreviewRecord>): void {
  const record: PreviewRecord = {
    fleet: fleetName,
    workspace: "preview",
    path: root,
    repo: root,
    server: null,
    updater: null,
    updaterStarted: null,
    include: [],
    exclude: [],
    merged: [],
    left: [],
    stack: null,
    stackFrom: null,
    stackGiven: null,
    commit: null,
    conflicts: [],
    error: null,
    updated: null,
    workers: [],
    ports: { combined: null, workers: {} },
    ...given,
  };

  writeFileSync(join(root, "preview.json"), JSON.stringify(recordJson(record)));
}

const at = (path: string): string => `http://127.0.0.1:${port}${path}`;

/** Wait (at most `ms`, 2 s unless told, in 20 ms steps) until `check` holds. */
async function until(check: () => Promise<boolean> | boolean, ms = 2000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 20) {
    if (await check()) return true;
    await Bun.sleep(20);
  }

  return false;
}

async function answers(): Promise<boolean> {
  try {
    await fetch(at("/"));

    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  base = tmp("fleet-preview-server-");
  dir = join(base, "fleet");
  env = baseEnv(join(base, "registry"), { TAILSCALE: join(base, "no-tailscale") });
  expect(fleet(["state", dir, "init", "--project", "shop", "--goal", "g", "--no-render"], env).code).toBe(0);
  expect(fleet(["serve", dir, "--pid", String(process.pid)], env).code).toBe(0);
  port = freePort();
  const started = await startPreviewServer({ port, machine: machine(env), tailscale: join(base, "no-tailscale"), https: undefined, tickMs: 20 }, () => {});

  if (started instanceof Error) throw started;
  serving = started;
  expect(await until(answers)).toBe(true);
});

afterEach(async () => {
  await serving?.stop();

  for (const s of stubs.splice(0)) void s.stop(true);
});

/** Stop the default server and start one with `more` instead. */
async function restart(more: Partial<PreviewServerOptions>, log: (line: string) => void = () => {}): Promise<void> {
  await serving?.stop();
  const started = await startPreviewServer({ port, machine: machine(env), tailscale: join(base, "no-tailscale"), https: undefined, tickMs: 20, ...more }, log);

  if (started instanceof Error) throw started;
  serving = started;
}

describe("the preview server", () => {
  test("a request to /f/<fleet>/preview/ reaches the dev server, and stamps .seen for the keeper", async () => {
    const own = stub("a1");
    writeRecord(dir, "shop", { workers: [{ ...devServer(own, "/f/shop/preview/a1/", dir), worker: "a1" }] });
    const res = await fetch(at("/f/shop/preview/a1/src/main.tsx"));
    expect([res.status, await res.text()]).toEqual([200, "a1 GET /f/shop/preview/a1/src/main.tsx"]);
    expect(existsSync(seenPath(dir, "a1"))).toBe(true);
    const bare = await fetch(at("/f/shop/preview"), { redirect: "manual" });
    expect([bare.status, bare.headers.get("Location")]).toEqual([301, "/f/shop/preview/"]);
  });

  test("a WebSocket upgrade passes through", async () => {
    const own = stub("combined");
    writeRecord(dir, "shop", { server: devServer(own, "/f/shop/preview/", dir) });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/f/shop/preview/`, "vite-hmr");

    const got = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (e) => resolve(String(e.data)));
      socket.addEventListener("error", () => reject(new Error("socket failed")));
    });

    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    socket.send("hi");
    expect(await got).toBe("combined echo:hi");
    socket.close();
  });

  test("a service worker's script off a preview's path is the kill switch", async () => {
    const res = await fetch(at("/sw.js"), { headers: { "Service-Worker": "script" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("registration.unregister()");
  });

  test("an unknown worker, an unknown fleet and any other path answer 404", async () => {
    const own = stub("a1");
    writeRecord(dir, "shop", { workers: [{ ...devServer(own, "/f/shop/preview/a1/", dir), worker: "a1" }] });
    expect((await fetch(at("/f/shop/preview/zz/"))).status).toBe(404);
    expect((await fetch(at("/f/nobody/preview/"))).status).toBe(404);

    for (const path of ["/", "/f/shop/", "/f/shop/state.json", "/f/shop/chat", "/api/fleets"]) expect([path, (await fetch(at(path))).status]).toEqual([path, 404]);
    expect(await (await fetch(at("/f/shop/chat"))).json()).toEqual({ error: "the preview server serves only /f/<fleet>/preview/; the pages are the cloud's" });
  });

  test("a host that is not this machine is refused", async () => {
    const res = await fetch(at("/f/shop/preview/"), { headers: { Host: "evil.example:80" } });
    expect(res.status).toBe(421);
  });

  test("a team moved to the cloud keeps its preview links", async () => {
    const away = join(base, "fleet", "away");
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, "cloud.json"), JSON.stringify({ fleet: "away", cloud: "https://cloud.example/f/away/" }));
    const own = stub("w1");
    writeRecord(away, "away", { workers: [{ ...devServer(own, "/f/away/preview/w1/", away), worker: "w1" }] });
    const res = await fetch(at("/f/away/preview/w1/"));
    expect([res.status, await res.text()]).toEqual([200, "w1 GET /f/away/preview/w1/"]);
  });

  test("it turns tailscale serve off on stop, while it still holds the port", async () => {
    const calls = join(base, "tailscale.calls");
    const fake = join(base, "fake-tailscale");
    writeFileSync(
      fake,
      `#!/bin/sh
case "$1 $2" in
  "status --json") printf '%s' '{"BackendState": "Running", "Self": {"DNSName": "box.tail.ts.net.", "TailscaleIPs": ["127.0.0.9"], "UserID": 7}, "User": {"7": {"LoginName": "o@example.com"}}, "Peer": {}}' ;;
  "serve --bg") echo serve >> "${calls}" ;;
  "serve --https=9443") python3 -c 'import socket, sys
s = socket.socket()
print("off held" if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else "off free")' ${String(port)} >> "${calls}" ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(fake, 0o755);
    await restart({ tailscale: fake, https: 9443, certificate: async () => new Error("no certificate here") });
    expect(await until(() => existsSync(calls))).toBe(true);
    await serving?.stop();
    serving = undefined;
    expect(readFileSync(calls, "utf8")).toBe("serve\noff held\n");
  });

});
