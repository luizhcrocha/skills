// Runs what a fleet checkout's cloud and office host really do between a card and its grant, over the mirror
// fleet_fold.mjs left: `export` is the host's exportMirror (apps/host/src/export.ts) into the folder; `answer` is the
// page's answer as it sends it (the card's answerText, shownGrant), the cloud's takeWrite (packages/cloud/src/writes.ts),
// the export, then, unless `grant` is false, the host's real runGrants (apps/host/src/grant-writes.ts) over a one-shot
// live stream and a cloud that keeps what it is sent.
// node fleet_host.mjs FLEET_CHECKOUT < {"step", "mirror": path, "dir", "home", "roots", "at", "gate", "decision",
//   "option", "shown": fields the page sent otherwise (null drops one), "grant": false}
// prints {"ops": what the cloud stored, "write": the write as it ended, "outcome": takeWrite's tag}.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const { step, mirror: mirrorFile, dir, home, roots = [], at, gate, decision, option, shown = {}, grant = true } = JSON.parse(readFileSync(0, "utf8"));
const { exportMirror } = await load("apps/host/src/export.ts");
const { applyOps } = await load("packages/ledger/src/mirror.ts");
const mirror = JSON.parse(readFileSync(mirrorFile, "utf8"));
const log = () => undefined;
const exported = async (held) => {
  const done = await exportMirror(dir, held, { log });
  if (done._tag === "Failure") throw new Error(JSON.stringify(done.failure));
};

if (step === "export") {
  await exported(mirror);
  process.stdout.write(JSON.stringify({ ops: [] }));
} else {
  const { takeWrite } = await load("packages/cloud/src/writes.ts");
  const { answerText } = await load("packages/ledger/src/answer-text.ts");
  const { shownGrant } = await load("apps/page/src/views/select.ts");
  const { runGrants } = await load("apps/host/src/grant-writes.ts");
  const { folderFiles } = await load("apps/host/src/files.ts");
  const Result = await import(pathToFileURL(createRequire(join(checkout, "apps/host/package.json")).resolve("effect/Result")).href);
  const card = mirror.decision[decision].record;
  const form = { choice: option };
  const sent = { id: `w-${decision}-${Object.keys(mirror.write).length}`, what: "answer", text: answerText(card, form).text, decision, form, rev: card.rev ?? 1, ...shownGrant(card.refusal), ...shown };
  const request = Object.fromEntries(Object.entries(sent).filter(([, value]) => value !== null));
  const taken = takeWrite({ mirror, seq: 1000 + Object.keys(mirror.message).length, request, by: "luiz", now: Date.now(), moved: true, ownerAnswersFrom: gate });
  const landed = applyOps(mirror, taken.ops).mirror;
  await exported(landed);
  const moved = [];
  if (grant && option !== "deny" && taken.outcome._tag === "Created") {
    const stop = new AbortController();
    const live = { listen: (on) => on({ _tag: "Snapshot", mirror: landed }) };
    const cloud = { post: async ({ ops }) => { moved.push(...ops); stop.abort(); return Result.succeed({}); } };
    await runGrants({ dir, hostName: "office", roots }, { cloud, live, files: folderFiles(dir), log, now: () => new Date(at), home }, { signal: stop.signal });
  }
  const write = moved[0]?.record ?? (taken.outcome._tag === "Created" ? taken.outcome.write : undefined);
  process.stdout.write(JSON.stringify({ ops: [...taken.ops, ...moved], write, outcome: taken.outcome._tag }));
}
