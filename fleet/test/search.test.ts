/**
 * `fleet search`: the index over every command's help, its ranking, the no-match line, and the one mention of
 * it in `fleet --help` and the unknown-command error.
 */
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { COMMAND_NAMES } from "../src/cli/commands.ts";
import { entriesOf, scoreOf, search, termsOf } from "../src/cli/search.ts";
import { baseEnv, fleet, tmp, type Environment } from "./support.ts";

let env: Environment;

beforeEach(() => {
  env = baseEnv(join(tmp(), "home"));
});

/** The command lines `fleet search WORDS` prints, without their summaries and --help lines. */
function lines(...words: string[]): string[] {
  return fleet(["search", ...words], env)
    .stdout.split("\n")
    .filter((l) => l.startsWith("fleet "))
    .map((l) => l.split(" — ")[0] ?? "");
}

describe("ranking", () => {
  test("a word in the name outranks the same word in a summary", () => {
    const team = { command: "team", verb: "add", line: "fleet team add NAME", summary: "write an agent", text: "" };
    const ws = { command: "ws", verb: "add", line: "fleet ws DIR add NAME", summary: "add a workspace", text: "" };
    const terms = termsOf(["workspace", "add"]);
    expect([scoreOf(ws, terms), scoreOf(team, terms)]).toEqual([4, 3]);
    expect(scoreOf(ws, termsOf(["workspaces"]))).toBe(1);
    expect([scoreOf(ws, termsOf(["work"])), scoreOf(ws, termsOf(["worker"]))]).toEqual([1, 0]);
  });

  test("the subcommand whose name and options fit comes first, with its --help", () => {
    const ran = fleet(["search", "chat", "say"], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout.split("\n").slice(0, 2)).toEqual([
      "fleet chat DIR say --as WHO [--re N] [--decision D] [--mark N[,N...] [--no-change WHY]] TEXT — append a message from WHO",
      "  fleet chat --help",
    ]);
    expect(lines("workspace", "add")[0]).toStartWith("fleet ws DIR add NAME");
    expect(lines("landing", "turn")[0]).toBe("fleet turn [DIR]");
    expect(lines("room", "say")[0]).toBe("fleet room PROJECT say [--as TEAM] [--re K] TEXT");
    expect(lines("preview", "share")[0]).toBe("fleet preview share FLEET [WORKER] [--for 24h] [--password-file F]");
    expect(lines("step", "next")[0]).toBe("fleet state DIR step next --milestone M --title T");
  });

  test("at most five hits, two lines each", () => {
    const out = fleet(["search", "fleet"], env).stdout.split("\n").filter((l) => l !== "");
    expect(out.length).toBe(10);
  });

  test("every command's help gives its own entry, and the index never reads a continuation as a subcommand", () => {
    const tab = search([{ name: "tab", help: "usage: fleet tab {run,wait} ...\n\n    run --as W   start it\n                 run COMMAND in a tab\n    wait BLOCK   block" }], ["run"]);
    expect(tab.map((e) => e.line)).toEqual(["fleet tab run --as W", "fleet tab …"]);
    expect(entriesOf({ name: "brief", help: "usage: fleet brief DIR WORKER", about: "a brief" })).toEqual([
      { command: "brief", verb: undefined, line: "fleet brief DIR WORKER", summary: "a brief", text: "a brief fleet brief DIR WORKER" },
    ]);
  });
});

describe("no match", () => {
  test("says so and names every top-level command on one line, exit 1", () => {
    const ran = fleet(["search", "zzzq", "qqqz"], env);
    expect([ran.code, ran.stdout]).toEqual([1, `no fleet command matches 'zzzq qqqz'; the commands: ${COMMAND_NAMES.join(", ")}\n`]);
  });

  test("no words is a usage error", () => {
    expect(fleet(["search"], env).code).toBe(2);
    expect(fleet(["search", "the"], env).code).toBe(2);
  });
});

describe("the mention", () => {
  test("fleet --help lists each command and says fleet search finds one, once", () => {
    const ran = fleet(["--help"], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout.split("`fleet search <words>` finds a command").length).toBe(2);
    expect(ran.stdout).toContain("\n  turn     whether this fleet holds the landing turn");
  });

  test("an unknown command's error says it on its first line", () => {
    const ran = fleet(["nope"], env);
    expect([ran.code, ran.stderr.split("\n")[0]]).toEqual([2, "fleet: no command 'nope': `fleet search <words>` finds a command"]);
  });

  test("fleet COMMAND --help prints the table's help, for a command whose parser has none of its own too", () => {
    expect(fleet(["turn", "--help"], env)).toEqual({ code: 0, stdout: "usage: fleet turn [DIR]\n", stderr: "" });
    expect(fleet(["served", "-h"], env).stdout).toBe("usage: fleet served\n");
    expect(fleet(["room", "--help"], env).stdout).toStartWith("usage: fleet room PROJECT {");
  });
});
