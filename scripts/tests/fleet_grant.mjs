// Runs a fleet checkout's real host grant: what the office host does with the owner's answer on a permission card
// (apps/host/src/grant-writes.ts grantOf, the checks against the folder's state.json and the files, then
// apps/host/src/grants.ts applyGrant, the rule and the records).
// node fleet_grant.mjs FLEET_CHECKOUT < {"dir", "state", "write", "at", "roots", "home"}
// prints {"none": true} for an answer that asks no grant, {"refused": why}, or {"granted": <what applyGrant gave>}.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.argv[2];
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const { grantOf } = await load("apps/host/src/grant-writes.ts");
const { applyGrant } = await load("apps/host/src/grants.ts");
const { dir, state, write, at, roots, home } = JSON.parse(readFileSync(0, "utf8"));
const grant = grantOf(state, write, at, roots);
const failed = (result) => (result._tag === "Failure" ? result.failure.reason : undefined);
if (grant === undefined) {
  process.stdout.write(JSON.stringify({ none: true }));
} else if (failed(grant) !== undefined) {
  process.stdout.write(JSON.stringify({ refused: failed(grant) }));
} else {
  const applied = await applyGrant(dir, grant.success, { home });
  process.stdout.write(JSON.stringify(failed(applied) === undefined ? { granted: applied.success } : { refused: failed(applied) }));
}
