/**
 * `fleet fleets orphans`: the machine's orphaned test and dev processes (orphans.ts), as the manager's page
 * lists them: root pid, age, the tree's memory, who started it, the command. It lists only; a tree is
 * stopped from the page's Stop, by Luiz.
 */
import * as Effect from "effect/Effect";

import { Out } from "../io.ts";
import { minAgeOf, orphansNow } from "../orphans.ts";
import type { Machine } from "../world.ts";

function hours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** List the orphans; none is a line saying so. */
export function orphansCommand(machine: Machine): Effect.Effect<void, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const minAge = minAgeOf(machine.env);
    const found = orphansNow(machine.registry.known(), machine.registry.live(), minAge, machine.registry.place.config);

    if (found.length === 0) out.out(`no orphaned test or dev process older than ${hours(minAge)}\n`);

    for (const o of found) {
      const who = o.fleet ?? (o.session === null ? "unknown" : `session ${o.session}`);
      out.out(`${o.pid}  ${hours(o.age)}  ${Math.round(o.rss / 1024)} MB  ${who}  ${o.workspace ?? o.cwd ?? ""}\n    ${o.command}\n`);
    }
  });
}
