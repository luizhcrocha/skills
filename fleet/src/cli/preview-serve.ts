/**
 * `fleet preview serve [--port N] [--https PORT] [--share-port N]`: the workers' previews (`hub/preview-server.ts`),
 * at the port and paths the hub had, so its links keep working. Runs until SIGTERM or SIGINT. With it, the public
 * side for shared previews on loopback (`hub/preview-share.ts`).
 *
 * `fleet preview share <fleet> [<worker>] [--for 24h] [--password-file F]` shares one preview publicly and prints
 * its link and password once; `fleet preview unshare <fleet> [<worker>]` ends it; `fleet preview shares` lists them.
 */
import * as Effect from "effect/Effect";

import { readFileSync } from "node:fs";

import { Refusal } from "../errors.ts";
import { resolvePath } from "../files.ts";
import { createShare, FUNNEL_PORT, readShares, removeShares, SHARE_MS, SHARE_PORT } from "../hub/preview-share.ts";
import { readRecord } from "../preview/record.ts";
import type { Entry } from "../registry.ts";
import { DEFAULT_PORT, startPreviewServer } from "../hub/preview-server.ts";
import { readTailnetSync, tailscaleBin } from "../hub/tailnet.ts";
import { Out } from "../io.ts";
import { World, type Machine } from "../world.ts";
import { exitOf } from "./exit.ts";

/** The verbs of `fleet preview` that take no fleet's directory. */
export const SERVER_VERBS: ReadonlySet<string> = new Set(["serve", "share", "unshare", "shares"]);

const USAGE = "usage: fleet preview serve [--port N] [--https PORT] [--share-port N] | share FLEET [WORKER] [--for 24h] [--password-file F] | unshare FLEET [WORKER] | shares";

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "preview", reason }));
}

/** The value after `flag` in `argv`, and `argv` without the two. */
function option(argv: readonly string[], flag: string): readonly [string | undefined, string[]] {
  const at = argv.indexOf(flag);

  if (at < 0) return [undefined, [...argv]];

  return [argv[at + 1], [...argv.slice(0, at), ...argv.slice(at + 2)]];
}

function portOf(text: string | undefined): number | undefined {
  const port = Number(text);

  return text !== undefined && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function serve(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [portText, afterPort] = option(argv, "--port");
    const [httpsText, afterHttps] = option(afterPort, "--https");
    const [shareText, rest] = option(afterHttps, "--share-port");

    if (rest.length > 0) return yield* refuse(USAGE);
    const sharePort = portOf(shareText ?? machine.env("FLEET_SHARE_PORT") ?? String(SHARE_PORT));
    const port = portOf(portText ?? machine.env("FLEET_HUB_PORT") ?? String(DEFAULT_PORT));
    const https = httpsText === undefined ? undefined : portOf(httpsText);

    if (port === undefined || sharePort === undefined || (httpsText !== undefined && https === undefined)) return yield* refuse("a port is a number from 1 to 65535");
    const log = (line: string): void => out.err(`preview serve: ${line}\n`);
    const running = yield* Effect.promise(() => startPreviewServer({ port, machine, tailscale: tailscaleBin(machine.env), https, sharePort }, log));

    if (running instanceof Error) return yield* refuse(running.message);

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.once("SIGTERM", () => resolve());
          process.once("SIGINT", () => resolve());
        }),
    );
    yield* Effect.promise(() => running.stop());
    log("stopped");

    return 0;
  });
}

/** `24h`, `90m`, `2d` in ms. */
function durationOf(text: string): number | undefined {
  const m = /^(\d+)([mhd])$/.exec(text);

  if (m === null) return undefined;
  const n = Number(m[1]);

  return n > 0 ? n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000) : undefined;
}

/** The fleet a name or a directory names, among those this machine shows (moved teams included). */
function fleetOf(machine: Machine, name: string): Entry | undefined {
  const shown = machine.registry.shown();
  const dir = name.includes("/") ? resolvePath(name) : undefined;

  return shown.find((e) => e.dir === dir || e.id === name) ?? shown.find((e) => e.aliases.includes(name));
}

function share(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [forText, afterFor] = option(argv, "--for");
    const [passwordFile, rest] = option(afterFor, "--password-file");
    const [name, worker, ...extra] = rest;

    if (name === undefined || extra.length > 0 || rest.some((a) => a.startsWith("-"))) return yield* refuse(USAGE);
    const ms = forText === undefined ? SHARE_MS : durationOf(forText);

    if (ms === undefined) return yield* refuse("--for is a length such as 90m, 24h or 2d");
    const entry = fleetOf(machine, name);

    if (entry === undefined) return yield* refuse(`no fleet '${name}' here`);
    const record = readRecord(entry.dir);
    const server = worker === undefined ? record?.server : record?.workers.find((w) => w.worker === worker);

    if (server === undefined || server === null) return yield* refuse(worker === undefined ? `${entry.id} has no combined preview` : `${entry.id} has no preview of ${worker}`);
    let password: string | undefined;

    if (passwordFile !== undefined) {
      try {
        password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
      } catch (cause: unknown) {
        return yield* refuse(`cannot read ${passwordFile}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }

      if (password.length < 12) return yield* refuse("a share's password is at least 12 characters");
    }

    const made = createShare(machine.registry.place.home, { fleet: entry.id, dir: entry.dir, worker: worker ?? null, ms, password, now: Date.now() });
    const dns = readTailnetSync(tailscaleBin(machine.env))?.self.dns ?? "<this machine's MagicDNS name>";
    out.out(`link: https://${dns}:${FUNNEL_PORT}/${made.token}/\n`);
    out.out(`password: ${made.password}\n`);
    out.out(`until: ${new Date(made.share.expires).toISOString()}\n`);
    out.err(`preview: the public side needs \`fleet preview serve\` running and, once, the owner's \`tailscale funnel --bg --https=${FUNNEL_PORT} http://127.0.0.1:${SHARE_PORT}\`\n`);

    return 0;
  });
}

function unshare(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const [name, worker, ...extra] = argv;

    if (name === undefined || extra.length > 0) return yield* refuse(USAGE);
    const entry = fleetOf(machine, name);
    const fleet = entry?.id ?? name;
    const gone = removeShares(machine.registry.place.home, (s) => s.fleet === fleet && (worker === undefined || s.worker === worker), Date.now());
    out.out(`ended ${gone} share${gone === 1 ? "" : "s"} of ${fleet}${worker === undefined ? "" : `/${worker}`}\n`);

    return 0;
  });
}

function shares(machine: Machine): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const now = Date.now();

    for (const s of readShares(machine.registry.place.home).filter((x) => x.expires > now)) {
      out.out(`${s.id} ${s.fleet}${s.worker === null ? "" : `/${s.worker}`} until ${new Date(s.expires).toISOString()}\n`);
    }

    return 0;
  });
}

/** Run `fleet preview <verb> …` for a verb of {@link SERVER_VERBS}. */
export function previewServerCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;
    const [verb, ...rest] = argv;
    const run = verb === "serve" ? serve(machine, rest) : verb === "share" ? share(machine, rest) : verb === "unshare" ? unshare(machine, rest) : verb === "shares" ? shares(machine) : refuse(USAGE);

    return yield* run.pipe(Effect.catch(exitOf));
  });
}
