import type { StorageLike } from "./core.ts";

/** A preview's path, combined or a worker's, on this hub or a peer's: the only scope a service worker of the hub's
 * origin may have. */
const PREVIEW_SCOPE = /^\/f\/[^/]+\/preview\//u;

/** The sessionStorage key set while the page loads again for a worker it dropped: the load after it does not again. */
const RELOADED = "fleet-stray-worker-reload";

/** A registration, as far as this module reads it. */
export interface Registration {
  readonly scope: string;
  readonly active: object | null;
  unregister(): Promise<boolean>;
}

/** The origin's service workers, as far as this module reads them: `navigator.serviceWorker`. */
export interface Workers {
  readonly controller: object | null;
  getRegistrations(): Promise<readonly Registration[]>;
}

/** A fleet's path inside another's, `/f/<a>/f/<b>/…`: the hub routes it as `/f/<b>/…` (its `collapse`). */
const NESTED = /^\/f\/[^/]+(\/f\/[^/]+(?:\/.*)?)$/u;

/** Whether a worker's scope stays under a preview's path, as the hub routes the path. */
function isPreviewScope(scope: string): boolean {
  let path = new URL(scope).pathname;

  for (let m = NESTED.exec(path); m !== null; m = NESTED.exec(path)) path = m[1] ?? path;

  return PREVIEW_SCOPE.test(path);
}

/** Load the page again, unless this load is the one such a reload made, so a worker that still controls it never
 * loops the page. */
function reloadOnce(storage: StorageLike, reload: () => void): void {
  if (storage.getItem(RELOADED) !== null) {
    storage.removeItem(RELOADED);

    return;
  }

  storage.setItem(RELOADED, "1");
  reload();
}

/** Unregister every service worker of this origin whose scope reaches past a preview's path: one a preview registered
 * before the hub refused it (a script with `Service-Worker-Allowed: /`) would see this page, its token included. A
 * preview's own worker is kept. When one it dropped controls this page, the page is loaded again once, without it.
 * A backstop, not the defence: a worker that controls this page can serve it without this code, and the hub's kill
 * switch is what replaces one at its update check. `storage` is the tab's sessionStorage (a storage that throws
 * loads nothing again); without service workers (a page not served over a secure context) there is nothing to do. */
export async function dropStrayWorkers(
  workers: Workers | undefined = "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
  storage?: StorageLike,
  reload: () => void = () => location.reload(),
): Promise<void> {
  if (workers === undefined) return;

  try {
    const controller = workers.controller;
    const stray = (await workers.getRegistrations()).filter((r) => !isPreviewScope(r.scope));

    await Promise.all(stray.map((r) => r.unregister()));
    const store = storage ?? sessionStorage;

    if (controller !== null && stray.some((r) => r.active === controller)) reloadOnce(store, reload);
    else store.removeItem(RELOADED);
  } catch {
    // a browser that refuses the list (a sandboxed frame) holds none this page can reach; a storage that throws
    // guards no reload, so none is made
  }
}
