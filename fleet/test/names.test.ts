import { describe, expect, test } from "bun:test";
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
