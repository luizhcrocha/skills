/**
 * The Links page's facts: a link's kind as people recognise it (old `dev`/`page` rows read at display time),
 * where it is reached from, the hub's HTTP probe (a fake server up, refusing, behind a dead proxy, and gone),
 * the probe cache's "checked" and "since", and the hub's `files/` route, which serves a file a link names under
 * the fleet's files root and refuses everything else.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stampOf } from "../src/clock.ts";
import { filePathOf, filesRoot, linkKind, reachOf, servedRel } from "../src/ledger/links.ts";
import { answers, LinkProbes } from "../src/hub/probes.ts";
import { startHub, type Running } from "../src/hub/server.ts";
import * as Option from "effect/Option";

import { asArray, asObject, asString, parseObject, type Json, type JsonObject } from "../src/json.ts";
import { baseEnv, machine, sleep, tmp, type Environment } from "./support.ts";

describe("a link's kind and reach", () => {
  test("old rows read as the kinds people recognise, without being rewritten", () => {
    const cases: readonly (readonly [string | undefined, string, string, string])[] = [
      ["dev", "https://box.ts.net:7501/", "Live preview", "preview"],
      ["page", "https://box.ts.net:4518/", "Gold-marking page", "doc"],
      ["page", "https://claude.ai/artifact/Bcwsy", "Agent tool architecture", "doc"],
      ["dev", "https://claude.ai/artifact/Bcwsy", "x", "doc"],
      ["page", "https://box.ts.net:7501/caso/CA1014/prototipo/mapa", "Map", "prototype"],
      ["dev", "https://box.ts.net:5424/caso/CA1116/tarefas", "Tarefas tab prototype (throwaway)", "prototype"],
      ["page", "file:///home/u/.local/state/infra/auth-review.md", "Auth review", "doc"],
      ["tool", "https://box.ts.net:7501/caso/CA1014/prototipo/mapa", "Map", "tool"],
      [undefined, "http://localhost:8000", "Lab lakeFS", "preview"],
    ];

    const got: string[] = cases.map(([k, u, t]) => linkKind(k, u, t));

    expect(got).toEqual(cases.map((c) => c[3]));
  });

  test("this machine and its tailnet are probed; elsewhere is not; a file is a file", () => {
    const urls = ["http://localhost:8000", "https://box.ts.net:1/", "http://100.69.17.95:3/", "https://claude.ai/artifact/x", "file:///tmp/x.md", "http://example.com/"];
    expect(urls.map((u) => reachOf(u))).toEqual(["machine", "machine", "machine", "external", "file", "external"]);
    expect(filePathOf("file:///a/coordinator/../b%20c.md")).toBe("/a/b c.md");
    expect(filePathOf("file://elsewhere/a.md")).toBeUndefined();
  });

  test("a host is read as fetch reads it: what does not read plainly is elsewhere, never probed", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["http://0127.0.0.1/", "external"],
      ["http://0100.64.0.1/", "external"],
      ["http://evil.example\\@127.0.0.1/", "external"],
      ["http://user@127.0.0.1/", "external"],
      ["http://user:pw@localhost:3000/", "external"],
      ["http://[::ffff:7f00:1]/", "external"],
      ["http://127.0.0.1\t.evil.com/", "external"],
      ["http://2130706433/", "machine"],
      ["http://[::1]:3000/", "machine"],
      ["http://127.0.0.1:8080/", "machine"],
      ["http://100.64.0.1/", "machine"],
    ];

    expect(cases.map(([u]) => [u, reachOf(u)])).toEqual(cases.map(([u, r]) => [u, r]));
  });

  test("a ts.net name is this machine's only under its own tailnet's suffix, once a hub read it", () => {
    const url = "https://foo.tail1234.ts.net/";
    expect([reachOf(url, "tail1234.ts.net"), reachOf(url, "other.ts.net"), reachOf(url, null), reachOf(url)]).toEqual(["machine", "external", "external", "machine"]);
    expect(reachOf("https://tail1234.ts.net.evil.com/", "tail1234.ts.net")).toBe("external");
  });

  test("an address read one way and fetched another is never probed", async () => {
    let seen = "";

    const local = serve((req) => {
      seen = req.url;

      return new Response("x");
    });

    const tricky = `${local.slice(0, -1)}\\@100.64.0.1/`;
    expect([reachOf(tricky), await answers(tricky, 1000), seen]).toEqual(["external", false, ""]);
  });

  test("a file is served from under the files root only, with no hidden part", () => {
    expect(servedRel("/r", "/r/a b/c.md")).toBe("a%20b/c.md");
    expect([servedRel("/r", "/r/../etc/passwd"), servedRel("/r", "/r/.env"), servedRel("/r", "/elsewhere/x.md"), servedRel("/r", "/r")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const env = (vars: Record<string, string>) => (name: string) => vars[name];
    expect(filesRoot("/tmp/s/scratchpad/coordinator", env({ HOME: "/home/u" }))).toBe("/tmp/s/scratchpad");
    expect(filesRoot("/home/u/.local/state/infra-coordinator/fleet", env({ HOME: "/home/u" }))).toBe("/home/u/.local/state/infra-coordinator");
    expect(filesRoot("/home/u/.local/state/fleet", env({ HOME: "/home/u" }))).toBe("/home/u/.local/state/fleet");
    expect(filesRoot("/home/u/work/coordinator", env({ HOME: "/home/u" }))).toBe("/home/u/work/coordinator");
  });
});

const servers: ReturnType<typeof Bun.serve>[] = [];

/** A fake server on a free loopback port answering every request with `answer`; its address. */
function serve(answer: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  servers.push(s);

  return `http://127.0.0.1:${String(s.port)}/`;
}

/** A loopback address nothing listens on. */
function gone(): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const url = `http://127.0.0.1:${String(s.port)}/`;
  void s.stop(true);

  return url;
}

afterEach(() => {
  for (const s of servers.splice(0)) void s.stop(true);
});

describe("the hub's probe", () => {
  test("up when the server answers, down when nothing does or its proxy says it is gone", async () => {
    const seen: string[] = [];

    const ok = serve((req) => {
      seen.push(req.method);

      return new Response("hello");
    });

    const headless = serve((req) => (req.method === "HEAD" ? new Response(null, { status: 405 }) : new Response("x")));
    const missing = serve(() => new Response("no", { status: 404 }));
    const moved = serve(() => new Response(null, { status: 302, headers: { Location: "https://example.com/" } }));
    const proxy = serve(() => new Response("bad gateway", { status: 502 }));

    const slow = serve(async () => {
      await sleep(400);

      return new Response("late");
    });


    expect(await Promise.all([ok, headless, missing, moved].map((u) => answers(u)))).toEqual([true, true, true, true]);
    expect(seen).toEqual(["HEAD"]);
    expect(await Promise.all([proxy, gone()].map((u) => answers(u)))).toEqual([false, false]);
    expect(await answers(slow, 100)).toBe(false);
  });

  test("a probe is held for its time: checked when it ran, since when it first read so", async () => {
    let up = true;
    let clock = new Date("2026-10-09T18:02:00-05:00");
    const probes = new LinkProbes(() => clock, () => Promise.resolve(up), 0);
    const url = "https://box.ts.net:7501/";

    expect(probes.get([url])).toEqual([undefined]);
    await probes.settled();
    const at = (iso: string): string => stampOf(new Date(iso));
    expect(probes.get([url])[0]).toEqual({ up: true, checked: at("2026-10-09T18:02:00-05:00"), since: at("2026-10-09T18:02:00-05:00") });
    await probes.settled();
    clock = new Date("2026-10-09T20:31:00-05:00");
    up = false;
    probes.get([url]);
    await probes.settled();
    clock = new Date("2026-10-09T20:40:00-05:00");
    probes.get([url]);
    await probes.settled();
    expect(probes.get([url])[0]).toEqual({ up: false, checked: at("2026-10-09T20:40:00-05:00"), since: at("2026-10-09T20:31:00-05:00") });
  });
});

describe("the hub's links: probes and files", () => {
  let base: string;
  let root: string;
  let env: Environment;
  let running: Running | undefined;
  let port: number;
  const probed: string[] = [];

  function writeLinks(links: readonly JsonObject[], more: JsonObject = {}): void {
    const state = {
      project: "p",
      goal: "g",
      status: "running",
      now: "n",
      started: "2026-01-01T00:00:00+00:00",
      roadmap: [{ id: "m1", title: "M", steps: [] }],
      agents: [],
      roadblocks: [],
      events: [],
      decisions: [],
      links,
      ...more,
    };

    writeFileSync(join(root, "state.json"), JSON.stringify(state));
  }

  beforeEach(async () => {
    base = tmp("fleet-links-");
    root = join(base, "session", "scratchpad", "coordinator");
    mkdirSync(root, { recursive: true });
    env = baseEnv(join(base, "registry"));
    writeLinks([]);
    const m = machine(env);
    m.registry.register(root, "u", process.pid, "2026-01-01T00:00:00+00:00");
    const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    port = free.port ?? 0;
    void free.stop(true);
    probed.length = 0;

    const probe = (url: string): Promise<boolean> => {
      probed.push(url);

      return answers(url);
    };

    const got = await startHub({ port, machine: m, tailscale: join(base, "no-tailscale"), peers: false, hosts: [], https: undefined, probe }, () => {});

    if (got instanceof Error) throw got;
    running = got;
  });

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${String(port)}${path}`, { redirect: "manual" });

  const stamped = (value: Json | undefined): boolean => asString(value) !== undefined;

  async function shownLinks(): Promise<JsonObject[]> {
    const body = Option.getOrUndefined(parseObject(await (await get("/f/p/state.json")).text())) ?? {};

    return (asArray(body["links"]) ?? []).map((l) => asObject(l) ?? {});
  }

  test("each link of this machine is probed over HTTP, and the view says when it was checked", async () => {
    const up = serve(() => new Response("ok"));
    const down = gone();
    writeLinks([
      { id: "l1", url: up, title: "Live app", kind: "preview" },
      { id: "l2", url: down, title: "Old build", kind: "dev" },
      { id: "l3", url: "https://claude.ai/artifact/x", title: "Design", kind: "page" },
    ]);
    await shownLinks();
    await sleep(300);
    writeLinks(
      [
        { id: "l1", url: up, title: "Live app", kind: "preview" },
        { id: "l2", url: down, title: "Old build", kind: "dev" },
        { id: "l3", url: "https://claude.ai/artifact/x", title: "Design", kind: "page" },
      ],
      { now: "again" },
    );
    const links = await shownLinks();

    expect(links.map((l) => [l["kind"], l["reach"], l["up"], stamped(l["checked"]), stamped(l["state_since"])])).toEqual([
      ["preview", "machine", true, true, true],
      ["preview", "machine", false, true, true],
      ["doc", "external", false, false, false],
    ]);
    expect(probed.sort()).toEqual([down, up].sort());
  });

  test("a file a link names under the fleet's files root is served read-only; anything else is not found", async () => {
    const scratch = join(base, "session", "scratchpad");
    writeFileSync(join(scratch, "plan.md"), "# The plan\n");
    writeFileSync(join(scratch, "unlinked.md"), "secret-ish\n");
    writeFileSync(join(base, "outside.md"), "outside\n");
    mkdirSync(join(scratch, ".hidden"));
    writeFileSync(join(scratch, ".hidden", "x.md"), "hidden\n");
    symlinkSync(join(base, "outside.md"), join(scratch, "escape.md"));
    writeLinks([
      { id: "l1", url: `file://${root}/../plan.md`, title: "Plan", kind: "doc" },
      { id: "l2", url: `file://${join(base, "outside.md")}`, title: "Outside", kind: "doc" },
      { id: "l3", url: `file://${join(scratch, "escape.md")}`, title: "Escape", kind: "doc" },
      { id: "l4", url: `file://${join(scratch, ".hidden", "x.md")}`, title: "Hidden", kind: "doc" },
    ]);

    const links = await shownLinks();
    expect(links.map((l) => [l["reach"], l["file"], l["up"]])).toEqual([
      ["file", "files/plan.md", true],
      ["file", null, true],
      ["file", "files/escape.md", true],
      ["file", null, true],
    ]);

    const served = await get("/f/p/files/plan.md");
    expect([served.status, await served.text(), served.headers.get("Content-Type"), served.headers.get("Content-Security-Policy")?.startsWith("sandbox")]).toEqual([
      200,
      "# The plan\n",
      "text/plain; charset=utf-8",
      true,
    ]);

    for (const path of [
      "/f/p/files/unlinked.md",
      "/f/p/files/escape.md",
      "/f/p/files/.hidden/x.md",
      "/f/p/files/../../outside.md",
      "/f/p/files/%2e%2e/%2e%2e/outside.md",
      "/f/p/files/..%2f..%2foutside.md",
      "/f/p/files/coordinator/state.json",
      `/f/p/files/${encodeURIComponent(join(base, "outside.md"))}`,
    ]) {
      const res = await get(path);
      const text = await res.text();

      expect([path, res.status === 200 || text.includes("outside") || text.includes("hidden")]).toEqual([path, false]);
    }
  });
  test("a link's symlink to a hidden file or into a hidden directory, a FIFO and a device are not found", async () => {
    const scratch = join(base, "session", "scratchpad");
    writeFileSync(join(scratch, ".env"), "SECRET=1\n");
    symlinkSync(join(scratch, ".env"), join(scratch, "notes.md"));
    mkdirSync(join(scratch, ".git"));
    writeFileSync(join(scratch, ".git", "config"), "gitcfg\n");
    symlinkSync(join(scratch, ".git"), join(scratch, "repo"));
    spawnSync("mkfifo", [join(scratch, "pipe.log")]);
    symlinkSync("/dev/zero", join(scratch, "zero.log"));
    writeLinks(["notes.md", "repo/config", "pipe.log", "zero.log"].map((p, i) => ({ id: `l${String(i)}`, url: `file://${join(scratch, p)}`, title: p, kind: "doc" })));

    for (const path of ["notes.md", "repo/config", "pipe.log", "zero.log"]) {
      const res = await get(`/f/p/files/${path}`);
      const text = await res.text();

      expect([path, res.status, text.includes("SECRET") || text.includes("gitcfg")]).toEqual([path, 404, false]);
    }
  });

  test("a linked file is streamed, and one over 50 MB is refused with 413", async () => {
    const scratch = join(base, "session", "scratchpad");
    writeFileSync(join(scratch, "big.log"), "");
    truncateSync(join(scratch, "big.log"), 40 * 1024 * 1024);
    writeFileSync(join(scratch, "huge.log"), "");
    truncateSync(join(scratch, "huge.log"), 51 * 1024 * 1024);
    writeLinks(["big.log", "huge.log"].map((p, i) => ({ id: `l${String(i)}`, url: `file://${join(scratch, p)}`, title: p, kind: "doc" })));

    const big = await get("/f/p/files/big.log");
    expect([big.status, (await big.arrayBuffer()).byteLength]).toEqual([200, 40 * 1024 * 1024]);
    const huge = await get("/f/p/files/huge.log");
    expect([huge.status, huge.headers.get("Content-Type"), await huge.text()]).toEqual([
      413,
      "text/plain; charset=utf-8",
      "This file is 51 MB; the hub serves a linked file of at most 50 MB. Open it on the machine.\n",
    ]);
  });
  test("with no tailnet read at the hub's start, a ts.net link is elsewhere and never probed", async () => {
    writeLinks([{ id: "l1", url: "https://box.tail1234.ts.net:7501/", title: "App", kind: "preview" }]);
    const links = await shownLinks();
    await sleep(100);
    expect([links.map((l) => l["reach"]), probed]).toEqual([["external"], []]);
  });
});
