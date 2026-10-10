/**
 * The tailnet as the hub reads it, through the `tailscale` CLI (`$TAILSCALE`, else on PATH): this
 * machine's name, addresses and login, the peers that are online, and who owns the machine a request
 * comes from (`tailscale whois`). Tailscale may be absent or stopped: every reading is then empty and
 * the hub serves this machine alone, on loopback.
 */
import { spawnSync } from "node:child_process";

import * as Option from "effect/Option";

import { asArray, asBoolean, asObject, asString, parseJson, type Json, type JsonObject } from "../json.ts";

/** One machine of the tailnet. */
export interface Node {
  /** The first label of its MagicDNS name (`cr-cache`): how the hub's paths name it. */
  readonly name: string;
  /** Its MagicDNS name, without the trailing dot. */
  readonly dns: string;
  /** Its Tailscale IPv4 address, when it has one. */
  readonly ip: string | undefined;
  readonly online: boolean;
}

/** This machine and its peers. */
export interface Tailnet {
  readonly self: Node;
  /** The login that owns this machine (`luizhcrocha@github`), when Tailscale says. */
  readonly login: string | undefined;
  readonly peers: readonly Node[];
  /** Its MagicDNS suffix (`tail1234.ts.net`): Tailscale's `MagicDNSSuffix`, else this machine's name without its
   * first label. */
  readonly suffix: string | undefined;
}

/** The tailscale binary. */
export function tailscaleBin(env: (name: string) => string | undefined): string {
  const given = env("TAILSCALE");

  return given !== undefined && given !== "" ? given : "tailscale";
}

function nodeOf(object: JsonObject | undefined): Node | undefined {
  const dns = asString(object?.["DNSName"])?.replace(/\.$/, "");

  if (object === undefined || dns === undefined || dns === "") return undefined;

  const ips = (asArray(object["TailscaleIPs"]) ?? []).flatMap((ip) => {
    const text = asString(ip);

    return text === undefined ? [] : [text];
  });

  return { name: dns.split(".")[0] ?? dns, dns, ip: ips.find((ip) => !ip.includes(":")), online: asBoolean(object["Online"]) ?? false };
}

/** The tailnet from `tailscale status --json`, or undefined when Tailscale is absent or not running. */
export function tailnetOf(status: Json | undefined): Tailnet | undefined {
  const root = asObject(status);

  if (root === undefined || root["BackendState"] !== "Running") return undefined;
  const me = asObject(root["Self"]);
  const self = nodeOf(me);

  if (self === undefined) return undefined;
  const userId = me?.["UserID"];
  const users = asObject(root["User"]);
  const login = userId === undefined || userId === null ? undefined : asString(asObject(users?.[String(userId)])?.["LoginName"]);

  const peers = Object.values(asObject(root["Peer"]) ?? {}).flatMap((p) => {
    const node = nodeOf(asObject(p));

    return node === undefined ? [] : [node];
  });

  const given = asString(root["MagicDNSSuffix"]) ?? asString(asObject(root["CurrentTailnet"])?.["MagicDNSSuffix"]);
  const suffix = (given ?? self.dns.split(".").slice(1).join(".")).replace(/\.$/u, "").toLowerCase();

  return { self: { ...self, online: true }, login, peers, suffix: suffix === "" ? undefined : suffix };
}

function decode(text: string): Json | undefined {
  return Option.getOrUndefined(parseJson(text));
}

/** `tailscale ARGS` run now, its stdout; undefined when it cannot run or fails. */
export function tailscaleSync(bin: string, args: readonly string[]): string | undefined {
  const done = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });

  return done.error !== undefined || done.status !== 0 ? undefined : done.stdout;
}

/** `tailscale ARGS`, its stdout; undefined when it cannot run or fails. */
export async function tailscale(bin: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);

    return code === 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The tailnet now (a fresh `tailscale status --json`), or undefined. */
export async function readTailnet(bin: string): Promise<Tailnet | undefined> {
  const text = await tailscale(bin, ["status", "--json"]);

  return text === undefined ? undefined : tailnetOf(decode(text));
}

/** The tailnet now, synchronously, for a one-shot command. */
export function readTailnetSync(bin: string): Tailnet | undefined {
  const text = tailscaleSync(bin, ["status", "--json"]);

  return text === undefined ? undefined : tailnetOf(decode(text));
}

/** The login that owns the machine at `ip` (`tailscale whois`), or undefined. */
export async function whois(bin: string, ip: string): Promise<string | undefined> {
  const text = await tailscale(bin, ["whois", "--json", ip]);

  return text === undefined ? undefined : asString(asObject(asObject(decode(text))?.["UserProfile"])?.["LoginName"]);
}

/** Whether `ip` is a Tailscale address (100.64.0.0/10, or fd7a:115c:a1e0::/48). */
export function isTailnetIp(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);

  if (v4 !== null) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;

  return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

/** Whether `ip` is this machine's loopback. */
export function isLoopback(ip: string): boolean {
  return ip === "::1" || /^(?:::ffff:)?127\./.test(ip);
}
