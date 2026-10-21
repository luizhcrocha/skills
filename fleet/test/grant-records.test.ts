import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recordOf, recordsDir } from "../src/hub/grant-records.ts";
import { asArray, asObject, asString } from "../src/json.ts";
import { tmp } from "./support.ts";

const LOCK = ".settings.local.json.lock";

const cases = asArray(asObject(JSON.parse(readFileSync(join(import.meta.dir, "grant-records.cases.json"), "utf8")))?.["cases"]) ?? [];

describe("where a root's grant records live (grant-records.cases.json)", () => {
  test("each case's root has its records in the case's folder", () => {
    expect(cases.length).toBe(3);

    for (const c of cases) {
      const at = (k: string): string => asString(asObject(c)?.[k]) ?? "";
      expect(recordsDir(at("home"), at("root"))).toBe(at("dir"));
    }
  });

  test("no home, no records", () => {
    expect(recordOf(undefined, "/r/.claude/settings.local.json", "tstack-grants-issued.json")).toBeUndefined();
  });
});

describe("the one-time import of a record kept in the tree", () => {
  const ISSUED = "tstack-grants-issued.json";

  const setup = () => {
    const base = tmp("grant-records-");
    const root = join(base, "root");
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });

    return { home: join(base, "home"), root, file: join(root, ".claude", "settings.local.json"), old: join(root, ".claude", "hooks", ISSUED) };
  };

  test("the tree's record is copied once, every entry kept exactly once, and never read again", () => {
    const { home, root, file, old } = setup();
    const entries = ["p-1", "p-2", "p-3"].map((decision) => ({ decision, rule: `Bash(${decision})`, file, at: "2026-10-21T10:00:00+00:00", n: 1, of: 1 }));
    const text = `${JSON.stringify({ issued: entries }, null, 2)}\n`;
    writeFileSync(old, text);

    const got = recordOf(home, file, ISSUED);
    expect(got).toBe(join(recordsDir(home, root), ISSUED));
    expect(readFileSync(got ?? "", "utf8")).toBe(text);

    // A checkout puts an older record in the tree: the one outside it is the record now, as it was.
    writeFileSync(old, JSON.stringify({ issued: [entries[0]] }));
    expect(recordOf(home, file, ISSUED)).toBe(got);
    expect(readFileSync(got ?? "", "utf8")).toBe(text);
    expect((asArray(asObject(JSON.parse(readFileSync(got ?? "", "utf8")))?.["issued"]) ?? []).map((e) => asObject(e)?.["decision"])).toEqual(["p-1", "p-2", "p-3"]);
  });

  test("with no record in the tree the folder is made empty, and a record a checkout puts there later is never imported", () => {
    const { home, root, file, old } = setup();
    const got = recordOf(home, file, ISSUED);
    expect([existsSync(old), readdirSync(recordsDir(home, root))]).toEqual([false, []]);
    writeFileSync(old, JSON.stringify({ issued: [{ decision: "p-old" }] }));
    expect(recordOf(home, file, ISSUED)).toBe(got);
    expect(readdirSync(recordsDir(home, root))).toEqual([]);
  });

  test("both records of the tree come out together, and a symlink is not followed", () => {
    const { home, root, file, old } = setup();
    writeFileSync(old, "{\"issued\":[]}");
    symlinkSync(old, join(root, ".claude", "hooks", "tstack-grants-ended.json"));
    recordOf(home, file, "tstack-grants-ended.json");
    expect(readdirSync(recordsDir(home, root))).toEqual([ISSUED]);
  });

  test("nothing is imported through a symlinked hooks folder, whatever the folder it leads to holds", () => {
    const { home, root, file } = setup();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, ISSUED), "{\"issued\":[]}");
    writeFileSync(join(elsewhere, "tstack-grants-ended.json"), JSON.stringify({ ended: [{ file, decision: "p-1", rule: "Bash(ls)", granted: "2026-10-21T10:00:00+00:00", at: "x", why: "used" }] }));
    rmdirSync(join(root, ".claude", "hooks"));
    symlinkSync(elsewhere, join(root, ".claude", "hooks"));
    expect(recordOf(home, file, ISSUED)).toBe(join(recordsDir(home, root), ISSUED));
    expect(readdirSync(recordsDir(home, root))).toEqual([]);
  });

  test("a take-back forged on the tree whose rule is still in a grant file is not imported; one whose rule is gone is", () => {
    const { home, root, file } = setup();
    const take = (decision: string, rule: string) => ({ file, decision, rule, granted: "2026-10-21T10:00:00+00:00", at: "x", why: "used" });
    writeFileSync(join(root, ".claude", "tstack-grants.json"), JSON.stringify({ permissions: { allow: ["Agent(spawn)"] } }));
    writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    writeFileSync(join(root, ".claude", "hooks", ISSUED), JSON.stringify({ issued: [["p-1", "Bash(ls)"], ["p-2", "Bash(gone)"], ["p-3", "Agent(spawn)"]].map(([decision, rule]) => ({ decision, rule, file, at: "2026-10-21T10:00:00+00:00", n: 1, of: 1 })) }));
    writeFileSync(join(root, ".claude", "hooks", "tstack-grants-ended.json"), JSON.stringify({ note: "kept", ended: [take("p-1", "Bash(ls)"), take("p-2", "Bash(gone)"), take("p-3", "Agent(spawn)")] }));
    const got = recordOf(home, file, "tstack-grants-ended.json");
    expect(JSON.parse(readFileSync(got ?? "", "utf8"))).toEqual({ note: "kept", ended: [take("p-2", "Bash(gone)")] });
  });

  test("a take-back on the tree of no grant on the tree's record of issued grants is not imported, nor one marked line; one with no file and no rev matches without", () => {
    const { home, root, file, old } = setup();
    const granted = "2026-10-21T10:00:00+00:00";
    const issued = { decision: "p-1", rule: "Bash(gone)", file, at: granted, rev: "r1", n: 1, of: 1 };
    const take = { file, decision: "p-1", rule: "Bash(gone)", granted, rev: "r1", at: "x", why: "used" };
    const future = { file, decision: "p-9", rule: "Bash(echo 9)", granted: "2026-10-22T10:00:00+00:00", at: "x", why: "used" };
    const bare = { decision: "p-1", rule: "Bash(gone)", granted, at: "y", why: "used" };
    writeFileSync(old, JSON.stringify({ issued: [issued] }));
    writeFileSync(join(root, ".claude", "hooks", "tstack-grants-ended.json"), JSON.stringify({ ended: [take, bare, future, { ...take, rev: "r2" }, { ...take, file: join(root, ".claude", "tstack-grants.json") }, { ...take, line: true }] }));
    const got = recordOf(home, file, "tstack-grants-ended.json");
    expect(JSON.parse(readFileSync(got ?? "", "utf8"))).toEqual({ ended: [take, bare] });
  });

  test("only regular files are imported: a folder or a FIFO at the tree's path is skipped", () => {
    const { home, root, file, old } = setup();
    mkdirSync(old);
    execFileSync("mkfifo", [join(root, ".claude", "hooks", "tstack-grants-ended.json")]);
    recordOf(home, file, ISSUED);
    expect(readdirSync(recordsDir(home, root))).toEqual([]);
  });

  test("the import holds the settings lock: while another holds it, nothing is made and no record is given", () => {
    const { home, root, file, old } = setup();
    writeFileSync(old, "{\"issued\":[]}");
    mkdirSync(join(root, ".claude", LOCK));
    expect(recordOf(home, file, ISSUED)).toBeUndefined();
    expect(existsSync(recordsDir(home, root))).toBe(false);
    rmdirSync(join(root, ".claude", LOCK));
    expect(recordOf(home, file, ISSUED)).toBe(join(recordsDir(home, root), ISSUED));
    expect(existsSync(join(root, ".claude", LOCK))).toBe(false);
  });

  test("a root with no .claude has no record, and nothing is made", () => {
    const base = tmp("grant-records-");
    const home = join(base, "home");
    expect(recordOf(home, join(base, "root", ".claude", "settings.local.json"), ISSUED)).toBeUndefined();
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("a record a writer puts in the folder while it is imported is kept: the import moves each copy in by link, never the folder by rename", () => {
    const { home, root, file, old } = setup();
    const ended = join(root, ".claude", "hooks", "tstack-grants-ended.json");
    writeFileSync(old, "the tree's issued");
    writeFileSync(ended, "the tree's ended");
    const dir = recordsDir(home, root);
    const got = recordOf(home, file, ISSUED, { beforeMove: () => writeFileSync(join(dir, "tstack-grants-ended.json"), "a writer's") });
    expect(got).toBe(join(dir, ISSUED));
    expect([readdirSync(dir).toSorted(), readFileSync(join(dir, ISSUED), "utf8"), readFileSync(join(dir, "tstack-grants-ended.json"), "utf8")]).toEqual([["tstack-grants-ended.json", ISSUED], "the tree's issued", "a writer's"]);
    expect(readdirSync(join(home, ".claude", "tstack-grants"))).toEqual([dir.split("/").at(-1) ?? ""]);
  });

  test("a sweep started mid-import waits for it, then keeps the imported take-back and adds its own", async () => {
    const { home, root, file, old } = setup();
    const fleetDir = join(root, "..", "fleet");
    mkdirSync(fleetDir);
    const at = "2026-01-01T00:00:00+00:00";
    const rule = "Bash(echo hi)";
    writeFileSync(file, JSON.stringify({ permissions: { allow: [rule] } }));
    writeFileSync(join(fleetDir, "grants.jsonl"), `${JSON.stringify({ op: "grant", decision: "p-1", ref: "P1", rule, file, at })}\n`);
    writeFileSync(old, JSON.stringify({ issued: [{ decision: "p-0", ref: "P0", rule: "Bash(old)", file, at, n: 1, of: 1 }, { decision: "p-1", ref: "P1", rule, file, at, n: 1, of: 1 }] }));
    const taken = { file, decision: "p-0", rule: "Bash(old)", granted: at, at, why: "used" };
    writeFileSync(join(root, ".claude", "hooks", "tstack-grants-ended.json"), JSON.stringify({ ended: [taken] }));
    const script = join(root, "..", "sweep.ts");
    writeFileSync(script, `import { expireGrants } from ${JSON.stringify(join(import.meta.dir, "..", "src", "hub", "grants.ts"))};\nconsole.log(JSON.stringify(await expireGrants([${JSON.stringify(fleetDir)}], new Date("2026-01-01T00:31:00+00:00"), "2026-01-01T00:31:00+00:00", ${JSON.stringify(home)})));\n`);
    let sweep: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    recordOf(home, file, ISSUED, {
      beforeMove: () => {
        sweep = Bun.spawn(["bun", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        Bun.sleepSync(500);
      },
    });
    expect(await sweep?.exited).toBe(0);
    expect(await new Response(sweep?.stdout).text()).toBe(`${JSON.stringify([`${rule} in ${file}`])}\n`);
    const ended = asArray(asObject(JSON.parse(readFileSync(join(recordsDir(home, root), "tstack-grants-ended.json"), "utf8")))?.["ended"]) ?? [];
    expect(ended.map((e) => [asObject(e)?.["decision"], asObject(e)?.["why"]])).toEqual([["p-0", "used"], ["p-1", "expired"]]);
  });
});
