// Runs every RuleTester suite in the pack (anti-slop/, tstack/), one node process each, the .ts run as it is
// (Node strips the types; tsx is not needed). The suites run under node, not bun: oxlint's RuleTester refuses
// "other runtimes" (rawTransferSupported). bun installs the pack (bun.lock).
// anti-slop's require-readable-spacing-cli test shells out to `pnpm exec oxlint`;
// it runs only where pnpm is installed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tests(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const hasPnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status === 0;
const failed = [];
let ran = 0;
for (const file of ["anti-slop", "tstack"]
  .map((d) => join(root, d))
  .filter((d) => existsSync(d))
  .flatMap(tests).sort()) {
  const name = relative(root, file);
  if (file.endsWith("-cli.test.ts") && !hasPnpm) {
    console.log(`skip ${name} (needs pnpm)`);
    continue;
  }
  const run = spawnSync("node", [file], { stdio: "inherit" });
  ran += 1;
  if (run.status !== 0) failed.push(name);
  console.log(`${run.status === 0 ? "ok  " : "FAIL"} ${name}`);
}
console.log(`${ran - failed.length}/${ran} suites passed`);
process.exit(failed.length === 0 ? 0 : 1);
