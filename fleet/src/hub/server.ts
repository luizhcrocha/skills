/**
 * The hub as a running server: Bun.serve on loopback and on this machine's Tailscale address (never on
 * any other interface), the same port on both. Tailscale down at start is not fatal: the hub serves on
 * loopback and binds the tailnet address once it comes up. With `https`, `tailscale serve` also exposes
 * it at https://<this machine>:<https>/ (Tailscale's certificate; the browser's alerts need a secure page).
 * `REGISTRY/hub/hub.json` says where it runs, for `fleet serve`.
 */
import { join } from "node:path";

import { stampOf } from "../clock.ts";
import { makeDirs, readText, remove, writeAtomic } from "../files.ts";
import { asNumber, asObject, asString, dumps, parseObject } from "../json.ts";
import { alive } from "../registry.ts";
import { Hub, type HubOptions } from "./hub.ts";
import { previewSockets, type SocketData } from "./preview-proxy.ts";
import { tailscale } from "./tailnet.ts";

import * as Option from "effect/Option";

/** The hub's port unless told otherwise. */
export const DEFAULT_PORT = 7420;

/** Where a running hub says where it is. */
export function hubRecordPath(home: string): string {
  return join(home, "hub", "hub.json");
}

/** What a running hub recorded: its pid, port and address, or undefined when none runs. */
export function runningHub(home: string): { readonly pid: number; readonly port: number; readonly url: string } | undefined {
  const record = asObject(Option.getOrUndefined(parseObject(readText(hubRecordPath(home)) ?? "")));
  const pid = asNumber(record?.["pid"]);
  const port = asNumber(record?.["port"]);
  const url = asString(record?.["url"]);

  if (pid === undefined || port === undefined || url === undefined || !alive(pid)) return undefined;

  return { pid, port, url };
}

/** A running hub. */
export interface Running {
  readonly hub: Hub;
  /** The address to give the user. */
  readonly url: string;
  /** Stop serving, take the https address back, forget the record. */
  readonly stop: () => Promise<void>;
}

type Server = Bun.Server<SocketData>;

/** What the hub starts with: its options, and the https port `tailscale serve` exposes it on, if any. */
export interface StartOptions extends HubOptions {
  readonly https: number | undefined;
}

/** Start the hub; why not when loopback's port is taken. */
export async function startHub(options: StartOptions, log: (line: string) => void): Promise<Running | Error> {
  const hub = new Hub(options);
  await hub.start();
  const port = options.port;

  const listen = (hostname: string): Server =>
    Bun.serve<SocketData>({
      hostname,
      port,
      idleTimeout: 60,
      websocket: previewSockets,
      fetch: (req, server) =>
        hub.fetch(
          req,
          server.requestIP(req)?.address ?? "",
          () => server.timeout(req, 0),
          (data, headers) => server.upgrade(req, { data, headers }),
        ),
      error: (cause) => new Response(dumps({ error: cause.message }), { status: 500, headers: { "Content-Type": "application/json" } }),
    });

  const servers: Server[] = [];

  try {
    servers.push(listen("127.0.0.1"));
  } catch (cause: unknown) {
    hub.stop();

    return new Error(`cannot listen on 127.0.0.1:${port}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

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

  const home = options.machine.registry.place.home;
  makeDirs(join(home, "hub"));
  writeAtomic(hubRecordPath(home), `${dumps({ pid: process.pid, port, url, https: https ?? null, since: stampOf(options.machine.now()) }, { indent: 2 })}\n`);
  log(`serving ${url} (127.0.0.1:${port}${tailnetBound === undefined ? "" : `, ${tailnetBound}:${port}`})`);

  return {
    hub,
    url,
    stop: async () => {
      clearInterval(rebind);
      hub.stop();

      for (const server of servers) void server.stop(true);

      if (https !== undefined && url.startsWith("https:")) await tailscale(options.tailscale, ["serve", `--https=${https}`, "off"]);

      if (asNumber(asObject(Option.getOrUndefined(parseObject(readText(hubRecordPath(home)) ?? "")))?.["pid"]) === process.pid) remove(hubRecordPath(home));
    },
  };
}
