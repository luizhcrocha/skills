/**
 * Links up or down, for a long-running hub: each address's last probe is answered at once, and an
 * address probed more than {@link PROBE_S} seconds ago is probed again in the background (Python's
 * `served.up`, cached the same way). For the TCP cache, an address never probed reads as down until its first
 * probe ends; for the links' HTTP probes ({@link LinkProbes}), it is unknown.
 */
import { stampOf } from "../clock.ts";
import { accepts } from "../page/probe.ts";
import { fetchHost } from "../ledger/links.ts";
import { probeTarget } from "../page/url.ts";
import type { Probed } from "../page/view.ts";

/** How long a probe's answer holds. */
export const PROBE_S = 10;

/** The last probe of each address. */
export class ProbeCache {
  private readonly held = new Map<string, { up: boolean; at: number; busy: boolean }>();

  /** Whether each of `urls` answered at its last probe; stale ones are probed again. */
  up(urls: readonly string[]): boolean[] {
    return urls.map((url) => {
      const { host, port } = probeTarget(url);
      const key = `${host}:${port}`;
      const hit = this.held.get(key);

      if (hit === undefined || (!hit.busy && performance.now() - hit.at >= PROBE_S * 1000)) {
        const entry = hit ?? { up: false, at: 0, busy: true };
        entry.busy = true;
        this.held.set(key, entry);
        void accepts(host, port).then((ok) => {
          entry.up = ok;
          entry.at = performance.now();
          entry.busy = false;
        });
      }

      return hit?.up ?? false;
    });
  }
}

/** How long a link's HTTP probe holds. */
export const LINK_PROBE_S = 60;

/** How long a link's HTTP probe waits for an answer. */
export const LINK_PROBE_TIMEOUT_MS = 3000;

/** Whether the server at `url` answers: a HEAD (a GET of one byte when HEAD is not allowed), redirects never
 * followed, no credentials. Down when nothing answers in time, the connection or TLS fails, or a proxy in
 * front says its server is gone (502, 503, 504: `tailscale serve` before a stopped dev server). A loopback
 * address is not held to its certificate. Only ever called for a link of this machine or its tailnet. */
export async function answers(url: string, timeoutMs = LINK_PROBE_TIMEOUT_MS): Promise<boolean> {
  const host = fetchHost(url);

  if (host === undefined) return false;
  const loopback = host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(host);

  const ask = (method: "HEAD" | "GET"): Promise<Response> => {
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      method,
      redirect: "manual",
      headers: method === "GET" ? { Range: "bytes=0-0", "User-Agent": "fleet-hub-probe" } : { "User-Agent": "fleet-hub-probe" },
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (loopback) init.tls = { rejectUnauthorized: false };

    return fetch(url, init);
  };

  try {
    let res = await ask("HEAD");

    if (res.status === 405 || res.status === 501) {
      await res.body?.cancel();
      res = await ask("GET");
    }

    await res.body?.cancel();

    return res.status < 502 || res.status > 504;
  } catch {
    return false;
  }
}

/** A link's last probe, held. */
interface Held {
  /** Whether it answered; null while unknown: never probed yet, or its probe itself failed. */
  up: boolean | null;
  checked: string;
  since: string;
  /** When it was checked, in ms of the injected clock. */
  at: number;
  busy: boolean;
  seen: boolean;
}

/** How many addresses the hub holds a probe for: the least recently asked goes first. */
export const LINK_PROBES_HELD = 512;

/** The links' HTTP probes, for a long-running hub: each address's last answer at once, with when it was
 * checked and since when it reads up, down or unknown; an address probed more than {@link LINK_PROBE_S} seconds
 * ago (on the injected clock) is probed again in the background. An address never probed, or whose probe
 * failed, is unknown (`up: null`). At most {@link LINK_PROBES_HELD} addresses are held, the least recently
 * asked dropped first. */
export class LinkProbes {
  private readonly held = new Map<string, Held>();
  private readonly now: () => Date;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly ttlMs: number;
  private readonly most: number;

  constructor(now: () => Date, probe: (url: string) => Promise<boolean> = (url) => answers(url), ttlMs = LINK_PROBE_S * 1000, most = LINK_PROBES_HELD) {
    this.now = now;
    this.probe = probe;
    this.ttlMs = ttlMs;
    this.most = most;
  }

  /** The last probe of each of `urls`; stale ones are probed again. */
  get(urls: readonly string[]): Probed[] {
    return urls.map((url) => {
      const hit = this.held.get(url) ?? { up: null, checked: "", since: "", at: 0, busy: false, seen: false };
      this.held.delete(url);
      this.held.set(url, hit);

      for (const oldest of this.held.keys()) {
        if (this.held.size <= this.most) break;
        this.held.delete(oldest);
      }

      if (!hit.busy && (!hit.seen || this.now().getTime() - hit.at >= this.ttlMs)) this.start(url, hit);

      return { up: hit.up, checked: hit.checked, since: hit.since };
    });
  }

  /** Probe `url` for `entry`, owning the promise: a probe that throws or rejects reads as unknown, and the
   * entry is never left busy. */
  private start(url: string, entry: Held): void {
    entry.busy = true;

    const done = (up: boolean | null): void => {
      const stamp = stampOf(this.now());

      if (!entry.seen || entry.up !== up) entry.since = stamp;
      entry.up = up;
      entry.checked = stamp;
      entry.at = this.now().getTime();
      entry.seen = true;
      entry.busy = false;
    };

    let running: Promise<boolean>;

    try {
      running = this.probe(url);
    } catch {
      done(null);

      return;
    }

    running.then(done, () => {
      done(null);
    });
  }

  /** How many addresses are held (tests). */
  get size(): number {
    return this.held.size;
  }

  /** Every probe under way, done (tests). */
  async settled(): Promise<void> {
    while ([...this.held.values()].some((h) => h.busy)) await new Promise((r) => setTimeout(r, 10));
  }
}
