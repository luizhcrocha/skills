/**
 * `fleet ws`'s trash, against throwaway jj repos: what prune moves there until gc, and the one workspace prune keeps that
 * a permission card can send there. The rest of `fleet ws` is ws.test.ts.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { asArray, asObject } from "../src/json.ts";
import { toTrash } from "../src/ws/trash.ts";
import { FLEET, fleet, readJson } from "./support.ts";
import { base, dir, env, freshRepo, jj, lastEvent, makeTemplate, moreEnv, onFailingJj, repo, state, work, workspaces, ws } from "./ws-support.ts";

// Each test runs jj as a subprocess, up to 51 times: ws.test.ts has the numbers.
setDefaultTimeout(60_000);

beforeAll(makeTemplate);

beforeEach(freshRepo);

describe("the trash: a pruned workspace is moved, not deleted, until gc", () => {
  const ID = "repo/a1@20260105T090000Z";

  function trash(): string {
    return join(base, "registry", "trash");
  }

  /** A done worker a1 whose change is integrated, and whose workspace holds an ignored file and a scratch note. */
  function integrated(): string {
    writeFileSync(join(repo, ".gitignore"), ".dev.vars\nnotes/\n");
    jj(repo, "describe", "-m", "ignore");
    jj(repo, "new");
    state("agent", "a1", "--task", "t", "--milestone", "m1");
    ws("add", "a1", "--repo", repo);
    const at = join(base, "repo-a1");
    work(at, "one.txt", "a1: one");
    writeFileSync(join(at, ".dev.vars"), "TOKEN=only here\n");
    mkdirSync(join(at, "notes"));
    writeFileSync(join(at, "notes", "scratch.md"), "half a thought\n");
    jj(repo, "rebase", "-r", "a1@-", "-B", "@");
    state("agent", "a1", "--status", "done");

    return at;
  }

  test("prune --apply moves the folder, ignored files and all, to the trash beside a note, and forgets the workspace", () => {
    const at = integrated();
    const tip = jj(repo, "log", "--no-graph", "-r", "a1@", "-T", 'commit_id ++ "|" ++ parents.map(|c| c.commit_id()).join(",")').split("|");
    const ran = ws("prune", "--apply");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toBe(`pruned a1: ${at} is in the trash, ${ID}: \`fleet ws restore ${ID}\` brings it back\n`);
    expect(existsSync(at)).toBe(false);
    const entry = join(trash(), "repo", "a1@20260105T090000Z");
    expect(readFileSync(join(entry, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(readFileSync(join(entry, "notes", "scratch.md"), "utf8")).toBe("half a thought\n");
    expect(readJson(`${entry}.json`)).toEqual({
      repo,
      workspace: "a1",
      path: at,
      commit: tip[0] ?? "",
      parents: [tip[1] ?? ""],
      trashed: "2026-01-05T09:00:00+00:00",
      fleet: dir,
      why: "fleet ws prune --apply: its worker a1 is done and its changes are in the stack",
    });
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("default\n");
    expect(asObject(lastEvent())?.["text"]).toBe(`Workspace a1 pruned: its changes are in the stack; ${at} moved to the trash (${ID}).`);
  });

  test("restore brings the folder and its ignored files back to its old path, and jj knows it as the workspace again", () => {
    const at = integrated();
    const parent = jj(repo, "log", "--no-graph", "-r", "a1@-", "-T", "commit_id");
    expect(ws("prune", "--apply").code).toBe(0);
    const ran = fleet(["ws", "restore", ID], env);
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toBe(`restored ${ID} to ${at}: jj workspace a1 again, on ${parent.slice(0, 12)}\n`);
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(readFileSync(join(at, "notes", "scratch.md"), "utf8")).toBe("half a thought\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    expect(jj(repo, "workspace", "root", "--name", "a1").trim()).toBe(at);
    expect(jj(at, "log", "--no-graph", "-r", "@", "-T", 'parents.map(|c| c.commit_id()).join(",") ++ "|" ++ empty')).toBe(`${parent}|true`);
    expect(jj(at, "status")).toContain("The working copy has no changes.");
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });

  /** Rewrite the trashed a1's note with `parents`, as a hand-edited note or a parent jj lost would leave it. */
  function noteParents(parents: readonly string[]): void {
    const note = join(trash(), "repo", "a1@20260105T090000Z.json");
    writeFileSync(note, JSON.stringify({ ...readJson(note), parents }));
  }

  test("restore on a noted parent jj no longer has starts on the default workspace's parents, and says the parent is gone", () => {
    const at = integrated();
    expect(ws("prune", "--apply").code).toBe(0);
    noteParents(["0123456789abcdef0123456789abcdef01234567"]);
    const ran = fleet(["ws", "restore", ID], env);
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([0, "", `restored ${ID} to ${at}: jj workspace a1 again, on the default workspace's parents (its noted parent 0123456789ab is gone)\n`]);
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    expect(jj(repo, "workspace", "root", "--name", "a1").trim()).toBe(at);
    expect(jj(at, "log", "--no-graph", "-r", "@-", "-T", "commit_id")).toBe(jj(repo, "log", "--no-graph", "-r", "@-", "-T", "commit_id"));
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });

  test("a restore jj cannot add leaves no workspace behind and brings the folder back as plain files, with jj's error", () => {
    const at = integrated();
    expect(ws("prune", "--apply").code).toBe(0);
    noteParents(["x("]);
    const ran = fleet(["ws", "restore", ID], env);
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([
      1,
      "",
      `restored ${ID} to ${at}, as plain files: jj could not add it as workspace a1 (Error: Failed to parse revset: Syntax error); its .jj is stale, so jj there fails until the folder is a workspace again\n`,
    ]);
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("default\n");
    expect(existsSync(`${at}-restored`)).toBe(false);
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });

  test("restore never deletes an old .jj that holds a repo's store, as a hand-written note pointing at a repo would leave", () => {
    const other = join(base, "other");
    Bun.spawnSync(["jj", "git", "init", other], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(other, "kept.txt"), "mine\n");
    const entry = join(trash(), "repo", "other@20260105T090000Z");
    mkdirSync(join(trash(), "repo"), { recursive: true });
    Bun.spawnSync(["mv", other, entry]);
    const at = join(base, "repo-other");
    writeFileSync(`${entry}.json`, JSON.stringify({ repo, workspace: "other", path: at, parents: [] }));
    const ran = fleet(["ws", "restore", "repo/other@20260105T090000Z"], env);
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([
      1,
      "",
      `restored repo/other@20260105T090000Z to ${at}: jj workspace other again, on the default workspace's parents\nws: kept ${entry}.stale-jj: its repo is a directory, a repo's own store, so restore does not delete it\n`,
    ]);
    expect(existsSync(join(`${entry}.stale-jj`, "repo", "store"))).toBe(true);
    expect(readFileSync(join(at, "kept.txt"), "utf8")).toBe("mine\n");
  });

  test("restore to a path that is taken goes beside it, and says so", () => {
    const at = integrated();
    ws("prune", "--apply");
    mkdirSync(at);
    writeFileSync(join(at, "someone else's"), "x\n");
    const ran = fleet(["ws", "restore", ID], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain(`restored ${ID} to ${at}-restored (${at} is taken): jj workspace a1 again`);
    expect(readFileSync(join(`${at}-restored`, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(existsSync(join(at, "someone else's"))).toBe(true);
    expect(jj(repo, "workspace", "root", "--name", "a1").trim()).toBe(`${at}-restored`);
    expect(fleet(["ws", "restore", "repo/nothing@20260105T090000Z"], env).stderr).toContain("ws: no trash entry repo/nothing@20260105T090000Z");
  });

  test("trash lists each entry with its age, size and note; gc deletes only those past the age, and a dry run touches nothing", () => {
    integrated();
    ws("prune", "--apply");
    moreEnv({ FLEET_NOW: "2026-01-10T09:00:00+00:00" });
    state("agent", "a2", "--task", "t", "--milestone", "m1");
    ws("add", "a2", "--repo", repo);
    state("agent", "a2", "--status", "done");
    ws("prune", "--apply");
    moreEnv({ FLEET_NOW: "2026-01-13T10:00:00+00:00" });
    const listed = fleet(["ws", "trash"], env);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(new RegExp(`^${ID}  8d 1h  \\d+ KB  a1 of ${repo}, fleet ${dir}: fleet ws prune --apply: its worker a1 is done`, "m"));
    expect(listed.stdout).toMatch(/^repo\/a2@20260110T090000Z {2}3d 1h {2}\d+ KB {2}a2 of /m);

    const dry = fleet(["ws", "gc", "--dry-run"], env);
    expect([dry.code, dry.stdout]).toEqual([0, `would delete ${ID} (8d 1h old)\ndry run, nothing deleted; 1 entry younger than 7 days kept\n`]);
    expect(existsSync(join(trash(), "repo", "a1@20260105T090000Z"))).toBe(true);

    const gone = fleet(["ws", "gc"], env);
    expect([gone.code, gone.stdout]).toEqual([0, `deleted ${ID} (8d 1h old)\n1 entry younger than 7 days kept\n`]);
    expect(readdirSync(join(trash(), "repo")).sort()).toEqual(["a2@20260110T090000Z", "a2@20260110T090000Z.json"]);
    expect(fleet(["ws", "gc", "--older-than", "3"], env).stdout).toContain("deleted repo/a2@20260110T090000Z (3d 1h old)");
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
    expect(fleet(["ws", "gc", "--older-than", "x"], env).code).toBe(1);
  });

  test("a trash on another filesystem refuses the move and leaves the folder and no note", () => {
    // The shelf is `<trash>/<repo's basename>`: with the trash at / and a repo named proc, the shelf is /proc,
    // which exists (mkdir is a no-op) and is another filesystem than the temp dir.
    const path = join(base, "proc-w");
    mkdirSync(path);
    writeFileSync(join(path, ".dev.vars"), "SECRET\n");
    expect(statSync("/proc").dev).not.toBe(statSync(path).dev);
    const note = { repo: join(base, "proc"), workspace: "w", path, commit: null, parents: [], trashed: "", fleet: "", why: "" };
    expect(toTrash("/", note, new Date("2026-01-01T00:00:00Z"))).toEqual({ refused: `could not move ${path} to the trash (/ is on another filesystem, and the trash only renames); nothing is deleted` });
    expect(readFileSync(join(path, ".dev.vars"), "utf8")).toBe("SECRET\n");
    expect(existsSync("/proc/w@20260101T000000Z.json")).toBe(false);
  });

  test("gc goes by the stamp in an entry's name: an entry without one is kept and named, a note with no folder is named, a restore's stale .jj is no entry", () => {
    const shelf = join(trash(), "repo");

    const entry = (name: string, note?: string): void => {
      mkdirSync(join(shelf, name), { recursive: true });
      writeFileSync(join(shelf, name, "f"), "x");

      if (note !== undefined) writeFileSync(join(shelf, `${name}.json`), note);
    };

    entry("a@20260101T000000Z", JSON.stringify({ repo, workspace: "a", path: join(base, "repo-a") })); // exactly 7 days old
    entry("b@20251231T235959Z"); // 7 days and 1 s, no note
    entry("c@20251201T000000Z", "{not json");
    entry("f@20260107T120000Z", JSON.stringify({ repo, workspace: "f", path: join(base, "repo-f") })); // 12 hours old
    entry("d@20251201T000000Z.stale-jj"); // a restore that stopped half way left it
    entry("e");
    writeFileSync(join(shelf, "g@20251101T000000Z.json"), "{}");
    moreEnv({ FLEET_NOW: "2026-01-08T00:00:00+00:00" });
    const extras = `1 entry with no stamp in its name kept: repo/e\na note with no folder, kept: ${join(shelf, "g@20251101T000000Z.json")}\n`;

    expect(fleet(["ws", "trash"], env).stdout).not.toContain("stale-jj");
    const dry = fleet(["ws", "gc", "--older-than", "1", "--dry-run"], env);
    expect([dry.code, dry.stdout]).toEqual([
      0,
      `would delete repo/c@20251201T000000Z (38d 0h old)\nwould delete repo/b@20251231T235959Z (7d 0h old)\nwould delete repo/a@20260101T000000Z (7d 0h old)\ndry run, nothing deleted; 1 entry younger than 1 day kept\n${extras}`,
    ]);
    const gone = fleet(["ws", "gc"], env);
    expect([gone.code, gone.stdout]).toEqual([0, `deleted repo/c@20251201T000000Z (38d 0h old)\ndeleted repo/b@20251231T235959Z (7d 0h old)\n2 entries younger than 7 days kept\n${extras}`]);
    expect(readdirSync(shelf).sort()).toEqual(["a@20260101T000000Z", "a@20260101T000000Z.json", "d@20251201T000000Z.stale-jj", "e", "f@20260107T120000Z", "f@20260107T120000Z.json", "g@20251101T000000Z.json"]);
  });

  test("a trash the folder cannot be moved into refuses the prune for that workspace and keeps the folder", () => {
    const at = integrated();
    mkdirSync(join(trash(), "repo"), { recursive: true });
    chmodSync(join(trash(), "repo"), 0o555);
    const ran = ws("prune", "--apply");
    chmodSync(join(trash(), "repo"), 0o755);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toMatch(new RegExp(`^ws: kept a1: could not move ${at} to the trash \\(.*EACCES.*\\); nothing is deleted\\n$`));
    expect(readFileSync(join(at, ".dev.vars"), "utf8")).toBe("TOKEN=only here\n");
    expect(jj(repo, "workspace", "list", "-T", 'name ++ "\\n"')).toBe("a1\ndefault\n");
    expect(workspaces()[0]?.["status"]).toBe("active");
    expect(readdirSync(join(trash(), "repo"))).toEqual([]);
  });
});

describe("fleet ws DIR trash NAME --card ID: one workspace prune keeps, trashed on a permission card for that exact call", () => {
  const trash = (): string => join(base, "registry", "trash");
  const names = (): string => jj(repo, "--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\n"');
  /** The command as the CLI prints it, which a permission card's call must be. */
  const call = (name: string, id: string): string => `${FLEET} ws ${dir} trash ${name} --card ${id}`;

  const only = (name: string, id: string): string =>
    `only a permission card whose call is exactly \`${call(name, id)}\`, decided allow-once or allow-kind, moves a workspace prune keeps`;

  /** Luiz's answer on the page: the CLI lets no agent decide a permission allow-once, so the test writes it. */
  function answer(id: string, said: string): void {
    const raw = readJson(join(dir, "state.json"));
    const decisions = (asArray(raw["decisions"]) ?? []).map((d) => (asObject(d)?.["id"] === id ? { ...asObject(d), status: "decided", answer: said, resolution: "answered on the page" } : d));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...raw, decisions }));
  }

  /** Permission card `id` for Bash call `asked`, decided `said` (undefined: left open). */
  function permission(id: string, asked: string, said: string | undefined): void {
    state("decision", id, "--kind", "permission", "--tool", "Bash", "--call", asked, "--root", repo, "--title", "Trash a workspace?", "--why", "prune keeps it",
      "--recommend", "allow-once", "--reason", "throwaway work");

    if (said !== undefined) answer(id, said);
  }

  /** A done worker t1 whose workspace holds a THROWAWAY change and an empty described one: prune keeps it. */
  function throwaway() {
    state("agent", "t1", "--task", "t", "--milestone", "m1");
    ws("add", "t1", "--repo", repo);
    const at = join(base, "repo-t1");
    work(at, "proto.txt", "THROWAWAY: prototype of the page");
    jj(at, "describe", "-m", "THROWAWAY notes, empty");
    jj(at, "new");
    state("agent", "t1", "--status", "done");
    const commit = jj(repo, "log", "--no-graph", "-r", "description(substring:'THROWAWAY: prototype')", "-T", "commit_id");

    return { at, commit };
  }

  /** Nothing moved: folder, jj workspace and row as they were, no trash entry. */
  function untouched(at: string): void {
    expect(existsSync(join(at, "proto.txt"))).toBe(true);
    expect(names()).toBe("default\nt1\n");
    expect(workspaces().find((w) => w["id"] === "t1")?.["status"]).toBe("active");
    expect(existsSync(join(trash(), "repo")) ? readdirSync(join(trash(), "repo")) : []).toEqual([]);
  }

  test("moves the folder to the trash beside a note naming the card, forgets the workspace without snapshotting the main checkout, keeps its commits", () => {
    const { at, commit } = throwaway();
    expect(ws("prune", "--apply").stderr).toContain("ws: kept t1: 2 change(s) not in the stack");
    permission("d1", call("t1", "d1"), "allow-once");
    writeFileSync(join(repo, "unsnapshotted.txt"), "the main checkout's own edit\n");
    // a hand-made entry under the same stamp is never overwritten
    mkdirSync(join(trash(), "repo", "t1@20260105T090000Z"), { recursive: true });
    const ran = ws("trash", "t1", "--card", "d1");
    const id = "repo/t1@20260105T090000Z-2";
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout).toBe(`trashed t1 under card d1: ${at} is in the trash, ${id}: \`fleet ws restore ${id}\` brings it back\n`);
    expect(existsSync(at)).toBe(false);
    expect(readFileSync(join(trash(), id, "proto.txt"), "utf8")).toBe("THROWAWAY: prototype of the page\n");
    expect(readJson(join(trash(), `${id}.json`))).toMatchObject({ workspace: "t1", path: at, fleet: dir, card: "d1", why: "fleet ws trash t1 --card d1: its worker t1 is done and its changes are THROWAWAY or empty" });
    expect(names()).toBe("default\n");
    expect(jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", commit, "-T", "description")).toBe("THROWAWAY: prototype of the page\n");
    expect(jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", "default@", "-T", "empty")).toBe("true");
    expect(workspaces()[0]).toMatchObject({ id: "t1", status: "pruned", pruned: "2026-01-05T09:00:00+00:00", card: "d1" });
    expect(asObject(lastEvent())?.["text"]).toBe(`Workspace t1 trashed under card d1: its changes are THROWAWAY or empty; ${at} moved to the trash (${id}).`);
    expect(fleet(["ws", "restore", id], env).code).toBe(0);
    expect(readFileSync(join(at, "proto.txt"), "utf8")).toBe("THROWAWAY: prototype of the page\n");
  });

  /** Worker t1's empty workspace, an orphan stack beside it on the same base, and its folder. */
  function emptyBesideAnOrphan(): string {
    state("agent", "t1", "--task", "t", "--milestone", "m1");
    ws("add", "t1", "--repo", repo);
    state("agent", "t1", "--status", "done");
    jj(repo, "new", "@-", "-m", "nobody: orphan");
    writeFileSync(join(repo, "orphan.txt"), "o\n");
    jj(repo, "new", "@-");

    return join(base, "repo-t1");
  }

  test("a stack only beside the workspace keeps it from prune and not from a card's yes, and stays in jj", () => {
    const at = emptyBesideAnOrphan();
    expect(ws("prune", "--apply").stderr).toMatch(/^ws: kept t1: 1 change\(s\) beside its @, not in the stack: \w+ nobody: orphan \(`fleet ws trash --card` lets it go; they stay in jj\)\n$/);
    permission("d1", call("t1", "d1"), "allow-once");
    const ran = ws("trash", "t1", "--card", "d1");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(existsSync(at)).toBe(false);
    expect(jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", 'description(substring:"nobody: orphan")', "-T", "description")).toBe("nobody: orphan\n");
  });

  test("a list that fails between the check and the move refuses: the folder never goes without its forget", () => {
    const at = emptyBesideAnOrphan();
    permission("d1", call("t1", "d1"), "allow-once");
    const ran = onFailingJj(1, "ws", dir, "trash", "t1", "--card", "d1");
    expect(ran.stderr).toBe(`ws: kept t1: jj could not list the workspaces of ${repo}; nothing is moved or deleted\n`);
    expect(ran.code).toBe(1);
    expect(existsSync(at)).toBe(true);
    expect(names()).toBe("default\nt1\n");
  });

  test("allow-kind with only whitespace after it is a yes too", () => {
    const { at } = throwaway();
    permission("p-9a2b3c4d", call("t1", "p-9a2b3c4d"), "allow-kind \n");
    expect(ws("trash", "t1", "--card", "p-9a2b3c4d").code).toBe(0);
    expect(existsSync(at)).toBe(false);
  });

  // P196 (#1323): a permission card's call carries the CLI's full path, and allow-kind prints that call to run.
  test("a card whose call names this CLI by its full path is a yes", () => {
    const { at } = throwaway();
    permission("full", `${FLEET} ws ${dir} trash t1 --card full`, "allow-kind");
    const ran = ws("trash", "t1", "--card", "full");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(existsSync(at)).toBe(false);
  });

  test("a card whose call names this CLI by a link to it is a yes", () => {
    const { at } = throwaway();
    // A page ask holds a CLI by its path only when the path ends in /fleet and its real path is an install path
    // (isFleetCli): this link's is the plugin's own bin/fleet.
    const link = join(base, "bin", "fleet");
    mkdirSync(join(base, "bin"), { recursive: true });
    symlinkSync(FLEET, link);
    permission("linked", `${link} ws ${dir} trash t1 --card linked`, "allow-once");
    expect(ws("trash", "t1", "--card", "linked").code).toBe(0);
    expect(existsSync(at)).toBe(false);
  });

  test("a card whose call is the bare fleet form older refusals printed is a yes", () => {
    const { at } = throwaway();
    permission("bare", `fleet ws ${dir} trash t1 --card bare`, "allow-once");
    expect(ws("trash", "t1", "--card", "bare").code).toBe(0);
    expect(existsSync(at)).toBe(false);
  });

  test("a card whose call names another program, or this CLI with words changed, is no yes", () => {
    const { at } = throwaway();
    // A permission names a file that can be read, so each program is one: another `fleet`, and one under a
    // `fleet/bin/fleet` of its own that is no tstack bin/fleet hands over to.
    const evil = join(base, "evil", "fleet");
    const lookalike = join(base, "lookalike", "fleet", "bin", "fleet");

    for (const program of [evil, lookalike]) {
      mkdirSync(join(program, ".."), { recursive: true });
      writeFileSync(program, "#!/bin/sh\n");
      chmodSync(program, 0o755);
    }

    // `..` after a link: the path resolves, `..` dropped first, to a link to this CLI (dd/a/good/fleet), but the
    // kernel follows dd/a/s to dd/evil/d1 first and runs the planted dd/evil/good/fleet (round 5's late review, R1).
    const dd = join(base, "dd");
    mkdirSync(join(dd, "a", "good"), { recursive: true });
    mkdirSync(join(dd, "evil", "d1"), { recursive: true });
    mkdirSync(join(dd, "evil", "good"), { recursive: true });
    symlinkSync(FLEET, join(dd, "a", "good", "fleet"));
    symlinkSync(join(dd, "evil", "d1"), join(dd, "a", "s"));
    writeFileSync(join(dd, "evil", "good", "fleet"), "#!/bin/sh\n");
    chmodSync(join(dd, "evil", "good", "fleet"), 0o755);
    const throughLink = `${join(dd, "a", "s")}/../good/fleet`;

    // A page ask holds …/fleet only at an install path (whyNoAsk's isFleetCli), so these cards are not opened at all.
    for (const [id, asked] of [
      ["evil", `${evil} ws ${dir} trash t1 --card evil`],
      ["lookalike", `${lookalike} ws ${dir} trash t1 --card lookalike`],
      ["dotdot", `${throughLink} ws ${dir} trash t1 --card dotdot`],
      ["dot", `${dirname(FLEET)}/./fleet ws ${dir} trash t1 --card dot`],
      ["empty", `${dirname(FLEET)}//fleet ws ${dir} trash t1 --card empty`],
      ["chained", `${evil};/..${FLEET} ws ${dir} trash t1 --card chained`],
    ] as const) {
      const opened = fleet(["state", dir, "decision", id, "--kind", "permission", "--tool", "Bash", "--call", asked, "--root", repo, "--title", "Trash a workspace?",
        "--why", "prune keeps it", "--recommend", "allow-once", "--reason", "throwaway work", "--no-render"], env);

      expect([opened.code, opened.stderr.includes("is not the fleet CLI: a program named fleet by its path is held only at one of the plugin's install paths")]).toEqual([1, true]);

      const ran = ws("trash", "t1", "--card", id);
      expect([ran.code, ran.stderr]).toEqual([1, `ws: no card ${id} in this fleet's ledger: ${only("t1", id)}; open one for that call\n`]);
      untouched(at);
    }

    for (const [id, asked] of [
      ["spaced", `${FLEET}  ws ${dir} trash t1 --card spaced`],
      ["more", `${FLEET} ws ${dir} trash t1 --card more --all`],
    ] as const) {
      permission(id, asked, "allow-kind");
      const ran = ws("trash", "t1", "--card", id);
      expect([ran.code, ran.stderr]).toEqual([1, `ws: card ${id} asks for \`${asked}\`: ${only("t1", id)}; open one for that call\n`]);
      untouched(at);
    }
  });

  // The review's probes (ws-trash-card-rv/probe.test.ts): each of these cards trashed t1, and none is a yes to it.
  const notYes: [string, () => void, string, () => string][] = [
    ["a decision decided A, where A means keep", () => state("decision", "k", "--kind", "decision", "--title", "Keep workspace t1 for the demo?", "--question", "Keep t1?", "--why", "w",
      "--option", "A: keep it | t1 stays for the demo", "--option", "B: trash it | it goes", "--decide", "A", "--resolution", "r"), "k", () => "card k is kind decision, not a permission"],
    ["a plain yes to another question about t1", () => state("decision", "q", "--title", "Should t1's prototype be shown Friday?", "--question", "Show t1 on Friday?", "--decide", "yes", "--resolution", "r"), "q", () => "card q is kind decision, not a permission"],
    ["a decision naming t1 in passing, decided A", () => state("decision", "n", "--kind", "decision", "--title", "Which lane gets the docs?", "--question", "Docs lane?", "--why", "t1 is done",
      "--option", "A: lane x | x does it", "--option", "B: lane y | y", "--decide", "A", "--resolution", "r"), "n", () => "card n is kind decision, not a permission"],
    ["an input answered ok", () => state("decision", "i", "--kind", "input", "--title", "Port for t1?", "--question", "Which port should t1 use?", "--decide", "ok", "--resolution", "r"), "i", () => "card i is kind input, not a permission"],
    ["an action answered yes", () => state("decision", "ac", "--kind", "action", "--title", "Log into t1's preview", "--question", "Please log in on t1", "--decide", "yes", "--resolution", "r"), "ac", () => "card ac is kind action, not a permission"],
    ["a permission allow-once for a read of t1", () => permission("p-1a2b3c4d", `jj -R ${repo} log -r t1@`, "allow-once"), "p-1a2b3c4d", () => `card p-1a2b3c4d asks for \`jj -R ${repo} log -r t1@\``],
    ["a permission allow-once with a qualifier, for another card's call", () => permission("p-2a2b3c4d", call("t1", "x"), "allow-once, but not t1"), "p-2a2b3c4d", () => `card p-2a2b3c4d asks for \`${call("t1", "x")}\``],
    ["a permission allow-kind for another card's call", () => permission("p-3a2b3c4d", call("t1", "x"), "allow-kind"), "p-3a2b3c4d", () => `card p-3a2b3c4d asks for \`${call("t1", "x")}\``],
  ];

  for (const [label, open, id, why] of notYes) {
    test(`refuses ${label}, moving nothing, and says to open a permission card for the exact call`, () => {
      const { at } = throwaway();
      open();
      const ran = ws("trash", "t1", "--card", id);
      expect([ran.code, ran.stderr]).toEqual([1, `ws: ${why()}: ${only("t1", id)}; open one for that call\n`]);
      untouched(at);
    });
  }

  test("refuses, moving nothing, unless the worker is idle, every change is THROWAWAY or empty, and the card is a standing allow on this very call", () => {
    const { at } = throwaway();

    const refused = (args: string[], why: string): void => {
      const ran = ws("trash", ...args);
      expect([ran.code, ran.stderr]).toEqual([1, `ws: ${why}\n`]);
      untouched(at);
    };

    const usage = (args: string[]): void => {
      expect(ws("trash", ...args).stderr).toStartWith("ws: usage: fleet ws DIR");
      untouched(at);
    };

    usage(["t1"]);
    usage(["t1", "--card"]);
    usage(["t1", "t2", "--card", "d1"]);
    usage(["t1", "--card", "d1", "--all"]);
    permission("open", call("t1", "open"), undefined);
    refused(["t1", "--card", "open"], `card open is open: ${only("t1", "open")}`);
    permission("no", call("t1", "no"), "deny");
    refused(["t1", "--card", "no"], `card no was decided "deny": ${only("t1", "no")}`);
    permission("vague", call("t1", "vague"), "allow-once, but keep the notes");
    refused(["t1", "--card", "vague"], `card vague was decided "allow-once, but keep the notes": ${only("t1", "vague")}`);
    permission("caps", call("t1", "caps"), "Allow-Once");
    refused(["t1", "--card", "caps"], `card caps was decided "Allow-Once": ${only("t1", "caps")}`);
    // A card's opener refuses a trash of a workspace the ledger does not record (whyNoAsks): the other call is t1's.
    permission("other", call("t1", "d2"), "allow-once");
    refused(["t1", "--card", "other"], `card other asks for \`${call("t1", "d2")}\`: ${only("t1", "other")}; open one for that call`);
    permission("more", `${call("t1", "more")} --all`, "allow-once");
    refused(["t1", "--card", "more"], `card more asks for \`${call("t1", "more")} --all\`: ${only("t1", "more")}; open one for that call`);
    refused(["t1", "--card", "d9"], `no card d9 in this fleet's ledger: ${only("t1", "d9")}; open one for that call`);
    refused(["t1", "--card", "elsewhere/d1"], "a card ID is letters, digits and '-': \"elsewhere/d1\"");
    permission("gone", call("t1", "gone"), undefined);
    state("decision", "gone", "--withdraw", "moot");
    refused(["t1", "--card", "gone"], `card gone is withdrawn: ${only("t1", "gone")}`);
    permission("ok", call("t1", "ok"), "allow-once");
    state("decision", "later", "--kind", "input", "--title", "Keep t1 after all?", "--question", "q", "--why", "w", "--supersedes", "ok");
    refused(["t1", "--card", "ok"], `card ok is superseded by I1: ${only("t1", "ok")}`);
    permission("yes", call("t1", "yes"), "allow-once");
    refused(["default", "--card", "yes"], "never the default workspace, nor a main checkout");
    refused(["../t1", "--card", "yes"], "no active workspace ../t1 in this fleet's ledger: `fleet ws DIR list` names them");
    refused(["t2", "--card", "yes"], "no active workspace t2 in this fleet's ledger: `fleet ws DIR list` names them");
    state("agent", "t1", "--status", "running");
    refused(["t1", "--card", "yes"], "kept t1: its worker t1 is running");
    state("agent", "t1", "--status", "done");
    work(at, "real.txt", "feat: real work");
    const real = ws("trash", "t1", "--card", "yes");
    expect([real.code, real.stderr]).toEqual([1, expect.stringMatching(/^ws: kept t1: 1 change\(s\) neither THROWAWAY nor empty: \w+ feat: real work\n$/)]);
    expect(existsSync(at)).toBe(true);
  });

  test("refuses the workspace it runs in, and a row whose path is the main checkout", () => {
    const { at } = throwaway();
    permission("yes", call("t1", "yes"), "allow-once");
    const was = process.cwd();
    process.chdir(at);

    try {
      expect(ws("trash", "t1", "--card", "yes").stderr).toBe(`ws: ${at} holds this command's own working directory: run it from elsewhere\n`);
    } finally {
      process.chdir(was);
    }

    untouched(at);

    const row = (path: string): void => {
      const raw = readJson(join(dir, "state.json"));
      const others = (asArray(raw["workspaces"]) ?? []).filter((w) => asObject(w)?.["id"] !== "main");

      writeFileSync(join(dir, "state.json"), JSON.stringify({ ...raw, workspaces: [...others, { id: "main", agent: "t1", path, repo, status: "active" }] }));
    };

    // A card's opener refuses a trash of a workspace the ledger does not record (whyNoAsks), and a root that is a
    // worker's workspace: the row is recorded elsewhere for the card, then moved onto the main checkout.
    row(join(dir, "elsewhere"));
    permission("main", call("main", "main"), "allow-once");
    row(repo);
    expect(ws("trash", "main", "--card", "main").stderr).toBe("ws: never the default workspace, nor a main checkout\n");
    expect(existsSync(join(repo, "README"))).toBe(true);
  });

  test("jj failing to forget brings the folder back and leaves no entry", () => {
    const { at } = throwaway();
    permission("yes", call("t1", "yes"), "allow-once");
    const ops = join(repo, ".jj", "repo", "op_heads", "heads");
    chmodSync(ops, 0o555);
    const ran = ws("trash", "t1", "--card", "yes");
    chmodSync(ops, 0o755);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toStartWith("ws: kept t1: ");
    untouched(at);
  });

  /** Workspace `name` of the repo, with a THROWAWAY change, forgotten and moved by hand into the trash as `entry`. */
  function byHand(name: string, entry: string): string {
    state("agent", name, "--task", "t", "--milestone", "m1");
    ws("add", name, "--repo", repo);
    const at = join(base, `repo-${name}`);
    work(at, "proto.txt", "THROWAWAY: proto");
    jj(repo, "workspace", "forget", name);
    mkdirSync(join(trash(), "repo"), { recursive: true });
    Bun.spawnSync(["mv", at, join(trash(), "repo", entry)]);

    return at;
  }

  test("--adopt gives an entry moved in by hand a note and a stamp under the workspace name its .jj records, so restore brings it back and gc ages it", () => {
    const at = byHand("c18", "c18-manual");
    expect(fleet(["ws", "restore", "repo/c18-manual"], env).stderr).toContain("has no readable note");
    expect(fleet(["ws", "trash", "--adopt", "repo/c18-manual", "--repo", repo, "--name", "c19"], env).stderr)
      .toBe("ws: trash entry repo/c18-manual is jj workspace c18 by its .jj/working_copy/checkout, not c19: leave --name out\n");
    const ran = fleet(["ws", "trash", "--adopt", "repo/c18-manual", "--repo", repo], env);
    const id = "repo/c18@20260105T090000Z";
    expect([ran.code, ran.stderr, ran.stdout]).toEqual([0, "", `adopted repo/c18-manual as ${id}: \`fleet ws restore ${id}\` brings it back, \`fleet ws gc\` deletes it after 7 days\n`]);
    expect(readJson(join(trash(), `${id}.json`))).toEqual({
      repo, workspace: "c18", path: at, commit: null, parents: [], trashed: "2026-01-05T09:00:00+00:00", fleet: "", why: "fleet ws trash --adopt: moved to the trash by hand, with no note",
    });
    expect(fleet(["ws", "trash", "--adopt", id, "--repo", repo], env).stderr).toBe(`ws: trash entry ${id} has a note already\n`);
    expect(fleet(["ws", "trash", "--adopt", "repo/nothing", "--repo", repo], env).stderr).toContain("ws: no trash entry repo/nothing in ");
    expect(fleet(["ws", "gc", "--dry-run"], { ...env, FLEET_NOW: "2026-01-13T09:00:00+00:00" }).stdout).toContain(`would delete ${id} (8d 0h old)`);
    expect(fleet(["ws", "restore", id], env).code).toBe(0);
    expect(readFileSync(join(at, "proto.txt"), "utf8")).toBe("THROWAWAY: proto\n");
    expect(names()).toBe("c18\ndefault\n");
  });

  test("--adopt of an entry whose .jj names no workspace takes --name, checked as add checks a name, and refuses without it", () => {
    byHand("c20", "x y");
    rmSync(join(trash(), "repo", "x y", ".jj", "working_copy", "checkout"));
    const adopt = (...more: string[]) => fleet(["ws", "trash", "--adopt", "repo/x y", "--repo", repo, ...more], env);
    expect(adopt().stderr).toBe("ws: trash entry repo/x y has no .jj/working_copy/checkout that names its workspace: give it with --name NAME\n");
    expect(adopt("--name", "x y").stderr).toBe("ws: a workspace name is letters, digits, '_', '.' or '-', and not 'default': \"x y\"\n");
    expect(adopt("--name", "default").code).toBe(1);
    expect(readdirSync(join(trash(), "repo"))).toEqual(["x y"]);
    const ran = adopt("--name", "c20");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(readJson(join(trash(), "repo", "c20@20260105T090000Z.json"))).toMatchObject({ workspace: "c20", path: join(base, "repo-c20") });
  });

  test("--adopt of an entry whose .jj records a name add would refuse (../x1, a NUL, a space) reads it as no name and takes --name", () => {
    byHand("c21", "odd");
    const checkout = join(trash(), "repo", "odd", ".jj", "working_copy", "checkout");
    const adopt = (...more: string[]) => fleet(["ws", "trash", "--adopt", "repo/odd", "--repo", repo, ...more], env);

    for (const recorded of ["../x1", "a\0", "x y"]) {
      const bytes = Buffer.from(recorded);
      writeFileSync(checkout, Buffer.concat([Buffer.from([0x1a, bytes.length]), bytes]));
      expect(adopt().stderr).toBe("ws: trash entry repo/odd has no .jj/working_copy/checkout that names its workspace: give it with --name NAME\n");
    }

    const ran = adopt("--name", "c21");
    expect([ran.code, ran.stderr]).toEqual([0, ""]);
    expect(readJson(join(trash(), "repo", "c21@20260105T090000Z.json"))).toMatchObject({ workspace: "c21", path: join(base, "repo-c21") });
  });
});
