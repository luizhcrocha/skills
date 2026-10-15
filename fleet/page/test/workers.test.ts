/**
 * The service workers a fleet's page drops (src/workers.ts): each whose scope reaches past a preview's path, as the
 * hub routes paths (`/f/<a>/f/<b>/…` as `/f/<b>/…`), a preview's own kept; and the page loaded again once when one it
 * dropped was its controller, never twice in a row.
 */
import { expect, test } from "bun:test";

import type { StorageLike } from "../src/core.ts";
import { dropStrayWorkers, type Registration } from "../src/workers.ts";

/** A storage in memory, as a tab's sessionStorage. */
function memory(): StorageLike & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();

  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** A registration at `scope` on the page's origin, and the worker it runs; `dropped` lists the scopes unregistered. */
function at(scope: string, dropped: string[]): Registration & { readonly active: object } {
  return {
    scope: `http://127.0.0.1:9${scope}`,
    active: { scope },
    unregister: () => {
      dropped.push(scope);

      return Promise.resolve(true);
    },
  };
}

test("a worker's scope past a preview's path is unregistered, a preview's own kept, a nested fleet's preview counted as the hub routes it", async () => {
  const dropped: string[] = [];
  const registrations = ["/", "/f/", "/f/p/", "/f/p/preview/", "/f/p/preview/a1/", "/f/a/f/x/preview/", "/f/a/f/x/", "/f/a/preview/f/x/"].map((s) => at(s, dropped));
  let reloads = 0;

  await dropStrayWorkers({ controller: null, getRegistrations: () => Promise.resolve(registrations) }, memory(), () => (reloads += 1));
  expect([dropped.sort(), reloads]).toEqual([["/", "/f/", "/f/a/f/x/", "/f/p/"], 0]);
});

test("the page is loaded again when a worker it dropped was its controller, and not again on the load that follows", async () => {
  const storage = memory();
  let reloads = 0;
  const reload = (): void => void (reloads += 1);
  const wide = at("/f/", []);
  const own = at("/f/p/preview/", []);

  await dropStrayWorkers({ controller: wide.active, getRegistrations: () => Promise.resolve([wide, own]) }, storage, reload);
  expect(reloads).toBe(1);

  // The worker still controls the load that follows (its unregistering did not take): no second reload, no loop.
  await dropStrayWorkers({ controller: wide.active, getRegistrations: () => Promise.resolve([wide, own]) }, storage, reload);
  expect(reloads).toBe(1);

  // A later load that finds it again reloads once more; one with no stray controller reloads nothing.
  await dropStrayWorkers({ controller: wide.active, getRegistrations: () => Promise.resolve([wide]) }, storage, reload);
  expect(reloads).toBe(2);
  await dropStrayWorkers({ controller: null, getRegistrations: () => Promise.resolve([wide]) }, storage, reload);
  expect([reloads, storage.data.size]).toEqual([2, 0]);
});

test("a dropped worker that is not the page's controller reloads nothing, and a storage that throws reloads nothing", async () => {
  let reloads = 0;
  const reload = (): void => void (reloads += 1);
  const wide = at("/f/", []);
  const own = at("/f/p/preview/", []);

  await dropStrayWorkers({ controller: own.active, getRegistrations: () => Promise.resolve([wide, own]) }, memory(), reload);

  const throwing: StorageLike = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };

  await dropStrayWorkers({ controller: wide.active, getRegistrations: () => Promise.resolve([wide]) }, throwing, reload);
  expect(reloads).toBe(0);
});
