/**
 * The ledger's lock: an exclusive `flock` of DIR/state.json itself, held by whoever reads, changes and
 * writes it (`fleet state`, the hub's rename), so neither loses the other's change. state.json is written
 * in place, so its inode, and the lock on it, outlive every write; no lock file joins the fleet's DIR.
 */
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { holdExclusiveLock, type Hold } from "../lock.ts";

/** Take the lock of the ledger in `root` with `hold`, waiting for it: the function that releases it, or
 * undefined when there is no ledger yet (`init` makes it, and has nothing to race). */
export function lockLedger(root: string, hold: Hold = holdExclusiveLock): (() => void) | undefined {
  let fd: number;

  try {
    fd = openSync(join(root, "state.json"), "r+");
  } catch {
    return undefined;
  }

  let release: () => void;

  try {
    release = hold(fd);
  } catch (cause: unknown) {
    closeSync(fd);
    throw cause;
  }

  return () => {
    release();
    closeSync(fd);
  };
}

/** Run `body` under the ledger's lock, taken with `hold`. */
export function withLedgerLock<T>(root: string, body: () => T, hold: Hold = holdExclusiveLock): T {
  const release = lockLedger(root, hold);

  try {
    return body();
  } finally {
    release?.();
  }
}
