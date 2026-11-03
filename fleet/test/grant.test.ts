/**
 * `fleet grant use` and `fleet grants` (src/cli/grant.ts): the wire to the host over a real loopback server, and the
 * kinds file as the host writes it, read under a temp HOME at a fixed clock.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { grantWith, grantsWith } from "../src/cli/grant.ts";
import { recordingOut } from "../src/io.ts";
import { machineOf } from "../src/world.ts";
import { World } from "../src/world.ts";
import { fakeHost, stopHosts, type FakeHost, type Reply } from "./project-host-fake.ts";
import { baseEnv, tmp, type Environment, type Ran } from "./support.ts";

const CALL = "wrangler deploy";
const NOW = new Date("2026-11-03T12:00:00Z");
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KIND = { id: "k1", action: "deploy", repo: { main: "/r/fleet/.jj/repo", origin: "git@github.com:luizhcrocha/fleet.git" }, task: "tasks/grant/deploy-page.sh", sha256: SHA };

afterEach(stopHosts);

interface Place {
  readonly home: string;
  readonly dir: string;
  readonly env: Environment;
}

function place(host?: FakeHost, more: Environment = {}): Place {
  const home = tmp("fleet-grant-home-");
  const dir = join(home, "fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), "{}");

  return { home, dir, env: baseEnv(dir, { HOME: home, CLAUDE_PROJECT_DIR: "/r/ws", FLEET_RUN_URL: host?.origin ?? "http://127.0.0.1:1", ...more }) };
}

async function ran(at: Place, go: (o: { readonly cwd: string }) => ReturnType<typeof grantWith>): Promise<Ran> {
  const { layer, recorded } = recordingOut();
  const world = Layer.succeed(
    World,
    machineOf(
      () => NOW,
      (name) => at.env[name],
    ),
  );
  const code = await Effect.runPromise(go({ cwd: "/r/ws/app" }).pipe(Effect.provide(Layer.mergeAll(world, layer))));

  return { code, stdout: recorded.stdout.join(""), stderr: recorded.stderr.join("") };
}

const use = (at: Place, ...more: string[]): Promise<Ran> => ran(at, ({ cwd }) => grantWith(["use", at.dir, "--call", CALL, ...more], cwd));
const list = (at: Place): Promise<Ran> => ran(at, () => grantsWith([at.dir]));

const answering = (reply: Reply): FakeHost => fakeHost({ "POST /grants/use": reply });
const ISSUED = { status: 200, body: { kind: KIND, rule: `Bash(${CALL})`, file: "/r/ws/.claude/settings.local.json", until: "2026-11-04T09:00:00Z" } };

describe("fleet grant use", () => {
  test("sends the wire's fields and only two env names, and prints the call to run", async () => {
    const host = answering(ISSUED);
    const at = place(host, { OP_SERVICE_ACCOUNT_TOKEN: "s3cret" });
    const done = await use(at, "--agent-id", "agent-7");

    expect(host.sent.map((s) => [s.method, s.path, s.type])).toEqual([["POST", "/grants/use", "application/json"]]);
    expect(host.sent[0]?.body).toEqual({ dir: at.dir, call: CALL, cwd: "/r/ws/app", root: "/r/ws", agent_id: "agent-7", env: { HOME: at.home, CLAUDE_PROJECT_DIR: "/r/ws" } });
    expect(done).toEqual({
      code: 0,
      stdout: `granted under the kind: deploy-page in repo fleet, from any workspace, until 2026-11-04T09:00:00Z. Run exactly this call now, unchanged, once, as a Bash call of its own; the rule is in /r/ws/.claude/settings.local.json:\n  ${CALL}\n`,
      stderr: "",
    });
  });

  test("a subagent is named, and a main session sends null", async () => {
    const host = answering(ISSUED);
    await use(place(host));
    expect((host.sent[0]?.body as Record<string, unknown>)["agent_id"]).toBeNull();
  });

  test("an answer whose rule is not this call fails closed", async () => {
    const host = answering({ status: 200, body: { ...ISSUED.body, rule: "Bash(wrangler deploy --env x)" } });
    const done = await use(place(host));

    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toBe(`grant: the host issued Bash(wrangler deploy --env x), which is not this call: run nothing, and tell the owner\n`);
  });

  test("a 2xx with no rule, no file or no end time fails closed", async () => {
    for (const field of ["rule", "file", "until", "kind"]) {
      const done = await use(place(answering({ status: 200, body: { ...ISSUED.body, [field]: undefined } })));

      expect(done.code).toBe(1);
      expect(done.stderr).toContain("run nothing");
    }
  });

  test("a refusal is said in the host's words, with its tag", async () => {
    const done = await use(place(answering({ status: 409, body: { _tag: "KindLapsed", why: "the kind ended at 09:00" } })));

    expect(done).toEqual({ code: 1, stdout: "", stderr: "grant: the host refused (KindLapsed): the kind ended at 09:00. Run nothing of it; ask on a card\n" });
  });

  test("a non-2xx with no words, and a host from before this route, fail closed in plain words", async () => {
    const blank = await use(place(answering({ status: 500, body: {} })));
    expect([blank.code, blank.stderr]).toEqual([1, "grant: the host refused (500): no reason given. Run nothing of it; ask on a card\n"]);
    const old = await use(place(fakeHost({})));
    expect([old.code, old.stderr]).toEqual([1, "grant: this machine's fleet-host has no /grants/use yet: no 24-hour kind can be used here. Run nothing of it; ask on a card\n"]);
  });

  test("no host answering fails closed", async () => {
    const done = await use(place());

    expect(done.code).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("grant: nothing answers at http://127.0.0.1:1: this machine's fleet-host is not running");
    expect(done.stderr).toContain("nothing is granted, so run nothing of it");
  });

  test("a FLEET_RUN_URL off loopback sends nothing", async () => {
    const done = await use(place(undefined, { FLEET_RUN_URL: "http://example.com:7633" }));

    expect([done.code, done.stderr]).toEqual([1, "grant: FLEET_RUN_URL is http://example.com:7633; it is the host service's http address on 127.0.0.1 with its port\n"]);
  });

  test("--call is required, and so is a verb", async () => {
    const at = place();
    const bare = await ran(at, ({ cwd }) => grantWith(["use", at.dir], cwd));
    expect([bare.code, bare.stderr.includes("--call")]).toEqual([2, true]);
    const none = await ran(at, ({ cwd }) => grantWith([], cwd));
    expect(none.code).toBe(2);
  });
});

describe("fleet grants", () => {
  function kinds(at: Place, rows: readonly object[]): string {
    const file = join(at.home, ".claude", "tstack-grants", "kinds.json");
    mkdirSync(join(at.home, ".claude", "tstack-grants"), { recursive: true });
    writeFileSync(file, JSON.stringify({ kinds: rows }));

    return file;
  }

  const GRANTED = { card: "P4", team: "fleet-a", by: "owner", at: "2026-11-03T09:00:00Z" };
  const USE = { at: "2026-11-03T10:00:00Z", team: "fleet-b", workspace: "/r/ws", commit: "abc123", command: CALL, scripts: [], rule: `Bash(${CALL})` };

  test("lists each kind with what holds it now and every use, by the clock and not the file's word alone", async () => {
    const at = place();
    const file = kinds(at, [
      { ...KIND, granted: GRANTED, until: "2026-11-04T09:00:00Z", uses: [USE] },
      { id: "k2", action: "push", task: "tasks/grant/push-master.sh", sha256: SHA, repo: KIND.repo, granted: GRANTED, until: "2026-11-03T11:00:00Z", uses: [] },
      { id: "k3", action: "deploy", task: "tasks/grant/deploy-host.sh", sha256: SHA, repo: { main: "/r/other/.jj/repo", origin: null }, granted: GRANTED, until: "2026-11-04T09:00:00Z", ended: { why: "revoked", at: "2026-11-03T09:30:00Z" }, uses: [] },
    ]);
    const before = readFileSync(file, "utf8");

    expect(await list(at)).toEqual({
      code: 0,
      stdout:
        "k1: deploy-page in repo fleet, from any workspace: live until 2026-11-04T09:00:00Z, granted on P4 of fleet-a, 1 use\n" +
        "  2026-11-03T10:00:00Z fleet-b /r/ws abc123: wrangler deploy\n" +
        "k2: push-master in repo fleet, from any workspace: lapsed 2026-11-03T11:00:00Z, granted on P4 of fleet-a, 0 uses\n" +
        "k3: deploy-host in repo other, from any workspace: revoked 2026-11-03T09:30:00Z, granted on P4 of fleet-a, 0 uses\n",
      stderr: "",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("no file is no kinds", async () => {
    expect(await list(place())).toEqual({ code: 0, stdout: "no kind is granted on this machine\n", stderr: "" });
  });

  test("a file that does not read is said, not taken for none", async () => {
    const at = place();
    mkdirSync(join(at.home, ".claude", "tstack-grants"), { recursive: true });
    writeFileSync(join(at.home, ".claude", "tstack-grants", "kinds.json"), "{");
    const done = await list(at);

    expect(done.code).toBe(1);
    expect(done.stderr).toContain("kinds.json does not read");
  });

  test("a folder that is no fleet's is refused", async () => {
    const at = place();
    const done = await ran({ ...at }, () => grantsWith([join(at.home, "nope")]));

    expect(done.code).toBe(1);
    expect(done.stderr).toContain("is not a fleet's folder");
  });
});
