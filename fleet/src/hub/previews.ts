/**
 * The preview path, apart from the hub's page, ledger and chat: `/f/<fleet>/preview/…` and
 * `/f/<fleet>/preview/<worker>/…` passed to the fleet's dev servers, HTTP and WebSocket (`preview-proxy.ts`),
 * a root-mode preview at the root of its own TLS port (`fetchRooted`, `preview-ports.ts`), the "starting" and
 * "halted" pages, and the `DIR/preview/<w>.seen` stamp the idle-sleep keeper reads (`preview/sleep.ts`).
 *
 * One module, two entry points: the hub routes its preview paths here, and `fleet preview serve`
 * (`preview-server.ts`) serves only these, so previews outlive the hub.
 */
import { dumps, type JsonOut } from "../json.ts";
import { readRecord, type DevServer } from "../preview/record.ts";
import { idleMs, noteRequest, serverStanding } from "../preview/sleep.ts";
import type { Entry } from "../registry.ts";
import type { Machine } from "../world.ts";
import { writerRefusal, type Viewer } from "./policy.ts";
import { whois, type Tailnet } from "./tailnet.ts";
import { haltedPage, isPing, killSwitch, previewTarget, proxiedHost, proxiedIdentity, proxyHttp, proxySocket, startingPage, type Target, type Upgrade } from "./preview-proxy.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A JSON response. */
export function jsonResponse(status: number, body: JsonOut, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(dumps(body, { ensureAscii: false }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

/** A preview's path, combined or a worker's, on this hub or a peer's: the only one that serves a service worker. */
export const PREVIEW_PATH = /^\/f\/[^/]+\/preview\//u;

/**
 * A preview runs on the origin of the hub's pages (or of the other fleets' previews), and a service worker it
 * registers from a script outside its own path would see every page in that script's folder. Only a preview's own
 * path serves one; elsewhere a worker's script is the kill switch, which ends a worker registered before this rule
 * at its next update check, and any other worker's request is refused. Undefined: not a service worker's request.
 */
export function serviceWorkerGuard(req: Request, path: string): Response | undefined {
  if (PREVIEW_PATH.test(path)) return undefined;
  const worker = req.headers.get("Service-Worker");

  if (worker === "script") return killSwitch(req);

  if (worker !== null || req.headers.get("Sec-Fetch-Dest") === "serviceworker") {
    return jsonResponse(403, { error: "a service worker is registered only under a preview's path" });
  }

  return undefined;
}

/** Whether `host` (`host:port`, lower case) names this machine at `port`: loopback, or its tailnet name or address. */
export function answersAt(tailnet: Tailnet | undefined, host: string, port: number): boolean {
  const self = tailnet?.self;
  const names = ["127.0.0.1", "localhost", "[::1]", self?.dns, self?.name, self?.ip].flatMap((n) => (n === undefined ? [] : [`${n.toLowerCase()}:${port}`]));

  return names.includes(host);
}

/** Who owns each tailnet address, as `tailscale whois` says, held a minute. */
export class Logins {
  private readonly held = new Map<string, { readonly login: string | undefined; readonly at: number }>();

  private readonly tailscale: string;

  constructor(tailscale: string) {
    this.tailscale = tailscale;
  }

  async login(ip: string): Promise<string | undefined> {
    const held = this.held.get(ip);

    if (held !== undefined && performance.now() - held.at < 60_000) return held.login;
    const login = await whois(this.tailscale, ip);
    this.held.set(ip, { login, at: performance.now() });

    return login;
  }
}

/** A root-mode preview served at the root of its public port: which fleet, which dev server. */
export interface Rooted {
  readonly port: number;
  readonly fleet: string;
  readonly dir: string;
  /** The worker of a per-worker preview; undefined for the combined one. */
  readonly worker: string | undefined;
}

export interface PreviewsOptions {
  readonly machine: Machine;
  /** The fleets whose previews are served: the live ones, and the teams moved to the cloud (their folder's record). */
  readonly entries: () => readonly Entry[];
  /** Who asks, as Tailscale says (`policy.ts` `viewerOf`). */
  readonly viewer: (req: Request, ip: string) => Promise<Viewer>;
  /** The login that owns this machine, when Tailscale says. */
  readonly owner: () => string | undefined;
  /** Whether `host` (`host:port`, lower case) names this machine at `port`. */
  readonly answersAt: (host: string, port: number) => boolean;
  /** The port of the server itself, never a root-mode preview's. */
  readonly port: number;
}

/** The preview path, for whichever server holds it. */
export class Previews {
  /** When a request to each preview's dev server was last noted (`preview/sleep.ts`), by fleet dir and worker. */
  private readonly noted = new Map<string, number>();

  private readonly options: PreviewsOptions;

  constructor(options: PreviewsOptions) {
    this.options = options;
  }

  /** `rest` of `/f/<entry>/…` when it is the preview's (`/preview` or `/preview/…`); else undefined. */
  route(req: Request, ip: string, entry: Entry, rest: string, url: URL, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> | Response | undefined {
    if (rest === "/preview") return new Response(null, { status: 301, headers: { Location: `/f/${encodeURIComponent(entry.id)}/preview/${url.search}`, ...NO_STORE } });

    if (!rest.startsWith("/preview/")) return undefined;

    return this.preview(req, ip, entry, rest.slice("/preview/".length), url.search, keepOpen, upgrade);
  }

  /** A preview path, passed to its dev server (`pass`). */
  private async preview(req: Request, ip: string, entry: Entry, tail: string, search: string, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const target = previewTarget(readRecord(entry.dir), entry.id, tail);

    if ("waking" in target) return this.wake(req, entry.dir, target.waking);

    if ("halted" in target) return haltedPage(req, entry.dir, target);

    if (!("server" in target)) return jsonResponse(target[0], { error: target[1].replace("DIR", entry.dir) });

    return this.pass(req, ip, entry.dir, target, search, keepOpen, upgrade);
  }

  /** A request to a dev server asleep or waking: noted, which wakes it (unless it is Vite's ping), and
   * answered with the page that reloads itself until the server answers. */
  private wake(req: Request, root: string, worker: string | undefined): Response {
    if (isPing(req)) return jsonResponse(503, { error: "the preview's dev server is asleep" });
    noteRequest(root, worker);
    this.noted.set(`${root}\0${worker ?? ""}`, Date.now());

    return startingPage(req);
  }

  /** Note a use of a dev server (a request, a WebSocket frame) for its idle sleep, at most every few seconds per server. */
  private noteUse(root: string, worker: string | undefined): void {
    const key = `${root}\0${worker ?? ""}`;
    const every = Math.min(5000, (idleMs(this.options.machine.env) ?? 20_000) / 4);

    if (Date.now() - (this.noted.get(key) ?? 0) < every) return;
    this.noted.set(key, Date.now());
    noteRequest(root, worker);
  }

  /** Pass a request to a preview's dev server: a WebSocket piped, anything else asked and answered, with the
   * identity verified and where the browser asked (`proxiedHost`). A request that could change something there
   * (not GET, HEAD or OPTIONS) is the chat's writers' only. */
  private async pass(req: Request, ip: string, root: string, target: Target, search: string, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    if (!isPing(req)) this.noteUse(root, target.worker);
    const viewer = await this.options.viewer(req, ip);
    const identity = proxiedIdentity(ip, viewer, req.headers);
    proxiedHost(req, ip, target.onHubOrigin).forEach((value, key) => identity.set(key, value));

    if ((req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      if (upgrade === undefined) return jsonResponse(400, { error: "WebSockets are not served here" });

      return proxySocket(req, target, search, upgrade, identity, () => this.noteUse(root, target.worker));
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const denied = writerRefusal(this.options.owner(), viewer);

      if (denied !== undefined) return jsonResponse(403, { error: denied });
    }

    keepOpen();

    return proxyHttp(req, target, search, identity);
  }

  /** The root-mode previews to listen for: each recorded dev server with a public port, while it is started (its
   * pid recorded), asleep, or failed or unkept (to say so). A port named twice goes to the first; the server's own never. */
  rootedPreviews(): Rooted[] {
    const found: Rooted[] = [];
    const ports = new Set<number>([this.options.port]);

    for (const entry of this.options.entries()) {
      const record = readRecord(entry.dir);

      if (record === undefined) continue;
      const servers: (readonly [string | undefined, DevServer | null])[] = [[undefined, record.server], ...record.workers.map((w) => [w.worker, w] as const)];

      for (const [worker, server] of servers) {
        if (server === null || server.public === null || (server.pid === null && server.keeper === null && server.failed === null) || ports.has(server.public)) continue;
        ports.add(server.public);
        found.push({ port: server.public, fleet: entry.id, dir: entry.dir, worker });
      }
    }

    return found;
  }

  /** Answer one request from `ip` on `slot`'s public port: every path goes to its dev server at its root,
   * WebSocket or not, as `/f/<fleet>/preview/` does, with `X-Forwarded-Prefix: /`. A Host that is not this
   * machine at that port is refused (421), against DNS rebinding. */
  async fetchRooted(req: Request, ip: string, slot: Rooted, keepOpen: () => void, upgrade?: Upgrade): Promise<Response | undefined> {
    if (!this.options.answersAt((req.headers.get("Host") ?? "").toLowerCase(), slot.port)) return jsonResponse(421, { error: "unknown host" }, { Connection: "close" });
    const record = readRecord(slot.dir);
    const server = slot.worker === undefined ? record?.server : record?.workers.find((w) => w.worker === slot.worker);

    const now = server === undefined || server === null ? "stopped" : serverStanding(server);

    if (now === "asleep" || now === "waking") return this.wake(req, slot.dir, slot.worker);

    if (server !== undefined && server !== null && (now === "failed" || now === "unkept")) return haltedPage(req, slot.dir, { halted: now, worker: slot.worker, server });

    if (server === undefined || server === null || now !== "running") {
      const start = slot.worker === undefined ? `fleet preview ${slot.dir} start --root` : `fleet preview ${slot.dir} start --per-worker ${slot.worker} --root`;

      return jsonResponse(502, { error: `this preview's dev server is not running: \`${start}\`` });
    }

    const url = new URL(req.url);

    return this.pass(req, ip, slot.dir, { server, path: url.pathname, prefix: "/", worker: slot.worker, onHubOrigin: false }, url.search, keepOpen, upgrade);
  }
}
