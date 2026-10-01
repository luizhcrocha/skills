import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { codeChanged, fingerprint, supervised } from "../src/hub/reload.ts";

const envOf = (vars: Readonly<Record<string, string>>) => (name: string): string | undefined => vars[name];

describe("supervised", () => {
  test("systemd's INVOCATION_ID or launchd's job label count; a plain shell does not", () => {
    expect(supervised(envOf({ INVOCATION_ID: "b3f9c8e5" }))).toBe(true);
    expect(supervised(envOf({ XPC_SERVICE_NAME: "org.nix-community.home.fleet-hub" }))).toBe(true);
    expect(supervised(envOf({ XPC_SERVICE_NAME: "0" }))).toBe(false);
    expect(supervised(envOf({}))).toBe(false);
  });
});

describe("the hub's sources", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fleet-reload-"));
    mkdirSync(join(root, "src", "hub"), { recursive: true });
    writeFileSync(join(root, "src", "hub", "server.ts"), "export {};\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "bun.lock"), "{}\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("the fingerprint moves with an edit, a new file and the lockfile, and stays put otherwise", () => {
    const before = fingerprint(root);

    expect(fingerprint(root)).toBe(before);

    writeFileSync(join(root, "src", "hub", "server.ts"), "export const a = 1;\n");
    const edited = fingerprint(root);

    expect(edited).not.toBe(before);

    writeFileSync(join(root, "src", "hub", "new.ts"), "export {};\n");
    expect(fingerprint(root)).not.toBe(edited);

    const added = fingerprint(root);

    utimesSync(join(root, "bun.lock"), new Date(0), new Date(0));
    expect(fingerprint(root)).not.toBe(added);
  });

  test("a change that holds still for one look ends the watch; no change never does", async () => {
    const quiet = codeChanged(root, 20);
    const nothing = await Promise.race([quiet.changed.then(() => "changed"), Bun.sleep(120).then(() => "quiet")]);

    quiet.stop();
    expect(nothing).toBe("quiet");

    const watch = codeChanged(root, 20);

    writeFileSync(join(root, "src", "hub", "server.ts"), "export const b = 2;\n");
    const seen = await Promise.race([watch.changed.then(() => "changed"), Bun.sleep(1000).then(() => "timeout")]);

    watch.stop();
    expect(seen).toBe("changed");
  });
});
