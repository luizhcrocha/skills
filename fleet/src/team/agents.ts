/**
 * A repo's standing agents: one file each, `.fleet/agents/<name>.json`, in the Anthropic Agents SDK's agent
 * fields (`name`, `description`, `model: {id, effort}`, `system`, `tools`, `multiagent`, `metadata`) and a
 * `fleet` block for what that API has no field for (`role`, `opening`, `remote_control`, `machine`, `ledger`).
 * The role gives the defaults, so a coordinator's file can be `{"fleet": {"role": "coordinator"}}`. `tools`,
 * `multiagent` and `metadata` are kept for a cloud launcher and not applied here: Claude Code's settings and
 * the plugin's permission cards decide a local agent's tools. `.fleet/team.json` may name the session
 * (`{"session": "skills"}`); else it is the repo's folder. Either is refused unless it is a plain name.
 */
import { basename, isAbsolute, join } from "node:path";
import * as Option from "effect/Option";

import { isDir, listDir, readText } from "../files.ts";
import { asBoolean, asObject, asString, parseObject, type Json, type JsonObject } from "../json.ts";

/** Why a file or a team is refused: one sentence naming the file and the field. */
export interface Why {
  readonly why: string;
}

/** The roles a standing agent plays. */
export type Role = "manager" | "coordinator";

/** The efforts `claude --effort` takes. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** One effort. */
export type Effort = (typeof EFFORTS)[number];

/** One standing agent, its defaults filled in. */
export interface Agent {
  readonly name: string;
  readonly description: string;
  readonly model: { readonly id: string; readonly effort: Effort };
  readonly system: string | undefined;
  /** Kept for a cloud launcher; a local agent's tools are Claude Code's settings and permission cards. */
  readonly tools: Json | undefined;
  readonly multiagent: Json | undefined;
  readonly metadata: Json | undefined;
  readonly fleet: {
    readonly role: Role;
    /** The first prompt, sent once the agent is ready. */
    readonly opening: string;
    readonly remote_control: boolean;
    /** Where it runs: `local`, the only one started yet. */
    readonly machine: string;
    /** Its ledger folder when the file names one, absolute. */
    readonly ledger: string | undefined;
  };
}

/** A repo's team: its session and its agents, by name. */
export interface Team {
  readonly repo: string;
  readonly session: string;
  readonly agents: readonly Agent[];
}

/** What a role gives an agent that does not say. Coordinators and the manager run on Opus at low effort
 * (coordinator/MODELS.md). */
const ROLE_DEFAULTS: Readonly<Record<Role, { readonly opening: string; readonly model: { readonly id: string; readonly effort: Effort } }>> = {
  coordinator: { opening: "/tstack:coordinator", model: { id: "opus", effort: "low" } },
  manager: { opening: "/tstack:manager", model: { id: "opus", effort: "low" } },
};

/** The fields of an agent's file. */
const FIELDS = ["name", "description", "model", "system", "tools", "multiagent", "metadata", "fleet"];

/** The fields of its `fleet` block. */
const FLEET_FIELDS = ["role", "opening", "remote_control", "machine", "ledger"];

/** herdr's agent names, which a standing agent's name must also be. */
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** A session's name: a letter or digit first, then letters, digits, `.`, `_` and `-`; no path, no option. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isEffort(value: string): value is Effort {
  return EFFORTS.some((e) => e === value);
}

function isRole(value: string): value is Role {
  return value === "manager" || value === "coordinator";
}

/** A string field read: its text (undefined when absent), or the sentence saying it is not one. */
type Field = { readonly text: string | undefined } | Why;

function stringField(raw: JsonObject, key: string, file: string, label = key): Field {
  const value = raw[key];

  if (value === undefined) return { text: undefined };
  const text = asString(value);

  return text === undefined || text === "" ? { why: `${file}: ${label} is a non-empty string` } : { text };
}

function parseModel(raw: JsonObject, file: string, fallback: Agent["model"]): Agent["model"] | Why {
  if (raw["model"] === undefined) return fallback;
  const model = asObject(raw["model"]);

  if (model === undefined) return { why: `${file}: model is an object: {"id": ..., "effort": ...}` };
  const id = stringField(model, "id", file, "model.id");

  if ("why" in id) return id;

  if (id.text === undefined) return { why: `${file}: model.id is required when model is given` };
  const effort = stringField(model, "effort", file, "model.effort");

  if ("why" in effort) return effort;

  if (effort.text === undefined) return { id: id.text, effort: fallback.effort };

  return isEffort(effort.text) ? { id: id.text, effort: effort.text } : { why: `${file}: model.effort is '${effort.text}'; it is one of ${EFFORTS.join(", ")}` };
}

function parseFleet(raw: JsonObject, file: string, home: string): Agent["fleet"] | Why {
  const block = asObject(raw["fleet"]);

  if (block === undefined) return { why: `${file}: fleet.role is required: manager or coordinator` };
  const unknown = Object.keys(block).find((k) => !FLEET_FIELDS.includes(k));

  if (unknown !== undefined) return { why: `${file}: fleet.${unknown} is not a field of the fleet block (${FLEET_FIELDS.join(", ")})` };
  const role = asString(block["role"]);

  if (role === undefined) return { why: `${file}: fleet.role is required: manager or coordinator` };

  if (!isRole(role)) return { why: `${file}: fleet.role is '${role}'; it is manager or coordinator` };
  const opening = stringField(block, "opening", file, "fleet.opening");

  if ("why" in opening) return opening;
  const machine = stringField(block, "machine", file, "fleet.machine");

  if ("why" in machine) return machine;
  const ledger = stringField(block, "ledger", file, "fleet.ledger");

  if ("why" in ledger) return ledger;
  const remote = block["remote_control"] === undefined ? true : asBoolean(block["remote_control"]);

  if (remote === undefined) return { why: `${file}: fleet.remote_control is true or false` };
  const ledgerPath = ledger.text === undefined ? undefined : ledger.text.startsWith("~/") ? join(home, ledger.text.slice(2)) : ledger.text;

  if (ledgerPath !== undefined && !isAbsolute(ledgerPath)) return { why: `${file}: fleet.ledger is an absolute path (or ~/...)` };

  return { role, opening: opening.text ?? ROLE_DEFAULTS[role].opening, remote_control: remote, machine: machine.text ?? "local", ledger: ledgerPath };
}

/** The agent `name` from its file's text (`home` expands a `~/` ledger), or why the file is refused. */
export function parseAgent(name: string, text: string, home = ""): Agent | Why {
  const file = `${name}.json`;

  if (!NAME.test(name)) return { why: `${file}: name '${name}' is lower-case letters, digits, - and _, starting with a letter, at most 32 (herdr's agent names)` };
  const raw = Option.getOrUndefined(parseObject(text));

  if (raw === undefined) return { why: `${file} is not a JSON object` };
  const unknown = Object.keys(raw).find((k) => !FIELDS.includes(k));

  if (unknown !== undefined) return { why: `${file}: ${unknown} is not a field of an agent (${FIELDS.join(", ")})` };
  const given = stringField(raw, "name", file);

  if ("why" in given) return given;

  if (given.text !== undefined && given.text !== name) return { why: `${file}: name is '${given.text}'; it must be the file's name, '${name}'` };
  const fleet = parseFleet(raw, file, home);

  if ("why" in fleet) return fleet;
  const model = parseModel(raw, file, ROLE_DEFAULTS[fleet.role].model);

  if ("why" in model) return model;
  const description = stringField(raw, "description", file);

  if ("why" in description) return description;
  const system = stringField(raw, "system", file);

  if ("why" in system) return system;

  return {
    name,
    description: description.text ?? `The ${name} ${fleet.role}`,
    model,
    system: system.text,
    tools: raw["tools"],
    multiagent: raw["multiagent"],
    metadata: raw["metadata"],
    fleet,
  };
}

/** The team defined in `repo`'s `.fleet/` (`home` expands `~/` ledgers), or why it is refused. */
export function readTeam(repo: string, home: string): Team | Why {
  const dir = join(repo, ".fleet", "agents");
  const files = isDir(dir) ? listDir(dir).filter((f) => f.endsWith(".json")).sort() : [];

  if (files.length === 0) return { why: `no agents defined: ${dir}/<name>.json defines one` };
  const agents: Agent[] = [];

  for (const file of files) {
    const agent = parseAgent(file.slice(0, -".json".length), readText(join(dir, file)) ?? "", home);

    if ("why" in agent) return agent;
    agents.push(agent);
  }

  const teamText = readText(join(repo, ".fleet", "team.json"));
  const teamRaw = teamText === undefined ? {} : Option.getOrUndefined(parseObject(teamText));

  if (teamRaw === undefined) return { why: "team.json is not a JSON object" };
  const session = stringField(teamRaw, "session", "team.json");

  if ("why" in session) return session;
  const name = session.text ?? basename(repo);

  if (!SESSION.test(name))
    return {
      why: `${session.text === undefined ? `the repo's folder name '${name}', the team's session,` : `team.json: session '${name}'`} is not a session name: letters, digits, ., _ and -, starting with a letter or digit, at most 64; .fleet/team.json's "session" names another`,
    };

  return { repo, session: name, agents };
}

/** The agent's first prompt: its opening, and the ledger it picks up when it has one. */
export function openingOf(agent: Agent, ledger: string | undefined): string {
  return ledger === undefined ? agent.fleet.opening : `${agent.fleet.opening} Your ledger is ${ledger}.`;
}
