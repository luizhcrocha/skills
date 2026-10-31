/**
 * A repo's standing agents (`.fleet/agents/<name>.json`, src/team/agents.ts): the Agents SDK's fields, the
 * `fleet` block, the defaults a role gives, the session `.fleet/team.json` names, and the sentence that names
 * the field a bad file gets wrong.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { openingOf, parseAgent, readTeam } from "../src/team/agents.ts";
import { tmp } from "./support.ts";

function repoWith(files: Readonly<Record<string, string>>): string {
  const repo = tmp("fleet-team-repo-");
  mkdirSync(join(repo, ".fleet", "agents"), { recursive: true });

  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, ".fleet", path), text);

  return repo;
}

describe("an agent's file", () => {
  test("a coordinator's file of one line takes the rest from its role", () => {
    expect(parseAgent("ui", '{"fleet": {"role": "coordinator"}}')).toEqual({
      name: "ui",
      description: "The ui coordinator",
      model: { id: "opus", effort: "low" },
      system: undefined,
      tools: undefined,
      multiagent: undefined,
      metadata: undefined,
      fleet: { role: "coordinator", opening: "/tstack:coordinator", remote_control: true, machine: "local", ledger: undefined, project: undefined },
    });
  });

  test("a manager opens with the manager skill", () => {
    const agent = parseAgent("boss", '{"fleet": {"role": "manager"}}');

    expect("why" in agent ? agent.why : agent.fleet.opening).toBe("/tstack:manager");
  });

  test("every field given is kept, tools and multiagent included", () => {
    const text = JSON.stringify({
      name: "ui",
      description: "Runs the UI fleet",
      model: { id: "claude-opus-5-5", effort: "medium" },
      system: "You run the UI fleet.",
      tools: [{ type: "agent_toolset_20260401" }],
      multiagent: { agents: ["reviewer"] },
      metadata: { owner: "luiz" },
      fleet: { role: "coordinator", opening: "/tstack:coordinator go", remote_control: false, machine: "local", ledger: "/x/ledger", project: "court" },
    });

    expect(parseAgent("ui", text)).toEqual({
      name: "ui",
      description: "Runs the UI fleet",
      model: { id: "claude-opus-5-5", effort: "medium" },
      system: "You run the UI fleet.",
      tools: [{ type: "agent_toolset_20260401" }],
      multiagent: { agents: ["reviewer"] },
      metadata: { owner: "luiz" },
      fleet: { role: "coordinator", opening: "/tstack:coordinator go", remote_control: false, machine: "local", ledger: "/x/ledger", project: "court" },
    });
  });

  test.each([
    ["not json", "{", "ui.json is not a JSON object"],
    ["no role", "{}", "ui.json: fleet.role is required: manager or coordinator"],
    ["a role of no kind", '{"fleet": {"role": "worker"}}', "ui.json: fleet.role is 'worker'; it is manager or coordinator"],
    ["another name", '{"name": "web", "fleet": {"role": "coordinator"}}', "ui.json: name is 'web'; it must be the file's name, 'ui'"],
    ["an effort of no level", '{"model": {"id": "opus", "effort": "huge"}, "fleet": {"role": "coordinator"}}', "ui.json: model.effort is 'huge'; it is one of low, medium, high, xhigh, max"],
    ["a model with no id", '{"model": {"effort": "low"}, "fleet": {"role": "coordinator"}}', "ui.json: model.id is required when model is given"],
    ["an unknown field", '{"modle": "opus", "fleet": {"role": "coordinator"}}', "ui.json: modle is not a field of an agent (name, description, model, system, tools, multiagent, metadata, fleet)"],
    ["an unknown fleet field", '{"fleet": {"role": "coordinator", "openning": "x"}}', "ui.json: fleet.openning is not a field of the fleet block (role, opening, remote_control, machine, ledger, project)"],
    ["a remote_control that is no bool", '{"fleet": {"role": "coordinator", "remote_control": "yes"}}', "ui.json: fleet.remote_control is true or false"],
    ["an empty opening", '{"fleet": {"role": "coordinator", "opening": ""}}', "ui.json: fleet.opening is a non-empty string"],
    ["a relative ledger", '{"fleet": {"role": "coordinator", "ledger": "led"}}', "ui.json: fleet.ledger is an absolute path (or ~/...)"],
    ["a project that is no project id", '{"fleet": {"role": "coordinator", "project": "Court Integrations"}}', "ui.json: fleet.project is 'Court Integrations'; it is a project's id (lower-case letters, digits and -), as `fleet project list` prints it"],
  ])("%s is refused with a sentence naming the field", (_, text, why) => {
    expect(parseAgent("ui", text)).toEqual({ why });
  });

  test("a name that is not lower-case letters, digits, - and _ is refused", () => {
    expect(parseAgent("UI team", '{"fleet": {"role": "coordinator"}}')).toEqual({ why: "UI team.json: name 'UI team' is lower-case letters, digits, - and _, starting with a letter, at most 32" });
  });

  test("a ledger under ~ is the home's", () => {
    const agent = parseAgent("ui", '{"fleet": {"role": "coordinator", "ledger": "~/led"}}', "/home/u");

    expect("why" in agent ? agent.why : agent.fleet.ledger).toBe("/home/u/led");
  });
});

describe("the team of a repo", () => {
  test("the session is the repo's folder, the agents its files by name", () => {
    const repo = repoWith({ "agents/ui.json": '{"fleet": {"role": "coordinator"}}', "agents/boss.json": '{"fleet": {"role": "manager"}}', "agents/notes.txt": "x" });
    const team = readTeam(repo, "/home/u");

    expect("why" in team ? team.why : { session: team.session, names: team.agents.map((a) => a.name) }).toEqual({ session: basename(repo), names: ["boss", "ui"] });
  });

  test("team.json names the session", () => {
    const repo = repoWith({ "agents/ui.json": '{"fleet": {"role": "coordinator"}}', "team.json": '{"session": "skills"}' });
    const team = readTeam(repo, "/home/u");

    expect("why" in team ? team.why : team.session).toBe("skills");
  });

  test("a bad file refuses the team, naming it", () => {
    const repo = repoWith({ "agents/ui.json": '{"fleet": {"role": "boss"}}' });

    expect(readTeam(repo, "/home/u")).toEqual({ why: "ui.json: fleet.role is 'boss'; it is manager or coordinator" });
  });

  test("a repo with no agents says where they go", () => {
    const repo = tmp("fleet-team-empty-");

    expect(readTeam(repo, "/home/u")).toEqual({ why: `no agents defined: ${repo}/.fleet/agents/<name>.json defines one` });
  });
});

describe("what a tab runs", () => {
  test("the opening names the ledger", () => {
    const agent = parseAgent("ui", '{"fleet": {"role": "coordinator"}}');

    if ("why" in agent) throw new Error(agent.why);
    expect(openingOf(agent, "/s/fleet/ui")).toBe("/tstack:coordinator Your ledger is /s/fleet/ui.");
    expect(openingOf(agent, undefined)).toBe("/tstack:coordinator");
  });
});
