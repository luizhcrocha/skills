/**
 * The hub: one server for every fleet on this machine and, through Tailscale, on the other machines that
 * run one. It replaces each fleet's own `serve_dashboard.py` server. Routes:
 *
 * - `/` the index of every fleet (this machine's registry, then each peer hub's), `/events` its live
 *   stream, `/api/fleets` this machine's fleets as JSON (what a peer hub reads).
 * - `/f/<fleet>/…` a fleet of this machine, as serve_dashboard.py served it: the page (rendered from
 *   state.json on each load), `GET /chat`, `GET /events` (SSE: `hello`, `state`, `chat`, pings),
 *   `POST /chat`, `POST /chat/preview`, `GET /skills` (what the session can be told to run, held 60 s),
 *   and the files under its DIR (`decisions/*` sandboxed), with the
 *   same status codes. `/f/<a>/f/<b>/…` is `/f/<b>/…` (a manager's page links its fleets relatively), and
 *   a fleet's old id, from before its session's number was dropped (`/f/3.ui-coordinator/…`), moves (301)
 *   to its id while the entry lives.
 * - `/f/<fleet>/preview/…` and `/f/<fleet>/preview/<worker>/…` the fleet's preview dev servers, HTTP and
 *   WebSocket (`preview-proxy.ts`); `POST /f/<fleet>/preview-workers` takes a worker in or out of the
 *   combined preview, under the chat's write policy.
 * - `/f/<fleet>@<machine>/…` a fleet of a peer hub, passed through: this hub checks a post by its own
 *   rules first, then the peer checks this machine (its owner's login) by its rules.
 *
 * A preview in root mode is served apart, at the root of a public port of its own (`fetchRooted`,
 * `preview-ports.ts`): every path there goes to its dev server as it is, under the same identity rule.
 *
 * A request whose Host this hub does not answer to is refused (421), against DNS rebinding.
 */
import { join, normalize } from "node:path";

import { address, append, hostOf, type Draft } from "../chat/chat.ts";
import { Courier, deliveries } from "../chat/relay.ts";
import { readChat, Tail } from "../chat/store.ts";
import { stampOf } from "../clock.ts";
import { ChatError } from "../errors.ts";
import { readBytes, resolvePath, strerror } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type Json, type JsonObject, type JsonOut } from "../json.ts";
import { answerRefusal } from "../ledger/answers.ts";
import { pageHtml, readTemplate } from "../page/render.ts";
import { pick, readLedger } from "../preview/updater.ts";
import { isRunning } from "../preview/devserver.ts";
import { readRecord, recordPath, type DevServer } from "../preview/record.ts";
import { PreviewError } from "../errors.ts";
import { summary, view, type Lookups } from "../page/view.ts";
import { pidOfEntry, type Entry } from "../registry.ts";
import { SpendReader } from "../transcripts.ts";
import { readUsage } from "../usage.ts";
import type { Machine } from "../world.ts";
import { indexHtml } from "./index-page.ts";
import { ProbeCache } from "./probes.ts";
import { grantRefusal, registeredSession, type Registered } from "./grants.ts";
import { grantor, hello, MAX_POST_BYTES, postRefusal, tooBig, viewerOf, writerRefusal, type Viewer } from "./policy.ts";
import { previewTarget, proxiedIdentity, proxyHttp, proxySocket, type Target, type Upgrade } from "./preview-proxy.ts";
import { Served } from "./served.ts";
import { PLUGIN_ROOT, readSkills, repoOf } from "./skills.ts";
import { readTailnet, whois, type Tailnet } from "./tailnet.ts";

import * as Option from "effect/Option";

/** A record built field by field before it is handed on. */
type Building<T> = { -readonly [K in keyof T]: T[K] };

/** How often a stream looks at its files. */
export const POLL_MS = 300;

/** How often a stream pings an idle client. */
export const PING_MS = 15_000;

/** How long a computed view serves an unchanged state.json before the derived figures are read again. */
const VIEW_TTL_MS = 2000;

/** How long a fleet's list of skills is served before the files are read again. */
const SKILLS_TTL_MS = 60_000;

/** How often the hub reads the tailnet and asks the peer hubs for their fleets. */
const PEERS_MS = 30_000;

/** How long a peer hub may take to answer. */
const PEER_TIMEOUT_MS = 2500;

/** A decision body's page runs without the hub's origin, so its scripts cannot post as the user. */
export const BODY_SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** What the hub needs from where it runs. */
export interface HubOptions {
  /** The port it listens on, and the one it reaches peer hubs on. */
  readonly port: number;
  /** This machine: registry, environment, clock. */
  readonly machine: Machine;
  /** The tailscale binary. */
  readonly tailscale: string;
  /** Whether to look for peer hubs on the tailnet. */
  readonly peers: boolean;
  /** Further `host:port` names the hub answers to (a `tailscale serve` https name). */
  readonly hosts: readonly string[];
}

/** A root-mode preview the hub serves at the root of its public port: which fleet, which dev server. */
export interface Rooted {
  readonly port: number;
  readonly fleet: string;
  readonly dir: string;
  /** The worker of a per-worker preview; undefined for the combined one. */
  readonly worker: string | undefined;
}

/** A peer hub, as it last answered. */
interface Peer {
  readonly name: string;
  readonly dns: string;
  readonly ip: string;
  readonly fleets: readonly JsonObject[];
  readonly at: string;
}

/** One fleet's view, as last computed. */
interface Viewed {
  readonly bytes: Buffer;
  readonly state: JsonObject;
  readonly json: string;
  readonly at: number;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A JSON response. */
export function jsonResponse(status: number, body: JsonOut, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(dumps(body, { ensureAscii: false }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

/** One server-sent event. */
export function sseEvent(event: string, data: string, id?: number): string {
  return `event: ${event}\n${id === undefined ? "" : `id: ${id}\n`}data: ${data}\n\n`;
}

const encoder = new TextEncoder();

/** A text/event-stream response fed by `start`, which returns how to stop; stopped when the client goes. */
export function sseResponse(signal: AbortSignal, start: (send: (text: string) => void) => () => void): Response {
  let stop: (() => void) | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    stop?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        if (closed) return;

        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };

      stop = start(send);
      signal.addEventListener("abort", () => {
        close();

        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no", ...NO_STORE },
  });
}

function afterParam(params: URLSearchParams): number {
  const given = params.get("after");

  return given !== null && /^\s*[+-]?\d+\s*$/.test(given) ? Number(given) : 0;
}

function resumePoint(lastEventId: string | null, params: URLSearchParams): number {
  return lastEventId !== null && /^\s*[+-]?\d+\s*$/.test(lastEventId) ? Number(lastEventId) : afterParam(params);
}

/** `/f/<a>/f/<b>/rest` as `/f/<b>/rest`, however deep. */
export function collapse(path: string): string {
  let at = path;

  for (let m = /^\/f\/[^/]+(\/f\/[^/]+(?:\/.*)?)$/.exec(at); m !== null; m = /^\/f\/[^/]+(\/f\/[^/]+(?:\/.*)?)$/.exec(at)) at = m[1] ?? at;

  return at;
}

/** The hub. */
export class Hub {
  readonly options: HubOptions;
  /** The `host:port` names it answers to, lower case. */
  readonly hosts = new Set<string>();
  /** Names added once it runs (`answerTo`): kept across the tailnet's re-reads. */
  private readonly added = new Set<string>();
  private tailnet: Tailnet | undefined;
  private readonly peerHubs = new Map<string, Peer>();
  private readonly served: Served;
  private readonly probes = new ProbeCache();
  private readonly spend = new SpendReader();
  private readonly views = new Map<string, Viewed>();
  private readonly skillLists = new Map<string, { readonly body: string; readonly at: number }>();
  private readonly logins = new Map<string, { readonly login: string | undefined; readonly at: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private courierTimer: ReturnType<typeof setInterval> | undefined;
  private readonly courier = new Courier();
  private readonly lookups: Lookups;

  constructor(options: HubOptions) {
    this.options = options;
    this.served = new Served(options.machine);
    this.lookups = { up: (urls) => this.probes.up(urls), discovered: () => this.served.latest(), spend: this.spend };
    this.setHosts();
  }

  /** The tailnet as last read. */
  get net(): Tailnet | undefined {
    return this.tailnet;
  }

  /** The login that owns this machine, when Tailscale says. */
  get owner(): string | undefined {
    return this.tailnet?.login;
  }

  private setHosts(): void {
    const port = this.options.port;
    this.hosts.clear();

    for (const name of ["127.0.0.1", "localhost", "[::1]"]) this.hosts.add(`${name}:${port}`);

    if (this.tailnet !== undefined) {
      const self = this.tailnet.self;

      for (const name of [self.dns, self.name, self.ip]) if (name !== undefined) this.hosts.add(`${name.toLowerCase()}:${port}`);
    }

    for (const host of [...this.options.hosts, ...this.added]) this.hosts.add(host.toLowerCase());
  }

  /** Answer to `host` (`host:port`) from now on, as to the names it started with. */
  answerTo(host: string): void {
    this.added.add(host.toLowerCase());
    this.hosts.add(host.toLowerCase());
  }

  /** Read the tailnet and ask the peer hubs, now and then every 30 s. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), PEERS_MS);
    this.courierTimer = setInterval(() => this.relay(), POLL_MS);
  }

  /** Stop looking. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);

    if (this.courierTimer !== undefined) clearInterval(this.courierTimer);
  }

  /** Mirror onto the manager's page what the coordinators answered in their own chats to the messages the
   * hub delivered from it; how many it wrote. Runs every POLL_MS. */
  relay(): number {
    try {
      return this.courier.relay(this.options.machine);
    } catch {
      return 0;
    }
  }

  /** Read the tailnet again, and ask each online peer for its fleets. */
  async refresh(): Promise<void> {
    this.tailnet = await readTailnet(this.options.tailscale);
    this.setHosts();

    if (!this.options.peers || this.tailnet === undefined) {
      this.peerHubs.clear();

      return;
    }

    const online = this.tailnet.peers.filter((p) => p.online && p.ip !== undefined);
    const seen = new Set<string>();

    await Promise.all(
      online.map(async (p) => {
        const ip = p.ip ?? "";
        const got = await this.askPeer(ip);

        if (got === undefined) return;
        seen.add(p.name);
        this.peerHubs.set(p.name, { name: p.name, dns: p.dns, ip, fleets: got, at: stampOf(this.options.machine.now()) });
      }),
    );

    for (const name of this.peerHubs.keys()) if (!seen.has(name)) this.peerHubs.delete(name);
  }

  /** Add a peer hub by hand (tests, and a peer at a known address). */
  async addPeer(name: string, ip: string): Promise<boolean> {
    const got = await this.askPeer(ip);

    if (got === undefined) return false;
    this.peerHubs.set(name, { name, dns: name, ip, fleets: got, at: stampOf(this.options.machine.now()) });

    return true;
  }

  private async askPeer(ip: string): Promise<JsonObject[] | undefined> {
    try {
      const res = await fetch(`http://${hostPart(ip)}:${this.options.port}/api/fleets`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });

      if (!res.ok) return undefined;
      const body = Option.getOrUndefined(parseObject(await res.text()));

      return (asArray(body?.["fleets"]) ?? []).flatMap((f) => {
        const o = asObject(f);

        return o === undefined ? [] : [o];
      });
    } catch {
      return undefined;
    }
  }

  private async login(ip: string): Promise<string | undefined> {
    const held = this.logins.get(ip);

    if (held !== undefined && performance.now() - held.at < 60_000) return held.login;
    const login = await whois(this.options.tailscale, ip);
    this.logins.set(ip, { login, at: performance.now() });

    return login;
  }

  private viewer(req: Request, ip: string): Promise<Viewer> {
    return viewerOf(ip, (name) => req.headers.get(name), this.owner, (at) => this.login(at), this.tailnet?.self.ip);
  }

  // -- the fleets of this machine --------------------------------------------------------------

  private entries(): Entry[] {
    return this.options.machine.registry.live();
  }

  /** This machine's fleets, as a peer hub and the index read them. */
  localFleets(): JsonObject[] {
    const machine = this.options.machine;

    return this.entries().map((e) => {
      const { index: _index, ...rest } = summary(machine, this.lookups, e);

      return { ...rest, role: e.role };
    });
  }

  /** The state of the fleet at `root` as its page is sent it, or undefined while it is missing or half written. */
  viewOf(root: string): Viewed | undefined {
    const state = readBytes(join(root, "state.json"));

    if (state === undefined) return undefined;
    // The preview's record changes the view too (the updater writes it): it is part of what is compared.
    const bytes = Buffer.concat([state, readBytes(recordPath(root)) ?? Buffer.alloc(0)]);
    const held = this.views.get(root);

    if (held !== undefined && held.bytes.equals(bytes) && performance.now() - held.at < VIEW_TTL_MS) return held;
    const parsed = Option.getOrUndefined(parseObject(state.toString("utf8")));

    if (parsed === undefined) return undefined;
    const shown = view(this.options.machine, this.lookups, parsed, root);
    const fresh: Viewed = { bytes, state: shown, json: dumps(shown, { ensureAscii: false }), at: performance.now() };
    this.views.set(root, fresh);

    return fresh;
  }

  /** What the index shows: every machine's fleets, the plan's usage, the gate, what else is served. */
  indexPayload(): JsonObject {
    const here = this.tailnet?.self.name ?? "this machine";
    const local = this.localFleets().map((f) => ({ ...f, path: `/f/${encodeURIComponent(asString(f["id"]) ?? "")}/` }));

    const peers = [...this.peerHubs.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((p) => ({
        name: p.name,
        here: false,
        at: p.at,
        fleets: p.fleets.map((f) => ({ ...f, path: `/f/${encodeURIComponent(`${asString(f["id"]) ?? ""}@${p.name}`)}/` })),
      }));

    const registry = this.options.machine.registry;

    return {
      machines: [{ name: here, here: true, fleets: local }, ...peers],
      usage: readUsage(registry.place.home) ?? null,
      gate: registry.gate() ?? null,
      found: this.served.latest().map((x) => ({ ...x })),
    };
  }

  // -- requests --------------------------------------------------------------------------------

  /** Answer one request from `ip`. `keepOpen` lifts the server's idle timeout for a stream; `upgrade` makes
   * a preview's WebSocket (undefined is then the answer). */
  async fetch(req: Request, ip: string, keepOpen: () => void, upgrade?: Upgrade): Promise<Response | undefined> {
    const host = (req.headers.get("Host") ?? "").toLowerCase();

    if (!this.hosts.has(host)) return jsonResponse(421, { error: "unknown host" }, { Connection: "close" });
    const url = new URL(req.url);
    const path = collapse(url.pathname);

    if (path === "/" || path === "/index.html") return this.index(req);

    if (path === "/api/fleets") return jsonResponse(200, { name: this.tailnet?.self.name ?? null, fleets: this.localFleets() });

    if (path === "/events") {
      keepOpen();

      return this.indexEvents(req);
    }

    const m = /^\/f\/([^/]+)(\/.*)?$/.exec(path);

    if (m === null) return jsonResponse(404, { error: "not found" });
    let name: string;

    try {
      name = decodeURIComponent(m[1] ?? "");
    } catch {
      return jsonResponse(404, { error: "not found" });
    }

    const rest = m[2];

    if (rest === undefined) {
      return new Response(null, { status: 301, headers: { Location: `/f/${m[1] ?? ""}/${url.search}`, ...NO_STORE } });
    }

    const at = name.indexOf("@");

    if (at >= 0) return this.proxy(req, ip, name.slice(0, at), name.slice(at + 1), rest, url.search, keepOpen);
    const entries = this.entries();
    const entry = entries.find((e) => e.id === name);
    // A fleet whose id dropped its session's number (`3.ui-coordinator`) is still found at the old address.
    const moved = entry === undefined ? entries.find((e) => e.aliases.includes(name)) : undefined;

    if (moved !== undefined) return new Response(null, { status: 301, headers: { Location: `/f/${encodeURIComponent(moved.id)}${rest}${url.search}`, ...NO_STORE } });

    if (entry === undefined) return jsonResponse(404, { error: `no fleet '${name}' is being served; the hub's index lists the ones that are` });

    return this.fleetRoute(req, ip, entry, rest, url, keepOpen, upgrade);
  }

  private index(req: Request): Response {
    if (req.method !== "GET" && req.method !== "HEAD") return jsonResponse(405, { error: "the index is read with GET" });

    return new Response(indexHtml(this.indexPayload()), { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
  }

  private indexEvents(req: Request): Response {
    return sseResponse(req.signal, (send) => {
      let last = "";
      let pinged = performance.now();

      const tick = (): void => {
        const json = dumps(this.indexPayload(), { ensureAscii: false });

        if (json !== last) {
          send(sseEvent("fleets", json));
          last = json;
        }

        if (performance.now() - pinged >= PING_MS) {
          send(": ping\n\n");
          pinged = performance.now();
        }
      };

      tick();
      const timer = setInterval(tick, 1000);

      return () => clearInterval(timer);
    });
  }

  private async fleetRoute(req: Request, ip: string, entry: Entry, rest: string, url: URL, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const root = entry.dir;
    const params = url.searchParams;

    if (rest === "/preview") return new Response(null, { status: 301, headers: { Location: `/f/${encodeURIComponent(entry.id)}/preview/${url.search}`, ...NO_STORE } });

    if (rest.startsWith("/preview/")) return this.preview(req, ip, entry, rest.slice("/preview/".length), url.search, keepOpen, upgrade);

    if (rest === "/preview-workers" && req.method === "POST") return this.previewWorkers(req, ip, root);

    if (req.method === "POST") return this.post(req, ip, root, rest);

    if (req.method !== "GET" && req.method !== "HEAD") return jsonResponse(405, { error: "not allowed" });

    if (rest === "/chat") return jsonResponse(200, { messages: readChat(root, afterParam(params)).map((m) => m.stored) });

    if (rest === "/skills") return new Response(req.method === "HEAD" ? null : this.skillsOf(root), { headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE } });

    if (rest === "/events") {
      keepOpen();
      const viewer = await this.viewer(req, ip);

      return this.fleetEvents(req, root, viewer, resumePoint(req.headers.get("Last-Event-ID"), params));
    }

    if (rest === "/" || rest === "/index.html") {
      const page = this.page(root);

      if (page !== undefined) return new Response(req.method === "HEAD" ? null : page, { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
    }

    return this.file(req, root, rest === "/" ? "/index.html" : rest);
  }

  /** A preview path, passed to its dev server (`pass`). */
  private async preview(req: Request, ip: string, entry: Entry, tail: string, search: string, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const target = previewTarget(readRecord(entry.dir), entry.id, tail);

    if (!("server" in target)) return jsonResponse(target[0], { error: target[1].replace("DIR", entry.dir) });

    return this.pass(req, ip, target, search, keepOpen, upgrade);
  }

  /** Pass a request to a preview's dev server: a WebSocket piped, anything else asked and answered, with the
   * identity the hub verified. A request that could change something there (not GET, HEAD or OPTIONS) is the
   * chat's writers' only. */
  private async pass(req: Request, ip: string, target: Target, search: string, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const viewer = await this.viewer(req, ip);
    const identity = proxiedIdentity(ip, viewer, req.headers);

    if ((req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      if (upgrade === undefined) return jsonResponse(400, { error: "WebSockets are not served here" });

      return proxySocket(req, target, search, upgrade, identity);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const denied = writerRefusal(this.owner, viewer);

      if (denied !== undefined) return jsonResponse(403, { error: denied });
    }

    keepOpen();

    return proxyHttp(req, target, search, identity);
  }

  // -- root mode -------------------------------------------------------------------------------

  /** The root-mode previews of this machine's fleets the hub listens for: each recorded dev server with a
   * public port, while it is started (its pid recorded). A port named twice goes to the first; the hub's own never. */
  rootedPreviews(): Rooted[] {
    const found: Rooted[] = [];
    const ports = new Set<number>([this.options.port]);

    for (const entry of this.entries()) {
      const record = readRecord(entry.dir);

      if (record === undefined) continue;
      const servers: (readonly [string | undefined, DevServer | null])[] = [[undefined, record.server], ...record.workers.map((w) => [w.worker, w] as const)];

      for (const [worker, server] of servers) {
        if (server === null || server.public === null || server.pid === null || ports.has(server.public)) continue;
        ports.add(server.public);
        found.push({ port: server.public, fleet: entry.id, dir: entry.dir, worker });
      }
    }

    return found;
  }

  /** Whether `host` (`host:port`, lower case) names this machine at `port`: loopback, or its tailnet name or address. */
  answersAt(host: string, port: number): boolean {
    const self = this.tailnet?.self;
    const names = ["127.0.0.1", "localhost", "[::1]", self?.dns, self?.name, self?.ip].flatMap((n) => (n === undefined ? [] : [`${n.toLowerCase()}:${port}`]));

    return names.includes(host);
  }

  /** Answer one request from `ip` on `slot`'s public port: every path goes to its dev server at its root,
   * WebSocket or not, as `/f/<fleet>/preview/` does, with `X-Forwarded-Prefix: /`. A Host that is not this
   * machine at that port is refused (421), against DNS rebinding. */
  async fetchRooted(req: Request, ip: string, slot: Rooted, keepOpen: () => void, upgrade?: Upgrade): Promise<Response | undefined> {
    if (!this.answersAt((req.headers.get("Host") ?? "").toLowerCase(), slot.port)) return jsonResponse(421, { error: "unknown host" }, { Connection: "close" });
    const record = readRecord(slot.dir);
    const server = slot.worker === undefined ? record?.server : record?.workers.find((w) => w.worker === slot.worker);

    if (server === undefined || server === null || server.pid === null || !isRunning(server.pid)) {
      const start = slot.worker === undefined ? `fleet preview ${slot.dir} start --root` : `fleet preview ${slot.dir} start --per-worker ${slot.worker} --root`;

      return jsonResponse(502, { error: `this preview's dev server is not running: \`${start}\`` });
    }

    const url = new URL(req.url);

    return this.pass(req, ip, { server, path: url.pathname, prefix: "/" }, url.search, keepOpen, upgrade);
  }

  /** `POST /f/<fleet>/preview-workers` `{worker, include}`: a worker taken into the combined preview or out
   * of it, from the page's checkboxes; checked as a chat post is. */
  private async previewWorkers(req: Request, ip: string, root: string): Promise<Response> {
    const viewer = await this.viewer(req, ip);
    const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name));

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });
    const raw = await req.text();

    if (Buffer.byteLength(raw) > MAX_POST_BYTES) return jsonResponse(413, { error: `a choice is at most ${MAX_POST_BYTES / 1024} KiB` });
    const body = Option.getOrUndefined(parseObject(raw));
    const worker = asString(body?.["worker"]);
    const include = body?.["include"];

    if (worker === undefined || (include !== true && include !== false)) return jsonResponse(400, { error: "send {worker, include: true|false}" });
    const done = pick(root, readLedger(root), worker, include);

    if (done instanceof PreviewError) return jsonResponse(400, { error: done.reason });

    return jsonResponse(200, { include: [...done.include], exclude: [...done.exclude] });
  }

  /** What `GET /f/<fleet>/skills` answers: the skills the fleet's session can run, read again after 60 s. */
  skillsOf(root: string): string {
    const held = this.skillLists.get(root);

    if (held !== undefined && performance.now() - held.at < SKILLS_TTL_MS) return held.body;
    const config = this.options.machine.config;
    const skills = readSkills({ config, plugin: PLUGIN_ROOT, repo: repoOf(root, config) });
    const body = dumps({ skills: skills.map((s) => ({ ...s })), builtins: false }, { ensureAscii: false });
    this.skillLists.set(root, { body, at: performance.now() });

    return body;
  }

  /** The page of the fleet at `root`, rendered from its state.json now; undefined while it cannot be. */
  page(root: string): string | undefined {
    const shown = this.viewOf(root);
    const template = readTemplate();

    if (shown === undefined || template === undefined) return undefined;
    const html = pageHtml(template, shown.state, false);

    return html instanceof Error ? undefined : html;
  }

  private file(req: Request, root: string, rest: string): Response {
    let decoded: string;

    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return jsonResponse(404, { error: "not found" });
    }

    const base = resolvePath(root);
    const target = normalize(join(base, normalize(`/${decoded}`)));
    const resolved = resolvePath(target);
    const inside = (p: string): boolean => p.startsWith(`${base}/`);

    if (!inside(target) || !inside(resolved) || decoded.split("/").some((part) => part.startsWith("."))) {
      return jsonResponse(404, { error: "not found" });
    }

    const bytes = readBytes(resolved);

    if (bytes === undefined) return jsonResponse(404, { error: "not found" });
    const body = resolved.startsWith(`${join(base, "decisions")}/`) ? { "Content-Security-Policy": BODY_SANDBOX } : {};

    return new Response(req.method === "HEAD" ? null : bytes, {
      headers: { "Content-Type": Bun.file(resolved).type, ...NO_STORE, ...body },
    });
  }

  private fleetEvents(req: Request, root: string, viewer: Viewer, after: number): Response {
    return sseResponse(req.signal, (send) => {
      const tail = new Tail(root, after);
      let sentState: string | undefined;
      let pinged = performance.now();
      send(sseEvent("hello", dumps(hello(this.owner, viewer), { ensureAscii: false })));

      const tick = (): void => {
        const state = this.viewOf(root)?.json;

        if (state !== undefined && state !== sentState) {
          send(sseEvent("state", state));
          sentState = state;
        }

        try {
          for (const m of tail.read()) send(sseEvent("chat", dumps(m.stored, { ensureAscii: false }), m.id));
        } catch {
          // the store cannot be read now (a directory, a permission): the stream goes on with the state
        }

        if (performance.now() - pinged >= PING_MS) {
          send(": ping\n\n");
          pinged = performance.now();
        }
      };

      tick();
      const timer = setInterval(tick, POLL_MS);

      return () => clearInterval(timer);
    });
  }

  private async post(req: Request, ip: string, root: string, rest: string): Promise<Response> {
    if (rest !== "/chat" && rest !== "/chat/preview") return jsonResponse(404, { error: "not found" });
    const viewer = await this.viewer(req, ip);
    const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name));

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });
    const raw = await req.text();

    if (Buffer.byteLength(raw) > MAX_POST_BYTES) return jsonResponse(413, { error: tooBig(Buffer.byteLength(raw)) });
    const body = raw.trim() === "" ? undefined : Option.getOrUndefined(parseObject(raw));

    if (body === undefined) return jsonResponse(400, { error: "the body is not a JSON object" });

    return this.chatPost(root, rest, body, viewer);
  }

  private async chatPost(root: string, rest: string, body: JsonObject, viewer: Viewer): Promise<Response> {
    const machine = this.options.machine;
    const text = asString(body["text"]);
    const reGiven = body["re"];
    const hasRe = reGiven !== undefined && reGiven !== null;
    const reNumber = asNumber(reGiven);

    if (text === undefined || (hasRe && (reNumber === undefined || !Number.isInteger(reNumber)))) {
      return jsonResponse(400, { error: "text must be a string and re a message id" });
    }

    const re: number | null = hasRe ? (reNumber ?? null) : null;

    const decisionGiven = body["decision"];
    const decision = decisionGiven === undefined || decisionGiven === null ? undefined : asString(decisionGiven);

    if (decisionGiven !== undefined && decisionGiven !== null && decision === undefined) return jsonResponse(400, { error: "decision must be a decision id" });
    const ruleGiven = body["rule"];
    const rule = ruleGiven === undefined || ruleGiven === null ? undefined : asString(ruleGiven);

    if (ruleGiven !== undefined && ruleGiven !== null && rule === undefined) return jsonResponse(400, { error: "rule must be the rule the page showed" });

    try {
      if (rest === "/chat/preview") {
        const resolved = address(machine, root, { sender: "user", text, re, allowUser: true });

        if (resolved instanceof ChatError) return jsonResponse(400, { error: resolved.reason });

        return jsonResponse(200, { to: resolved.to, parts: resolved.parts.map((p) => (p.mention === undefined ? { text: p.text } : { text: p.text, mention: p.mention })) });
      }

      if (decision !== undefined) {
        const why = answerRefusal(root, decision, text);

        if (why !== undefined) {
          const state = Option.getOrUndefined(parseObject(readBytes(join(root, "state.json"))?.toString("utf8") ?? "")) ?? {};

          const rows = (asArray(state["decisions"]) ?? []).flatMap((d) => {
            const o = asObject(d);

            return o === undefined ? [] : [o];
          });

          const found = rows.find((d) => d["id"] === decision) ?? rows.find((d) => asString(d["ref"]) === decision);
          const closed = found !== undefined && (found["status"] ?? "open") !== "open";

          return jsonResponse(closed ? 409 : 400, { error: why });
        }
      }

      const quote = quoteOf(body["quote"]);
      const side = sideOf(body["side"]);

      if (quote instanceof ChatError) return jsonResponse(400, { error: quote.reason });

      if (side instanceof ChatError) return jsonResponse(400, { error: side.reason });

      if (decision !== undefined) {
        const registered = (): Registered | undefined => {
          const entry = machine.registry.find(root);

          return registeredSession(entry === undefined ? undefined : pidOfEntry(entry));
        };

        const ungranted = await grantRefusal({ dir: root, decision, text, rule, by: grantor(viewer), at: stampOf(machine.now()), registered });

        if (ungranted !== undefined) return jsonResponse(409, { error: ungranted });
      }

      const draft: Building<Draft> = { sender: "user", text, re, allowUser: true };

      if (viewer.login !== undefined) draft.author = viewer.login;

      if (decision !== undefined) draft.decision = decision;

      if (quote !== undefined) draft.quote = quote;

      if (side !== undefined) draft.side = side;

      // On the manager's page, a message to live coordinators goes into their own chats too (an answer to
      // one of the manager's decisions stays the manager's).
      if (decision === undefined && hostOf(root) === "manager") {
        draft.alongside = (stored, known) => {
          const delivered = deliveries(machine, root, known, (asArray(stored["to"]) ?? []).flatMap((t) => asString(t) ?? []), {
            id: asNumber(stored["id"]) ?? 0,
            at: asString(stored["at"]) ?? "",
            text,
            re,
            side: stored["side"],
            author: asString(stored["author"]),
            quote: stored["quote"],
          });

          return delivered.length === 0 ? undefined : { delivered: delivered.map((d) => ({ fleet: d.fleet, id: d.id })) };
        };
      }

      const message = append(machine, root, draft, stampOf(machine.now()));

      if (message instanceof ChatError) return jsonResponse(400, { error: message.reason });

      return jsonResponse(201, message.stored);
    } catch (cause: unknown) {
      return jsonResponse(500, { error: `could not store the message: ${strerror(cause)}` });
    }
  }

  // -- peers -----------------------------------------------------------------------------------

  private async proxy(req: Request, ip: string, fleet: string, peerName: string, rest: string, search: string, keepOpen: () => void): Promise<Response> {
    const peer = this.peerHubs.get(peerName);

    if (peer === undefined) return jsonResponse(404, { error: `no hub on '${peerName}' answers; the index lists the machines that do` });
    let body: ArrayBuffer | undefined;

    if (req.method === "POST") {
      const viewer = await this.viewer(req, ip);
      const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name));

      if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });
      body = await req.arrayBuffer();
    }

    const headers = new Headers();

    for (const name of ["Accept", "Content-Type", "Last-Event-ID"]) {
      const value = req.headers.get(name);

      if (value !== null) headers.set(name, value);
    }

    if (rest === "/events") keepOpen();

    try {
      const init: RequestInit = { method: req.method, headers, redirect: "manual", signal: req.signal };

      if (body !== undefined) init.body = body;
      const upstream = await fetch(`http://${hostPart(peer.ip)}:${this.options.port}/f/${encodeURIComponent(fleet)}${rest}${search}`, init);

      const passed = new Headers();

      upstream.headers.forEach((value, key) => {
        if (!["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "date", "server"].includes(key.toLowerCase())) passed.set(key, value);
      });

      const location = passed.get("Location");

      if (location !== null && location.startsWith(`/f/${encodeURIComponent(fleet)}/`)) {
        passed.set("Location", `/f/${encodeURIComponent(`${fleet}@${peerName}`)}/${location.slice(`/f/${encodeURIComponent(fleet)}/`.length)}`);
      }

      return new Response(upstream.body, { status: upstream.status, headers: passed });
    } catch (cause: unknown) {
      return jsonResponse(502, { error: `${peerName}'s hub did not answer: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }
}

function hostPart(ip: string): string {
  return ip.includes(":") ? `[${ip}]` : ip;
}

function quoteOf(value: Json | undefined): JsonObject | undefined | ChatError {
  if (value === undefined || value === null) return undefined;
  const quote = asObject(value);

  return quote === undefined ? new ChatError({ reason: "a quote is the selected text, with where it was" }) : quote;
}

function sideOf(value: Json | undefined): number | "new" | undefined | ChatError {
  if (value === undefined || value === null) return undefined;

  if (value === "new") return "new";
  const n = asNumber(value);

  return n !== undefined && Number.isInteger(n) ? n : new ChatError({ reason: `no side chat #${asString(value) ?? dumps(value)}` });
}
