/**
 * The public ports of root mode: a preview that runs at its root (`--base /`) is served by the hub at the
 * root of an origin of its own, `http://<this machine>:<port>/`, on a port the hub listens on itself. Each
 * preview (the combined one, each per-worker one) is given its port once and keeps it in `DIR/preview.json`
 * across its stops and starts, so a bookmarked address stays good.
 *
 * The ports come from `FLEET_PREVIEW_PORTS` (`LO-HI`), 7500-7599 by default: beside the hub's 7420 and
 * 7443, clear of the ports this machine's other servers use (Vite's 5173, the apps' 24116-24118, 9787-9791,
 * 8444, 5300) and below the kernel's ephemeral range (32768 and up on Linux, 49152 on the Mac), where
 * `freePort` puts the dev servers themselves. A port is never given when another fleet's preview holds it,
 * when it is the hub's own, when `tailscale serve` exposes it, or when something listens on it now.
 */
import * as Option from "effect/Option";

import { PreviewError } from "../errors.ts";
import { readText } from "../files.ts";
import { asNumber, asObject, parseObject } from "../json.ts";
import { exposedOf } from "../hub/served.ts";
import { tailscaleBin, tailscaleSync, type Tailnet } from "../hub/tailnet.ts";
import type { Machine } from "../world.ts";
import { readRecord, type PreviewRecord } from "./record.ts";

/** The public ports' range unless `FLEET_PREVIEW_PORTS` says otherwise. */
export const DEFAULT_PORTS: readonly [number, number] = [7500, 7599];

/** The hub's own ports, never given: its http port and the https one `tailscale serve` gives it. */
const HUB_PORTS = [7420, 7443];

/** The range `FLEET_PREVIEW_PORTS` names, the default without it; why not when it is no range. */
export function portRange(env: (name: string) => string | undefined): readonly [number, number] | PreviewError {
  const given = env("FLEET_PREVIEW_PORTS");

  if (given === undefined || given.trim() === "") return DEFAULT_PORTS;
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(given);
  const lo = Number(m?.[1]);
  const hi = Number(m?.[2]);

  if (m === null || lo < 1 || hi > 65535 || lo > hi) return new PreviewError({ reason: `FLEET_PREVIEW_PORTS is ${given}: give a range of ports, LO-HI, such as 7500-7599` });

  return [lo, hi];
}

/** Which preview a port is for: the combined one (`worker` undefined) or one worker's. */
export interface Slot {
  readonly worker: string | undefined;
}

/** The port the record gives `slot`, or null. */
export function givenPort(record: PreviewRecord | undefined, slot: Slot): number | null {
  if (record === undefined) return null;

  return slot.worker === undefined ? record.ports.combined : (record.ports.workers[slot.worker] ?? null);
}

/** Every public port the fleets of this machine gave their previews, but `root`'s own `slot`. */
function claimed(machine: Machine, root: string, slot: Slot): Set<number> {
  const ports = new Set<number>();

  for (const entry of machine.registry.live()) {
    const record = readRecord(entry.dir);

    if (record === undefined) continue;
    const mine = entry.dir === root;

    if (record.ports.combined !== null && !(mine && slot.worker === undefined)) ports.add(record.ports.combined);

    for (const [worker, port] of Object.entries(record.ports.workers)) if (!(mine && slot.worker === worker)) ports.add(port);
  }

  return ports;
}

/** The ports the running hub listens on, from its record. */
function hubPorts(machine: Machine): number[] {
  const record = asObject(Option.getOrUndefined(parseObject(readText(`${machine.registry.place.home}/hub/hub.json`) ?? "")));

  return [asNumber(record?.["port"]), asNumber(record?.["https"])].flatMap((p) => (p === undefined ? [] : [p]));
}

/** Whether nothing listens on `host:port`: a listener there for an instant says so. */
function free(host: string, port: number): boolean {
  try {
    const probe = Bun.serve({ hostname: host, port, fetch: () => new Response("") });
    void probe.stop(true);

    return true;
  } catch {
    return false;
  }
}

/**
 * The public port of `slot` in the fleet at `root`: the one it was given before, else the first of the
 * range nothing else holds (free on loopback and on the tailnet address `net` names); why not when the
 * range has none.
 */
export function allocate(machine: Machine, root: string, slot: Slot, net: Tailnet | undefined): number | PreviewError {
  const range = portRange(machine.env);

  if (range instanceof PreviewError) return range;
  const [lo, hi] = range;
  const before = givenPort(readRecord(root), slot);

  if (before !== null && before >= lo && before <= hi) return before;
  const taken = claimed(machine, root, slot);

  for (const p of [...HUB_PORTS, ...hubPorts(machine)]) taken.add(p);

  for (const e of exposedOf(tailscaleSync(tailscaleBin(machine.env), ["serve", "status", "--json"]))) taken.add(e.port);
  const ip = net?.self.ip;

  for (let port = lo; port <= hi; port += 1) {
    if (taken.has(port)) continue;

    if (free("127.0.0.1", port) && (ip === undefined || free(ip, port))) return port;
  }

  return new PreviewError({ reason: `no free port in FLEET_PREVIEW_PORTS (${lo}-${hi}) for the preview's public address; widen the range or stop a preview that holds one` });
}
