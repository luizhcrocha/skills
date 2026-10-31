/**
 * A standing agent's ledger: the agent's file may name it (`fleet.ledger`); else it is the one the registry knows
 * by the agent's name, where it is; else its fixed home, `~/.local/state/fleet/<name>`, where a coordinator that
 * has none makes it. A ledger is never moved: a folder may hold a team's cloud.json, and its host runs from it. A
 * team's name is one per machine, so a ledger another project's or repo's team holds is not the agent's.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { isMoved, readText } from "../files.ts";
import { asArray, asObject, asString, parseObject } from "../json.ts";
import { fleetName, movedTeam, type Entry } from "../registry.ts";
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
  return agent.fleet.ledger === undefined ? ledgerNamed(agent.name, known, home) : { ledger: agent.fleet.ledger };
}

/** The ledger the registry (`known`) knows by `name`, where it is; else its fixed home. Entries of that name in
 * different folders are refused. A team a project's join made is named by its team id. */
export function ledgerNamed(name: string, known: readonly Entry[], home: string): { readonly ledger: string } | Why {
  const reals = [...new Set(known.flatMap((e) => (isAgentsEntry(e, name) && existsSync(e.dir) ? [realpathSync(e.dir)] : [])))];
  const [found, ...others] = reals;

  if (others.length > 0) return { why: `${name}: the registry knows ${reals.length} ledgers by its name, in different folders (${reals.join(", ")}); remove the stale entries so one is left` };

  return { ledger: found ?? join(fixedHomes(home), name) };
}

/** The team that holds `ledger` as this machine records it: its id, the project its cloud.json names, and the project
 * and repo (`owner/name`) a local join recorded for that id in `~/.local/state/fleet/teams.json`. A join's record names
 * the team's fixed home, so a ledger in another folder is not that team's. */
function holderOf(name: string, ledger: string, home: string) {
  const moved = movedTeam(ledger);
  const id = moved?.id ?? name;
  const atHome = ledger === join(fixedHomes(home), id);
  const listed = atHome ? Option.getOrUndefined(parseObject(readText(join(fixedHomes(home), "teams.json")) ?? "")) : undefined;
  const joined = (asArray(listed?.["teams"]) ?? []).map(asObject).find((t) => asString(t?.["id"]) === id);

  return { id, project: moved?.project ?? asString(joined?.["project"]), repo: asString(joined?.["repo"]) };
}

/**
 * Why `ledger`, the ledger of the agent `name` of `project` in the repo `repo()` names, is another team's: one of
 * another project (a moved ledger naming no project is one), or one a join recorded for another repo. A team's name
 * is one per machine, and its fixed home is found by name alone. `repo` is asked only when a repo is recorded.
 */
export function heldByAnother(name: string, ledger: string, home: string, project: string | undefined, repo: () => string | undefined): Why | undefined {
  const holder = holderOf(name, ledger, home);
  const otherProject = project !== undefined && (holder.project === undefined ? isMoved(ledger) : holder.project !== project);
  const ours = holder.repo === undefined ? undefined : repo();
  const otherRepo = ours !== undefined && holder.repo !== ours;

  if (!otherProject && !otherRepo) return undefined;
  const theirs = [holder.project === undefined ? (isMoved(ledger) ? "no project" : undefined) : `project ${holder.project}`, holder.repo === undefined ? undefined : `repo ${holder.repo}`].filter((p) => p !== undefined);
  const mine = [...(otherProject ? [`project ${project}`] : []), ...(otherRepo ? [`repo ${ours}`] : [])];

  return {
    why: `${name}: ${ledger} is the ledger of team ${holder.id} (${theirs.join(", ")}), not this agent's (${mine.join(", ")}): a team's name is one per machine, so give this agent another (\`fleet fleets list\` lists the teams here)`,
  };
}
