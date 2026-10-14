// Runs programs through a fleet checkout's real prelude and fold, as the cloud's program runtime does: the prelude
// (packages/ledger/src/prelude.ts) makes the drafts, and the fleet object's takeLog (packages/cloud/src/take-log.ts:
// the ledger's applyOps, a keyless card numbered from its letter's block, the checks across records) folds them into
// one mirror the programs share in order. The mirror starts with the number blocks a host puts (D, P, L, R from 219).
// node fleet_fold.mjs FLEET_CHECKOUT < {"programs": [{"name", "body", "fresh"?}]}
// prints [{"name", "returned", "applied": OpResult[]} | {"name", "thrown"}]; `fresh` starts that program on a mirror
// holding only the first program's records (the setup), so one program's records do not meet another's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
const at = "2026-10-14T12:00:00.000Z";
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const { preludeSource } = await load("packages/ledger/src/prelude.ts");
const { applyOps, emptyMirror } = await load("packages/ledger/src/mirror.ts");
const { takeLog } = await load("packages/cloud/src/take-log.ts");
const { programs } = JSON.parse(readFileSync(0, "utf8"));

let n = 0;
const log = new Map();
const id = () => `01K7C2Z9M4V8Q3R5T6W7X8${String(n++).padStart(4, "0")}`.slice(0, 26);
const blocks = ["D", "P", "L", "R"].map((letter, pos) => ({ _tag: "Put", kind: "numbers", key: letter, pos, record: { letter, next: 219, until: 239 } }));
let mirror = applyOps(emptyMirror, blocks).mirror;
let setup = mirror;

const records = (applied) => ({
  apply(drafts) {
    const logs = drafts.map((d) => ({ _tag: "Log", id: id(), host: "office", by: { _tag: "program", session: "s", execution: "x" }, at, ...d }));
    // The fleet object's log: round A's takeLog reads it as `logged`, slice 3's first one as `seen`.
    const folded = takeLog({ mirror, ops: logs, logged: (id) => log.get(id), seen: (id) => log.has(id), now: at });
    for (const op of folded.logged ?? []) log.set(op.id, op);
    mirror = folded.mirror;
    applied.push(...folded.results);
    return folded.results;
  },
  read(q) {
    const kind = "decisions" in q ? "decision" : q.kind;
    return Object.entries(mirror[kind] ?? {})
      .filter(([key, e]) => (q.key === undefined || key === q.key) && (!("decisions" in q) || e.record?.status === "open"))
      .map(([key, e]) => ({ kind, key, op: e.op, record: e.record }));
  },
});

const out = [];
for (const [i, p] of programs.entries()) {
  if (p.fresh) mirror = setup;
  const applied = [];
  try {
    const returned = new Function("records", `${preludeSource}\n${p.body}`)(records(applied));
    out.push({ name: p.name, returned, applied });
  } catch (e) {
    out.push({ name: p.name, thrown: String(e?.stack ?? e) });
  }
  if (i === 0) setup = mirror;
}
process.stdout.write(JSON.stringify(out));
