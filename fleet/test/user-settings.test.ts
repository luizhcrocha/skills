/**
 * A rule card's Add this rule writes the user's settings (user-settings.ts): the real file behind
 * `$HOME/.claude/settings.json`, the entry appended to `autoMode.allow` with `"$defaults"` kept first and every other
 * key and entry kept, two-space JSON with a trailing newline, an identical entry skipped, under the lock beside it.
 * Every test runs in a temp HOME, never the real one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../src/json.ts";
import { Ungranted } from "../src/hub/settings-file.ts";
import { addAutoModeRule, userSettingsFile } from "../src/hub/user-settings.ts";

let home: string;

let dotfiles: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "user-settings-"));
  home = join(base, "home");
  dotfiles = join(base, "dotfiles", "claude");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(dotfiles, { recursive: true });
});

afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
});

const RULE = "Removing a finished jj workspace: `jj workspace forget <name>` in a repo under /home/u/repos.\nNot covered: the default workspace, `jj abandon`, deleting the folder.";

const noRecord = (): undefined => undefined;

const json = (settings: JsonObject): string => `${JSON.stringify(settings, null, 2)}\n`;

describe("where a rule goes", () => {
  test("the link's target, so the dotfiles checkout holds the rule and the link stays a link", async () => {
    const target = join(dotfiles, "settings.json");
    writeFileSync(target, json({ model: "opus", permissions: { allow: ["Bash(ls)"] }, autoMode: { allow: ["$defaults", "K18 entry"], soft_deny: ["x"] }, hooks: {} }));
    chmodSync(target, 0o640);
    symlinkSync(target, join(home, ".claude", "settings.json"));

    const file = userSettingsFile(home);
    expect(file).toBe(target);
    expect(await addAutoModeRule(target, RULE, noRecord)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(json({ model: "opus", permissions: { allow: ["Bash(ls)"] }, autoMode: { allow: ["$defaults", "K18 entry", RULE], soft_deny: ["x"] }, hooks: {} }));
    expect(lstatSync(join(home, ".claude", "settings.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".claude", "settings.json"))).toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(existsSync(join(dotfiles, ".settings.local.json.lock"))).toBe(false);
  });

  test("a settings with no autoMode.allow gets one that keeps the defaults: $defaults first, then the rule", async () => {
    const file = join(home, ".claude", "settings.json");
    expect(userSettingsFile(home)).toBe(file);
    expect(await addAutoModeRule(file, RULE, noRecord)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(json({ autoMode: { allow: ["$defaults", RULE] } }));
    writeFileSync(file, json({ autoMode: { soft_deny: ["y"] } }));
    expect(await addAutoModeRule(file, RULE, noRecord)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(json({ autoMode: { soft_deny: ["y"], allow: ["$defaults", RULE] } }));
  });

  test("no HOME, or a link to a file that is not there, is no place to write", () => {
    expect(userSettingsFile(undefined)).toBeInstanceOf(Ungranted);
    expect(userSettingsFile("relative/home")).toBeInstanceOf(Ungranted);
    symlinkSync(join(dotfiles, "gone.json"), join(home, ".claude", "settings.json"));
    const none = userSettingsFile(home);
    expect(none instanceof Ungranted ? none.reason : none).toContain("cannot be resolved");
  });
});

describe("what the write keeps", () => {
  test("an identical entry is skipped and the file is left byte for byte", async () => {
    const file = join(home, ".claude", "settings.json");
    const text = JSON.stringify({ autoMode: { allow: ["$defaults", RULE] } });
    writeFileSync(file, text);
    expect(await addAutoModeRule(file, RULE, noRecord)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("a file that does not parse, or whose autoMode or autoMode.allow is malformed, is not touched", async () => {
    const file = join(home, ".claude", "settings.json");
    writeFileSync(file, "{ not json");
    expect(await addAutoModeRule(file, RULE, noRecord)).toBeInstanceOf(Ungranted);
    writeFileSync(file, '{"autoMode": {"allow": "x"}}');
    const got = await addAutoModeRule(file, RULE, noRecord);
    expect(got instanceof Ungranted ? got.reason : got).toBe(`${file}: autoMode.allow is not a list`);
    expect(readFileSync(file, "utf8")).toBe('{"autoMode": {"allow": "x"}}');
    writeFileSync(file, '{"autoMode": ["x"]}');
    const notObject = await addAutoModeRule(file, RULE, noRecord);
    expect(notObject instanceof Ungranted ? notObject.reason : notObject).toBe(`${file}: autoMode is not an object`);
  });

  test("a record that cannot be written puts the file back as it was", async () => {
    const file = join(home, ".claude", "settings.json");
    const text = '{"model": "opus"}';
    writeFileSync(file, text);
    const got = await addAutoModeRule(file, RULE, () => new Ungranted("no record"));
    expect(got).toEqual(new Ungranted("no record"));
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("a change by another writer between the read and the rename aborts the write: the file stays theirs, and no scratch file is left", async () => {
    const file = join(home, ".claude", "settings.json");
    writeFileSync(file, '{"model": "opus"}');
    const theirs = '{"model": "sonnet", "autoMode": {"allow": ["$defaults"]}}';
    const got = await addAutoModeRule(file, RULE, noRecord, () => writeFileSync(file, theirs));
    expect(got).toBeInstanceOf(Ungranted);
    expect(got instanceof Ungranted ? got.reason : "").toBe(`could not add the rule to ${file}: ${file} changed since it was read (Claude Code or an editor wrote it): answer again`);
    expect(readFileSync(file, "utf8")).toBe(theirs);
    expect(readdirSync(join(home, ".claude")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a failed record puts the file back only while it is what was written: another writer's change after it stays", async () => {
    const file = join(home, ".claude", "settings.json");
    writeFileSync(file, '{"model": "opus"}');
    const theirs = '{"model": "sonnet"}';

    const got = await addAutoModeRule(file, RULE, () => {
      writeFileSync(file, theirs);

      return new Ungranted("no record");
    });

    expect(got).toEqual(new Ungranted(`no record; ${file} changed after the rule went in (Claude Code or an editor wrote it), so nothing was put back: take the rule out of autoMode.allow by hand if it is there`));
    expect(readFileSync(file, "utf8")).toBe(theirs);
  });

  test("a held lock refuses after its wait, and a stale one is taken over", async () => {
    const file = join(home, ".claude", "settings.json");
    const lock = join(home, ".claude", ".settings.local.json.lock");
    mkdirSync(lock);
    const held = await addAutoModeRule(file, RULE, noRecord);
    expect(held instanceof Ungranted ? held.reason : held).toContain("is held");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await addAutoModeRule(file, RULE, noRecord)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock another writer took over as stale while this one held it is released without an error", async () => {
    const file = join(home, ".claude", "settings.json");
    const lock = join(home, ".claude", ".settings.local.json.lock");

    // The other writer removed the lock as stale and finished before this one let go of it.
    const taken = (): undefined => {
      rmSync(lock, { recursive: true });

      return undefined;
    };

    expect(await addAutoModeRule(file, RULE, taken)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ autoMode: { allow: ["$defaults", RULE] } });
  });
});
