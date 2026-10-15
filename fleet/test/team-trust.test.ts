/** Claude Code's folder trust (team/trust.ts) at its own interface: the root it keys, the folders it refuses, the
 * write racing another writer, and the terminal question. */
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { askerOn } from "../src/cli/team.ts";
import type { Json } from "../src/json.ts";
import { ensureTrusted, trustRootOf } from "../src/team/trust.ts";
import { tmp } from "./support.ts";

/** A main checkout with a worktree whose `.git` file points back at it, as `git worktree add` leaves them. */
interface Worktree {
  readonly main: string;
  readonly tree: string;
}

function worktree(): Worktree {
  const main = tmp("fleet-trust-main-");
  const tree = tmp("fleet-trust-tree-");
  mkdirSync(join(main, ".git", "worktrees", "w"), { recursive: true });
  writeFileSync(join(main, ".git", "worktrees", "w", "gitdir"), `${join(tree, ".git")}\n`);
  writeFileSync(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "w")}\n`);

  return { main, tree };
}

describe("the root", () => {
  test("a worktree is keyed on its main checkout, realpath'd", () => {
    const { main, tree } = worktree();
    const link = join(tmp("fleet-trust-link-"), "main");
    symlinkSync(main, link);
    writeFileSync(join(tree, ".git"), `gitdir: ${join(link, ".git", "worktrees", "w")}\n`);

    expect(trustRootOf(tree)).toBe(main);
  });

  test("a planted .git file naming a worktree that does not point back is keyed on its own folder", () => {
    const tree = tmp("fleet-trust-planted-");
    writeFileSync(join(tree, ".git"), "gitdir: /home/.git/worktrees/x\n");

    expect(trustRootOf(tree)).toBe(tree);
    writeFileSync(join(tree, ".git"), "gitdir: /.git/worktrees/x\n");
    expect(trustRootOf(tree)).toBe(tree);
  });
});

describe("ensureTrusted", () => {
  function config(text: string): string {
    const file = join(tmp("fleet-trust-config-"), ".claude.json");
    writeFileSync(file, text);

    return file;
  }

  test("refuses / and any folder at or above HOME, comparing realpaths", () => {
    const home = tmp("fleet-trust-home-");
    const linked = join(tmp("fleet-trust-l-"), "home");
    symlinkSync(home, linked);
    const file = config("{}");

    for (const root of ["/", "", dirname(home), linked]) {
      const got = ensureTrusted({ root, config: file, home, consent: { _tag: "Given" } });

      expect(got).toEqual({ why: `${root} is the home folder or a folder above it: Claude Code never keeps trust in the home folder, and trusting a folder above it would trust all below; start the team from a repository below it` });
    }

    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  test("a file another writer changes before the rename is read again, its change kept", () => {
    const root = tmp("fleet-trust-root-");
    const file = config('{"numStartups": 1}');
    let raced = false;

    const got = ensureTrusted({
      root,
      config: file,
      home: tmp("fleet-trust-home-"),
      consent: { _tag: "Given" },
      beforeRename: () => {
        if (raced) return;
        raced = true;
        writeFileSync(file, '{"numStartups": 2, "theme": "dark"}');
      },
    });

    expect(got).toEqual({ _tag: "Written", line: `trusted ${root} for Claude Code in ${file}` });
    const written: Json = JSON.parse(readFileSync(file, "utf8"));

    expect(written).toEqual({ numStartups: 2, theme: "dark", projects: { [root]: { hasTrustDialogAccepted: true } } });
    expect(readdirSync(dirname(file))).toEqual([".claude.json"]);
  });

  test("a file that changes on every try is refused and left as the other writer left it", () => {
    const root = tmp("fleet-trust-root-");
    const file = config("{}");
    let n = 0;
    const got = ensureTrusted({ root, config: file, home: tmp("fleet-trust-home-"), consent: { _tag: "Given" }, beforeRename: () => writeFileSync(file, `{"n": ${String((n += 1))}}`) });

    expect(got).toEqual({ why: `Claude Code's config ${file} changed while fleet team wrote it, twice; nothing written: start again` });
    expect(readFileSync(file, "utf8")).toBe('{"n": 2}');
    expect(readdirSync(dirname(file))).toEqual([".claude.json"]);
  });

  test("projects that is not an object of objects is refused, the file left", () => {
    const root = tmp("fleet-trust-root-");
    const file = config(JSON.stringify({ projects: { [root]: [] } }));

    expect(ensureTrusted({ root, config: file, home: tmp("fleet-trust-home-"), consent: { _tag: "Given" } })).toEqual({
      why: `Claude Code's config ${realpathSync(file)}: projects is not an object of objects; fleet team leaves it as it is`,
    });
  });
});

describe("the terminal question", () => {
  const reading = (text: string) => {
    let at = 0;

    return (byte: Buffer): number => {
      if (at >= text.length) return 0;
      byte[0] = text.charCodeAt(at);
      at += 1;

      return 1;
    };
  };

  test("asks on its writer and takes y or yes as a yes, anything else as a no", () => {
    const said: string[] = [];

    expect(askerOn((t) => said.push(t), reading("yes\n"))("trust? ")).toBe(true);
    expect(askerOn(() => undefined, reading("n\n"))("trust? ")).toBe(false);
    expect(said).toEqual(["trust? "]);
  });

  test("a read that fails (EAGAIN on a non-blocking terminal) is a no", () => {
    const again = (): number => {
      throw Object.assign(new Error("Resource temporarily unavailable"), { code: "EAGAIN" });
    };

    expect(askerOn(() => undefined, again)("trust? ")).toBe(false);
  });
});
