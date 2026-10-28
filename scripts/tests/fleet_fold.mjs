// Runs programs through a fleet checkout's real prelude and fold, as the cloud's program runtime does: the prelude
// (packages/ledger/src/prelude.ts) makes the drafts, and the fleet object's takeLog (packages/cloud/src/take-log.ts:
// the ledger's applyOps, a keyless card numbered from its letter's block, the checks across records) folds them into
// one mirror the programs share in order. The mirror starts with the number blocks a host puts (every letter it
// numbers with, apps/host/src/numbers.ts, from 219). A program's body runs as an async function, as the cloud's
// runtime runs it, so it may await grill.answer and the other intents that read the card. The bodies prelude runs after
// the prelude, as in the cloud, over a `bodies` connector of each program's own that keeps nothing: it holds a put to
// the cloud's rules (packages/cloud/src/bodies.ts:349-354: the ask's shape, a card id, 16 puts a program, the text's
// 2 MB, never empty) and answers the revision of the text it was given. It checks the Markdown text only: the cloud
// also holds the HTML that marked makes of it to 2 MB and never empty (bodies.ts:355-358), and its revision is of that
// HTML, but marked is not installed for the harness. A program over the service's limit (wire.ts) throws. The work
// prelude runs too, over a `work` connector that keeps no answer. Its read answers the input's `work` rows (a
// program's own `work` in their place), filtered as the cloud's work.read filters them (packages/cloud/src/
// program-object.ts: by repo, and by the row's team, work.ts's teamOf, `team` by default and none for team: null).
// node fleet_fold.mjs FLEET_CHECKOUT < {"programs": [{"name", "body", "fresh"?, "work"?}], "gate"?: ISO time,
//   "work"?: WorkRow[], "team"?: the fleet the programs run as}
// prints [{"name", "returned", "applied": OpResult[]} | {"name", "thrown"}]; `fresh` starts that program on a mirror
// holding only the first program's records (the setup), so one program's records do not meet another's. `gate` is the
// owner-answer gate's time (the Worker's OWNER_ANSWERS_FROM, takeLog's ownerAnswersFrom): from it, the fold refuses
// a program's decide.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
const at = "2026-10-14T12:00:00.000Z";
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const { preludeSource, bodiesPreludeSource, workPreludeSource = "" } = await load("packages/ledger/src/prelude.ts");
const { bodySentences, CARD_ID, EVIDENCE_LIMIT_BYTES, revisionOf } = await load("packages/ledger/src/bodies.ts");
const { PROGRAM_LIMIT_BYTES } = await load("packages/ledger/src/wire.ts");
const { applyOps, emptyMirror } = await load("packages/ledger/src/mirror.ts");
const { takeLog } = await load("packages/cloud/src/take-log.ts");
const { programs, gate, work: rows = [], team: ownTeam = "skills" } = JSON.parse(readFileSync(0, "utf8"));
const worked = rows.length > 0 || programs.some((p) => p.work?.length);
const { teamOf } = worked ? await load("packages/ledger/src/work.ts") : {};
const workOf = (given) => ({
  async read({ repo, team = ownTeam } = {}) {
    return structuredClone(given.filter((row) =>
      (repo === undefined || row.key.slice(0, row.key.lastIndexOf("/")) === repo) && (team === null || teamOf(row) === team)));
  },
});

let n = 0;
const log = new Map();
const id = () => `01K7C2Z9M4V8Q3R5T6W7X8${String(n++).padStart(4, "0")}`.slice(0, 26);
const blocks = ["D", "A", "I", "S", "G", "N", "P", "L", "R"].map((letter, pos) => ({ _tag: "Put", kind: "numbers", key: letter, pos, record: { letter, next: 219, until: 239 } }));
const AsyncFunction = (async () => {}).constructor;
const utf8 = new TextEncoder();
// PROGRAM_BODIES_LIMIT, packages/cloud/src/program-object.ts:77: the puts one program may make.
const PROGRAM_BODIES_LIMIT = 16;
const bodiesOf = () => {
  let puts = 0;
  return { async put(asked) {
    const keys = Object.keys(asked ?? {}).toSorted().join(",");
    const text = asked?.html ?? asked?.markdown;
    if (typeof asked?.card !== "string" || typeof text !== "string" || (keys !== "card,html" && keys !== "card,markdown"))
      throw new Error("bodies.put takes { card, html } or { card, markdown }, both strings");
    if (!CARD_ID.test(asked.card)) throw new Error(bodySentences.notACard(asked.card));
    if (++puts > PROGRAM_BODIES_LIMIT) throw new Error(`a program puts at most ${PROGRAM_BODIES_LIMIT} bodies`);
    const bytes = utf8.encode(text);
    if (bytes.byteLength > EVIDENCE_LIMIT_BYTES) throw new Error(bodySentences.tooLarge(bytes.byteLength));
    if (bytes.byteLength === 0) throw new Error(bodySentences.empty);
    return { revision: await revisionOf(bytes) };
  } };
};
let mirror = applyOps(emptyMirror, blocks).mirror;
let setup = mirror;

const records = (applied) => ({
  apply(drafts) {
    const logs = drafts.map((d) => ({ _tag: "Log", id: id(), host: "office", by: { _tag: "program", session: "s", execution: "x" }, at, ...d }));
    // The fleet object's log: round A's takeLog reads it as `logged`, slice 3's first one as `seen`.
    const folded = takeLog({ mirror, ops: logs, logged: (id) => log.get(id), seen: (id) => log.has(id), now: at,
      ownerAnswersFrom: gate });
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
    const size = utf8.encode(p.body).byteLength;
    if (size > PROGRAM_LIMIT_BYTES) throw new Error(`a program takes at most ${PROGRAM_LIMIT_BYTES} bytes; this one has ${size}`);
    const source = `${preludeSource}\n${workPreludeSource}\n${bodiesPreludeSource}\n${p.body}`;
    const returned = await new AsyncFunction("records", "work", "bodies", source)(records(applied), workOf(p.work ?? rows), bodiesOf());
    out.push({ name: p.name, returned, applied });
  } catch (e) {
    out.push({ name: p.name, thrown: String(e?.stack ?? e) });
  }
  if (i === 0) setup = mirror;
}
process.stdout.write(JSON.stringify(out));
