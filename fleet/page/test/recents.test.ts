/**
 * The places this browser opened last (src/recents.ts): one entry per place, newest first, at most
 * RECENTS_KEPT, under a version in the page's own storage; what is read back is parsed, so a corrupt or
 * foreign value is nothing kept; each visit reads the storage again before it writes, so two tabs of one
 * page keep both their visits.
 */
import { expect, test } from "bun:test";

import { Core, type FindRow, type StorageLike } from "../src/core.ts";
import { createRecents, merged, parseRecents, RECENTS_KEPT, visited, type Recent } from "../src/recents.ts";

/** A storage in memory, as two tabs of one browser share it. */
function memory(): StorageLike & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();

  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const place = (key: string, title = key): FindRow => ({ key, group: "decisions", ref: "", title, sub: "", hint: "", pill: "", go: { kind: "decision", id: key } });

const at = (r: FindRow, t: number): Recent => ({ ...r, at: t });

test("a visit moves the place to the front with its new words and time, once", () => {
  const list = [at(place("a"), 3), at(place("b"), 2), at(place("c"), 1)];
  expect(visited(list, at(place("c", "C now"), 4)).map((r) => [r.key, r.title])).toEqual([
    ["c", "C now"],
    ["a", "a"],
    ["b", "b"],
  ]);
});

test("the list keeps the newest RECENTS_KEPT", () => {
  let list: Recent[] = [];

  for (let i = 0; i < RECENTS_KEPT + 10; i++) list = visited(list, at(place("p" + String(i)), i));
  expect(list).toHaveLength(RECENTS_KEPT);
  expect(list[0]?.key).toBe("p" + String(RECENTS_KEPT + 9));
  expect(list.at(-1)?.key).toBe("p10");
});

test("merged: each place once by its newest visit, newest first", () => {
  expect(merged([at(place("a"), 1), at(place("b"), 5)], [at(place("a"), 7), at(place("c"), 3)]).map((r) => [r.key, r.at])).toEqual([
    ["a", 7],
    ["b", 5],
    ["c", 3],
  ]);
});

test("two tabs of one page: each visit reads what the other wrote, so both are kept", () => {
  const shared = memory();
  let now = 100;
  const one = createRecents(Core.prefsOf(shared, "fleet:/f/billing/"), () => now);
  const two = createRecents(Core.prefsOf(shared, "fleet:/f/billing/"), () => now);

  one.visit(place("d1"));
  now = 200;
  two.visit(place("w:a2"));
  now = 300;
  one.visit(place("c:4"));
  expect(one.list().map((r) => r.key)).toEqual(["c:4", "w:a2", "d1"]);
  two.reload();
  expect(two.list().map((r) => r.key)).toEqual(["c:4", "w:a2", "d1"]);
  expect(JSON.parse(shared.data.get("fleet:/f/billing/find-recent") ?? "null")).toMatchObject({ v: 1 });
});

test("parseRecents: another version, a corrupt value or a wrong shape is nothing; a bad entry is dropped alone", () => {
  const good = { ...place("d1"), at: 5 };
  expect(parseRecents({ v: 1, places: [good] })).toEqual([good]);
  expect(parseRecents({ v: 2, places: [good] })).toEqual([]);
  expect(parseRecents(null)).toEqual([]);
  expect(parseRecents("[]")).toEqual([]);
  expect(parseRecents({ v: 1, places: "x" })).toEqual([]);
  expect(parseRecents({ v: 1, places: [good, { ...good, key: 3 }, { ...good, key: "w", go: { kind: "nowhere" } }, { ...good, key: "x", at: "soon" }, 7] })).toEqual([good]);

  const shared = memory();
  shared.setItem("fleet:find-recent", "{not json");
  const r = createRecents(Core.prefsOf(shared, "fleet:"), () => 9);
  expect(r.list()).toEqual([]);
  r.visit(place("d1"));
  expect(r.list().map((x) => x.key)).toEqual(["d1"]);
});

test("a storage that throws keeps nothing and breaks nothing", () => {
  const broken: StorageLike = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };

  const r = createRecents(Core.prefsOf(broken, "fleet:"), () => 1);
  r.visit(place("d1"));
  expect(r.list().map((x) => x.key)).toEqual(["d1"]);
});
