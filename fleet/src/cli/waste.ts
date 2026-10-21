/**
 * `fleet waste DIR [WORKER] [--json]`: what each worker of the fleet with a task id wasted, read-only,
 * from its transcript ([waste.ts](../waste.ts)); one row per worker, worst first (most cache read + input
 * past 150k, then poll seconds, then calls in probe runs). `--json` gives each worker's whole record, the
 * per-call series with it.
 */
import { join } from "node:path";

import * as Effect from "effect/Effect";

import { Refusal, UsageError } from "../errors.ts";
import { resolvePath } from "../files.ts";
import { Out } from "../io.ts";
import { decodeLedger } from "../ledger/model.ts";
import { readObject } from "../registry.ts";
import { servingSessions, workerTranscript } from "../serving.ts";
import { wasteOf, type WorkerWaste } from "../waste.ts";
import { World, type Machine } from "../world.ts";
import { exitOf, printUsage } from "./exit.ts";

const USAGE = "usage: fleet waste DIR [WORKER] [--json]\n";

const HELP = `${USAGE}
What each worker with a task id wasted, from its transcript: calls, peak context, calls past 150k and
their share of cache read + input, cache hit ratio and misses, re-read files, poll-like Bash waits,
runs of 3+ probe or screenshot calls, and the calls before the first write. Worst first. WORKER (a
worker id or task id) narrows to one worker. --json prints the records, with each call's series.`;

interface Row {
  readonly worker: string;
  readonly task_id: string;
  readonly waste: WorkerWaste;
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;

const kilo = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const secs = (s: number): string => `${Math.round(s)}s`;

function cells(r: Row): string[] {
  const w = r.waste;

  return [
    r.worker,
    r.task_id,
    String(w.calls),
    kilo(w.peak_context),
    `${w.past_cap.calls} ${pct(w.past_cap.share)}`,
    `${pct(w.cache.hit_ratio)} ${w.cache.misses}`,
    `${w.rereads.files}/${w.rereads.rereads}`,
    `${w.polls.calls} ${secs(w.polls.seconds)}/${secs(w.polls.bash_seconds)}`,
    `${w.probe_runs.runs}/${w.probe_runs.calls} ${secs(w.probe_runs.seconds)}`,
    w.ramp.wrote ? String(w.ramp.calls) : `${w.ramp.calls} -`,
  ];
}

const HEAD = ["worker", "task", "calls", "peak", ">150k share", "hit miss", "reread f/n", "poll n s/bash", "probe runs/n s", "ramp"];

function table(rows: readonly string[][]): string {
  const widths = HEAD.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));

  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd()).join("\n");
}

const worst = (a: Row, b: Row): number =>
  b.waste.past_cap.tokens - a.waste.past_cap.tokens || b.waste.polls.seconds - a.waste.polls.seconds || b.waste.probe_runs.calls - a.waste.probe_runs.calls || a.worker.localeCompare(b.worker);

function run(machine: Machine, argv: readonly string[]): Effect.Effect<number, Refusal | UsageError, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    if (argv.includes("-h") || argv.includes("--help")) return yield* printUsage(HELP);
    const json = argv.includes("--json");
    const unknown = argv.find((a) => a.startsWith("-") && a !== "--json");
    const positional = argv.filter((a) => !a.startsWith("-"));

    if (unknown !== undefined) return yield* Effect.fail(new UsageError({ prog: "fleet waste", usage: USAGE, reason: `unrecognized arguments: ${unknown}` }));

    if (positional.length < 1 || positional.length > 2) return yield* Effect.fail(new UsageError({ prog: "fleet waste", usage: USAGE, reason: "give DIR and at most one WORKER" }));
    const root = resolvePath(positional[0] ?? "");
    const ledger = decodeLedger(readObject(join(root, "state.json")) ?? {});

    if (ledger instanceof Refusal) return yield* Effect.fail(new Refusal({ speaker: "waste", reason: `${root}: ${ledger.reason}` }));
    const named = positional[1];
    const workers = ledger.agents.filter((a) => a.task_id !== undefined && a.task_id !== "" && (named === undefined || a.id === named || a.task_id === named));

    if (named !== undefined && workers.length === 0) return yield* Effect.fail(new Refusal({ speaker: "waste", reason: `no worker ${named} with a task id in ${root}` }));
    const folders = servingSessions(machine.registry, machine.config, root);

    if (folders.length === 0) {
      if (json) out.out("[]\n");
      else out.out(`no session known for ${root}: neither its scratchpad, a served registry entry, a heartbeat nor its chat watch names one\n`);

      return 0;
    }

    const rows: Row[] = [];
    const lost: string[] = [];

    for (const a of workers) {
      const task = a.task_id ?? "";
      const path = workerTranscript(folders, task);
      const waste = path === undefined ? undefined : wasteOf(path);

      if (waste === undefined) lost.push(`${a.id} (${task})`);
      else rows.push({ worker: a.id, task_id: task, waste });
    }

    rows.sort(worst);

    if (json) {
      out.out(`${JSON.stringify(rows, null, 2)}\n`);

      return 0;
    }

    const lines = [table([HEAD, ...rows.map(cells)])];

    if (named !== undefined) for (const r of rows) for (const t of r.waste.rereads.top) lines.push(`  re-read ${t.reads}x ${t.path}`);

    if (lost.length > 0) lines.push(`no transcript with usage: ${lost.join(", ")}`);
    out.out(`${lines.join("\n")}\n`);

    return 0;
  });
}

/** Run `fleet waste` with `argv` (after `waste`); the exit code. */
export function wasteCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv).pipe(Effect.catch(exitOf));
  });
}
