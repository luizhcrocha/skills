/**
 * What this machine serves, and whose it is (Python's `served.py`): every port `tailscale serve`
 * exposes but the fleets' own pages, with the process listening behind it, its directory and command,
 * and the fleet whose session started it (by its parents, else by the first transcript that wrote its
 * address). Looking takes about a second, so the hub looks in the background and the page is sent the
 * last look.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { resolvePath } from "../files.ts";
import { asObject, asString, parseJson } from "../json.ts";
import type { Found } from "../page/view.ts";
import { splitUrl } from "../page/url.ts";
import { ancestry, commandOf, cwdOf, processes } from "../procs.ts";
import type { Entry } from "../registry.ts";
import { transcriptOf } from "../transcripts.ts";
import type { Machine } from "../world.ts";
import { tailscale, tailscaleBin } from "./tailnet.ts";

/** The stdout of `cmd`, or "" when it cannot run. */
async function output(cmd: readonly string[]): Promise<string> {
  try {
    const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);

    return text;
  } catch {
    return "";
  }
}

/** One port `tailscale serve` exposes over HTTPS, and where it proxies to. */
export interface Exposed {
  readonly port: number;
  readonly url: string;
  readonly target: string;
}

/** The HTTPS ports in `tailscale serve status --json`. */
export function exposedOf(text: string | undefined): Exposed[] {
  const status = asObject(Option.getOrUndefined(parseJson(text ?? "{}")));
  const found: Exposed[] = [];

  for (const [hostPort, web] of Object.entries(asObject(status?.["Web"]) ?? {})) {
    const handler = asObject(asObject(asObject(web)?.["Handlers"])?.["/"]);
    const target = asString(handler?.["Proxy"]);

    if (target === undefined || target === "") continue;
    const port = hostPort.includes(":") ? Number(hostPort.slice(hostPort.lastIndexOf(":") + 1)) : 443;
    found.push({ port, url: `https://${hostPort}/`, target });
  }

  return found.sort((a, b) => a.port - b.port);
}

/** Local port -> pid of the process listening on it, from `ss -ltnpH`. */
export function listenersOf(text: string): Map<number, number> {
  const ports = new Map<number, number>();

  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const pid = /pid=(\d+)/.exec(line)?.[1];
    const local = cols[3];

    if (cols.length < 4 || pid === undefined || local === undefined) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));

    if (Number.isInteger(port) && !ports.has(port)) ports.set(port, Number(pid));
  }

  return ports;
}

/** The fleet whose session started `pid` (it or a parent writes into the session's tasks/), or whose
 * session directory holds its working directory. */
export function ownerOf(pid: number, cwd: string, entries: readonly Entry[]): string | undefined {
  const chain = new Set(ancestry(pid));

  for (const e of entries) {
    const session = resolvePath(join(e.dir, "..", ".."));

    if (cwd === session || cwd.startsWith(`${session}/`)) return e.id;

    if (processes(e.dir).some((p) => chain.has(p.pid))) return e.id;
  }

  return undefined;
}

const said = new Map<string, string | undefined>();

/** The fleet whose session or workers first wrote this port's full address in their transcripts (kept
 * while the same process serves the port). */
export async function mentionedBy(port: number, pid: number, entries: readonly Entry[], config: string): Promise<string | undefined> {
  const key = `${port}:${pid}`;

  if (said.has(key)) return said.get(key);
  const patterns = [`ts.net:${port}`, `127.0.0.1:${port}`, `localhost:${port}`].flatMap((p) => ["-e", p]);
  const first: (readonly [string, string])[] = [];

  for (const e of entries) {
    const transcript = transcriptOf(e.dir, config);

    if (transcript === undefined || port === 443) continue;
    const paths = [transcript, join(transcript.replace(/\.jsonl$/, ""), "subagents")].filter((p) => existsSync(p));

    if (paths.length === 0) continue;
    const text = await output(["grep", "-rhF", "-m", "2", ...patterns, ...paths]);
    const stamps = [...text.matchAll(/"timestamp":\s*"([^"]+)"/g)].map((m) => m[1] ?? "");

    if (stamps.length > 0) first.push([stamps.sort()[0] ?? "", e.id]);
  }

  const found = first.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))[0]?.[1];
  said.set(key, found);

  return found;
}

/** Every served port but the fleets' pages, with the process behind it and its fleet: one look. */
export async function discover(machine: Machine): Promise<Found[]> {
  if (machine.env("FLEET_DISCOVER") === "0") return [];
  const entries = machine.registry.live();
  const pages = new Set(entries.map((e) => splitUrl(e.url).port));
  const listeners = listenersOf(await output(["ss", "-ltnpH"]));
  const found: Found[] = [];

  for (const s of exposedOf(await tailscale(tailscaleBin(machine.env), ["serve", "status", "--json"]))) {
    if (pages.has(s.port)) continue;
    const local = splitUrl(s.target).port;
    const pid = local === undefined ? undefined : listeners.get(local);
    const cwd = pid === undefined ? "" : cwdOf(pid);
    const command = pid === undefined ? "" : commandOf(pid);
    const fleet = pid === undefined ? undefined : (ownerOf(pid, cwd, entries) ?? (await mentionedBy(s.port, pid, entries, machine.config)));
    found.push({ ...s, pid: pid ?? null, cwd, command: [...command].slice(0, 200).join(""), fleet: fleet ?? null, up: pid !== undefined });
  }

  return found;
}

/** How often the hub looks again. */
export const SERVED_S = 30;

/** The last look, refreshed in the background once it is older than {@link SERVED_S}. */
export class Served {
  private value: Found[] = [];
  private at = 0;
  private busy = false;
  private readonly machine: Machine;

  constructor(machine: Machine) {
    this.machine = machine;
  }

  /** The last look; starts the next when it is stale. */
  latest(): readonly Found[] {
    if (!this.busy && performance.now() - this.at >= SERVED_S * 1000) {
      this.busy = true;
      discover(this.machine)
        .then((value) => {
          this.value = value;
        })
        .catch(() => {
          // a failed look leaves the last one: the page keeps serving
        })
        .finally(() => {
          this.at = performance.now();
          this.busy = false;
        });
    }

    return this.value;
  }
}
