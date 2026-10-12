/**
 * The hub's look at the machine's orphaned test and dev processes (orphans.ts), refreshed in the background
 * every {@link ORPHANS_S} seconds after a page asks, so no request waits on reading /proc. `FLEET_DISCOVER=0`
 * (the tests' machines) or `FLEET_ORPHANS=0` turns it off: the machine's own processes are no test's to see.
 */
import { liveSessionsOf, minAgeOf, orphansNow, previewPids, stopOrphan, type Orphan, type Stopped } from "../orphans.ts";
import type { Machine } from "../world.ts";

/** How often the hub looks again. */
export const ORPHANS_S = 60;

/** The last look, refreshed after the response once it is older than {@link ORPHANS_S}. */
export class OrphanWatch {
  private value: Orphan[] = [];
  private at = Number.NEGATIVE_INFINITY;
  private busy = false;
  private readonly machine: Machine;

  constructor(machine: Machine) {
    this.machine = machine;
  }

  /** Whether this machine's hub looks at all. */
  get on(): boolean {
    return this.machine.env("FLEET_DISCOVER") !== "0" && this.machine.env("FLEET_ORPHANS") !== "0";
  }

  /** The orphans' minimum age, in seconds ($FLEET_ORPHAN_HOURS). */
  get minAge(): number {
    return minAgeOf(this.machine.env);
  }

  /** The last look; starts the next when it is stale. */
  latest(): readonly Orphan[] {
    if (this.on && !this.busy && performance.now() - this.at >= ORPHANS_S * 1000) {
      this.busy = true;
      setTimeout(() => {
        this.look();
      }, 0);
    }

    return this.value;
  }

  /** The pids a Stop never touches: the served fleets' preview dev servers. */
  exempt(): Set<number> {
    return previewPids(this.machine.registry.live());
  }

  /** Stop the tree Luiz clicked Stop on, while it is still the orphan the page showed (orphans.ts). */
  async stop(pid: number, started: number): Promise<Stopped> {
    const config = this.machine.registry.place.config;

    return stopOrphan(pid, started, this.minAge, this.exempt(), undefined, (rows) => liveSessionsOf(rows, config));
  }

  /** Look now (after a Stop, so the page loses the row at once). */
  look(): void {
    try {
      const registry = this.machine.registry;
      this.value = this.on ? orphansNow(registry.known(), registry.live(), this.minAge, registry.place.config) : [];
    } catch {
      // a failed look leaves the last one: the page keeps serving
    } finally {
      this.at = performance.now();
      this.busy = false;
    }
  }
}
