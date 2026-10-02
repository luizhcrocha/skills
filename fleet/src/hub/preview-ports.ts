/**
 * The hub's listeners for root-mode previews: for each preview whose record names a public port and whose
 * dev server was started (its pid recorded), the hub serves that port over TLS on loopback and on this
 * machine's tailnet address, the two places it listens on its own port, never on any other interface, and
 * passes every path there to the dev server at its root (`Hub.fetchRooted`). The dev server itself stays on
 * loopback: only the hub faces the tailnet.
 *
 * The certificate is this machine's from Tailscale (`preview-tls.ts`), so the address is
 * `https://<MagicDNS name>:<port>/`. Without one the hub opens no public port at all (never plain http);
 * a renewed one replaces the listeners, the open connections kept.
 *
 * `sync` binds what the records ask for and lets go of what they no longer do; the hub runs it every
 * second and at start, so a restarted hub listens again from the records alone. A port it cannot take (held
 * by another process, or no certificate) is reported, not fatal: `REGISTRY/hub/previews.json` says what
 * each port is for, whether the hub serves it and at which address, or why not, for `fleet preview status`
 * and the page.
 */
import { join } from "node:path";

import * as Option from "effect/Option";

import { makeDirs, readText, remove, writeAtomic } from "../files.ts";
import { asArray, asBoolean, asNumber, asObject, asString, dumps, parseObject } from "../json.ts";
import type { Rooted } from "./hub.ts";
import { NoCertificate, type Named } from "./preview-tls.ts";

/** What the hub says of one public port. */
export interface PortState {
  readonly port: number;
  readonly fleet: string;
  /** The worker of a per-worker preview, null for the combined one. */
  readonly worker: string | null;
  /** Whether it listens on 127.0.0.1. */
  readonly loopback: boolean;
  /** The tailnet address it listens on, or null. */
  readonly tailnet: string | null;
  /** Where a browser reaches it, `https://<MagicDNS name>:<port>/`, while the hub serves it; else null. */
  readonly url: string | null;
  /** Why it cannot serve it where it should, or null. */
  readonly error: string | null;
}

/** Where the hub says which public ports it listens on. */
export function previewPortsPath(home: string): string {
  return join(home, "hub", "previews.json");
}

/** What the running hub (`pid`) last said of the public ports; undefined when it said nothing. */
export function readPortStates(home: string, pid: number): PortState[] | undefined {
  const o = asObject(Option.getOrUndefined(parseObject(readText(previewPortsPath(home)) ?? "")));

  if (o === undefined || asNumber(o["pid"]) !== pid) return undefined;

  return (asArray(o["ports"]) ?? []).flatMap((p) => {
    const row = asObject(p);
    const port = asNumber(row?.["port"]);

    if (row === undefined || port === undefined) return [];

    return [
      {
        port,
        fleet: asString(row["fleet"]) ?? "",
        worker: asString(row["worker"]) ?? null,
        loopback: asBoolean(row["loopback"]) ?? false,
        tailnet: asString(row["tailnet"]) ?? null,
        url: asString(row["url"]) ?? null,
        error: asString(row["error"]) ?? null,
      },
    ];
  });
}

/** A listener the hub opens: on `hostname`, `port`, over TLS with `tls`, answering for `slot`. */
export type Listen = (hostname: string, port: number, slot: Rooted, tls: { readonly cert: string; readonly key: string }) => { stop: (closeActive?: boolean) => Promise<void> };

type Listener = ReturnType<Listen>;

interface Held {
  readonly slot: Rooted;
  loopback: Listener | undefined;
  tailnet: { readonly ip: string; readonly server: Listener } | undefined;
  /** The certificate its listeners serve with. */
  cert: Named | undefined;
  error: string | null;
}

function why(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sameSlot(a: Rooted, b: Rooted): boolean {
  return a.dir === b.dir && a.fleet === b.fleet && a.worker === b.worker;
}

/** What the listeners are made from. */
export interface PreviewPortsOptions {
  /** The root-mode previews the records name now (`Hub.rootedPreviews`). */
  readonly wanted: () => readonly Rooted[];
  /** This machine's tailnet address, while Tailscale says. */
  readonly tailnetIp: () => string | undefined;
  /** The certificate to serve with now, or why there is none (`PreviewCertificate.current`). */
  readonly certificate: () => Named | NoCertificate;
  readonly listen: Listen;
  /** The registry's home, where `hub/previews.json` goes. */
  readonly home: string;
  readonly log: (line: string) => void;
}

/** The root-mode previews' listeners. */
export class PreviewPorts {
  private readonly held = new Map<number, Held>();
  private written = "";
  private readonly wanted: () => readonly Rooted[];
  private readonly tailnetIp: () => string | undefined;
  private readonly certificate: () => Named | NoCertificate;
  private readonly listen: Listen;
  private readonly home: string;
  private readonly log: (line: string) => void;

  constructor(options: PreviewPortsOptions) {
    this.wanted = options.wanted;
    this.tailnetIp = options.tailnetIp;
    this.certificate = options.certificate;
    this.listen = options.listen;
    this.home = options.home;
    this.log = options.log;
  }

  /** Listen where the records ask, let go where they no longer do, and say so in `previews.json`. */
  sync(): void {
    const wanted = new Map(this.wanted().map((r) => [r.port, r]));

    for (const [port, held] of this.held) {
      const next = wanted.get(port);

      if (next !== undefined && sameSlot(next, held.slot)) continue;
      this.close(held);
      this.held.delete(port);
      this.log(`stopped listening on port ${port} (${held.slot.fleet}${held.slot.worker === undefined ? "" : `/${held.slot.worker}`})`);
    }

    const ip = this.tailnetIp();
    const cert = this.certificate();

    for (const [port, slot] of wanted) {
      const held: Held = this.held.get(port) ?? { slot, loopback: undefined, tailnet: undefined, cert: undefined, error: null };
      this.held.set(port, held);

      if (cert instanceof NoCertificate) {
        this.close(held);
        held.cert = undefined;

        if (cert.reason !== held.error) this.log(`cannot serve https on port ${port}: ${cert.reason}`);
        held.error = cert.reason;
        continue;
      }

      if (held.cert !== undefined && held.cert !== cert) {
        void held.loopback?.stop(false);
        void held.tailnet?.server.stop(false);
        held.loopback = undefined;
        held.tailnet = undefined;
        this.log(`port ${port} takes the renewed certificate`);
      }

      held.cert = cert;
      const errors: string[] = [];

      if (held.loopback === undefined) {
        try {
          held.loopback = this.listen("127.0.0.1", port, slot, cert);
          this.log(`listening on 127.0.0.1:${port} for ${slot.fleet}'s preview${slot.worker === undefined ? "" : ` of ${slot.worker}`}`);
        } catch (cause: unknown) {
          errors.push(`cannot listen on 127.0.0.1:${port}: ${why(cause)}`);
        }
      }

      if (held.tailnet !== undefined && held.tailnet.ip !== ip) {
        void held.tailnet.server.stop(true);
        held.tailnet = undefined;
      }

      if (ip !== undefined && held.tailnet === undefined) {
        try {
          held.tailnet = { ip, server: this.listen(ip, port, slot, cert) };
          this.log(`listening on ${ip}:${port}`);
        } catch (cause: unknown) {
          errors.push(`cannot listen on ${ip}:${port}: ${why(cause)}`);
        }
      }

      const error = errors.length === 0 ? null : errors.join("; ");

      if (error !== null && error !== held.error) this.log(error);
      held.error = error;
    }

    this.write();
  }

  /** Let go of every port, and take back what `previews.json` said. */
  stop(): void {
    for (const held of this.held.values()) this.close(held);
    this.held.clear();

    if (asNumber(asObject(Option.getOrUndefined(parseObject(readText(previewPortsPath(this.home)) ?? "")))?.["pid"]) === process.pid) remove(previewPortsPath(this.home));
  }

  private close(held: Held): void {
    void held.loopback?.stop(true);
    void held.tailnet?.server.stop(true);
    held.loopback = undefined;
    held.tailnet = undefined;
  }

  private write(): void {
    const ports = [...this.held.entries()]
      .sort(([a], [b]) => a - b)
      .map(([port, h]) => ({
        port,
        fleet: h.slot.fleet,
        worker: h.slot.worker ?? null,
        loopback: h.loopback !== undefined,
        tailnet: h.tailnet?.ip ?? null,
        url: h.cert !== undefined && (h.loopback !== undefined || h.tailnet !== undefined) ? `https://${h.cert.name}:${port}/` : null,
        error: h.error,
      }));

    const text = `${dumps({ pid: process.pid, ports }, { indent: 2 })}\n`;

    if (text === this.written) return;
    makeDirs(join(this.home, "hub"));
    writeAtomic(previewPortsPath(this.home), text);
    this.written = text;
  }
}
