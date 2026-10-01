/**
 * The `fleet-core` script: the page's rules as the global `FleetCore`, which the page reads and
 * `tests/page.test.mjs` evaluates on its own.
 */
import { Core } from "./core.ts";

Object.assign(globalThis, { FleetCore: Core });
