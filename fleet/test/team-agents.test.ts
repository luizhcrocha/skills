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
      fleet: { role: "coordinator", opening: "/tstack:coordinator", mission: undefined, remote_control: true, machine: "local", ledger: undefined, project: undefined },
    });
  });

  test("a manager opens with the manager skill", () => {
    const agent = parseAgent("boss", '{"fleet": {"role": "manager"}}');

    expect("why" in agent ? agent.why : agent.fleet.opening).toBe("/tstack:manager");
  });

  test("a coordinator with a mission opens with tuca-mode, which makes the session a coordinator, carrying the mission", () => {
    const agent = parseAgent("api", '{"fleet": {"role": "coordinator", "project": "court", "mission": "Sync the court data"}}');

    expect("why" in agent ? agent.why : agent.fleet).toMatchObject({ opening: "/tstack:tuca-mode Sync the court data", mission: "Sync the court data" });
  });

  test("a mission of 2000 characters is taken whole", () => {
    const mission = "é".repeat(2000);
    const agent = parseAgent("api", JSON.stringify({ fleet: { role: "coordinator", mission } }));

    expect("why" in agent ? agent.why : agent.fleet.mission).toBe(mission);
  });

  test("a manager with a mission opens with the manager skill carrying it", () => {
    const agent = parseAgent("boss", '{"fleet": {"role": "manager", "mission": "Land the court work"}}');

    expect("why" in agent ? agent.why : agent.fleet.opening).toBe("/tstack:manager Land the court work");
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
      fleet: { role: "coordinator", opening: "/tstack:coordinator go", mission: undefined, remote_control: false, machine: "local", ledger: "/x/ledger", project: "court" },
    });

    expect(parseAgent("ui", text)).toEqual({
      name: "ui",
      description: "Runs the UI fleet",
      model: { id: "claude-opus-5-5", effort: "medium" },
      system: "You run the UI fleet.",
      tools: [{ type: "agent_toolset_20260401" }],
      multiagent: { agents: ["reviewer"] },
      metadata: { owner: "luiz" },
      fleet: { role: "coordinator", opening: "/tstack:coordinator go", mission: undefined, remote_control: false, machine: "local", ledger: "/x/ledger", project: "court" },
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
    ["an unknown fleet field", '{"fleet": {"role": "coordinator", "openning": "x"}}', "ui.json: fleet.openning is not a field of the fleet block (role, opening, mission, remote_control, machine, ledger, project)"],
    ["a remote_control that is no bool", '{"fleet": {"role": "coordinator", "remote_control": "yes"}}', "ui.json: fleet.remote_control is true or false"],
    ["an empty opening", '{"fleet": {"role": "coordinator", "opening": ""}}', "ui.json: fleet.opening is a non-empty string"],
    ["a relative ledger", '{"fleet": {"role": "coordinator", "ledger": "led"}}', "ui.json: fleet.ledger is an absolute path (or ~/...)"],
    ["a project that is no project id", '{"fleet": {"role": "coordinator", "project": "Court Integrations"}}', "ui.json: fleet.project is 'Court Integrations'; it is a project's id (lower-case letters, digits and -), as `fleet project list` prints it"],
    ["an empty mission", '{"fleet": {"role": "coordinator", "mission": ""}}', "ui.json: fleet.mission is a non-empty string"],
    [
      "a mission of two lines",
      '{"fleet": {"role": "coordinator", "mission": "Sync the court.\\nThen the rest."}}',
      "ui.json: fleet.mission is one line: the opening is typed into the agent's prompt, where each line would be sent alone",
    ],
    [
      "a mission holding an escape",
      '{"fleet": {"role": "coordinator", "mission": "Sync \\u001b[2Jthe court"}}',
      "ui.json: fleet.mission holds a control character (U+001B): it is plain text typed into the agent's prompt",
    ],
    ["a mission holding a tab", '{"fleet": {"role": "coordinator", "mission": "Sync\\tthe court"}}', "ui.json: fleet.mission holds a control character (U+0009): it is plain text typed into the agent's prompt"],
    ["a blank mission", '{"fleet": {"role": "coordinator", "mission": "   "}}', "ui.json: fleet.mission is blank: it says what the agent is started to do"],
    [
      "a mission over 2000 characters",
      JSON.stringify({ fleet: { role: "coordinator", mission: "é".repeat(2001) } }),
      "ui.json: fleet.mission is 2001 characters, over 2000: the opening types it whole into the agent's prompt; put the detail in a file of the repo and name the file in the mission",
    ],
    [
      "both an opening and a mission",
      '{"fleet": {"role": "coordinator", "opening": "/tstack:coordinator", "mission": "Sync the court."}}',
      "ui.json: names both fleet.opening and fleet.mission; the mission goes in the role's opening: drop fleet.opening",
    ],
  ])("%s is refused with a sentence naming the field", (_, text, why) => {
    expect(parseAgent("ui", text)).toEqual({ why });
  });

  test("a name that is not lower-case letters, digits, - and _ is refused", () => {
    expect(parseAgent("UI team", '{"fleet": {"role": "coordinator"}}')).toEqual({ why: "UI team.json: name 'UI team' is lower-case letters, digits, - and _, starting with a letter, at most 32" });
  });

  test("an agent of a project whose name holds _ is refused: its name is its team's id, which holds no _", () => {
    expect(parseAgent("ui_x", '{"fleet": {"role": "coordinator", "project": "court"}}')).toEqual({
      why: "ui_x.json: an agent of a project (fleet.project) is named by lower-case letters, digits and - only: its name is its team's id; rename the file",
    });
    expect(parseAgent("ui_x", '{"fleet": {"role": "coordinator"}}')).toMatchObject({ name: "ui_x" });
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

  test("the ledger is a sentence of its own after a mission", () => {
    const opened = (mission: string, ledger: string | undefined): string => {
      const agent = parseAgent("api", JSON.stringify({ fleet: { role: "coordinator", mission } }));

      if ("why" in agent) throw new Error(agent.why);

      return openingOf(agent, ledger);
    };

    expect(opened("Sync the court data", "/s/fleet/api")).toBe("/tstack:tuca-mode Sync the court data. Your ledger is /s/fleet/api.");
    expect(opened("Sync the court data.", "/s/fleet/api")).toBe("/tstack:tuca-mode Sync the court data. Your ledger is /s/fleet/api.");
    expect(opened("Is the sync done?", "/s/fleet/api")).toBe("/tstack:tuca-mode Is the sync done? Your ledger is /s/fleet/api.");
    expect(opened("Sync the court data", undefined)).toBe("/tstack:tuca-mode Sync the court data");
  });
});
