/**
 * A standing agent's ledger: the agent's file may name it (`fleet.ledger`); else it is the one the registry knows
 * by the agent's name, where it is; else its fixed home, `~/.local/state/fleet/<name>`, where a coordinator that
 * has none makes it. A ledger is never moved: a folder may hold a team's cloud.json, and its host runs from it.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { fleetName, type Entry } from "../registry.ts";
import type { Agent, Why } from "./agents.ts";

/** Where every fixed home is: `~/.local/state/fleet`. */
export function fixedHomes(home: string): string {
  return join(home, ".local", "state", "fleet");
}

/** Whether a registry entry is the agent's: its id, an old id or its session's name. */
export function isAgentsEntry(entry: Entry, name: string): boolean {
  return entry.id === name || entry.aliases.includes(name) || (entry.session !== null && fleetName(entry.session) === name);
}

/**
 * The ledger of `agent`, `known` being the registry's fleets (served or not) and `home` the user's: its file's
 * own; else the registry's for its name, where it is; else its fixed home. Registry entries of its name in
 * different folders are refused.
 */
export function ledgerOf(agent: Agent, known: readonly Entry[], home: string): { readonly ledger: string } | Why {
  if (agent.fleet.ledger !== undefined) return { ledger: agent.fleet.ledger };
  const reals = [...new Set(known.flatMap((e) => (isAgentsEntry(e, agent.name) && existsSync(e.dir) ? [realpathSync(e.dir)] : [])))];
  const [found, ...others] = reals;

  if (others.length > 0) return { why: `${agent.name}: the registry knows ${reals.length} ledgers by its name, in different folders (${reals.join(", ")}); remove the stale entries so one is left` };

  return { ledger: found ?? join(fixedHomes(home), agent.name) };
}
