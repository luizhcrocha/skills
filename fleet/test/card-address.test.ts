/**
 * A card's address (`ledger/card-address.ts`): written by number and slug, read back by id first, then by the
 * number it starts with, so an old address and one with a stale slug both still open their card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { cardHash, cardNumberOf, cardSegment, cardSlug, findCard, parseCardHash, readsAsAddress } from "../src/ledger/card-address.ts";

describe("cardSlug", () => {
  test("a short kebab-case of the title, accents dropped", () => {
    expect(cardSlug("Pick the database")).toBe("pick-the-database");
    expect(cardSlug("Decisão: usar o Postgres?")).toBe("decisao-usar-o-postgres");
    expect(cardSlug("  D219's   follow-up (v2)  ")).toBe("d219-s-follow-up-v2");
  });

  test("six words and 48 characters at most, cut between words", () => {
    expect(cardSlug("one two three four five six seven eight")).toBe("one-two-three-four-five-six");
    const long = cardSlug("internationalization localization containerization orchestration");

    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).toBe("internationalization-localization");
    expect(cardSlug("x".repeat(80))).toBe("x".repeat(48));
  });

  test("empty when the title has no letter or digit", () => {
    for (const t of ["", "  ", "—?!", null, undefined, "日本語"]) expect(cardSlug(t)).toBe("");
  });
});

describe("cardSegment and cardHash", () => {
  test("by number and slug, lowercased, with the fleet when one is given", () => {
    const d = { id: "shares-503", ref: "D219", title: "Share the cache" };

    expect(cardSegment(d)).toBe("d219-share-the-cache");
    expect(cardHash(d, "ui")).toBe("#decision/ui/d219-share-the-cache");
    expect(cardHash(d)).toBe("#decision/d219-share-the-cache");
    expect(cardHash(d, "")).toBe("#decision/d219-share-the-cache");
    expect(cardHash({ id: "x", ref: "P64", title: "Grant gh" }, "ui@box")).toBe("#decision/ui%40box/p64-grant-gh");
  });

  test("by id when the card has no number, or no title to make a slug", () => {
    expect(cardHash({ id: "shares-503", title: "Share" }, "ui")).toBe("#decision/ui/shares-503");
    expect(cardHash({ id: "shares-503", ref: "", title: "Share" })).toBe("#decision/shares-503");
    expect(cardHash({ id: "d3", ref: "D7", title: "?" }, "ui")).toBe("#decision/ui/d3");
    expect(cardHash({ id: "k1", ref: "K1", title: "Not a card's number" })).toBe("#decision/k1");
  });
});

describe("parseCardHash", () => {
  test("one segment or a fleet and one, decoded", () => {
    expect(parseCardHash("#decision/d219-share")).toEqual({ fleet: null, card: "d219-share" });
    expect(parseCardHash("#decision/ui/d219-share")).toEqual({ fleet: "ui", card: "d219-share" });
    expect(parseCardHash("#decision/ui%40box/shares-503")).toEqual({ fleet: "ui@box", card: "shares-503" });
  });

  test("anything else names no card", () => {
    for (const h of ["", "#decisions", "#decision/", "#decision/a/b/c", "#decision//b", "#decision/a b", "#decision/a@b", "#decision/a%2/b", "#decision/a/b%2Fc", null]) {
      expect([h, parseCardHash(h)]).toEqual([h, null]);
    }
  });

  test("what cardHash writes reads back as its segment", () => {
    for (const [d, fleet] of [
      [{ id: "shares-503", ref: "D219", title: "Share the cache" }, "ui"],
      [{ id: "schema.v2-a", title: "" }, "ui@box"],
      [{ id: "a1", ref: "A78", title: "Deploy à prod" }, null],
    ] as const) {
      expect(parseCardHash(cardHash(d, fleet))).toEqual({ fleet, card: cardSegment(d) });
    }
  });
});

describe("findCard", () => {
  const rows = [
    { id: "d3", ref: "D7", title: "Old id that reads as a number" },
    { id: "pick-db", ref: "D3", title: "Pick the database" },
    { id: "shares-503", ref: "D219", title: "Share the cache" },
    { id: "grant", ref: "P64", title: "Grant gh" },
  ];

  test("an id first, exactly: an address written before numbers keeps its card", () => {
    expect(findCard(rows, "d3")?.id).toBe("d3");
    expect(findCard(rows, "shares-503")?.id).toBe("shares-503");
  });

  test("else the number it starts with, any case, whatever slug follows", () => {
    expect(findCard(rows, "d219-share-the-cache")?.id).toBe("shares-503");
    expect(findCard(rows, "d219-a-title-since-changed")?.id).toBe("shares-503");
    expect(findCard(rows, "D219")?.id).toBe("shares-503");
    expect(findCard(rows, "p64")?.id).toBe("grant");
    expect(findCard(rows, "d3-pick-the-database")?.id).toBe("pick-db");
  });

  test("what cardSegment writes finds its own card", () => {
    for (const d of rows) expect(findCard(rows, cardSegment(d))?.id).toBe(d.id);
  });

  test("nothing when neither names a card", () => {
    expect(findCard(rows, "d999-gone")).toBeUndefined();
    expect(findCard(rows, "nope")).toBeUndefined();
    expect(cardNumberOf("k1")).toBeNull();
    expect(cardNumberOf("d12x")).toBeNull();
  });
});

describe("readsAsAddress", () => {
  test("an id that is a number and a slug takes a card's address; a bare number or a plain id does not", () => {
    for (const id of ["a1-deploy", "D219-share-the-cache", "p64-x"]) expect([id, readsAsAddress(id)]).toEqual([id, true]);

    for (const id of ["d1", "D219", "shares-503", "k1-x", "d12x-y", "deploy"]) expect([id, readsAsAddress(id)]).toEqual([id, false]);
  });
});

/** The cases both grammars read the same: this file and the fleet repo's apps/page/src/views/card-link.cases.json are one file in two copies. */
interface Cases {
  readonly slug: readonly (readonly [string | null, string])[];
  readonly hash: readonly { readonly card: { readonly id: string; readonly ref?: string; readonly title?: string }; readonly fleet: string | null; readonly hash: string }[];
  readonly parse: readonly (readonly [string, { readonly fleet: string | null; readonly card: string } | null])[];
  readonly find: { readonly rows: readonly { readonly id: string; readonly ref: string }[]; readonly cases: readonly (readonly [string, string | null])[] };
}

describe("the cases the cloud page shares (card-address.cases.json)", () => {
  // SAFETY: the file is this suite's own fixture, written in the shape `Cases` names.
  const cases = JSON.parse(readFileSync(join(import.meta.dir, "card-address.cases.json"), "utf8")) as Cases;

  test("slugs", () => {
    for (const [title, slug] of cases.slug) expect([title, cardSlug(title)]).toEqual([title, slug]);
  });

  test("addresses written", () => {
    for (const c of cases.hash) expect([c.card, c.fleet, cardHash(c.card, c.fleet)]).toEqual([c.card, c.fleet, c.hash]);
  });

  test("addresses read", () => {
    for (const [hash, at] of cases.parse) expect([hash, parseCardHash(hash)]).toEqual([hash, at]);
  });

  test("cards found", () => {
    for (const [card, id] of cases.find.cases) expect([card, findCard(cases.find.rows, card)?.id ?? null]).toEqual([card, id]);
  });
});
