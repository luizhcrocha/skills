/**
 * The hub's page and Stop tokens (tokens.ts) live in one file in the hub's state dir, `REGISTRY/hub/tokens.json`, so a
 * page opened before a restart still answers after it: made on the first start, reused after, replaced when it is not
 * trusted (unreadable, malformed, a token of the wrong length, a mode other than 0600, another owner, a symlink), always
 * written 0600 through a temp file and a rename. A token older than 24 h is replaced at the hub's start or when it is
 * checked, and the one it replaced is still accepted for 24 h. Every clock here is pinned; nothing sleeps.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePrivateDir } from "../src/files.ts";
import { grantRefusal, PAGE_TOKEN_HEADER, STALE_PAGE_TOKEN } from "../src/hub/policy.ts";
import { startHub } from "../src/hub/server.ts";
import { HubTokens, TOKEN_GRACE_MS, TOKEN_ROTATE_MS, tokensPath } from "../src/hub/tokens.ts";
import { baseEnv, machine, tmp } from "./support.ts";

const HOUR = 3_600_000;

let home: string;

let path: string;

let lines: string[];

let at: number;

const clock = (): number => at;

function open(uid?: number): HubTokens {
  return HubTokens.open(path, clock, { log: (line) => lines.push(line), uid });
}

/** A token file as a hub wrote it at `created`, with these tokens. */
function planted(page: string, stop: string, created = 0): string {
  return JSON.stringify({ page: { token: page, created }, stop: { token: stop, created } });
}

const PAGE = "p".repeat(32);

const STOP = "s".repeat(32);

function mode(): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fleet-tokens-"));
  path = tokensPath(home);
  lines = [];
  at = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the token file", () => {
  test("is the hub's state dir's tokens.json", () => {
    expect(path).toBe(join(home, "hub", "tokens.json"));
  });

  test("the first start makes it, 0600, with a page and a Stop token of 32 characters each, and no temp file left", () => {
    const tokens = open();
    expect(existsSync(path)).toBe(true);
    expect(mode()).toBe(0o600);
    expect(tokens.current("page")).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(tokens.current("stop")).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(tokens.current("page")).not.toBe(tokens.current("stop"));
    expect(readdirSync(join(home, "hub"))).toEqual(["tokens.json"]);
    expect(lines).toEqual([]);
  });

  test("the hub's state dir it makes is 0700", () => {
    open();
    expect(statSync(join(home, "hub")).mode & 0o777).toBe(0o700);
  });

  test("a hub state dir already there with another mode is made 0700", () => {
    mkdirSync(join(home, "hub"), { mode: 0o755 });
    chmodSync(join(home, "hub"), 0o755);
    open();
    expect(statSync(join(home, "hub")).mode & 0o777).toBe(0o700);
  });

  test("a symlink where the hub's state dir goes is left as it is: the directory it points at keeps its mode", () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o755 });
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(home, "hub"));
    makePrivateDir(join(home, "hub"));
    expect([lstatSync(join(home, "hub")).isSymbolicLink(), statSync(elsewhere).mode & 0o777]).toEqual([true, 0o755]);
  });

  test("a second start reuses it: an open page's token still answers", () => {
    const first = open();
    at = HOUR;
    const second = open();
    expect([second.current("page"), second.current("stop")]).toEqual([first.current("page"), first.current("stop")]);
  });

  test("a planted file the hub trusts is reused as it is", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP), { mode: 0o600 });
    const tokens = open();
    expect([tokens.current("page"), tokens.current("stop")]).toEqual([PAGE, STOP]);
  });

  for (const [what, text] of [
    ["not JSON", "{not json"],
    ["a token of the wrong length", planted("p".repeat(31), STOP)],
    ["a token with a character base64url has not", planted(`${"p".repeat(31)}=`, STOP)],
    ["no Stop token", JSON.stringify({ page: { token: PAGE, created: 0 } })],
    ["no creation time", JSON.stringify({ page: { token: PAGE }, stop: { token: STOP, created: 0 } })],
    ["an empty file", ""],
  ] as const) {
    test(`a malformed file (${what}) is replaced with new tokens, 0600`, () => {
      mkdirSync(join(home, "hub"));
      writeFileSync(path, text, { mode: 0o600 });
      const tokens = open();
      expect(tokens.current("page")).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      expect([tokens.current("page"), tokens.current("stop")]).not.toContain(PAGE);
      expect(mode()).toBe(0o600);
      expect(open().current("page")).toBe(tokens.current("page"));
      expect(lines.join("\n")).toContain("malformed");
    });
  }

  test("a file of another mode than 0600 is not trusted: new tokens, written 0600", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP), { mode: 0o644 });
    chmodSync(path, 0o644);
    const tokens = open();
    expect([tokens.current("page"), tokens.current("stop")]).not.toContain(PAGE);
    expect(tokens.current("stop")).not.toBe(STOP);
    expect(mode()).toBe(0o600);
    expect(lines.join("\n")).toContain("mode 0644");
  });

  test("an unreadable file (mode 0000) is not trusted: new tokens, written 0600", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP), { mode: 0o600 });
    chmodSync(path, 0o000);
    const tokens = open();
    expect(tokens.current("page")).not.toBe(PAGE);
    expect(mode()).toBe(0o600);
  });

  test("a file another user owns is not trusted: new tokens, written 0600", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP), { mode: 0o600 });
    const tokens = open((process.getuid?.() ?? 0) + 1);
    expect([tokens.current("page"), tokens.current("stop")]).not.toContain(PAGE);
    expect(tokens.current("stop")).not.toBe(STOP);
    expect(mode()).toBe(0o600);
    expect(lines.join("\n")).toContain("owned by");
  });

  test("a symlink there is refused: never read nor written through, replaced by a file of its own, 0600", () => {
    mkdirSync(join(home, "hub"));
    const elsewhere = join(home, "elsewhere.json");
    writeFileSync(elsewhere, planted(PAGE, STOP), { mode: 0o600 });
    symlinkSync(elsewhere, path);
    const tokens = open();
    expect(tokens.current("page")).not.toBe(PAGE);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(mode()).toBe(0o600);
    expect(readFileSync(elsewhere, "utf8")).toBe(planted(PAGE, STOP));
    expect(lines.join("\n")).toContain("symlink");
  });

  test("no line it logs holds a token", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP), { mode: 0o644 });
    chmodSync(path, 0o644);
    const tokens = open();
    expect(lines.length).toBeGreaterThan(0);

    for (const token of [PAGE, STOP, tokens.current("page"), tokens.current("stop")]) expect(lines.join("\n")).not.toContain(token);
  });
});

describe("rotation", () => {
  test("rotates after 24 h and keeps the previous token 24 h more", () => {
    expect([TOKEN_ROTATE_MS, TOKEN_GRACE_MS]).toEqual([24 * HOUR, 24 * HOUR]);
  });

  test("a token 25 h old is replaced when it is checked; the previous one answers at 30 h and not at 49 h", () => {
    const tokens = open();
    const old = tokens.current("page");
    const oldStop = tokens.current("stop");
    at = 23 * HOUR;
    expect(tokens.accepted("page")).toEqual([old]);
    at = 25 * HOUR;
    const accepted = tokens.accepted("page");
    const fresh = tokens.current("page");
    expect(fresh).not.toBe(old);
    expect(accepted).toEqual([fresh, old]);
    expect(tokens.accepted("stop")).toEqual([tokens.current("stop"), oldStop]);
    at = 30 * HOUR;
    expect(tokens.accepted("page")).toContain(old);
    expect(open().accepted("page")).toEqual([fresh, old]);
    at = 49 * HOUR;
    expect(tokens.accepted("page")).not.toContain(old);
    expect(tokens.accepted("page")).toContain(fresh);
    expect(tokens.accepted("stop")).not.toContain(oldStop);
  });

  test("a new page gets the current token once the old one is due", () => {
    const tokens = open();
    const old = tokens.current("page");
    at = 25 * HOUR;
    expect(tokens.current("page")).not.toBe(old);
  });

  test("the hub's start replaces a token 25 h old and keeps the old one in grace, written to the file", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP), { mode: 0o600 });
    at = 25 * HOUR;
    const tokens = open();
    expect(tokens.current("page")).not.toBe(PAGE);
    expect(tokens.accepted("page")).toEqual([tokens.current("page"), PAGE]);
    expect(readFileSync(path, "utf8")).toContain(tokens.current("page"));
    at = 49 * HOUR;
    expect(open().accepted("page")).not.toContain(PAGE);
  });

  test("a clock stepped back never rotates: after two 1-second steps back an open page's token still answers", () => {
    at = 10 * HOUR;
    const tokens = open();
    const page = tokens.current("page");
    at -= 1000;
    expect(tokens.accepted("page")).toEqual([page]);
    at -= 1000;
    expect(tokens.accepted("page")).toEqual([page]);
    expect(open().accepted("page")).toEqual([page]);
  });

  test("a token made more than 24 h ahead of the clock is replaced, and answers 24 h more; one 23 h ahead is kept", () => {
    mkdirSync(join(home, "hub"));
    writeFileSync(path, planted(PAGE, STOP, 25 * HOUR), { mode: 0o600 });
    const tokens = open();
    expect(tokens.current("page")).not.toBe(PAGE);
    expect(tokens.accepted("page")).toEqual([tokens.current("page"), PAGE]);
    expect(readFileSync(path, "utf8")).toContain(tokens.current("page"));
    at = 24 * HOUR;
    expect(tokens.accepted("page")).not.toContain(PAGE);
    at = 0;
    writeFileSync(path, planted(PAGE, STOP, 23 * HOUR), { mode: 0o600 });
    expect(open().accepted("page")).toEqual([PAGE]);
  });

  test("a token made at 0 h and first checked at 100 h is refused: its grace ran from 24 h, when it was due", () => {
    const tokens = open();
    const old = tokens.current("page");
    at = 100 * HOUR;
    expect(tokens.accepted("page")).toEqual([tokens.current("page")]);
    expect(tokens.accepted("page")).not.toContain(old);
    expect(open().accepted("page")).not.toContain(old);
  });

  test("the grace ends exactly 48 h after the token was made: accepted at 48 h less 1 ms, refused at 48 h", () => {
    const tokens = open();
    const old = tokens.current("page");
    at = 30 * HOUR;
    expect(tokens.accepted("page")).toContain(old);
    at = 48 * HOUR - 1;
    expect(tokens.accepted("page")).toContain(old);
    at = 48 * HOUR;
    expect(tokens.accepted("page")).not.toContain(old);
  });
});

describe("the compare", () => {
  test("checks every accepted token, timing-safe, whatever an earlier one gave", () => {
    const hosts = new Set(["127.0.0.1:1"]);
    const accepted = ["a".repeat(32), "b".repeat(32)];

    const header = (name: string): string | null =>
      ({ Origin: "http://127.0.0.1:1", "Sec-Fetch-Site": "same-origin", [PAGE_TOKEN_HEADER]: accepted[0] ?? "" })[name] ?? null;

    const spy = spyOn(crypto, "timingSafeEqual");

    try {
      expect(grantRefusal(hosts, "127.0.0.1:1", accepted, header)).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockClear();
      expect(grantRefusal(hosts, "127.0.0.1:1", [...accepted].reverse(), header)).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockClear();
      expect(grantRefusal(hosts, "127.0.0.1:1", ["c".repeat(32), "d".repeat(32)], header)?.[1]).toBe(STALE_PAGE_TOKEN);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the hub's tokens", () => {
  test("a hub that cannot bind its port leaves the token file as it was: the hub that holds the port keeps its tokens", async () => {
    const base = tmp("fleet-tokens-hub-");
    const m = machine(baseEnv(join(base, "registry")));
    const file = tokensPath(m.registry.place.home);
    mkdirSync(join(m.registry.place.home, "hub"), { recursive: true });
    const old = planted(PAGE, STOP, Date.now() - 25 * HOUR);
    writeFileSync(file, old, { mode: 0o600 });
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = taken.port ?? 0;

    try {
      const got = await startHub({ port, machine: m, tailscale: join(base, "no-tailscale"), peers: false, hosts: [], https: undefined }, () => {});

      if (!(got instanceof Error)) await got.stop();
      expect([got instanceof Error, readFileSync(file, "utf8")]).toEqual([true, old]);
    } finally {
      await taken.stop(true);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
