/**
 * A preview shared publicly (`preview-share.ts`): only its link opens its password form, only its password signs
 * in, its cookie opens only its own dev server, and expiry or unshare ends link and cookie alike. Nothing else
 * of the machine (the private `/f/` routes, another worker's preview) answers on the public side.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recordJson, type DevServer, type PreviewRecord } from "../src/preview/record.ts";
import { startedAt } from "../src/preview/tracked.ts";
import { createShare, PublicShares, removeShares, SHARE_MS } from "../src/hub/preview-share.ts";
import { tmp } from "./support.ts";

let home: string;

let dir: string;

let clock: number;

let shares: PublicShares;

const logged: string[] = [];

const stubs: ReturnType<typeof Bun.serve>[] = [];

/** A stand-in dev server: answers with its name, the method and the path, and the headers `headers` asks for. */
function stub(name: string, headers: Readonly<Record<string, string>> = {}): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);

      if (url.pathname.endsWith("/forwarded")) return new Response([req.headers.get("X-Forwarded-Host"), req.headers.get("X-Forwarded-Proto"), req.headers.get("Forwarded")].join("|"));

      return new Response(`${name} ${req.method === "GET" ? "" : `${req.method} `}${url.pathname}`, { headers });
    },
  });

  stubs.push(server);

  return server.port ?? 0;
}

function devServer(port: number, base: string): DevServer {
  return { cmd: "stub", port, pid: process.pid, pidStarted: startedAt(process.pid) ?? null, unit: null, base, path: dir, log: join(dir, "x.log"), started: "", public: null, keeper: null, keeperStarted: null, keeperUnit: null, asleep: null, failed: null };
}

function writeRecord(workers: PreviewRecord["workers"]): void {
  const record: PreviewRecord = { fleet: "shop", workspace: "preview", path: dir, repo: dir, server: null, updater: null, updaterStarted: null, include: [], exclude: [], merged: [], left: [], stack: null, stackFrom: null, stackGiven: null, commit: null, conflicts: [], error: null, updated: null, workers, ports: { combined: null, workers: {} } };
  writeFileSync(join(dir, "preview.json"), JSON.stringify(recordJson(record)));
}

function get(path: string, cookie = "", init: RequestInit = {}): Promise<Response | undefined> {
  const headers = new Headers(init.headers);

  if (cookie !== "") headers.set("Cookie", cookie);

  return shares.fetch(new Request(`http://127.0.0.1:7600${path}`, { ...init, headers }), undefined);
}

const post = (token: string, password: string): Promise<Response | undefined> =>
  shares.fetch(new Request(`http://127.0.0.1:7600/${token}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }).toString() }), undefined);

/** Sign in to a share: its cookie, `name=value`. */
async function signIn(token: string, password: string): Promise<string> {
  const res = await post(token, password);
  expect(res?.status).toBe(303);

  return (res?.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

beforeEach(() => {
  home = tmp("fleet-share-");
  dir = join(home, "fleet");
  mkdirSync(dir, { recursive: true });
  clock = 1_800_000_000_000;
  logged.length = 0;
  shares = new PublicShares({ home, now: () => clock, log: (line) => logged.push(line) });
  writeRecord([
    { ...devServer(stub("a1"), "/f/shop/preview/a1/"), worker: "a1" },
    { ...devServer(stub("a2"), "/f/shop/preview/a2/"), worker: "a2" },
  ]);
});

afterEach(() => {
  for (const s of stubs.splice(0)) void s.stop(true);
});

const share = (worker: string, ms = SHARE_MS) => createShare(home, { fleet: "shop", dir, worker, ms, password: undefined, now: clock });

describe("a shared preview", () => {
  test("without its token, nothing answers: 404, the private routes included", async () => {
    share("a1");

    for (const path of ["/", "/f/shop/", "/f/shop/preview/a1/", "/f/shop/preview/a2/", `/${"A".repeat(43)}/`]) expect([path, (await get(path))?.status]).toEqual([path, 404]);
  });

  test("its link shows the password form, never the page", async () => {
    const { token } = share("a1");
    const res = await get(`/${token}/`);
    expect(res?.status).toBe(200);
    const body = (await res?.text()) ?? "";
    expect(body).toContain('name="password"');
    expect(body).not.toContain("a1 ");
  });

  test("a wrong password is refused and counted; five a minute, then a pause", async () => {
    const { token, password } = share("a1");

    for (let i = 0; i < 5; i += 1) expect((await post(token, "nope"))?.status).toBe(401);
    expect(logged.filter((l) => l.includes("wrong password"))).toHaveLength(5);
    expect((await post(token, password))?.status).toBe(429);
    clock += 61_000;
    expect((await post(token, password))?.status).toBe(303);
    expect(logged.join("\n")).not.toContain(password);
  });

  test("the right password sets a strict cookie scoped to the preview, which opens it", async () => {
    const { token, password } = share("a1");
    const res = await post(token, password);
    expect([res?.status, res?.headers.get("Location")]).toEqual([303, "/f/shop/preview/a1/"]);
    const set = res?.headers.get("Set-Cookie") ?? "";
    expect(set).toContain("Path=/f/shop/preview/a1/");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Strict");
    const page = await get("/f/shop/preview/a1/index.html", set.split(";")[0]);
    expect([page?.status, await page?.text()]).toEqual([200, "a1 /f/shop/preview/a1/index.html"]);
    expect(logged.some((l) => l.includes("public request 1"))).toBe(true);
  });

  test("share A's token and cookie never reach preview B", async () => {
    const a = share("a1");
    share("a2");
    const cookie = await signIn(a.token, a.password);
    expect((await get("/f/shop/preview/a2/index.html", cookie))?.status).toBe(404);
    expect((await get("/f/shop/preview/a2/", cookie.replace(/^fleet-share-[0-9a-f]+/, "fleet-share-x")))?.status).toBe(404);
  });

  test("the password of share A does not open share B", async () => {
    const a = share("a1");
    const b = share("a2");
    expect((await post(b.token, a.password))?.status).toBe(401);
  });

  test("expiry ends the link and the cookie", async () => {
    const { token, password } = share("a1", 60 * 60 * 1000);
    const cookie = await signIn(token, password);
    clock += 60 * 60 * 1000;
    expect((await get(`/${token}/`))?.status).toBe(404);
    expect((await get("/f/shop/preview/a1/", cookie))?.status).toBe(404);
  });

  test("unshare stops it, and keeps only hashes on disk", async () => {
    const { token, password, share: made } = share("a1");
    const cookie = await signIn(token, password);
    const kept = readFileSync(join(home, "hub", "shares.json"), "utf8");
    expect(kept).not.toContain(token);
    expect(kept).not.toContain(password);
    expect(removeShares(home, (s) => s.id === made.id, clock)).toBe(1);
    expect((await get(`/${token}/`))?.status).toBe(404);
    expect((await get("/f/shop/preview/a1/", cookie))?.status).toBe(404);
    expect(readFileSync(join(home, "hub", "shares.log"), "utf8")).toMatch(/share .* shop\/a1 until[\s\S]*unshare .* shop\/a1/);
  });

  test("wrong passwords sent at once are counted before any is checked: five checked, the rest 429", async () => {
    const { token } = share("a1");
    const answers = await Promise.all(Array.from({ length: 40 }, () => post(token, "nope")));
    const statuses = answers.map((r) => r?.status);
    expect([statuses.filter((s) => s === 401).length, statuses.filter((s) => s === 429).length]).toEqual([5, 35]);
    expect(logged.filter((l) => l.includes("wrong password"))).toHaveLength(5);
  });

  test("a password form's body past 4 KiB is refused unread", async () => {
    const { token, password } = share("a1");
    const res = await shares.fetch(new Request(`http://127.0.0.1:7600/${token}/`, { method: "POST", body: `password=${password}&pad=${"x".repeat(5000)}` }), undefined);
    expect(res?.status).toBe(413);
  });

  test("the form and its redirect send no referrer", async () => {
    const { token, password } = share("a1");
    expect((await get(`/${token}/`))?.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await post(token, "nope"))?.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await post(token, password))?.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("a dev server's headers that act on the whole public origin are dropped, and its service worker past its path is the kill switch", async () => {
    writeRecord([{ ...devServer(stub("a1", { "Service-Worker-Allowed": "/", "Clear-Site-Data": '"*"', NEL: "{}", "Report-To": "{}", "X-Kept": "1" }), "/f/shop/preview/a1/"), worker: "a1" }]);
    const { token, password } = share("a1");
    const cookie = await signIn(token, password);
    const page = await get("/f/shop/preview/a1/", cookie);
    expect([page?.headers.get("Service-Worker-Allowed"), page?.headers.get("Clear-Site-Data"), page?.headers.get("NEL"), page?.headers.get("Report-To"), page?.headers.get("X-Kept")]).toEqual([null, null, null, null, "1"]);
    const worker = await get("/f/shop/preview/a1/sw.js", cookie, { headers: { "Service-Worker": "script" } });
    expect(await worker?.text()).toContain("registration.unregister()");
  });

  test("the dev server's own tools are not public: a __ path, and a write to /@vite/, /@fs/, /@id/ or /node_modules/", async () => {
    const { token, password } = share("a1");
    const cookie = await signIn(token, password);

    for (const path of ["/f/shop/preview/a1/__open-in-editor?file=/etc/passwd", "/f/shop/preview/a1/%5F%5Fopen-in-editor", "/f/shop/preview/a1/x/__inspect/"]) {
      expect([path, (await get(path, cookie))?.status]).toEqual([path, 403]);
    }

    for (const path of ["/f/shop/preview/a1/@vite/client", "/f/shop/preview/a1/@fs/etc/passwd", "/f/shop/preview/a1/@id/x", "/f/shop/preview/a1/node_modules/.vite/x.js"]) {
      expect([path, (await get(path, cookie, { method: "POST", body: "x" }))?.status]).toEqual([path, 403]);
      expect([path, (await get(path, cookie))?.status]).toEqual([path, 200]);
    }

    const write = await get("/f/shop/preview/a1/api/notes", cookie, { method: "POST", body: "a note" });
    expect([write?.status, await write?.text()]).toEqual([200, "a1 POST /f/shop/preview/a1/api/notes"]);
  });

  test("the dev server is told the public host and https, never the client's forwarding headers", async () => {
    const { token, password } = share("a1");
    const cookie = await signIn(token, password);
    const res = await get("/f/shop/preview/a1/forwarded", cookie, { headers: { Host: "box.tail.ts.net:10000", "X-Forwarded-Host": "evil.example", Forwarded: 'host="evil.example";proto=http' } });
    expect(await res?.text()).toBe('box.tail.ts.net:10000|https|host="box.tail.ts.net:10000";proto=https');
  });

  test("a dev server that is down says only that the preview is not running", async () => {
    const { token, password } = share("a1");
    const cookie = await signIn(token, password);

    for (const s of stubs.splice(0)) await s.stop(true);
    const res = await get("/f/shop/preview/a1/", cookie);
    expect([res?.status, await res?.text()]).toEqual([502, "The preview is not running\n"]);
  });

  test("signed-in browsers are forgotten when their share ends, and a share keeps at most 32", async () => {
    const { token, password } = share("a1", 60 * 60 * 1000);
    const first = await signIn(token, password);

    for (let i = 0; i < 32; i += 1) await signIn(token, password);
    expect(shares.signedIn()).toBe(32);
    expect((await get("/f/shop/preview/a1/", first))?.status).toBe(404);
    clock += 60 * 60 * 1000;
    await get("/");
    expect(shares.signedIn()).toBe(0);
  });
});
