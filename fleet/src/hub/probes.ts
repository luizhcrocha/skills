/**
 * Links up or down, for a long-running hub: each address's last probe is answered at once, and an
 * address probed more than {@link PROBE_S} seconds ago is probed again in the background (Python's
 * `served.up`, cached the same way). An address never probed reads as down until its first probe ends.
 */
import { accepts } from "../page/probe.ts";
import { probeTarget } from "../page/url.ts";

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
