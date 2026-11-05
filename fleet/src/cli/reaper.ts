/**
 * `fleet fleets gate hogs [--json] [--read-only] [--min SIZE] [--idle MINUTES]` and `gate reap [--json]`: reaper.ts's
 * report and kill. Only `reap` signals anything, and only under the gate's lock; it has no way to name a group, so an
 * unread flag refuses rather than meaning "everything". A refusal exits 75, as a gate run that gave up does: nothing
 * happened, and it may be asked again. `$FLEET_REAPER_SNAPSHOT` reads for a read-only `hogs` alone: a table handed for a
 * test must never reach a kill.
 */
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal } from "../errors.ts";
import { floorOf, gateOf } from "../gate.ts";
import { Out } from "../io.ts";
import { stampOf } from "../clock.ts";
import { bytesText, DEFAULTS, judge, reapNow, reportText, type AuditLog, type Report, type Thresholds } from "../reaper.ts";
import { fileAuditLog, handedPath, realKillIo, realSnapshot, reportFloor, snapshotToRead } from "../reaper-read.ts";
import type { Machine } from "../world.ts";

/** Exit of a kill refused: nothing was done. */
const REFUSED = 75;

export const REAPER_VERBS: ReadonlySet<string> = new Set(["hogs", "reap"]);

function refuse(reason: string): Effect.Effect<never, Refusal> {
  return Effect.fail(new Refusal({ speaker: "fleets", reason }));
}

function auditOf(machine: Machine): AuditLog {
  return fileAuditLog(join(machine.registry.place.home, "gate"));
}

function reportLine(report: Report, at: string) {
  return { line: "report" as const, at, reapable: report.reapable, held: report.held, groups: report.groups.filter((j) => j.verdict.kind === "reap" || j.verdict.kind === "ask").map((j) => ({ key: j.group.key, verdict: j.verdict.kind, rss: j.group.rss })) };
}

/** The first word of `args` that is no flag of `bare` or `valued`, or a `valued` flag's value. */
function unreadIn(args: readonly string[], bare: readonly string[], valued: readonly string[] = []): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] ?? "";

    if (valued.includes(word)) i += 1;
    else if (!bare.includes(word)) return word;
  }

  return undefined;
}

/** `--min` and `--idle`, or why they do not read. */
function thresholdsOf(machine: Machine, args: readonly string[]): Thresholds | { readonly refused: string } {
  let { minRss, idleS } = DEFAULTS;

  for (const [i, word] of args.entries()) {
    if (word === "--min") {
      const size = floorOf(args[i + 1] ?? "", machine.env)?.bytes;

      if (size === undefined) return { refused: `--min takes a size, not '${args[i + 1] ?? ""}'` };
      minRss = size;
    } else if (word === "--idle") {
      const minutes = Number(args[i + 1]);

      if (!Number.isFinite(minutes) || minutes <= 0) return { refused: `--idle takes minutes, not '${args[i + 1] ?? ""}'` };
      idleS = minutes * 60;
    }
  }

  return { minRss, idleS };
}

function hogs(machine: Machine, args: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const unread = unreadIn(args, ["--json", "--read-only"], ["--min", "--idle"]);

    if (unread !== undefined) return yield* refuse(`gate hogs: no such flag or word: '${unread}'`);
    const t = thresholdsOf(machine, args);

    if ("refused" in t) return yield* refuse(t.refused);

    if (!args.includes("--read-only") && handedPath(machine) !== undefined) return yield* refuse(`gate hogs: FLEET_REAPER_SNAPSHOT is set: only --read-only reads a handed table, since hogs writes the audit log`);
    const report = judge(snapshotToRead(machine, gateOf(machine.registry).standing(machine.now())), t, reportFloor(machine));

    if (!args.includes("--read-only")) auditOf(machine).append(reportLine(report, stampOf(machine.now())));

    if (args.includes("--json")) out.out(`${JSON.stringify(report, null, 2)}\n`);
    else for (const line of reportText(report, t)) out.out(`${line}\n`);

    return 0;
  });
}

function reap(machine: Machine, args: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const unread = unreadIn(args, ["--json"]);

    if (unread !== undefined) {
      out.err(`gate reap: it takes only --json, not '${unread}', and nothing was done\n`);

      return REFUSED;
    }

    if (handedPath(machine) !== undefined) {
      out.err("gate reap: FLEET_REAPER_SNAPSHOT is set: a kill reads the machine only, and nothing was done\n");

      return REFUSED;
    }

    const gate = gateOf(machine.registry);
    const io = { ...realKillIo(auditOf(machine)), now: () => stampOf(machine.now()) };
    const world = { gate, read: (standing: Parameters<typeof realSnapshot>[1]) => realSnapshot(machine, standing), io, floor: reportFloor(machine) };
    const outcome = yield* Effect.promise(() => reapNow(world));

    if (args.includes("--json")) out.out(`${JSON.stringify(outcome, null, 2)}\n`);
    else {
      if (outcome.reaped.length === 0) out.out("nothing to reap\n");

      for (const r of outcome.reaped) out.out(`reaped ${r.key}: ${bytesText(r.freed)} freed, ${String(r.stopped.length)} stopped${r.left.length === 0 ? "" : `, ${String(r.left.length)} left (${r.left.join(" ")})`}\n`);
    }

    return 0;
  });
}

/** `gate hogs|reap`. */
export function reaperCli(machine: Machine, what: string, args: readonly string[]): Effect.Effect<number, Refusal, Out> {
  return what === "hogs" ? hogs(machine, args) : reap(machine, args);
}
