/**
 * The control plane's commands:
 *
 * - `fleet hub [--port N] [--https PORT] [--no-peers] [--reload | --no-reload]`: run the hub until stopped
 *   (SIGTERM, SIGINT). The port is `--port`, else `$FLEET_HUB_PORT`, else 7420. Under a supervisor (systemd,
 *   launchd), or with `--reload`, it also stops when its own sources change, exiting 75 so the supervisor
 *   starts it on the new code.
 * - `fleet serve DIR [--stop] [--pid PID]`: put DIR's fleet in the registry, so the hub serves it at
 *   `/f/<fleet>/`, and print its address (`--stop` takes it out). The entry lives while PID does: by
 *   default the Claude Code session that runs the command (the nearest `claude` among its parents).
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
import { isDir, readText, resolvePath, writeText } from "../files.ts";
import { discover } from "../hub/served.ts";
import { codeChanged, RELOAD_EXIT, supervised } from "../hub/reload.ts";
import { DEFAULT_PORT, runningHub, startHub } from "../hub/server.ts";
import { readTailnetSync, tailscaleBin } from "../hub/tailnet.ts";
import { Out } from "../io.ts";
import { asObject, parseJson, parseObject } from "../json.ts";
import { decodeLedger, ledgerText } from "../ledger/model.ts";
import { validate } from "../ledger/validate.ts";
import { cliLookups } from "../page/lookups.ts";
import { pageHtml, readTemplate, writePage } from "../page/render.ts";
import { view } from "../page/view.ts";
import { ancestry, nameOf } from "../procs.ts";
import { spentBy } from "../transcripts.ts";
import { keepUsage, usageLines } from "../usage.ts";
import { secondsNow, World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

function refuse(speaker: "hub" | "serve" | "render_dashboard" | "usage" | "spend", reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker, reason }));
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

// -- fleet hub ---------------------------------------------------------------------------------

function hub(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [portText, afterPort] = option(argv, "--port");
    const [httpsText, rest] = option(afterPort, "--https");
    const peers = !rest.includes("--no-peers");
    const reload = rest.includes("--reload") || (!rest.includes("--no-reload") && supervised(machine.env));
    const unknown = rest.filter((a) => a !== "--no-peers" && a !== "--reload" && a !== "--no-reload");

    if (unknown.length > 0) return yield* refuse("hub", "usage: fleet hub [--port N] [--https PORT] [--no-peers] [--reload | --no-reload]");
    const port = portOf(portText, machine);
    const https = httpsText === undefined ? undefined : portOf(httpsText, machine);

    if (port === undefined || (httpsText !== undefined && https === undefined)) return yield* refuse("hub", "a port is a number from 1 to 65535");
    const log = (line: string): void => out.err(`hub: ${line}\n`);
    const underSupervisor = supervised(machine.env);
    const serving = underSupervisor ? undefined : runningHub(machine.registry.place.home);

    // A hub started by hand leaves a running hub alone: under a supervisor it would only be stopped again.
    if (serving !== undefined) {
      out.out(`${serving.url}\n`);
      log(`a hub already serves ${serving.url} (pid ${String(serving.pid)}${serving.supervised ? ", the service" : ""}); leaving it`);

      return 0;
    }

    const running = yield* Effect.promise(() =>
      startHub({ port, machine, tailscale: tailscaleBin(machine.env), peers, hosts: [], https, supervised: underSupervisor }, log),
    );

    if (running instanceof Error) return yield* refuse("hub", running.message);
    out.out(`${running.url}\n`);

    const watch = reload ? codeChanged() : undefined;

    const why = yield* Effect.promise(() =>
      Promise.race([
        new Promise<"signal">((resolve) => {
          process.once("SIGTERM", () => resolve("signal"));
          process.once("SIGINT", () => resolve("signal"));
        }),
        ...(watch ? [watch.changed.then(() => "code" as const)] : []),
      ]),
    );

    watch?.stop();

    if (why === "code") log("its code changed: stopping, to be started again on the new code");
    yield* Effect.promise(() => running.stop());
    log("stopped");

    return why === "code" ? RELOAD_EXIT : 0;
  });
}

// -- fleet serve -------------------------------------------------------------------------------

/** The Claude Code session that runs this command: the nearest `claude` among its parents, else the parent. */
export function sessionPid(): number {
  return ancestry(process.ppid).find((pid) => nameOf(pid) === "claude") ?? process.ppid;
}

/** The hub's address on this machine: the running hub's, else the one it will have. */
function hubUrl(machine: Machine, port: number | undefined): string {
  const running = runningHub(machine.registry.place.home);

  if (running !== undefined && port === undefined) return running.url;
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
    const dirs = afterPort.filter((a) => a !== "--stop");
    const dir = dirs[0];

    if (dirs.length !== 1 || dir === undefined) return yield* refuse("serve", "usage: fleet serve DIR [--stop] [--pid PID] [--port N]");
    const root = resolvePath(dir);

    if (!isDir(root)) return yield* refuse("serve", `${root} is not a directory`);
    const registry = machine.registry;

    if (stop) {
      const entry = registry.find(root);
      registry.unregister(root);
      out.out(entry === undefined ? `${root} was not being served\n` : `stopped ${entry.url}\n`);

      return 0;
    }

    const pid = pidText === undefined ? sessionPid() : Number(pidText);

    if (!Number.isInteger(pid) || pid <= 1) return yield* refuse("serve", "--pid takes the pid of the process the fleet lives as long as");
    const port = portText === undefined ? undefined : portOf(portText, machine);
    const base = hubUrl(machine, port);
    const stamp = stampOf(machine.now());
    const first = registry.register(root, base, pid, stamp);
    const entry = registry.register(root, `${base}f/${encodeURIComponent(first.id)}/`, pid, stamp);
    out.out(`${entry.url}\n`);
    const boss = registry.manager();

    if (boss !== undefined && entry.role !== "manager") {
      out.out(`manager: session ${boss.session ?? "(not named yet)"}  ${boss.url}  what holds for every fleet: ${join(boss.dir, "standing.md")}\n`);
    }

    if (runningHub(registry.place.home) === undefined) {
      out.err(`serve: no hub runs on this machine yet; start it (systemctl --user start fleet-hub, or fleet hub) and ${entry.url} answers\n`);
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

    const text = readText(statePath);
    const object = text === undefined ? undefined : Option.getOrUndefined(parseObject(text));

    if (object === undefined) return yield* refuse("render_dashboard", `cannot read state: ${statePath}`);
    const ledger = decodeLedger(object);

    if (ledger instanceof Refusal) return yield* Effect.fail(ledger);
    const fault = validate(ledger);

    if (fault !== undefined) return yield* Effect.fail(fault);
    ledger.updated = stampOf(machine.now());
    const written = ledgerText(ledger);
    writeText(statePath, written);
    const template = readTemplate();
    const shown = view(machine, cliLookups(), Option.getOrElse(parseObject(written), () => ({})), dirname(resolvePath(statePath)));
    const html = template === undefined ? new Error("cannot read the template") : pageHtml(template, shown, argv.includes("--fragment"));

    if (html instanceof Error) return yield* refuse("render_dashboard", html.message);
    writePage(outPath, html);
    out.out(`rendered ${outPath} (${ledger.agents.length} agents, updated ${ledger.updated})\n`);

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
      keepUsage(home, asObject(Option.getOrUndefined(parseJson(given.toString("utf8"))))?.["rate_limits"], secondsNow(machine), process.pid);
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

/** Run one of the control plane's commands (`cli` is hub, serve, render, usage, spend or served). */
export function controlCli(cli: string, argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    const run =
      cli === "hub"
        ? hub(machine, argv)
        : cli === "serve"
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
export const CONTROL_CLIS = ["hub", "serve", "render", "usage", "spend", "served"] as const;
