/**
 * The herdr adapter (src/team/herdr.ts). On a stand-in `herdr` script that records its arguments: the command an
 * agent's tab starts, the bounded wait, and a server that never answers. On real herdr: a throwaway session
 * `fleet-team-test-<random>` started headless, a tab running `sleep 600` in place of claude, closed, the session
 * stopped and deleted. It closes only what it made, never touches another session, never stops the server, and
 * is skipped without herdr.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { parseAgent, type Agent } from "../src/team/agents.ts";
import { claudeArgv, herdrLauncher } from "../src/team/herdr.ts";
import { tmp } from "./support.ts";

function agent(text = '{"fleet": {"role": "coordinator"}}'): Agent {
  const parsed = parseAgent("ui", text);

  if ("why" in parsed) throw new Error(parsed.why);

  return parsed;
}

/** A stand-in `herdr` binary, the folder it keeps its files in, and the argument lines it was called with. */
interface StandIn {
  readonly bin: string;
  readonly dir: string;
  readonly calls: () => string[];
}

/** A stand-in `herdr` in a new folder: it appends its arguments to `calls` and answers as herdr would, a server
 * writing its pid to `server.pid` and never answering when `mute` is there. */
function standIn(): StandIn {
  const dir = tmp("fleet-team-bin-");
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  *" server") echo $$ > "${dir}/server.pid"; exec sleep 600 ;;
  *"workspace list"*) [ -e "${dir}/mute" ] && exit 1; echo '{"result":{"workspaces":[{"workspace_id":"w1"}]}}' ;;
  *"tab create"*) echo '{"result":{"tab":{"tab_id":"w1:t1","label":"ui"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  *"agent start"*) [ -e "${dir}/blocked" ] && { echo '{"error":{"message":"agent ui is blocked during startup and is not ready for prompts"}}' >&2; exit 1; }
    [ -e "${dir}/broken" ] && { echo '{"error":{"message":"claude exited"}}' >&2; exit 1; }
    echo '{"result":{}}' ;;
  *"agent wait"*) echo '{"error":{"message":"timed out"}}' >&2; exit 1 ;;
  "session list --json") echo '{"sessions":[]}' ;;
  *) echo '{"result":{}}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);

  return { bin, dir, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n") };
}

describe("herdr's command lines", () => {
  test("an agent's tab starts a new claude named after it, its system prompt in a file beside the team's marks", () => {
    const fake = standIn();
    const state = tmp("fleet-team-state-");
    const tab = herdrLauncher({ state, bin: fake.bin }).tab("s", { cwd: "/r", label: "ui", agent: agent('{"system": "Run the UI fleet.", "fleet": {"role": "coordinator"}}') });

    expect(tab).toEqual({ handle: "w1:t1", label: "ui" });
    expect(fake.calls().at(-1)).toBe(`--session s agent start ui --kind claude --pane w1:p1 --timeout 120000 -- --name ui --model opus --effort low --remote-control ui --append-system-prompt-file ${state}/ui.system.md`);
    expect(readFileSync(join(state, "ui.system.md"), "utf8")).toBe("Run the UI fleet.");
  });

  test("an agent blocked at its start on a prompt (a new folder's trust question) keeps its tab, for the user to answer", () => {
    const fake = standIn();
    writeFileSync(join(fake.dir, "blocked"), "");
    const tab = herdrLauncher({ state: tmp("fleet-team-state-"), bin: fake.bin }).tab("s", { cwd: "/r", label: "ui", agent: agent() });

    expect(tab).toEqual({ blocked: { handle: "w1:t1", label: "ui" } });
    expect(fake.calls().filter((c) => c.includes("tab close"))).toEqual([]);
  });

  test("an agent that fails to start any other way has its tab closed", () => {
    const fake = standIn();
    writeFileSync(join(fake.dir, "broken"), "");
    const tab = herdrLauncher({ state: tmp("fleet-team-state-"), bin: fake.bin }).tab("s", { cwd: "/r", label: "ui", agent: agent() });

    expect("why" in tab && tab.why).toContain("claude exited");
    expect(fake.calls().at(-1)).toBe("--session s tab close w1:t1");
  });

  test("remote control off and no system prompt leave both out", () => {
    expect(claudeArgv(agent('{"fleet": {"role": "coordinator", "remote_control": false}}'), undefined)).toEqual(["claude", "--name", "ui", "--model", "opus", "--effort", "low"]);
  });

  test("settle waits a bounded time and says so when it gives up", () => {
    const fake = standIn();

    expect(herdrLauncher({ state: fake.dir, bin: fake.bin }).settle("s", "ui")).toEqual({ why: "it was not ready within 10 min (herdr agent wait: timed out)" });
    expect(fake.calls()).toEqual(["--session s agent wait ui --until idle --until done --timeout 600000"]);
  });

  test("a server that never answers is stopped with its process group", () => {
    const fake = standIn();
    writeFileSync(join(fake.dir, "mute"), "");
    const opened = herdrLauncher({ state: fake.dir, bin: fake.bin, serverWaitMs: 600 }).open("s", fake.dir);

    expect(opened).toEqual({ why: "herdr session s did not answer within 0.6 s of starting; its server was stopped" });
    const pid = readFileSync(join(fake.dir, "server.pid"), "utf8").trim();
    Bun.sleepSync(200);
    const stat = existsSync(`/proc/${pid}/stat`) ? (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] ?? "") : "gone";

    expect(["gone", "Z"]).toContain(stat);
  });
});

const HERDR = Bun.which("herdr");

/** The processes this run's herdr server left behind: it fetches agent-detection manifests with curl
 * (herdr.dev), which outlive the session by up to their 15 s timeout. */
function leftBehind(): number[] {
  const mark = process.env["FLEET_TEST_RUN"];

  return readdirSync("/proc").flatMap((entry) => {
    const pid = Number(entry);

    try {
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8");

      return Number.isInteger(pid) && pid !== process.pid && mark !== undefined && environ.includes(`FLEET_TEST_RUN=${mark}`) && command.includes("herdr") ? [pid] : [];
    } catch {
      return [];
    }
  });
}

/** Stop what the throwaway session left: its own processes only, found by this run's mark. */
function stopLeftBehind(): void {
  for (const pid of leftBehind()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  }
}

describe.skipIf(HERDR === null)("herdr", () => {
  test(
    "a session started headless takes a tab running a command, typed for nushell, and gives it back closed",
    () => {
      const session = `fleet-team-test-${Math.random().toString(36).slice(2, 10)}`;
      const dir = tmp("fleet-team-herdr-");
      let command = ["/bin/sh", "-c", "sleep 600"];
      const herdr = herdrLauncher({ state: dir, command: () => command });
      let handle = "";

      try {
        const opened = herdr.open(session, dir);

        if ("why" in opened || opened.started === undefined) throw new Error(`not started: ${JSON.stringify(opened)}`);
        handle = opened.started;
        expect(herdr.open(session, dir)).toEqual({ started: undefined });
        expect(herdr.sessions()).toContain(session);
        expect(herdr.owns(session, handle)).toBe(true);
        expect(herdr.owns(session, "1@0")).toBe(false);

        const first = herdr.tab(session, { cwd: dir, label: "ui", agent: agent() });

        if ("why" in first) throw new Error(first.why);

        if ("blocked" in first) throw new Error(`first blocked at its start`);
        const second = herdr.tab(session, { cwd: dir, label: "web", agent: agent() });

        if ("why" in second) throw new Error(second.why);

        if ("blocked" in second) throw new Error(`second blocked at its start`);
        const look = herdr.look(session);

        expect("why" in look ? look.why : look.tabs).toEqual([first, second]);
        expect(first.label).toBe("ui");
        command = ["/bin/sh", "-c", "echo it's"];
        expect(herdr.tab(session, { cwd: dir, label: "x", agent: agent() })).toEqual({
          why: `the tab's command holds a quote or a line break ("echo it's"), which the pane's shell would misread`,
        });

        expect(herdr.close(session, second.handle)).toBeUndefined();
        const after = herdr.look(session);

        expect("why" in after ? after.why : after.tabs.map((t) => t.label)).toEqual(["ui"]);
        expect(herdr.close(session, first.handle)).toBeUndefined();
      } finally {
        expect(herdr.end(session, handle)).toBeUndefined();
        spawnSync("herdr", ["session", "delete", session]);
        stopLeftBehind();
      }

      expect(herdr.sessions()).not.toContain(session);
      expect(herdr.owns(session, handle)).toBe(false);
    },
    60_000,
  );
});
