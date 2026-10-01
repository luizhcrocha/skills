/**
 * The lookups a one-shot command renders the page with: each link probed once, no served ports (a
 * fresh Python process's `served.discovered()` returns its empty last look and starts one in the
 * background, which ends with the process), spend read now.
 */
import { SpendReader } from "../transcripts.ts";
import { upAllSync } from "./probe.ts";
import type { Lookups } from "./view.ts";

/** The lookups of one CLI command. */
export function cliLookups(): Lookups {
  return { up: upAllSync, discovered: () => [], spend: new SpendReader() };
}
