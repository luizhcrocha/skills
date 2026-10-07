/**
 * The manager's quick filter by agent: who each decision is for (on a manager's page a fleet's decision is
 * that fleet's; the manager's own is the worker it names, or no agent's), the agents with an open decision,
 * counted, and the list narrowed to one of them.
 */
import type { Decision, Json } from "./core.ts";

/** The scope that keeps every decision. */
export const ALL = "";

/** The scope of the decisions that name no agent. */
export const NO_AGENT = "none";

/** An agent with an open decision: its key, its id (a fleet's or a worker's; null for no agent), how many are open. */
export interface Scope {
  readonly key: string;
  readonly agent: string | null;
  readonly fleet: boolean;
  readonly count: number;
}

/** The scope a decision belongs to. */
export function scopeOf(d: Decision): string {
  if (d.fleet) return "fleet:" + d.fleet;

  return d.agent ? "agent:" + d.agent : NO_AGENT;
}

/** Every agent with an open decision, once, in name order, no agent last. */
export function scopes(decisions: readonly Decision[]): Scope[] {
  const found = new Map<string, Scope>();

  for (const d of decisions) {
    if (d.status !== "open") continue;
    const key = scopeOf(d);
    const had = found.get(key);
    found.set(key, had ? { ...had, count: had.count + 1 } : { key, agent: d.fleet || d.agent || null, fleet: Boolean(d.fleet), count: 1 });
  }

  return [...found.values()].sort((a, b) =>
    a.agent === null || b.agent === null ? Number(a.agent === null) - Number(b.agent === null) : a.agent.localeCompare(b.agent, undefined, { numeric: true }) || a.key.localeCompare(b.key),
  );
}

/** The decisions of one scope, in their order; ALL keeps every one. */
export function narrow(decisions: readonly Decision[], scope: string): readonly Decision[] {
  return scope === ALL ? decisions : decisions.filter((d) => scopeOf(d) === scope);
}

/** The scope chosen, while it still has an open decision; else ALL (a stored value that is stale or not a scope). */
export function held(list: readonly Scope[], chosen: Json | undefined): string {
  return list.find((s) => s.key === chosen)?.key ?? ALL;
}
