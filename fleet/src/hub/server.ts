/**
 * The hub as a running server: Bun.serve on loopback and on this machine's Tailscale address (never on
 * any other interface), the same port on both. Tailscale down at start is not fatal: the hub serves on
 * loopback and binds the tailnet address once it comes up. With `https`, `tailscale serve` also exposes
 * it at https://<this machine>:<https>/ (Tailscale's certificate; the browser's alerts need a secure page).
 * `REGISTRY/hub/hub.json` says where it runs, for `fleet serve`. It also listens on the public port of each
 * root-mode preview, in the same two places (`preview-ports.ts`).
 */
import { join } from "node:path";

import { stampOf } from "../clock.ts";
import { makeDirs, readText, remove, writeAtomic } from "../files.ts";
import { asNumber, asObject, asString, dumps, parseObject } from "../json.ts";
import { commandOf } from "../procs.ts";
import { alive } from "../registry.ts";
import { Hub, type HubOptions, type Rooted } from "./hub.ts";
import { PreviewPorts } from "./preview-ports.ts";
import { previewSockets, type SocketData, type Upgrade } from "./preview-proxy.ts";
import { tailscale } from "./tailnet.ts";

import * as Option from "effect/Option";

export { previewPortsPath, readPortStates, type PortState } from "./preview-ports.ts";

/** How often the hub looks for root-mode previews to listen for, or to let go of. */
const PREVIEW_PORTS_MS = 1000;

/** The hub's port unless told otherwise. */
export const DEFAULT_PORT = 7420;

/** Where a running hub says where it is. */
export function hubRecordPath(home: string): string {
  return join(home, "hub", "hub.json");
}

/** A hub's record: where it runs, and whether a supervisor (systemd, launchd) started it. */
export interface HubRecord {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly supervised: boolean;
}

/** What a running hub recorded: its pid, port and address, or undefined when none runs. */
export function runningHub(home: string): HubRecord | undefined {
  const record = asObject(Option.getOrUndefined(parseObject(readText(hubRecordPath(home)) ?? "")));
  const pid = asNumber(record?.["pid"]);
  const port = asNumber(record?.["port"]);
  const url = asString(record?.["url"]);

  if (pid === undefined || port === undefined || url === undefined || !alive(pid)) return undefined;

  return { pid, port, url, supervised: record?.["supervised"] === true };
}

/** Whether `pid` runs the fleet's hub: its command line is `… main.ts hub …` or `… fleet hub …`. */
export function isHubProcess(pid: number): boolean {
  return /(?:main\.ts|fleet)\s+hub(?:\s|$)/.test(commandOf(pid));
}

/** A running hub. */
export interface Running {
  readonly hub: Hub;
  /** The address to give the user. */
  readonly url: string;
  /** Stop serving, take the https address back, forget the record. */
  readonly stop: () => Promise<void>;
  /** Listen for the root-mode previews the records name now, and let go of the others (it runs every second). */
  readonly syncPreviews: () => void;
}

type Server = Bun.Server<SocketData>;

/** What the hub starts with: its options, and the https port `tailscale serve` exposes it on, if any. */
export interface StartOptions extends HubOptions {
  readonly https: number | undefined;
  /** Started by systemd or launchd: it takes the port over from a hub started by hand. */
  readonly supervised?: boolean;
}

/** Start the hub; why not when loopback's port is taken. */
export async function startHub(options: StartOptions, log: (line: string) => void): Promise<Running | Error> {
  const hub = new Hub(options);
  await hub.start();
  const port = options.port;

  const serve = (hostname: string, at: number, answer: (req: Request, ip: string, keepOpen: () => void, upgrade: Upgrade) => Promise<Response | undefined>): Server =>
    Bun.serve<SocketData>({
      hostname,
      port: at,
      idleTimeout: 60,
      websocket: previewSockets,
      fetch: (req, server) =>
        answer(
          req,
          server.requestIP(req)?.address ?? "",
          () => server.timeout(req, 0),
          (data, headers) => server.upgrade(req, { data, headers }),
        ),
      error: (cause) => new Response(dumps({ error: cause.message }), { status: 500, headers: { "Content-Type": "application/json" } }),
    });

  const listen = (hostname: string): Server => serve(hostname, port, (req, ip, keepOpen, upgrade) => hub.fetch(req, ip, keepOpen, upgrade));

  const listenRooted = (hostname: string, at: number, slot: Rooted): Server =>
    serve(hostname, at, (req, ip, keepOpen, upgrade) => hub.fetchRooted(req, ip, slot, keepOpen, upgrade));

  const servers: Server[] = [];
  const home = options.machine.registry.place.home;
  const bound = await bindLoopback(listen, home, options.supervised === true, log);

  if (bound instanceof Error) {
    hub.stop();

    return new Error(`cannot listen on 127.0.0.1:${port}: ${bound.message}`);
  }

  servers.push(bound);

  let tailnetBound: string | undefined;

  const bindTailnet = (): void => {
    const ip = hub.net?.self.ip;

    if (ip === undefined || ip === tailnetBound) return;

    try {
      servers.push(listen(ip));
      tailnetBound = ip;
      log(`listening on ${ip}:${port}`);
    } catch (cause: unknown) {
      log(`cannot listen on ${ip}:${port} yet: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  bindTailnet();
  const rebind = setInterval(bindTailnet, 30_000);
  const previews = new PreviewPorts({ wanted: () => hub.rootedPreviews(), tailnetIp: () => hub.net?.self.ip, listen: listenRooted, home, log });

  const syncPreviews = (): void => {
    try {
      previews.sync();
    } catch (cause: unknown) {
      log(`the root-mode previews' ports: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  syncPreviews();
  const repreview = setInterval(syncPreviews, PREVIEW_PORTS_MS);
  const self = hub.net?.self;
  let url = self === undefined ? `http://127.0.0.1:${port}/` : `http://${self.dns}:${port}/`;
  const https = options.https;

  if (https !== undefined && self !== undefined) {
    const served = await tailscale(options.tailscale, ["serve", "--bg", `--https=${https}`, `http://127.0.0.1:${port}`]);

    if (served === undefined) log(`tailscale serve refused https on port ${https}; the hub stays on http`);
    else {
      hub.answerTo(`${self.dns}:${https}`);
      url = `https://${self.dns}:${https}/`;
    }
  }

  makeDirs(join(home, "hub"));
  writeAtomic(
    hubRecordPath(home),
    `${dumps({ pid: process.pid, port, url, https: https ?? null, supervised: options.supervised === true, since: stampOf(options.machine.now()) }, { indent: 2 })}\n`,
  );
  log(`serving ${url} (127.0.0.1:${port}${tailnetBound === undefined ? "" : `, ${tailnetBound}:${port}`})`);

  return {
    hub,
    url,
    syncPreviews,
    stop: async () => {
      clearInterval(rebind);
      clearInterval(repreview);
      previews.stop();
      hub.stop();

      for (const server of servers) void server.stop(true);

      if (https !== undefined && url.startsWith("https:")) await tailscale(options.tailscale, ["serve", `--https=${https}`, "off"]);

      if (asNumber(asObject(Option.getOrUndefined(parseObject(readText(hubRecordPath(home)) ?? "")))?.["pid"]) === process.pid) remove(hubRecordPath(home));
    },
  };
}

/**
 * Listen on loopback. A supervised hub that finds the port held by a hub started by hand (a session ran
 * `fleet hub` while the service was down) stops that one and takes the port, instead of failing every few
 * seconds while the hand-started one keeps it. Anything else on the port stays the caller's error.
 */
async function bindLoopback(listen: (hostname: string) => Server, home: string, supervised: boolean, log: (line: string) => void): Promise<Server | Error> {
  const attempt = (): Server | Error => {
    try {
      return listen("127.0.0.1");
    } catch (cause: unknown) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  };

  const first = attempt();

  if (!(first instanceof Error) || !supervised) return first;
  const other = runningHub(home);

  if (other === undefined || other.supervised || other.pid === process.pid || !isHubProcess(other.pid)) return first;
  process.kill(other.pid, "SIGTERM");

  for (let waited = 0; waited < 5_000; waited += 200) {
    await Bun.sleep(200);
    const next = attempt();

    if (!(next instanceof Error)) {
      log(`took over from a hub started by hand (pid ${String(other.pid)})`);

      return next;
    }
  }

  return first;
}
