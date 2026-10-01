/**
 * `fleet`: the fleet's core CLIs in one binary. `fleet state …` is the ledger (state.py), `fleet chat …`
 * the chat (chat.py), `fleet fleets …` the registry (fleets.py). The process's clock (FLEET_NOW), its
 * environment and its stdout/stderr are provided here, and only here.
 */
import { runFleet } from "./cli/run.ts";
import { processEnv, processOut } from "./io.ts";

process.exit(await runFleet(process.argv.slice(2), processEnv, processOut, process.env["FLEET_NOW"]));
