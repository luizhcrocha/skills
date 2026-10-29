/**
 * `fleet preview serve`: the workers' previews without the hub. It serves only the preview path
 * (`previews.ts`): `/f/<fleet>/preview/…` on the hub's port, on loopback and this machine's tailnet address
 * (never another interface), `tailscale serve` https in front as the hub has it, and each root-mode preview at
 * the root of its own TLS port (`preview-ports.ts`). Same URLs and ports as the hub had, so a link given while
 * the hub ran keeps working, and the keeper's `.seen` stamp is written the same way. No page, ledger or chat.
 * A port it cannot bind is tried again every tick.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { makePrivateDir, readText, remove, writeAtomic } from "../files.ts";
import { asNumber, asObject, dumps, parseObject } from "../json.ts";
import { alive, type Entry } from "../registry.ts";
import type { Machine } from "../world.ts";
import { viewerOf } from "./policy.ts";
import { PreviewPorts } from "./preview-ports.ts";
import { previewSockets, type SocketData, type Upgrade } from "./preview-proxy.ts";
import { servePreviewPort } from "./preview-serve.ts";
import { PreviewCertificate, tailscaleCertificate, type CertificateSource } from "./preview-tls.ts";
import { FUNNEL_PORT, PublicShares } from "./preview-share.ts";
import { answersAt, jsonResponse, Logins, Previews, serviceWorkerGuard } from "./previews.ts";
import { readTailnet, tailscale, type Tailnet } from "./tailnet.ts";

/** The port the previews are served on unless told otherwise: the one the hub had, so its links keep working. */
export const DEFAULT_PORT = 7420;

/** Where a running preview server says where it is. */
export function previewServerPath(home: string): string {
  return join(home, "hub", "preview-server.json");
}

/** The live pid another process wrote at `path`, if any. */
function pidAt(path: string): number | undefined {
  const pid = asNumber(asObject(Option.getOrUndefined(parseObject(readText(path) ?? "")))?.["pid"]);

  return pid !== undefined && pid !== process.pid && alive(pid) ? pid : undefined;
}

/** The pid of the preview server that runs on this machine, if one does. */
export function runningPreviewServer(home: string): number | undefined {
  return pidAt(previewServerPath(home));
}

export interface PreviewServerOptions {
  /** The hub's port: the preview path is served at the same address. */
  readonly port: number;
  readonly machine: Machine;
  /** The tailscale binary. */
  readonly tailscale: string;
  /** The https port `tailscale serve` exposes it on, as the hub's `--https`. */
  readonly https: number | undefined;
  /** Where the root-mode ports' certificate comes from; `tailscale cert` unless told otherwise. */
  readonly certificate?: CertificateSource;
  /** The loopback port of the public side, for shared previews (`preview-share.ts`, behind Tailscale Funnel); none when undefined. */
  readonly sharePort?: number;
  /** How often it binds what it could not yet, and syncs the root-mode ports (ms). */
  readonly tickMs?: number;
}

/** A running preview server. */
export interface PreviewServing {
  /** Whether it holds the ports now. */
  readonly holding: () => boolean;
  readonly stop: () => Promise<void>;
}

type Server = Bun.Server<SocketData>;

/** The preview server's answer to a request on its port: the preview path, nothing else. */
class PreviewServer {
  tailnet: Tailnet | undefined;
  private readonly logins: Logins;
  private readonly hosts = new Set<string>();
  readonly previews: Previews;
  private readonly options: PreviewServerOptions;

  constructor(options: PreviewServerOptions) {
    this.options = options;
    this.logins = new Logins(options.tailscale);
    const entries = (): readonly Entry[] => options.machine.registry.shown();
    this.previews = new Previews({
      machine: options.machine,
      entries,
      viewer: (req, ip) => viewerOf(ip, (name) => req.headers.get(name), this.tailnet?.login, (at) => this.logins.login(at), this.tailnet?.self.ip),
      owner: () => this.tailnet?.login,
      answersAt: (host, at) => answersAt(this.tailnet, host, at),
      port: options.port,
    });
  }

  answerTo(host: string): void {
    this.hosts.add(host.toLowerCase());
  }

  async fetch(req: Request, ip: string, keepOpen: () => void, upgrade: Upgrade): Promise<Response | undefined> {
    const host = (req.headers.get("Host") ?? "").toLowerCase();

    if (!this.hosts.has(host) && !answersAt(this.tailnet, host, this.options.port)) return jsonResponse(421, { error: "unknown host" }, { Connection: "close" });
    const url = new URL(req.url);
    const guarded = serviceWorkerGuard(req, url.pathname);

    if (guarded !== undefined) return guarded;
    const m = /^\/f\/([^/]+)(\/.*)$/.exec(url.pathname);
    let name: string | undefined;

    try {
      name = m === null ? undefined : decodeURIComponent(m[1] ?? "");
    } catch {
      name = undefined;
    }

    const notHere = jsonResponse(404, { error: "the preview server serves only /f/<fleet>/preview/; the pages are the cloud's" });

    if (name === undefined || m === null) return notHere;
    const entries = this.options.machine.registry.shown();
    const entry = entries.find((e) => e.id === name) ?? entries.find((e) => e.aliases.includes(name));

    if (entry === undefined) return jsonResponse(404, { error: `no fleet '${name}' has a preview here` });
    const rest = m[2] ?? "/";

    if (entry.id !== name && (rest === "/preview" || rest.startsWith("/preview/"))) {
      return new Response(null, { status: 301, headers: { Location: `/f/${encodeURIComponent(entry.id)}${rest}${url.search}`, "Cache-Control": "no-store" } });
    }

    return (await this.previews.route(req, ip, entry, rest, url, keepOpen, upgrade)) ?? notHere;
  }
}

/** Start the preview server: it binds at once, and again each tick for what it could not bind. */
export async function startPreviewServer(options: PreviewServerOptions, log: (line: string) => void): Promise<PreviewServing | Error> {
  const home = options.machine.registry.place.home;
  const server = new PreviewServer(options);
  server.tailnet = await readTailnet(options.tailscale);
  const port = options.port;

  const listen = (hostname: string): Server =>
    Bun.serve<SocketData>({
      hostname,
      port,
      idleTimeout: 60,
      websocket: previewSockets,
      fetch: (req, srv) =>
        server.fetch(
          req,
          srv.requestIP(req)?.address ?? "",
          () => srv.timeout(req, 0),
          (data, headers) => srv.upgrade(req, { data, headers }),
        ),
      error: (cause: Error) => jsonResponse(500, { error: cause.message }),
    });

  const certificate = new PreviewCertificate({ source: options.certificate ?? tailscaleCertificate(options.tailscale), name: () => server.tailnet?.self.dns, now: () => Date.now(), log });
  await certificate.check();
  const recertify = setInterval(() => void certificate.check(), 60_000);

  /** What it holds. */
  let held: { readonly servers: Map<string, Server>; readonly rooted: PreviewPorts; https: boolean } | undefined;
  let refused = "";

  const bind = (hostname: string): boolean => {
    if (held === undefined || held.servers.has(hostname)) return true;

    try {
      held.servers.set(hostname, listen(hostname));
      log(`listening on ${hostname}:${port}`);

      return true;
    } catch (cause: unknown) {
      const why = `cannot listen on ${hostname}:${port}: ${cause instanceof Error ? cause.message : String(cause)}`;

      if (why !== refused) log(why);
      refused = why;

      return false;
    }
  };

  // `tailscale serve` off first, while it still holds the port.
  const release = async (): Promise<void> => {
    if (held === undefined) return;
    const was = held;
    held = undefined;

    if (was.https && options.https !== undefined) await tailscale(options.tailscale, ["serve", `--https=${options.https}`, "off"]);
    was.rooted.stop();
    await Promise.all([...was.servers.values()].map((s) => s.stop(true)));
    log("let go of the preview ports");
  };

  const take = async (): Promise<void> => {
    if (held === undefined) {
      const rooted = new PreviewPorts({
        wanted: () => server.previews.rootedPreviews(),
        tailnetIp: () => server.tailnet?.self.ip,
        certificate: () => certificate.current(),
        listen: (hostname, at, slot, tls) => servePreviewPort(hostname, at, tls, (req, ip, upgrade) => server.previews.fetchRooted(req, ip, slot, () => {}, upgrade)),
        home,
        log,
      });

      held = { servers: new Map(), rooted, https: false };

      if (!bind("127.0.0.1")) {
        held = undefined;

        return;
      }

      refused = "";
      const self = server.tailnet?.self;

      if (options.https !== undefined && self !== undefined) {
        const served = await tailscale(options.tailscale, ["serve", "--bg", `--https=${options.https}`, `http://127.0.0.1:${port}`]);

        if (served === undefined) log(`tailscale serve refused https on port ${options.https}`);
        else if (held !== undefined) {
          held.https = true;
          server.answerTo(`${self.dns}:${options.https}`);
        }
      }

      log(`serving the previews at ${self === undefined || options.https === undefined ? `http://127.0.0.1:${port}` : `https://${self.dns}:${options.https}`}/f/<fleet>/preview/`);
    }

    const ip = server.tailnet?.self.ip;

    if (ip !== undefined) bind(ip);

    try {
      held?.rooted.sync();
    } catch (cause: unknown) {
      log(`the root-mode previews' ports: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;

    try {
      await take();
    } finally {
      busy = false;
    }
  };

  makePrivateDir(join(home, "hub"));
  writeAtomic(previewServerPath(home), `${dumps({ pid: process.pid, port, https: options.https ?? null }, { indent: 2 })}\n`);
  await tick();
  // The public side is apart from the private one: its own port, on loopback only (Funnel forwards to it), and it
  // answers only a share's link and its signed-in browsers.
  const shares = new PublicShares({ home, now: () => Date.now(), log, host: () => (server.tailnet === undefined ? undefined : `${server.tailnet.self.dns}:${String(FUNNEL_PORT)}`) });
  let publicSide: Server | undefined;

  try {
    publicSide =
      options.sharePort === undefined
        ? undefined
        : Bun.serve<SocketData>({
            hostname: "127.0.0.1",
            port: options.sharePort,
            idleTimeout: 60,
            websocket: previewSockets,
            fetch: (req, srv) => shares.fetch(req, (data, headers) => srv.upgrade(req, { data, headers })),
            error: () => new Response("error\n", { status: 500 }),
          });
  } catch (cause: unknown) {
    log(`no shared previews: cannot listen on 127.0.0.1:${String(options.sharePort)}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const ticking = setInterval(() => void tick(), options.tickMs ?? 1000);

  const reread = setInterval(() => {
    void readTailnet(options.tailscale).then((t) => {
      if (t !== undefined) server.tailnet = t;
    });
  }, 30_000);

  return {
    holding: () => held !== undefined,
    stop: async () => {
      clearInterval(ticking);
      clearInterval(reread);
      clearInterval(recertify);
      await release();
      void publicSide?.stop(true);

      if (asNumber(asObject(Option.getOrUndefined(parseObject(readText(previewServerPath(home)) ?? "")))?.["pid"]) === process.pid) remove(previewServerPath(home));
    },
  };
}
