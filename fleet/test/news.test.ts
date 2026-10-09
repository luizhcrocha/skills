/**
 * The machine's news (`fleet news`): items that wake nobody, a cursor per fleet, and the one line a state
 * command and a chat watch's wake print for unread news. Python's tests/test_news.py, ported.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { TEXT_MAX, unread, unreadLine } from "../src/news/news.ts";
import type { Machine } from "../src/world.ts";
import { baseEnv, fleet, machine, tmp, type Environment, type Ran } from "./support.ts";

let base: string;

let home: string;

let env: Environment;

let m: Machine;

function news(...args: string[]): Ran {
  return fleet(["news", ...args], env);
}

function served(name: string): string {
  const root = join(base, name);
  expect(fleet(["state", root, "init", "--project", name, "--goal", "g", "--no-render"], env).code).toBe(0);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, `${name}.json`), JSON.stringify({ id: name, role: "coordinator", dir: root, url: "u", pid: process.pid, session: null, since: "2026-01-05T08:00:00+00:00" }));

  return root;
}

beforeEach(() => {
  base = tmp();
  home = join(base, "registry");
  env = baseEnv(home, { FLEET_NOW: "2026-01-05T09:00:00+00:00", TZ: "UTC" });
  m = machine(env);
});

describe("post and read", () => {
  test("cursors are per fleet, and a reader never sees its own items", () => {
    expect(news("post", "--from", "skills", "--kind", "release", "1.9.20 is out").code).toBe(0);
    expect(news("post", "--from", "pipeline", "--to", "infra", "schema moved").code).toBe(0);
    expect(news("post", "--from", "skills", "--to", "pipeline", "--kind", "rule", "--keep", "gate slot first").code).toBe(0);
    expect(unread(m, "pipeline").map((i) => i.id)).toEqual([1, 3]);
    expect(unread(m, "infra").map((i) => i.id)).toEqual([1, 2]);
    expect(news("read", "--as", "pipeline").stdout).toBe(
      "#1 2026-01-05 09:00 skills -> all [release, do not save]: 1.9.20 is out\n#3 2026-01-05 09:00 skills -> pipeline [rule, keep]: gate slot first\n",
    );
    expect(news("read", "--as", "pipeline").stdout).toBe("no news for pipeline\n");
    expect(unread(m, "infra").map((i) => i.id)).toEqual([1, 2]);
    expect(readFileSync(join(home, "news", "read", "pipeline"), "utf8")).toBe("3");
    news("post", "--from", "infra", "--to", "pipeline,infra", "staging is back");
    expect(unread(m, "pipeline").map((i) => i.id)).toEqual([4]);
    expect(unread(m, "infra").map((i) => i.id)).toEqual([1, 2]);
  });

  test("refusals write nothing", () => {
    for (const [args, why] of [
      [["--to", "all,infra", "x"], "--to is `all` or a list of fleets"],
      [["  "], "the item has no text"],
      [["x".repeat(TEXT_MAX + 1)], `at most ${TEXT_MAX} characters`],
    ] as const) {
      const out = news("post", "--from", "skills", ...args);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain(why);
    }

    expect(existsSync(join(home, "news", "news.jsonl"))).toBe(false);
    expect(news("post", "--from", "skills", "--kind", "act", "x").code).toBe(2);
  });
});

describe("the unread line", () => {
  test("state commands and the watch's wake name unread news; reading it clears the line", () => {
    const root = served("pipeline");
    const show = (): string => fleet(["state", root, "show"], env).stderr;
    expect(show()).toBe("");
    news("post", "--from", "skills", "--to", "infra", "not for pipeline");
    expect(show()).toBe("");
    news("post", "--from", "skills", "1.9.20 is out");
    const line = "news: 1 unread for pipeline, never a wake: `fleet news read --as pipeline`\n";
    expect(show()).toBe(line);
    appendFileSync(join(root, "chat.jsonl"), `${JSON.stringify({ id: 1, at: "2026-01-05T09:00:00+00:00", from: "user", to: ["coordinator"], text: "hi", re: null })}\n`);
    expect(fleet(["chat", root, "watch", "--as", "coordinator", "--all", "--resume", "--once"], env).stdout).toBe(`#1 user -> coordinator: hi\n${line}`);
    news("read", "--as", "pipeline");
    expect(unreadLine(m, root)).toBeUndefined();
    expect(show()).toBe("");
  });

  test("a fleet the registry does not name hears nothing", () => {
    news("post", "--from", "skills", "for everyone");
    expect(unreadLine(m, join(base, "nowhere"))).toBeUndefined();
  });
});
