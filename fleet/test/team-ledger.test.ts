/**
 * Where a standing agent's ledger lives (src/team/ledger.ts): the file's own `fleet.ledger`, else the one the
 * registry knows by the agent's name, where it is, else `~/.local/state/fleet/<name>`. Nothing is moved. Every
 * home here is a temporary one.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { Entry } from "../src/registry.ts";
import { parseAgent, type Agent } from "../src/team/agents.ts";
import { ledgerOf } from "../src/team/ledger.ts";
import { tmp } from "./support.ts";

function agent(text = '{"fleet": {"role": "coordinator"}}', home = ""): Agent {
  const parsed = parseAgent("ui", text, home);

  if ("why" in parsed) throw new Error(parsed.why);

  return parsed;
}

function entry(id: string, dir: string, session: string | null = id): Entry {
  return { id, dir, role: "coordinator", url: "", session, since: "", aliases: [], raw: {} };
}

function ledgerAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), '{"project": "ui"}');

  return dir;
}

describe("an agent's ledger", () => {
  test("the file's own ledger is used where it is", () => {
    const home = tmp("fleet-team-home-");

    expect(ledgerOf(agent('{"fleet": {"role": "coordinator", "ledger": "/x/led"}}'), [entry("ui", "/elsewhere")], home)).toEqual({ ledger: "/x/led" });
  });

  test("an agent the registry does not know gets its fixed home", () => {
    const home = tmp("fleet-team-home-");

    expect(ledgerOf(agent(), [entry("web", "/w")], home)).toEqual({ ledger: join(home, ".local/state/fleet/ui") });
  });

  test("a ledger the registry knows outside the fixed homes is used where it is, nothing moved", () => {
    const home = tmp("fleet-team-home-");
    const old = ledgerAt(join(home, "scratch", "sess", "scratchpad", "fleet"));
    writeFileSync(join(old, "cloud.json"), "{}");

    expect(ledgerOf(agent(), [entry("ui", old)], home)).toEqual({ ledger: old });
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(readdirSync(old).sort()).toEqual(["cloud.json", "state.json"]);
    expect(existsSync(join(home, ".local/state/fleet/ui"))).toBe(false);
  });

  test("the registry knows the agent by its session's name too", () => {
    const home = tmp("fleet-team-home-");
    const old = ledgerAt(join(home, "scratch", "fleet"));

    expect(ledgerOf(agent(), [entry("ui-2", old, "3.ui")], home)).toEqual({ ledger: old });
  });

  test("a ledger in a fixed home reached through a symlink is the folder the symlink leads to", () => {
    const home = tmp("fleet-team-home-");
    const fixed = ledgerAt(join(home, ".local/state/fleet/skills"));
    const link = join(home, "old-scratchpad");
    symlinkSync(fixed, link);

    expect(ledgerOf(agent(), [entry("ui", link)], home)).toEqual({ ledger: fixed });
  });

  test("two registry entries for the agent in different folders are refused, naming both", () => {
    const home = tmp("fleet-team-home-");
    const a = ledgerAt(join(home, "a", "fleet"));
    const b = ledgerAt(join(home, "b", "fleet"));

    expect(ledgerOf(agent(), [entry("ui", a), entry("ui-old", b, "2.ui")], home)).toEqual({
      why: `ui: the registry knows 2 ledgers by its name, in different folders (${a}, ${b}); remove the stale entries so one is left`,
    });
  });

  test("two registry entries for the agent in one folder are one ledger", () => {
    const home = tmp("fleet-team-home-");
    const a = ledgerAt(join(home, "a", "fleet"));
    const link = join(home, "link");
    symlinkSync(a, link);

    expect(ledgerOf(agent(), [entry("ui", a), entry("ui-old", link, "2.ui")], home)).toEqual({ ledger: a });
  });
});
