/**
 * The hub: one server for every fleet on this machine and, through Tailscale, on the other machines that
 * run one. It replaces each fleet's own `serve_dashboard.py` server. Routes:
 *
 * - `/` the index of every fleet (this machine's registry, then each peer hub's), `/events` its live
 *   stream, `/api/fleets` this machine's fleets as JSON (what a peer hub reads).
 * - `/f/<fleet>/…` a fleet of this machine, as serve_dashboard.py served it: the page (rendered from
 *   state.json on each load), `GET /chat`, `GET /events` (SSE: `hello`, `state`, `chat`, pings),
 *   `POST /chat`, `POST /chat/preview`, `GET /skills` (what the session can be told to run, held 60 s),
 *   `GET /state.json` (the view the stream sends, not the ledger: the page polls it while the stream
 *   reconnects), and the files under its DIR, each sandboxed with no script (`decisions/*` as plain text,
 *   `files/*` a linked file whose scripts run without an origin: body-policy.ts), with the same status codes.
 *   `/f/<a>/f/<b>/…` is `/f/<b>/…` (a manager's page links its fleets relatively), and a fleet's old id,
 *   from before its session's number was dropped (`/f/3.ui-coordinator/…`), moves (301) to its id while the
 *   entry lives.
 * - `/f/<fleet>/preview/…` and `/f/<fleet>/preview/<worker>/…` the fleet's preview dev servers, HTTP and
 *   WebSocket (`preview-proxy.ts`); `POST /f/<fleet>/preview-workers` takes a worker in or out of the
 *   combined preview, under the chat's write policy; `POST /f/<fleet>/name` names a worker or the fleet from
 *   the page, under the same policy; `POST /f/<manager>/orphans/stop` stops an orphaned test or dev process
 *   tree Luiz clicked Stop on, on the manager's page (orphans.ts), under the same policy;
 *   `POST /f/<fleet>/onepw/unlocked` is Luiz's "1Password is unlocked" on the card every page shows while it
 *   is locked (onepw.ts), under the same policy: it clears every locked kind and tells the held fleets, each
 *   in its chat, or in its session when its host's watch is dead;
 *   `POST /f/<fleet>/wake` is Luiz's "Wake now" on a fleet whose host does not listen (wake.ts), under the
 *   same policy: one wake to the session's socket at once;
 *   `POST /f/<fleet>/attachments` stores an image pasted on the fleet's page (attachments.ts), from that page
 *   only, as a grant is (`grantRefusal`).
 * - `/f/<fleet>@<machine>/…` a fleet of a peer hub, passed through: this hub checks a post by its own
 *   rules first, then the peer checks this machine (its owner's login) by its rules.
 *
 * A preview in root mode is served apart, at the root of a public port of its own (`fetchRooted`,
 * `preview-ports.ts`): every path there goes to its dev server as it is, under the same identity rule.
 *
 * A request whose Host this hub does not answer to is refused (421), against DNS rebinding.
 */
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

import type { Building } from "../building.ts";
import { address, appendAll, hostOf, marksAlone, marksOf, ownerOfBatch, prepare, stateOfDir, storeRefusal, type Draft, type Prepared } from "../chat/chat.ts";
import { storeImage, uploadRefusal } from "../chat/attachments.ts";
import { coordinators, Courier, deliveries } from "../chat/relay.ts";
import { readChat, Tail } from "../chat/store.ts";
import { stampOf } from "../clock.ts";
import { ChatError } from "../errors.ts";
import { MOVED_MARKER, readBytes, readText, resolvePath, strerror } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject, type Json, type JsonObject } from "../json.ts";
import { answerRefusal } from "../ledger/answers.ts";
import { renameAgent } from "../ledger/rename.ts";
import { filePathOf, filesRoot } from "../ledger/links.ts";
import { allows } from "../ledger/permission.ts";
import { addsRule } from "../ledger/rule-card.ts";
import { pageHtml, readTemplate } from "../page/render.ts";
import { pick, readLedger } from "../preview/updater.ts";
import { recordPath } from "../preview/record.ts";
import { PreviewError } from "../errors.ts";
import { summary, view, type Lookups } from "../page/view.ts";
import { gateOf } from "../gate.ts";
import { movedTeam, pidOfEntry, type Entry } from "../registry.ts";
import { SpendReader } from "../transcripts.ts";
import { readUsage } from "../usage.ts";
import type { Machine } from "../world.ts";
import type { Probe } from "../host.ts";
import { clear as clearLock, settle as settleLock, statePath as lockPath, type Settled } from "../onepw.ts";
import { deafView, deliver, socksDir, WAKE_MS, wakeNow, wakePass, Wakes, wakesPath, type Send, type Woken } from "../wake.ts";
import { takeoverView } from "../takeover.ts";
import { FILE_POLICY, LINKED_POLICY, servedBody } from "./body-policy.ts";
import { indexHtml } from "./index-page.ts";
import { LinkProbes, ProbeCache } from "./probes.ts";
import { answerAsOffered, expireGrants, grantAnswer, registeredSession, type GrantAnswer, type Registered } from "./grants.ts";
import { allowedOrigin, chatOriginsPath, grantor, grantRefusal, hello, MAX_POST_BYTES, PAGE_TOKEN_META, PAGE_TOKEN_HEADER, parseChatOrigins, postRefusal, STALE_PAGE_TOKEN, STOP_TOKEN_META, stopRefusal, tooBig, viewerOf, writerRefusal, type Viewer } from "./policy.ts";
import { isOriginWide, killSwitch, type Upgrade } from "./preview-proxy.ts";
import { Served } from "./served.ts";
import { HubTokens, tokensPath } from "./tokens.ts";
import { OrphanWatch } from "./orphan-watch.ts";
import { PLUGIN_ROOT, readSkills, repoOf } from "./skills.ts";
import { readTailnet, type Tailnet } from "./tailnet.ts";
import { answersAt, jsonResponse, Logins, Previews, serviceWorkerGuard, type Rooted } from "./previews.ts";

export { jsonResponse, type Rooted } from "./previews.ts";

import * as Option from "effect/Option";

/** How often a stream looks at its files. */
export const POLL_MS = 300;

/** How often the index's streams are sent the fleets. */
export const INDEX_MS = 1000;

/** How often a stream pings an idle client. */
export const PING_MS = 15_000;

/** How long a computed view serves an unchanged state.json before the derived figures are read again. */
const VIEW_TTL_MS = 2000;

/** How long a fleet's list of skills is served before the files are read again. */
const SKILLS_TTL_MS = 60_000;

/** How often the hub reads the tailnet and asks the peer hubs for their fleets. */
const PEERS_MS = 30_000;

/** How often the hub settles what is over of the 1Password lock (a kind cleared by a command, or lapsed): the
 * hook holds and clears without the hub, so this only paces when the held fleets are told. */
export const ONEPW_MS = 5000;

/** How long a peer hub may take to answer. */
const PEER_TIMEOUT_MS = 2500;


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
  /** Whether a link's address answers (tests); else an HTTP probe ({@link answers}). */
  readonly probe?: (url: string) => Promise<boolean>;
  /** How a wake is written to a session's socket (tests); else wake.ts `deliver`. */
  readonly send?: Send;
  /** What is asked of the machine about a session's process before a write (tests); else host.ts `PROBE`. */
  readonly session?: Probe;
  /** Where the hub says what it cannot do for a fleet (a look that failed), one line each; server.ts gives
   * the log of the process. Nothing is said without it. */
  readonly log?: (line: string) => void;
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

/** The manager's page, with its Stop token: never framed, and no handle for a page that opened it. */
const PAGE_ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" } as const;

/** What a file of a fleet's DIR outside `decisions/` is served with: no origin, no script, never sniffed. */
const FILE_HEADERS = { "Content-Security-Policy": FILE_POLICY, "X-Content-Type-Options": "nosniff" } as const;

/** The body of a `grantRefusal` (a grant's or an upload's): `reload: true` with it only for a page that sent a token
 * the hub no longer accepts; one that sent none is not a page the hub served. */
function refusalBody(error: string, req: Request): JsonObject {
  return error === STALE_PAGE_TOKEN && (req.headers.get(PAGE_TOKEN_HEADER) ?? "") !== "" ? { error, reload: true } : { error };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The most a linked file may weigh to be served: over it, 413. */
export const LINKED_FILE_MAX = 50 * 1024 * 1024;

/** The size of `path` when, opened now (non-blocking, so a FIFO cannot hold the hub), it is a regular file;
 * undefined for a FIFO, a device, a directory or a file that cannot be opened. */
function openedFileSize(path: string): number | undefined {
  let fd: number | undefined;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const st = fstatSync(fd);

    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** How long a browser may keep a chat preflight's answer, in seconds. */
const PREFLIGHT_MAX_AGE = 600;

/** The CORS headers on every answer to a chat post from `origin`, a page the hub's config allows. */
function corsHeaders(origin: string) {
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
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
  /** This machine's MagicDNS suffix, read once, at the first read of the tailnet (the hub's start): the only
   * `*.ts.net` names a link reaches this machine by. Null until then, and when Tailscale gave none. */
  private suffix: string | null = null;
  private suffixRead = false;
  private readonly peerHubs = new Map<string, Peer>();
  private readonly served: Served;
  private readonly orphans: OrphanWatch;
  /** The token every fleet's page carries to answer a permission with a grant (`grantRefusal`), and the one the
   * manager's page carries to Stop an orphan (`stopRefusal`): kept in the hub's state dir, so they outlive a restart,
   * and rotated (tokens.ts). Opened once the hub holds its port (`openTokens`), so a hub that lost the port to another
   * never rotates the tokens the other one serves. */
  private held: HubTokens | undefined;
  private readonly probes = new ProbeCache();
  private readonly linkProbes: LinkProbes;
  private readonly spend = new SpendReader();
  private readonly views = new Map<string, Viewed>();
  private readonly skillLists = new Map<string, { readonly body: string; readonly at: number }>();

  private readonly logins: Logins;
  /** Its preview path (`previews.ts`), which `fleet preview serve` serves too. */
  private readonly previews: Previews;
  private timer: ReturnType<typeof setInterval> | undefined;
  private courierTimer: ReturnType<typeof setInterval> | undefined;
  private onepwTimer: ReturnType<typeof setInterval> | undefined;
  private wakeTimer: ReturnType<typeof setInterval> | undefined;
  /** What the hub did to wake each fleet's host (wake.ts), and the look that runs now, if one does. */
  private readonly wakes: Wakes;
  private readonly socks: string;
  private waking: Promise<Woken[]> | undefined;
  /** Why the last look failed as a whole, while it did: said once in the log, not at every look. */
  private lookFault: string | undefined;
  /** The settle of the 1Password lock that runs now, if one does. */
  private settling: Promise<Settled | undefined> | undefined;
  private readonly indexWatchers = new Set<(json: string) => void>();
  private indexTimer: ReturnType<typeof setInterval> | undefined;
  private readonly courier = new Courier();
  private readonly lookups: Lookups;

  constructor(options: HubOptions) {
    this.options = options;
    this.served = new Served(options.machine);
    this.orphans = new OrphanWatch(options.machine);
    this.linkProbes = new LinkProbes(options.machine.now, options.probe);
    this.wakes = new Wakes(options.machine, options.log);
    this.socks = socksDir(options.machine.env);
    this.lookups = {
      up: (urls) => this.probes.up(urls),
      probe: (urls) => this.linkProbes.get(urls),
      tailnet: () => this.suffix,
      discovered: () => this.served.latest(),
      orphans: () => this.orphans.latest(),
      deaf: (entry, heard) => deafView(options.machine, this.wakes, this.socks, entry, heard, options.session),
      blind: (entry) => this.wakes.blindView(entry.dir),
      takeover: (entry, heard) => takeoverView(entry.dir, heard.seen),
      spend: this.spend,
    };
    this.logins = new Logins(options.tailscale);
    this.previews = new Previews({
      machine: options.machine,
      entries: () => this.options.machine.registry.shown(),
      viewer: (req, ip) => this.viewer(req, ip),
      owner: () => this.owner,
      answersAt: (host, port) => this.answersAt(host, port),
      port: options.port,
    });
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
  /** Open the page and Stop tokens (tokens.ts): `startHub` calls it once the hub holds its port, and before that no
   * request reaches the hub, so the first use opens them at the latest. */
  openTokens(): HubTokens {
    this.held ??= HubTokens.open(tokensPath(this.options.machine.registry.place.home), () => this.options.machine.now().getTime(), { log: this.options.log });

    return this.held;
  }

  /** Whether `path` is in the hub's own state dir (`REGISTRY/hub`: its page and Stop tokens, its record, its config),
   * real paths compared: never a fleet's file, even when a fleet's DIR or files root holds the registry. */
  private inHubState(path: string): boolean {
    const state = resolvePath(dirname(tokensPath(this.options.machine.registry.place.home)));
    const real = resolvePath(path);

    return real === state || real.startsWith(`${state}/`);
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), PEERS_MS);
    this.courierTimer = setInterval(() => this.relay(), POLL_MS);
    this.onepwTimer = setInterval(() => void this.settleOnepw(), ONEPW_MS);
    this.wakeTimer = setInterval(() => void this.wakeHosts(), WAKE_MS);
  }

  /** Stop looking. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);

    if (this.courierTimer !== undefined) clearInterval(this.courierTimer);

    if (this.onepwTimer !== undefined) clearInterval(this.onepwTimer);

    if (this.wakeTimer !== undefined) clearInterval(this.wakeTimer);

    if (this.indexTimer !== undefined) clearInterval(this.indexTimer);
    this.indexTimer = undefined;
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

  /** Settle what is over of the 1Password lock (a kind cleared, or lapsed; onepw.ts `settle`): each held fleet
   * is told once, in its chat when its host's watch runs, else in its session through the verified write a wake
   * takes (wake.ts `deliverTo`). Runs every ONEPW_MS, one at a time: a call while one runs gets that one. What it
   * did, or undefined when nothing changed or it failed (the next run tries again): it never throws into the
   * server. */
  async settleOnepw(): Promise<Settled | undefined> {
    this.settling ??= settleLock(this.options.machine, { socks: this.socks, send: this.options.send ?? deliver, probe: this.options.session })
      .catch(() => undefined)
      .finally(() => {
        this.settling = undefined;
      });

    return this.settling;
  }

  /** Wake each served fleet's host that does not listen while the user's messages wait, when it may be woken
   * (wake.ts `mayWake`): one line to its session's socket, recorded. Runs every WAKE_MS and with each message
   * of the user's the hub takes ({@link wakeSoon}), one look at a time. What it wrote or tried. A fleet that
   * cannot be read is that fleet's failed look (wake.ts `Wakes.failed`: logged once, on the page as `blind`),
   * and the others are looked at. A look that fails as a whole (the registry does not read) wrote nothing and
   * is logged when its reason is new; the next run tries again: it never throws into the server. */
  async wakeHosts(): Promise<Woken[]> {
    this.waking ??= wakePass(this.options.machine, this.wakes, this.socks, this.options.send ?? deliver, this.options.session)
      .then((done) => {
        this.lookFault = undefined;

        return done;
      })
      .catch((cause: unknown) => {
        const why = strerror(cause);

        if (why !== this.lookFault) this.options.log?.(`wake: the look at the served fleets failed, and nobody was woken: ${why}`);
        this.lookFault = why;

        return [];
      })
      .finally(() => {
        this.waking = undefined;
      });

    return this.waking;
  }

  /** Read the tailnet again, and ask each online peer for its fleets. */
  async refresh(): Promise<void> {
    this.tailnet = await readTailnet(this.options.tailscale);

    if (!this.suffixRead) {
      this.suffix = this.tailnet?.suffix ?? null;
      this.suffixRead = true;
    }

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

  private viewer(req: Request, ip: string): Promise<Viewer> {
    return viewerOf(ip, (name) => req.headers.get(name), this.owner, (at) => this.logins.login(at), this.tailnet?.self.ip);
  }

  // -- the fleets of this machine --------------------------------------------------------------

  private entries(): Entry[] {
    return this.options.machine.registry.live();
  }

  /** Take back the one-time grants past their 30 minutes (grants.ts `expireGrants`), of every fleet the registry
   * names, served or not: a rule outlives the session it was granted to. What was taken back. */
  expireGrants(): Promise<string[]> {
    const machine = this.options.machine;

    return expireGrants(machine.registry.ledgerDirs(), machine.now(), stampOf(machine.now()), machine.env("HOME"));
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
    // The preview's record changes the view too (the updater writes it), and so do the machine's 1Password
    // lock (the card every page shows) and the wakes the hub wrote: each is part of what is compared.
    const also = [recordPath(root), lockPath(this.options.machine), wakesPath(this.options.machine)].map((path) => readBytes(path) ?? Buffer.alloc(0));
    const bytes = Buffer.concat([state, ...also]);
    const held = this.views.get(root);

    if (held !== undefined && held.bytes.equals(bytes) && performance.now() - held.at < VIEW_TTL_MS) return held;
    const parsed = Option.getOrUndefined(parseObject(state.toString("utf8")));

    if (parsed === undefined) return undefined;
    const me = this.options.machine.registry.find(root);
    // What the fleet is called, for the page's rename; the hub's alone, so the oracle's view has no such key.
    const named = me === undefined ? {} : { named: { id: me.id, session: me.session } };
    const shown = { ...view(this.options.machine, this.lookups, parsed, root), ...named };
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
      gate: gateOf(registry).head(this.options.machine.now()) ?? null,
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

    const guarded = serviceWorkerGuard(req, path);

    if (guarded !== undefined) return guarded;

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

    // A team moved to the cloud is read on its cloud page; a write to it is refused as for any fleet not served.
    // Only a top-level load goes there (the browser keeps its `#decision/<fleet>/<card>`, which the cloud page reads):
    // a fetch or a frame sent there lands on the cloud's login, which the browser blocks (no CORS, frame-ancestors).
    const away = entry === undefined && (req.method === "GET" || req.method === "HEAD") ? this.options.machine.registry.moved(entries).find((e) => e.id === name && e.url !== "") : undefined;

    if (away !== undefined && req.headers.get("Sec-Fetch-Dest") === "document") return new Response(null, { status: 302, headers: { Location: away.url, ...NO_STORE } });

    if (away !== undefined) return jsonResponse(409, { error: `${away.id} has moved to the cloud: its page is ${away.url}, which this hub neither serves nor frames`, moved: true, cloud: away.url });

    if (entry === undefined) return jsonResponse(404, { error: `no fleet '${name}' is being served; the hub's index lists the ones that are` });

    return this.fleetRoute(req, ip, entry, rest, url, keepOpen, upgrade);
  }

  private index(req: Request): Response {
    if (req.method !== "GET" && req.method !== "HEAD") return jsonResponse(405, { error: "the index is read with GET" });

    return new Response(indexHtml(this.indexPayload()), { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
  }

  /** The index as its streams are sent it. */
  private indexJson(): string {
    return dumps(this.indexPayload(), { ensureAscii: false });
  }

  /** Every second, build the index once and hand it to each open index stream: a page each, and the
   * build reads every fleet's files, so N streams must not cost N builds. Runs while a stream is open. */
  private indexTick(): void {
    const json = this.indexJson();

    for (const watcher of this.indexWatchers) watcher(json);
  }

  private indexEvents(req: Request): Response {
    return sseResponse(req.signal, (send) => {
      let last = "";
      let pinged = performance.now();

      const watcher = (json: string): void => {
        if (json !== last) {
          send(sseEvent("fleets", json));
          last = json;
        }

        if (performance.now() - pinged >= PING_MS) {
          send(": ping\n\n");
          pinged = performance.now();
        }
      };

      watcher(this.indexJson());
      this.indexWatchers.add(watcher);
      this.indexTimer ??= setInterval(() => this.indexTick(), INDEX_MS);

      return () => {
        this.indexWatchers.delete(watcher);

        if (this.indexWatchers.size === 0 && this.indexTimer !== undefined) {
          clearInterval(this.indexTimer);
          this.indexTimer = undefined;
        }
      };
    });
  }

  private async fleetRoute(req: Request, ip: string, entry: Entry, rest: string, url: URL, keepOpen: () => void, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const root = entry.dir;
    const params = url.searchParams;

    const preview = this.previews.route(req, ip, entry, rest, url, keepOpen, upgrade);

    if (preview !== undefined) return preview;

    if (rest === "/preview-workers" && req.method === "POST") return this.previewWorkers(req, ip, root);

    if (rest === "/name" && req.method === "POST") return this.rename(req, ip, root);

    if (rest === "/orphans/stop" && req.method === "POST") return this.stopOrphan(req, ip, entry);

    if (rest === "/onepw/unlocked" && req.method === "POST") return this.onepwUnlocked(req, ip);

    if (rest === "/wake" && req.method === "POST") return this.wakeFleet(req, ip, entry);

    if (rest === "/chat" && req.method === "OPTIONS") return this.preflight(req);

    if (rest === "/attachments" && req.method === "POST") return this.attach(req, ip, root);

    if (req.method === "POST") return this.post(req, ip, root, rest);

    if (req.method !== "GET" && req.method !== "HEAD") return jsonResponse(405, { error: "not allowed" });

    if (rest === "/chat") return jsonResponse(200, { messages: readChat(root, afterParam(params)).map((m) => m.stored) });

    if (rest === "/skills") return new Response(req.method === "HEAD" ? null : this.skillsOf(root), { headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE } });

    if (rest === "/events") {
      keepOpen();
      const viewer = await this.viewer(req, ip);

      return this.fleetEvents(req, root, viewer, resumePoint(req.headers.get("Last-Event-ID"), params));
    }

    if (pageRoute(rest)) {
      const page = this.page(root);

      if (page !== undefined && req.headers.get("Sec-Fetch-Dest") === "document") {
        // Only a top-level load of a fleet's page gets the page token (a grant's), and only the manager's the Stop
        // token; such a page can't be framed, and a page that opened it (a preview's, on this same origin) gets no
        // handle on it.
        const stop = entry.role === "manager" ? `<meta name="${STOP_TOKEN_META}" content="${this.openTokens().current("stop")}">` : "";
        const html = page.replace("</head>", `<meta name="${PAGE_TOKEN_META}" content="${this.openTokens().current("page")}">${stop}</head>`);

        return new Response(req.method === "HEAD" ? null : html, { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...PAGE_ISOLATION } });
      }

      if (page !== undefined) return new Response(req.method === "HEAD" ? null : page, { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
    }

    /* The page polls state.json while its stream reconnects: it gets the view the stream sends, never the bare
       ledger (a manager's has no coordinators, so its queue would empty and the decision shown read as answered). */
    if (rest === "/state.json") {
      const shown = this.viewOf(root);

      if (shown !== undefined) return new Response(req.method === "HEAD" ? null : shown.json, { headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE } });
    }

    if (rest.startsWith("/files/")) return this.linkedFile(req, root, rest.slice("/files/".length));

    return this.file(req, root, rest === "/" ? "/index.html" : rest);
  }

  // -- root mode -------------------------------------------------------------------------------

  /** The root-mode previews of this machine's fleets the hub listens for (`Previews.rootedPreviews`). */
  rootedPreviews(): Rooted[] {
    return this.previews.rootedPreviews();
  }

  /** Whether `host` (`host:port`, lower case) names this machine at `port`: loopback, or its tailnet name or address. */
  answersAt(host: string, port: number): boolean {
    return answersAt(this.tailnet, host, port);
  }

  /** Answer one request from `ip` on `slot`'s public port (`Previews.fetchRooted`). */
  fetchRooted(req: Request, ip: string, slot: Rooted, keepOpen: () => void, upgrade?: Upgrade): Promise<Response | undefined> {
    return this.previews.fetchRooted(req, ip, slot, keepOpen, upgrade);
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

  /** `POST /f/<fleet>/name` `{agent, name}` names worker `agent`, `{name}` the fleet, from the page; an empty
   * name gives it back to the name its session gives. Checked as a chat post is. */
  private async rename(req: Request, ip: string, root: string): Promise<Response> {
    const viewer = await this.viewer(req, ip);
    const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name));

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });
    const raw = await req.text();

    if (Buffer.byteLength(raw) > MAX_POST_BYTES) return jsonResponse(413, { error: `a name is at most ${MAX_POST_BYTES / 1024} KiB` });
    const body = Option.getOrUndefined(parseObject(raw));
    const name = asString(body?.["name"]);
    const given = body?.["agent"];
    const agent = asString(given);

    if (name === undefined || (given !== undefined && agent === undefined)) return jsonResponse(400, { error: "send {name} for the fleet, {agent, name} for a worker" });

    if (agent !== undefined) {
      const renamed = renameAgent(this.options.machine, root, agent, name);

      return "why" in renamed ? jsonResponse(400, { error: renamed.why }) : jsonResponse(200, { agent, ...renamed });
    }

    const entry = this.options.machine.registry.rename(root, name);

    if ("why" in entry) return jsonResponse(400, { error: entry.why });

    return jsonResponse(200, { id: entry.id, session: entry.session, path: `/f/${encodeURIComponent(entry.id)}/` });
  }

  /** `POST /f/<fleet>/orphans/stop` `{pid, started}`, on the manager's page only: Luiz's Stop on an orphaned
   * test or dev process. Checked as a chat post is, and more (`stopRefusal`): the hub's own origin, same-origin,
   * and the token the manager's page carries. The tree is stopped only while it is still reported, the same
   * process (its start time), so a pid reused since the page was drawn is never hit: TERM to the tree's own
   * processes, KILL to what is left a few seconds later. Nothing is ever stopped otherwise. */
  private async stopOrphan(req: Request, ip: string, entry: Entry): Promise<Response> {
    const viewer = await this.viewer(req, ip);
    const refusal = stopRefusal(this.owner, viewer, this.hosts, new URL(req.url).host, this.openTokens().accepted("stop"), (name) => req.headers.get(name));

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });

    if (entry.role !== "manager") return jsonResponse(403, { error: "orphaned processes are stopped from the manager's page" });
    const raw = await req.text();

    if (Buffer.byteLength(raw) > MAX_POST_BYTES) return jsonResponse(413, { error: `a stop is at most ${MAX_POST_BYTES / 1024} KiB` });
    const body = Option.getOrUndefined(parseObject(raw));
    const pid = asNumber(body?.["pid"]);
    const started = asNumber(body?.["started"]);

    if (pid === undefined || started === undefined || !Number.isInteger(pid) || pid <= 1) return jsonResponse(400, { error: "send {pid, started} of a row in Orphaned processes" });

    if (!this.orphans.on) return jsonResponse(409, { error: "this hub does not look at the machine's processes (FLEET_DISCOVER=0 or FLEET_ORPHANS=0)" });
    const done = await this.orphans.stop(pid, started);
    this.orphans.look();
    this.views.delete(entry.dir);

    if ("why" in done) return jsonResponse(409, { error: done.why });

    return jsonResponse(200, { stopped: [...done.stopped], left: [...done.left] });
  }

  /** `POST /f/<fleet>/onepw/unlocked` `{}`, on any fleet's page: Luiz's "1Password is unlocked" on the card.
   * Checked as a chat post is. It clears every locked kind as the user and settles at once, after the settle
   * that ran when it came, so each held fleet is told and every page loses the card: 200 `{cleared, told:
   * [{fleet, to, id, via}]}`, `via` `chat` with the notice's `id`, or `session` with `id` null. With nothing
   * locked it changes nothing (`cleared: false`); a hold already over and not yet settled is settled all the
   * same. */
  private async onepwUnlocked(req: Request, ip: string): Promise<Response> {
    const viewer = await this.viewer(req, ip);
    const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name));

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });

    if (Buffer.byteLength(await req.text()) > MAX_POST_BYTES) return jsonResponse(413, { error: `an answer is at most ${MAX_POST_BYTES / 1024} KiB` });

    try {
      const cleared = clearLock(this.options.machine, "user", "answered on the page") !== undefined;
      // A settle that runs now decided before this answer: the one after it tells the fleets.
      await this.settling;
      const settled = await this.settleOnepw();

      return jsonResponse(200, { cleared, told: (settled?.told ?? []).map((t) => ({ fleet: t.fleet, to: t.to, id: t.id ?? null, via: t.via })) });
    } catch (cause: unknown) {
      return jsonResponse(500, { error: `could not record the answer: ${strerror(cause)}` });
    }
  }

  /** Look now for a host to wake: the hub took a message of the user's, and a host that is idle and deaf is
   * woken for it at once, not at the timer's next look. A look that runs now may have passed the message's
   * fleet already, so another follows it. It never throws into the server ({@link wakeHosts}). */
  private wakeSoon(): void {
    const running = this.waking;

    void (running === undefined ? this.wakeHosts() : running.then(() => this.wakeHosts()));
  }

  /** `POST /f/<fleet>/wake` `{}`, or on the manager's page `{"fleet": "<id>"}` for one of its fleets: Luiz's
   * "Wake now" on a host that does not listen. Checked as a chat post is. One wake is written to the session's
   * socket at once, whatever the hub's backoff says (wake.ts `wakeNow`), under its own limits: one a minute, the
   * hour's three with the hub's, none while the last was not read. 200 `{woken: true, fleet, at}`; 409 when
   * there is nothing to wake or the session is not there; 429 `{error, again}` when a limit holds it; 502 when
   * the line could not be written (recorded, and the page says so). */
  private async wakeFleet(req: Request, ip: string, entry: Entry): Promise<Response> {
    const viewer = await this.viewer(req, ip);
    const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name));

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });
    const raw = await req.text();

    if (Buffer.byteLength(raw) > MAX_POST_BYTES) return jsonResponse(413, { error: `a wake is at most ${MAX_POST_BYTES / 1024} KiB` });
    const named = asString(Option.getOrUndefined(parseObject(raw))?.["fleet"]);
    const target = named === undefined || named === entry.id ? entry : entry.role === "manager" ? this.options.machine.registry.live().find((e) => e.id === named) : undefined;

    if (target === undefined) return jsonResponse(404, { error: `no fleet '${named ?? ""}' is served to wake from this page` });

    try {
      const done = await wakeNow(this.options.machine, this.wakes, this.socks, target, this.options.send ?? deliver, this.options.session);

      // Held by its own limits (one a minute, the hour's three, a wake not read yet): 429, with when it may be used.
      if ("why" in done) return jsonResponse(done.held ? 429 : 409, { error: done.why, again: done.again });

      return done.wake.error === null ? jsonResponse(200, { woken: true, fleet: done.fleet, at: done.wake.at }) : jsonResponse(502, { error: `could not wake ${done.fleet}: ${done.wake.error}` });
    } catch (cause: unknown) {
      return jsonResponse(500, { error: `could not wake: ${strerror(cause)}` });
    }
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

    if (!inside(target) || !inside(resolved) || decoded.split("/").some((part) => part.startsWith(".")) || this.inHubState(resolved)) {
      return jsonResponse(404, { error: "not found" });
    }

    const bytes = readBytes(resolved);

    if (bytes === undefined) return jsonResponse(404, { error: "not found" });
    // A script of DIR's is text: nothing a fleet's agents write runs on this origin, as a page's script or a worker.
    // Decided by the type the file would be served with, so every name a script has (.cjs, .jsx, .ts, …) is text.
    const named = Bun.file(resolved).type;
    const type = /javascript|ecmascript/iu.test(named) ? "text/plain; charset=utf-8" : named;
    const content = req.method === "HEAD" ? null : bytes;

    if (resolved.startsWith(`${join(base, "decisions")}/`)) return servedBody(content, type, NO_STORE);

    return new Response(content, { headers: { "Content-Type": type, ...NO_STORE, ...FILE_HEADERS } });
  }

  /** A file a link of the fleet at `root` names (`file://…`), read-only, at `files/<path under its files root>`:
   * only under the fleet's files root (its DIR, or its session's scratchpad or state dir: `filesRoot`), only a
   * file a link names, never a hidden part or a step out (`..`), in the path asked or in the one a symlink leads
   * to (`notes.md -> .env` is not found), never through a symlink that leads out, never the hub's own state dir (its
   * tokens), never a FIFO or a device (checked when it is opened). Anything else is not found; a file over {@link LINKED_FILE_MAX} is 413. It is streamed, so
   * a big file never holds the hub, and sent sandboxed, as a decision's body is: its scripts never run as the hub. */
  private linkedFile(req: Request, root: string, rest: string): Response {
    const missing = jsonResponse(404, { error: "not found" });
    let decoded: string;

    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return missing;
    }

    const parts = decoded.split("/");

    if (decoded.includes("\0") || parts.some((p) => p === "" || p.startsWith("."))) return missing;
    const base = resolvePath(filesRoot(resolvePath(root), this.options.machine.env));
    const target = resolvePath(join(base, ...parts));

    if (!target.startsWith(`${base}/`) || relative(base, target).split(sep).some((p) => p.startsWith(".")) || !isRegularFile(target)) return missing;

    if (this.inHubState(target)) return missing;
    const ledger = Option.getOrUndefined(parseObject(readText(join(root, "state.json")) ?? "")) ?? {};

    const named = (asArray(ledger["links"]) ?? []).some((l) => {
      const path = filePathOf(asString(asObject(l)?.["url"]) ?? "");

      return path !== undefined && resolvePath(path) === target;
    });

    if (!named) return missing;
    const size = openedFileSize(target);

    if (size === undefined) return missing;

    if (size > LINKED_FILE_MAX) {
      return new Response(`This file is ${String(Math.ceil(size / 1024 / 1024))} MB; the hub serves a linked file of at most ${String(LINKED_FILE_MAX / 1024 / 1024)} MB. Open it on the machine.\n`, {
        status: 413,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE },
      });
    }

    const type = /\.(?:md|markdown|txt|log|csv|tsv|jsonl)$/iu.test(target) ? "text/plain; charset=utf-8" : Bun.file(target).type;

    return new Response(req.method === "HEAD" ? null : Bun.file(target), {
      headers: { "Content-Type": type, ...NO_STORE, "Content-Security-Policy": LINKED_POLICY, "X-Content-Type-Options": "nosniff" },
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

  /** The pages the hub's config lets post to a chat from another origin, read now. */
  private chatOrigins(): ReadonlySet<string> {
    return parseChatOrigins(readText(chatOriginsPath(this.options.machine.registry.place.home)));
  }

  /** `OPTIONS /f/<fleet>/chat`: a browser asking whether a page of another origin may post here. One the
   * hub's config lists is told it may, with its cookies; any other is told nothing. */
  private preflight(req: Request): Response {
    const origin = allowedOrigin(this.hosts, this.chatOrigins(), (name) => req.headers.get(name));

    if (origin === undefined) return jsonResponse(403, { error: "cross-origin post refused" });

    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE),
        ...NO_STORE,
      },
    });
  }

  /** `POST /f/<fleet>/attachments`, the image's bytes as the body and its type as `Content-Type`: an image pasted
   * on the fleet's page, stored under its DIR (`storeImage`), answered `{path}` for the message that will carry it.
   * Only the fleet's own page uploads, as only it grants (`grantRefusal`: its origin, same-origin, its page token). */
  private async attach(req: Request, ip: string, root: string): Promise<Response> {
    const header = (name: string): string | null => req.headers.get(name);
    const viewer = await this.viewer(req, ip);
    const denied = writerRefusal(this.owner, viewer);

    if (denied !== undefined) return jsonResponse(403, { error: denied }, { Connection: "close" });
    const notOwn = grantRefusal(this.hosts, new URL(req.url).host, this.openTokens().accepted("page"), header);

    if (notOwn !== undefined) return jsonResponse(notOwn[0], refusalBody(notOwn[1], req), { Connection: "close" });
    const refused = uploadRefusal(header);

    if (refused !== undefined) return jsonResponse(refused[0], { error: refused[1] }, { Connection: "close" });
    const stored = storeImage(root, header("Content-Type"), Buffer.from(await req.arrayBuffer()));

    return "path" in stored ? jsonResponse(201, { path: stored.path }) : jsonResponse(stored.refused[0], { error: stored.refused[1] });
  }

  private async post(req: Request, ip: string, root: string, rest: string): Promise<Response> {
    if (rest !== "/chat" && rest !== "/chat/preview") return jsonResponse(404, { error: "not found" });
    const header = (name: string): string | null => req.headers.get(name);
    // Only the chat's own post opens to the pages the config lists; its preview stays the page's.
    const allowed = rest === "/chat" ? this.chatOrigins() : new Set<string>();
    const origin = allowedOrigin(this.hosts, allowed, header);
    const answer = await this.postFrom(req, ip, root, rest, allowed, origin);

    if (origin !== undefined) for (const [name, value] of Object.entries(corsHeaders(origin))) answer.headers.set(name, value);

    return answer;
  }

  private async postFrom(req: Request, ip: string, root: string, rest: string, allowed: ReadonlySet<string>, origin: string | undefined): Promise<Response> {
    const viewer = await this.viewer(req, ip);
    const refusal = postRefusal(this.owner, viewer, this.hosts, (name) => req.headers.get(name), allowed);

    if (refusal !== undefined) return jsonResponse(refusal[0], { error: refusal[1] }, { Connection: "close" });
    const raw = await req.text();

    if (Buffer.byteLength(raw) > MAX_POST_BYTES) return jsonResponse(413, { error: tooBig(Buffer.byteLength(raw)) });
    const body = raw.trim() === "" ? undefined : Option.getOrUndefined(parseObject(raw));

    if (body === undefined) return jsonResponse(400, { error: "the body is not a JSON object" });

    // A page of another origin sends messages; answering a decision or granting a permission is the fleet's own page's.
    if (origin !== undefined && ["decision", "rule", "rules", "root", "runs", "rule_text"].some((key) => (body[key] ?? null) !== null)) {
      return jsonResponse(403, { error: "a decision is answered on the fleet's own page, not from another origin" });
    }

    // An answer that grants, or adds a rule card's entry, comes only from the fleet's own page: a local process's post
    // is not the user's yes.
    if ((body["decision"] ?? null) !== null && (allows(asString(body["text"]) ?? "") || addsRule(asString(body["text"]) ?? ""))) {
      const refused = grantRefusal(this.hosts, new URL(req.url).host, this.openTokens().accepted("page"), (name) => req.headers.get(name));

      if (refused !== undefined) return jsonResponse(refused[0], refusalBody(refused[1], req));
    }

    return this.chatPost(root, rest, body, viewer, origin);
  }

  private async chatPost(root: string, rest: string, body: JsonObject, viewer: Viewer, origin: string | undefined): Promise<Response> {
    const machine = this.options.machine;
    const given = asString(body["text"]);
    const reGiven = body["re"];
    const hasRe = reGiven !== undefined && reGiven !== null;
    const reNumber = asNumber(reGiven);

    if (given === undefined || (hasRe && (reNumber === undefined || !Number.isInteger(reNumber)))) {
      return jsonResponse(400, { error: "text must be a string and re a message id" });
    }

    const re: number | null = hasRe ? (reNumber ?? null) : null;

    const decisionGiven = body["decision"];
    const decision = decisionGiven === undefined || decisionGiven === null ? undefined : asString(decisionGiven);

    if (decisionGiven !== undefined && decisionGiven !== null && decision === undefined) return jsonResponse(400, { error: "decision must be a decision id" });
    const text = decision === undefined ? given : answerAsOffered(root, decision, given);
    const ruleGiven = body["rule"];
    const rule = ruleGiven === undefined || ruleGiven === null ? undefined : asString(ruleGiven);

    if (ruleGiven !== undefined && ruleGiven !== null && rule === undefined) return jsonResponse(400, { error: "rule must be the rule the page showed" });
    const rulesGiven = body["rules"] ?? null;
    const rules = rulesGiven === null ? undefined : (asArray(rulesGiven) ?? []).flatMap((item) => (asString(item) === undefined ? [] : [asString(item) ?? ""]));

    if (rulesGiven !== null && (asArray(rulesGiven) === undefined || rules?.length !== asArray(rulesGiven)?.length)) {
      return jsonResponse(400, { error: "rules must be the rules the page showed, a list of strings" });
    }

    const runsGiven = body["runs"] ?? null;
    const runs = runsGiven === null ? undefined : (asArray(runsGiven) ?? []).flatMap((item) => (asString(item) === undefined ? [] : [asString(item) ?? ""]));

    if (runsGiven !== null && (asArray(runsGiven) === undefined || runs?.length !== asArray(runsGiven)?.length)) {
      return jsonResponse(400, { error: "runs must be the files the page showed, a list of strings" });
    }

    const shownRoot = (body["root"] ?? null) === null ? undefined : asString(body["root"]);
    const ruleText = (body["rule_text"] ?? null) === null ? undefined : asString(body["rule_text"]);

    if ((body["rule_text"] ?? null) !== null && ruleText === undefined) return jsonResponse(400, { error: "rule_text must be the rule card's entry the page showed" });

    if ((body["root"] ?? null) !== null && shownRoot === undefined) return jsonResponse(400, { error: "root must be the folder the page showed" });

    try {
      const marks = marksAlone({ marks: body["marks"], decision: body["decision"], quote: body["quote"], side: body["side"] }) ?? marksOf(body["marks"]);

      if (marks instanceof ChatError) return jsonResponse(400, { error: marks.reason });

      if (rest === "/chat/preview") {
        const side = sideOf(body["side"]);
        const quote = quoteOf(body["quote"]);

        if (side instanceof ChatError) return jsonResponse(400, { error: side.reason });

        if (quote instanceof ChatError) return jsonResponse(400, { error: quote.reason });
        const asked: Building<Parameters<typeof address>[2]> = { sender: "user", text, re, allowUser: true };

        if (side !== undefined) asked.side = side;

        if (quote !== undefined) asked.quote = quote;

        if (marks !== undefined) asked.marks = marks;
        const resolved = address(machine, root, asked);

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

      const away = movedWrite(root);

      if (away !== undefined) return away;
      const quote = quoteOf(body["quote"]);
      const side = sideOf(body["side"]);

      if (quote instanceof ChatError) return jsonResponse(400, { error: quote.reason });

      if (side instanceof ChatError) return jsonResponse(400, { error: side.reason });

      // On the manager's page, a message to live coordinators goes into their own chats too (an answer to
      // one of the manager's decisions stays the manager's).
      const delivering = (sent: string, re: number | null): Draft["alongside"] =>
        hostOf(root) !== "manager"
          ? undefined
          : (stored, known) => {
              const delivered = deliveries(machine, root, known, (asArray(stored["to"]) ?? []).flatMap((t) => asString(t) ?? []), {
                id: asNumber(stored["id"]) ?? 0,
                at: asString(stored["at"]) ?? "",
                text: sent,
                re,
                side: stored["side"],
                author: asString(stored["author"]),
                quote: stored["quote"],
                marks: stored["marks"],
                images: stored["images"],
                origin: asString(stored["origin"]),
              });

              return delivered.length === 0 ? undefined : { delivered: delivered.map((d) => ({ fleet: d.fleet, id: d.id })) };
            };

      // The decision's pending marks ride along with its answer: checked before anything is granted or stored.
      const riding = rideAlong(machine, root, body["batch"], decision, viewer, origin, delivering);

      if (riding instanceof ChatError) return jsonResponse(400, { error: riding.reason });
      const draft: Building<Draft> = { sender: "user", text, re, allowUser: true };

      if (viewer.login !== undefined) draft.author = viewer.login;

      if (decision !== undefined) draft.decision = decision;

      if (quote !== undefined) draft.quote = quote;

      if (marks !== undefined) draft.marks = marks;

      if (side !== undefined) draft.side = side;

      if (body["opens"] !== undefined) draft.opens = body["opens"];

      if (origin !== undefined) draft.origin = origin;

      const images = body["images"] ?? null;

      if (images !== null) draft.images = images;
      const alongside = decision === undefined ? delivering(text, re) : undefined;

      if (alongside !== undefined) draft.alongside = alongside;
      const prepared = prepare(machine, root, draft);

      if (prepared instanceof ChatError) return jsonResponse(400, { error: prepared.reason });
      const writing = riding === undefined ? [prepared] : [riding, prepared];
      const reachesMoved = hostOf(root) === "manager" ? movedRecipient(machine, root, writing) : undefined;

      if (reachesMoved !== undefined) return reachesMoved;
      const refused = storeRefusal(root, writing, stampOf(machine.now()));

      if (refused !== undefined) return jsonResponse(400, { error: refused.reason });
      let granted: GrantAnswer = { granted: undefined };

      if (decision !== undefined) {
        const registered = (): Registered | undefined => {
          const entry = machine.registry.find(root);

          return registeredSession(entry === undefined ? undefined : pidOfEntry(entry));
        };

        granted = await grantAnswer({ dir: root, decision, text, rule, rules, root: shownRoot, runs, by: grantor(viewer), at: stampOf(machine.now()), registered, home: machine.env("HOME"), ruleText });

        if ("refused" in granted) return jsonResponse(409, { error: granted.refused });
      }

      // The batch first, then the answer, in one write: one wake of the fleet's watch reads both.
      const written = appendAll(root, writing, stampOf(machine.now()));

      if (written instanceof ChatError) return jsonResponse(400, { error: written.reason });
      const message = written.at(-1);

      if (message === undefined) return jsonResponse(500, { error: "could not store the message: nothing was written" });
      // The message is in the chat, and in each coordinator's it was delivered to: a host of theirs that has
      // no watch running is woken now.
      this.wakeSoon();
      const batch = riding === undefined ? {} : { batch: written[0]?.stored ?? null };

      const note = "granted" in granted ? granted.granted : undefined;

      return jsonResponse(201, note === undefined ? { ...message.stored, ...batch } : { ...message.stored, grant: note, ...batch });
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

    for (const name of ["Accept", "Content-Type", "Last-Event-ID", "Service-Worker"]) {
      const value = req.headers.get(name);

      if (value !== null) headers.set(name, value);
    }

    if (rest === "/events") keepOpen();

    try {
      const init: RequestInit = { method: req.method, headers, redirect: "manual", signal: req.signal };

      if (body !== undefined) init.body = body;
      const upstream = await fetch(`http://${hostPart(peer.ip)}:${this.options.port}/f/${encodeURIComponent(fleet)}${rest}${search}`, init);

      // A worker's script the peer sends with `Service-Worker-Allowed` (a peer from before 1.9.61 passes a preview's
      // through; a newer one sends its own kill switch with it) is this hub's kill switch, allowed over the whole origin
      // as `proxyHttp`'s is, so a worker registered over it from a peer's preview ends at its update check. A peer's body
      // never comes with that header: the wide scope gives the peer nothing.
      if (req.headers.get("Service-Worker") === "script" && upstream.headers.has("Service-Worker-Allowed")) {
        await upstream.body?.cancel();

        return killSwitch(req, { "Service-Worker-Allowed": "/" });
      }

      const passed = new Headers();

      upstream.headers.forEach((value, key) => {
        if (!["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "date", "server"].includes(key.toLowerCase()) && !isOriginWide(key)) passed.set(key, value);
      });

      // A peer's file comes to this hub's origin: one the peer sent with no sandbox (a hub from before it had one) gets this hub's.
      if (!/(?:^|;)\s*sandbox\b/iu.test(passed.get("Content-Security-Policy") ?? "") && !pageRoute(rest) && !rest.startsWith("/preview/")) {
        for (const [name, value] of Object.entries(FILE_HEADERS)) passed.set(name, value);
      }

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

/** Whether `rest` (of `/f/<fleet>/rest`) is the fleet's page, which the hub renders and serves with its origin. */
function pageRoute(rest: string): boolean {
  return rest === "/" || rest === "/index.html";
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

/**
 * The batch an answer to `decision` carries (`batch: {text, marks, side?}`), checked and addressed as the user's batch
 * post would be, its marks on that same decision: undefined when there is none, refused when it is anything
 * else or rides with no answer.
 */
function rideAlong(
  machine: Machine,
  root: string,
  given: Json | undefined,
  decision: string | undefined,
  viewer: Viewer,
  origin: string | undefined,
  delivering: (text: string, re: number | null) => Draft["alongside"],
): Prepared | undefined | ChatError {
  if (given === undefined || given === null) return undefined;

  if (decision === undefined) return new ChatError({ reason: "a batch rides along with an answer to its decision only" });
  const batch = asObject(given);
  const text = asString(batch?.["text"]);
  const marks = marksOf(batch?.["marks"]);

  if (batch === undefined || text === undefined || batch["marks"] === undefined || batch["marks"] === null) return new ChatError({ reason: "batch is {text, marks}: the decision's pending marks" });

  if (marks instanceof ChatError) return marks;
  const on = asString(asObject(marks?.["decision"])?.["id"]);

  if (on === undefined || !decisionNamed(root, decision, on)) return new ChatError({ reason: `the batch's marks are on decision ${on ?? "?"}, not on ${decision}, the one answered` });
  // The answered decision is this page's own, so the batch's place is its own address, never another fleet's.
  const own = "#decision/" + on.split("/").map(encodeURIComponent).join("/");
  const placed = asString(asObject(marks?.["at"])?.["hash"]);

  if (placed !== own) return new ChatError({ reason: `the batch's place ${placed ?? "?"} is not the answered decision's own, ${own}` });
  const side = sideOf(batch["side"]);

  if (side instanceof ChatError) return side;
  const draft: Building<Draft> = { sender: "user", text, re: null, allowUser: true };

  if (marks !== undefined) draft.marks = marks;

  if (side !== undefined) draft.side = side;

  if (viewer.login !== undefined) draft.author = viewer.login;

  if (origin !== undefined) draft.origin = origin;
  const alongside = delivering(text, null);

  if (alongside !== undefined) draft.alongside = alongside;
  const prepared = prepare(machine, root, draft);
  const owner = ownerOfBatch(machine, root, marks);

  if (!(prepared instanceof ChatError) && marks?.["to"] !== undefined && prepared.resolved.to[0] !== owner) {
    return new ChatError({ reason: `the batch that rides along with an answer is the decision owner's (${owner})` });
  }

  return prepared;
}

/** The refusal of a write into the chat of the team at `dir` when it moved to the cloud: its host service owns that
 * chat.jsonl and rewrites it from the cloud, dropping a line the hub wrote there, so the user answers on its cloud page. */
function movedWrite(dir: string): Response | undefined {
  const team = movedTeam(dir);

  if (team === undefined) return undefined;
  const where = team.url === "" ? `its cloud page (${join(team.dir, MOVED_MARKER)} names none)` : `its cloud page, ${team.url}`;
  const error = `${team.id} has moved to the cloud: its host service rewrites ${join(team.dir, "chat.jsonl")} from the cloud and drops what the hub writes there, so nothing was written. Answer on ${where}.`;

  return jsonResponse(409, { error, cloud: team.url });
}

/** The refusal of a message on the manager's page that would be delivered into a moved team's chat ({@link movedWrite}). */
function movedRecipient(machine: Machine, managerRoot: string, writing: readonly Prepared[]): Response | undefined {
  const named = new Set(writing.flatMap((p) => p.resolved.to));

  for (const entry of coordinators(machine, managerRoot)) {
    const away = named.has(entry.id) ? movedWrite(entry.dir) : undefined;

    if (away !== undefined) return away;
  }

  return undefined;
}

/** Whether `given` (an id or a ref, as an answer names its decision) names the decision whose id is `id`. */
function decisionNamed(root: string, given: string, id: string): boolean {
  if (given === id) return true;

  return (asArray(stateOfDir(root)["decisions"]) ?? []).some((row) => {
    const d = asObject(row);

    return d?.["id"] === id && asString(d["ref"]) === given;
  });
}
