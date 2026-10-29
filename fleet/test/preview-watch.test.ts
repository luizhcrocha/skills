/**
 * Whether a session watches the preview's marks (`preview/watch.ts`), read from `picasso status`: a present
 * session with a running watch that claims the page-id hears it; an absent one, one with no watch, or one that
 * claims other pages does not; with routing off any watch hears it. The warning names the page-id and the
 * commands that arm a watch (push first, else a watch rearmed on every exit), and says nothing without picasso.
 * A preview served under the hub's address shares the hub's page-id, so its warning says root mode is needed; it
 * says nothing with routing off while a watch runs (it hears every mark) or while no tab has the preview open.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../src/json.ts";
import { pageIdFor, pageIdOf, watched, watchWarning } from "../src/preview/watch.ts";
import { tmp } from "./support.ts";

const ID = "cr-sede-pc.example.ts.net-7508";

const ADDRESS = "https://cr-sede-pc.example.ts.net:7508/";

function session(over: Partial<{ present: boolean; watches: number; claims: string[]; implicit: string[] }>): JsonObject {
  return { session: "s1", name: "casos-work", present: true, watches: 1, claims: [], implicit: [], subscriptions: [], ...over };
}

function status(sessions: JsonObject[], on = true, tabs: JsonObject[] = []): JsonObject {
  return { ok: true, tabs, routing: { on, sessions } };
}

describe("watched", () => {
  test("a present session with a watch that claims the page hears it", () => {
    expect(watched(status([session({ claims: [ID] })]), ID)).toBe(true);
    expect(watched(status([session({ implicit: [ID] })]), ID)).toBe(true);
  });

  test("an absent session, one with no watch, or one that claims other pages does not", () => {
    expect(watched(status([session({ claims: [ID], present: false })]), ID)).toBe(false);
    expect(watched(status([session({ claims: [ID], watches: 0 })]), ID)).toBe(false);
    expect(watched(status([session({ claims: ["other-7501"] })]), ID)).toBe(false);
    expect(watched(status([]), ID)).toBe(false);
  });

  test("with routing off, any running watch hears every page", () => {
    expect(watched(status([session({})], false), ID)).toBe(true);
  });
});

describe("pageIdFor", () => {
  test("derives the page-id from the host, port included", () => {
    expect(pageIdOf(ADDRESS)).toBe(ID);
    expect(pageIdFor(status([]), ADDRESS)).toBe(ID);
  });

  test("takes a connected tab's label on the same origin", () => {
    const tabs = [{ tab: "t-1", pageId: "processos", url: `${ADDRESS}caso/CA1/processos?l=1&x=a=b` }];
    expect(pageIdFor(status([], true, tabs), ADDRESS)).toBe("processos");
  });
});

describe("watchWarning", () => {
  function stub(body: JsonObject, code = 0): (name: string) => string | undefined {
    const dir = tmp();
    const bin = join(dir, "picasso");
    writeFileSync(join(dir, "status.json"), JSON.stringify(body));
    writeFileSync(bin, `#!/bin/sh\ncat '${join(dir, "status.json")}'\nexit ${code}\n`);
    chmodSync(bin, 0o755);

    return (name) => (name === "PICASSO" ? bin : undefined);
  }

  const own = { kind: "own", url: ADDRESS } as const;

  test("names the page-id, the claim, push, and a fallback watch rearmed on every exit", () => {
    const said = watchWarning(stub(status([session({ claims: ["other-7501"] })])), own) ?? "";
    expect(said).toContain(`page-id ${ID}`);
    expect(said).toContain(`\`picasso claim ${ID}\``);
    expect(said).toContain("invoke the picasso skill");
    expect(said).toContain(`\`picasso watch --page-id ${ID} --timeout 600\` in the background, rearmed on every exit, a timeout included`);
  });

  const HUB = "http://cr-sede-pc.example.ts.net:7420/f/ui/preview/";
  const shared = { kind: "shared", url: HUB, dir: "ui" } as const;
  const onPreview = [{ tab: "t-1", pageId: "cr-sede-pc.example.ts.net-7420", url: `${HUB}caso/CA1?l=1` }];

  test("a preview under the hub's address, open in a tab, says root mode routes its marks, and advises no claim", () => {
    const said = watchWarning(stub(status([session({ claims: ["other-7501"] })], true, onPreview)), shared) ?? "";
    expect(said).toContain("every fleet's preview on the preview server's shared origin shares");
    expect(said).toContain("`fleet preview ui set --root`");
    expect(said).not.toContain("picasso claim");
  });

  test("a preview under the hub's address, open in a tab, warns with routing off when no session watches", () => {
    expect(watchWarning(stub(status([], false, onPreview)), shared) ?? "").toContain("`fleet preview ui set --root`");
    expect(watchWarning(stub(status([session({ watches: 0 })], false, onPreview)), shared)).toBeDefined();
  });

  test("a preview under the hub's address says nothing with routing off and a watch running, or with no tab open on it", () => {
    expect(watchWarning(stub(status([session({})], false, onPreview)), shared)).toBeUndefined();
    expect(watchWarning(stub(status([session({ claims: ["other-7501"] })])), shared)).toBeUndefined();
    const dashboard = [{ tab: "t-2", pageId: "cr-sede-pc.example.ts.net-7420", url: "http://cr-sede-pc.example.ts.net:7420/f/ui/" }];
    expect(watchWarning(stub(status([session({ claims: ["other-7501"] })], true, dashboard)), shared)).toBeUndefined();
  });

  test("says nothing when watched, without picasso, or when the sidecar does not answer", () => {
    expect(watchWarning(stub(status([session({ claims: [ID] })])), own)).toBeUndefined();
    expect(watchWarning((name) => (name === "PICASSO" ? join(tmp(), "none") : undefined), own)).toBeUndefined();
    expect(watchWarning(stub({ ok: false, error: "no sidecar" }, 1), own)).toBeUndefined();
    expect(watchWarning(stub(status([])), { kind: "own", url: "/f/fleet/preview/" })).toBeUndefined();
  });
});
