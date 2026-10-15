/**
 * The control plane's commands:
 *
 * - `fleet serve DIR [--stop] [--pid PID] [--take-over]`: put DIR's fleet in the registry, so the preview server
 *   serves its previews under `/f/<fleet>/` (`--stop` takes it out). A team moved to the cloud (DIR holds cloud.json)
 *   stays moved, under the marker's name, and its cloud page is printed; any other has no page until it is cut over. The entry lives while PID does: by
 *   default the Claude Code session that runs the command (the nearest `claude` among its parents). It
 *   records that session's id (`$CLAUDE_CODE_SESSION_ID`), by which a respawned session keeps the name.
 * - `fleet render STATE OUT [--fragment]`: render a page from a state file (Python's render_dashboard.py).
 * - `fleet usage capture [-- COMMAND...] | show`, `fleet spend DIR`, `fleet served`: Python's usage.py,
 *   spend.py and served.py.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { stampOf } from "../clock.ts";
import { Refusal } from "../errors.ts";
import { isDir, MOVED_MARKER, movedRefusal, readText, resolvePath, writeText } from "../files.ts";
import { discover } from "../hub/served.ts";
import { DEFAULT_PORT } from "../hub/preview-server.ts";
import { readTailnetSync, tailscaleBin } from "../hub/tailnet.ts";
import { Out } from "../io.ts";
import { recordedHost, runs } from "../host.ts";
import { asObject, asString, parseJson, parseObject } from "../json.ts";
import { decodeLedger, ledgerText } from "../ledger/model.ts";
import { withLedgerLock } from "../ledger/store.ts";
import { validate } from "../ledger/validate.ts";
import { LockFailed } from "../lock.ts";
import { cliLookups } from "../page/lookups.ts";
import { pageHtml, readTemplate, writePage } from "../page/render.ts";
import { view } from "../page/view.ts";
import { stopKept } from "../preview/sleep.ts";
import { ancestry, exeOf, isClaudeBinary, nameOf } from "../procs.ts";
import { spentBy } from "../transcripts.ts";
import { partyOf, recordTakeover } from "../takeover.ts";
import { accountOf, keepUsage, usageLines } from "../usage.ts";
import { secondsNow, World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";
import { load, pruneOutlook } from "./ws.ts";

function refuse(speaker: "serve" | "render_dashboard" | "usage" | "spend", reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker, reason }));
}

/** `body` run under the ledger's lock of `root`; a refusal when the lock cannot be taken. */
function stampUnderLock<T>(root: string, body: () => T | Refusal): T | Refusal {
  try {
    return withLedgerLock(root, body);
  } catch (cause: unknown) {
    if (cause instanceof LockFailed) return new Refusal({ speaker: "render_dashboard", reason: `the ledger's lock could not be taken: ${cause.message}` });

    throw cause;
  }
}

/** The value after `flag` in `argv`, and `argv` without the two. */
function option(argv: readonly string[], flag: string): readonly [string | undefined, string[]] {
  const at = argv.indexOf(flag);

  if (at < 0) return [undefined, [...argv]];

  return [argv[at + 1], [...argv.slice(0, at), ...argv.slice(at + 2)]];
}

function portOf(given: string | undefined, machine: Machine): number | undefined {
  const text = given ?? machine.env("FLEET_HUB_PORT") ?? String(DEFAULT_PORT);
  const port = Number(text);

  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

// -- fleet serve -------------------------------------------------------------------------------

/** The Claude Code session that runs this command: the nearest `claude` among its parents, else the parent. */
export function sessionPid(): number {
  return ancestry(process.ppid).find((pid) => isClaudeBinary(nameOf(pid), exeOf(pid))) ?? process.ppid;
}

/** The address the fleet's previews are served under on this machine (`fleet preview serve`, on the port the hub had). */
function hubUrl(machine: Machine, port: number | undefined): string {
  const at = port ?? DEFAULT_PORT;
  const self = readTailnetSync(tailscaleBin(machine.env))?.self;

  return self === undefined ? `http://127.0.0.1:${at}/` : `http://${self.dns}:${at}/`;
}

function serve(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [pidText, afterPid] = option(argv, "--pid");
    const [portText, afterPort] = option(afterPid, "--port");
    const stop = afterPort.includes("--stop");
    const takeOver = afterPort.includes("--take-over");
    const dirs = afterPort.filter((a) => a !== "--stop" && a !== "--take-over");
    const dir = dirs[0];

    if (dirs.length !== 1 || dir === undefined) return yield* refuse("serve", "usage: fleet serve DIR [--stop] [--pid PID] [--port N] [--take-over]");
    const root = resolvePath(dir);

    if (!isDir(root)) return yield* refuse("serve", `${root} is not a directory`);
    const registry = machine.registry;

    if (stop) {
      const entry = registry.find(root);
      registry.unregister(root);
      out.out(entry === undefined ? `${root} was not being served\n` : `stopped ${entry.url}\n`);
      // No request reaches its previews now: a sleeping one would never wake, an awake one never sleep.
      const kept = stopKept(root, machine.env("PATH"));

      if (kept.length > 0) out.out(`stopped the previews that sleep when idle, with their keepers: ${kept.join(", ")}\n`);
      const raw = load(root);

      if (!(raw instanceof Refusal)) for (const line of pruneOutlook(root, raw)) out.out(`${line}\n`);

      return 0;
    }

    const pid = pidText === undefined ? sessionPid() : Number(pidText);

    if (!Number.isInteger(pid) || pid <= 1) return yield* refuse("serve", "--pid takes the pid of the process the fleet lives as long as");
    // The fleet has one host. While the session that served it runs, another process serving it is a copy of that
    // session (a fork, a second resume of its transcript): it would take the page, the watch and the wakes from
    // a host that still works. Only --take-over moves the fleet, and says whom it displaced: to whoever ran it,
    // in the fleet's ledger and chat, on the page, and to the displaced session (takeover.ts).
    const was = registry.find(root);
    const host = was === undefined ? undefined : recordedHost(was);
    const displaced = host !== undefined && host.pid !== pid && runs(host) ? host : undefined;

    if (displaced !== undefined && !takeOver) {
      return yield* refuse(
        "serve",
        `${root} is hosted by the session running as pid ${String(displaced.pid)} (${was?.id ?? ""}, session ${asString(was?.raw["session_id"]) ?? "not recorded"}), which is live: ` +
          `this process (pid ${String(pid)}) is a copy of it or another session, and the fleet's page, chat watch and wakes stay that session's. ` +
          `To move the fleet here, \`fleet serve ${root} --take-over\`, which is recorded in the fleet's ledger and chat and shown to the user on its page.`,
      );
    }

    const port = portText === undefined ? undefined : portOf(portText, machine);
    const base = hubUrl(machine, port);
    const stamp = stampOf(machine.now());
    // Claude Code gives every command it runs its session's id; it survives `claude respawn`, the pid does not.
    const given = machine.env("CLAUDE_CODE_SESSION_ID");
    const session = given === undefined || given === "" ? undefined : given;
    const first = registry.register(root, base, pid, stamp, session);
    const entry = registry.register(root, `${base}f/${encodeURIComponent(first.id)}/`, pid, stamp, session);
    out.out(
      entry.moved !== true
        ? `${entry.id} is registered as this session's fleet (${root}); it has no page until the team is cut over to the cloud\n`
        : entry.url === ""
          ? `${entry.id} is moved to the cloud, but ${join(root, MOVED_MARKER)} names no https page\n`
          : `${entry.id} is moved to the cloud: its page is ${entry.url}\n`,
    );

    if (displaced !== undefined) {
      out.out(`took over from the session running as pid ${String(displaced.pid)} (session ${asString(was?.raw["session_id"]) ?? "not recorded"}): its chat watch stands down, and it is not woken for this fleet any more\n`);
      // Never silent: the user reads it on the page, and the displaced session's watch says it as it stands down.
      const recorded = recordTakeover(machine, root, partyOf(pid, asString(entry.raw["session_id"])), partyOf(displaced.pid, asString(was?.raw["session_id"])));
      const where = [...(recorded.event ? ["an event in the fleet's ledger"] : []), ...(recorded.message === undefined ? [] : [`#${String(recorded.message)} in its chat`])];

      if (where.length > 0) out.out(`recorded: ${where.join(" and ")}${recorded.message === undefined ? "" : "; the page shows it to the user until the host has read their next message"}\n`);

      for (const fault of recorded.faults) out.err(`serve: the takeover is not recorded where it should be: ${fault}\n`);
    }

    const boss = registry.manager();

    if (boss !== undefined && entry.role !== "manager") {
      out.out(`manager: session ${boss.session ?? "(not named yet)"}  ${boss.url}  what holds for every fleet: ${join(boss.dir, "standing.md")}\n`);
    }

    return 0;
  });
}

// -- fleet render ------------------------------------------------------------------------------

function render(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const paths = argv.filter((a) => !a.startsWith("--"));
    const [statePath, outPath] = paths;

    if (paths.length !== 2 || statePath === undefined || outPath === undefined) {
      return yield* refuse("render_dashboard", "usage: fleet render STATE_JSON OUT_HTML [--fragment]");
    }

    const moved = movedRefusal(dirname(resolvePath(statePath)));

    if (moved !== undefined) return yield* refuse("render_dashboard", moved);

    const stamped = stampUnderLock(dirname(resolvePath(statePath)), (): { readonly text: string; readonly agents: number; readonly updated: string } | Refusal => {
      const text = readText(statePath);
      const object = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));

      if (object === undefined) return new Refusal({ speaker: "render_dashboard", reason: `cannot read state: ${statePath}` });
      const ledger = decodeLedger(object);

      if (ledger instanceof Refusal) return ledger;
      const fault = validate(ledger);

      if (fault !== undefined) return fault;
      ledger.updated = stampOf(machine.now());
      const written = ledgerText(ledger);
      writeText(statePath, written);

      return { text: written, agents: ledger.agents.length, updated: ledger.updated };
    });

    if (stamped instanceof Refusal) return yield* Effect.fail(stamped);
    const written = stamped.text;
    const template = readTemplate();
    const shown = view(machine, cliLookups(), Option.getOrElse(parseObject(written), () => ({})), dirname(resolvePath(statePath)));
    const html = template === undefined ? new Error("cannot read the template") : pageHtml(template, shown, argv.includes("--fragment"));

    if (html instanceof Error) return yield* refuse("render_dashboard", html.message);
    writePage(outPath, html);
    out.out(`rendered ${outPath} (${String(stamped.agents)} agents, updated ${stamped.updated})\n`);

    return 0;
  });
}

// -- usage, spend, served ----------------------------------------------------------------------

function usage(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const home = machine.registry.place.home;

    if (argv.length === 1 && argv[0] === "show") {
      for (const line of usageLines(home, secondsNow(machine))) out.out(`${line}\n`);

      return 0;
    }

    if (argv[0] !== "capture") return yield* refuse("usage", "usage: fleet usage capture [-- COMMAND...] | show");
    const rest = argv.slice(1);
    const command = rest[0] === "--" ? rest.slice(1) : rest;
    let given: Buffer = Buffer.alloc(0);

    try {
      given = Buffer.from(yield* Effect.promise(() => Bun.stdin.arrayBuffer()));
      const limits = asObject(Option.getOrUndefined(parseJson(given.toString("utf8"))))?.["rate_limits"];

      if (limits !== undefined) keepUsage(home, limits, secondsNow(machine), process.pid, accountOf(machine.env));
    } catch {
      // the status line comes first: nothing here may stop it
    }

    const [program, ...args] = command;

    if (program === undefined) return 0;
    const done = spawnSync(program, args, { input: given, stdio: ["pipe", "inherit", "inherit"] });

    if (done.error !== undefined) {
      out.err(`usage: cannot run ${program}: ${done.error.message}\n`);

      return 127;
    }

    return done.status ?? 1;
  });
}

function spend(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [dir] = argv;

    if (argv.length !== 1 || dir === undefined) return yield* refuse("spend", "usage: fleet spend DIR");
    const spent = spentBy(dir, machine.config);

    if (spent === undefined) {
      out.out(`no transcript for ${dir}: it is not a directory in a session's scratchpad, or the session has not answered yet\n`);

      return 0;
    }

    const share = spent.input > 0 ? Math.round((100 * spent.cached) / spent.input) : 0;
    const n = (x: number): string => x.toLocaleString("en-US");
    out.out(`${n(spent.output)} tokens written and ${n(spent.input)} read (${share}% from the cache) in ${n(spent.answers)} answers\n`);

    return 0;
  });
}

function served(machine: Machine): Effect.Effect<number, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    for (const s of yield* Effect.promise(() => discover(machine))) {
      out.out(`${s.url}  ${s.up ? "up" : "down"}  ${s.fleet ?? "(no fleet)"}  pid ${s.pid ?? "-"}  ${s.cwd}\n`);

      if (s.command !== "") out.out(`    ${s.command}\n`);
    }

    return 0;
  });
}

/** Run one of the control plane's commands (`cli` is serve, render, usage, spend or served). */
export function controlCli(cli: string, argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    const run =
      cli === "serve"
        ? serve(machine, argv)
        : cli === "render"
          ? render(machine, argv)
          : cli === "usage"
            ? usage(machine, argv)
            : cli === "spend"
              ? spend(machine, argv)
              : served(machine);

    return yield* run.pipe(Effect.catch(exitOf));
  });
}

/** The CLIs {@link controlCli} runs. */
export const CONTROL_CLIS = ["serve", "render", "usage", "spend", "served"] as const;
