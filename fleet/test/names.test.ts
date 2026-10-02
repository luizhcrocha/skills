import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withFleetDir } from "../src/cli/run.ts";
import { machineOf } from "../src/world.ts";
import { aliasesAfter, dropsNumber, fleetName, unnumbered } from "../src/registry.ts";
import { isHubProcess } from "../src/hub/server.ts";

describe("a fleet's name from its session's", () => {
  test("the number Claude Code puts before a restarted session goes", () => {
    expect(unnumbered("3.ui-coordinator")).toBe("ui-coordinator");
    expect(unnumbered("12.manager")).toBe("manager");
    expect(unnumbered("ui-coordinator")).toBe("ui-coordinator");
    expect(unnumbered("3.")).toBe("3.");
    expect(unnumbered("v2.ui")).toBe("v2.ui");
    expect(fleetName("3.UI Coordinator")).toBe("ui-coordinator");
  });

  test("the old id becomes an alias only when the new one is it without its number", () => {
    expect(dropsNumber("3.ui-coordinator", "ui-coordinator")).toBe(true);
    expect(dropsNumber("ui-coordinator", "billing")).toBe(false);
    expect(aliasesAfter({}, "3.ui-coordinator", "ui-coordinator")).toEqual(["3.ui-coordinator"]);
    expect(aliasesAfter({ aliases: ["2.ui-coordinator"] }, "3.ui-coordinator", "ui-coordinator")).toEqual(["2.ui-coordinator", "3.ui-coordinator"]);
    expect(aliasesAfter({ aliases: ["ui-coordinator"] }, "x", "ui-coordinator")).toEqual([]);
    expect(aliasesAfter({}, "billing", "invoices")).toEqual([]);
  });
});

describe("a hub process", () => {
  test("this test runner is not one", () => {
    expect(isHubProcess(process.pid)).toBe(false);
  });
});

describe("a fleet named instead of its directory", () => {
  test("a bare name is the served fleet's directory; paths, flags and unknown names pass as given", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-names-"));
    const dir = mkdtempSync(join(tmpdir(), "fleet-dir-"));

    writeFileSync(join(dir, "state.json"), "{}\n");
    const env = (name: string): string | undefined => (name === "FLEET_HOME" ? home : process.env[name]);
    const machine = machineOf(() => new Date("2026-10-02T12:00:00Z"), env);

    machine.registry.register(dir, "http://127.0.0.1:7420/f/x/", process.pid, "2026-10-02T12:00:00Z");
    const id = machine.registry.find(dir)?.id ?? "";

    expect(withFleetDir(["preview", id, "start"], machine)).toEqual(["preview", dir, "start"]);
    expect(withFleetDir(["state", dir, "show"], machine)).toEqual(["state", dir, "show"]);
    expect(withFleetDir(["state", "nosuch", "show"], machine)).toEqual(["state", "nosuch", "show"]);
    expect(withFleetDir(["fleets", id], machine)).toEqual(["fleets", id]);
    expect(withFleetDir(["state", "--help"], machine)).toEqual(["state", "--help"]);

    const second = mkdtempSync(join(tmpdir(), "fleet-dir-"));

    writeFileSync(join(second, "state.json"), "{}\n");
    machine.registry.register(second, "http://127.0.0.1:7420/f/y/", process.pid, "2026-10-02T12:00:01Z");
    machine.registry.name(dir, "ui-coordinator");
    machine.registry.name(second, "infra-coordinator");

    expect(withFleetDir(["preview", "ui", "start"], machine)).toEqual(["preview", dir, "start"]);
    expect(withFleetDir(["chat", "INFRA", "log"], machine)).toEqual(["chat", second, "log"]);
    expect(withFleetDir(["chat", "-coord", "log"], machine)).toEqual(["chat", "-coord", "log"]);
    expect(withFleetDir(["state", "coord", "show"], machine)).toEqual({ name: "coord", fits: ["infra-coordinator", "ui-coordinator"] });
    rmSync(second, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
