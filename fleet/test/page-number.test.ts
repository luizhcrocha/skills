/**
 * The numbers a page shows on a copy of a ledger (`page/number.ts`): a moved team's cloud cards, whose ids read as
 * numbers and carry no ref, next to its legacy cards, whose older ref can differ from their id. Luiz types the label
 * he sees, and a lookup takes an id first, then a number (`ledger/numbers.ts` `find`), so a label must reach the card
 * that shows it.
 */
import { describe, expect, test } from "bun:test";

import { asArray, asObject, asString, type JsonObject } from "../src/json.ts";
import { find } from "../src/ledger/numbers.ts";
import { numberState } from "../src/page/number.ts";

interface Row {
  readonly id: string;
  readonly ref?: string;
}

function rows(state: JsonObject): Row[] {
  return (asArray(state["decisions"]) ?? []).flatMap((item) => {
    const row = asObject(item);
    const id = row === undefined ? undefined : asString(row["id"]);
    const ref = row === undefined ? undefined : asString(row["ref"]);

    return id === undefined ? [] : [ref === undefined ? { id } : { id, ref }];
  });
}

function labels(state: JsonObject): Record<string, string | undefined> {
  return Object.fromEntries(rows(numberState(state)).map((r) => [r.id, r.ref]));
}

describe("a page's numbers on a moved team's ledger", () => {
  test("a cloud card is labelled with its id, and a legacy card keeps its older number", () => {
    const state: JsonObject = {
      decisions: [
        { id: "D209", ref: "D211", kind: "decision", opened: "2026-10-01T10:00:00Z" },
        { id: "D270", kind: "decision", opened: "2026-10-15T10:00:00Z" },
        { id: "P70", kind: "permission", opened: "2026-10-15T11:00:00Z" },
      ],
    };

    expect(labels(state)).toEqual({ D209: "D211", D270: "D270", P70: "P70" });
  });

  test("a card with a word id is still numbered above the highest label, skipping the ids in use", () => {
    const state: JsonObject = {
      decisions: [
        { id: "D209", ref: "D211", kind: "decision", opened: "2026-10-01T10:00:00Z" },
        { id: "D270", kind: "decision", opened: "2026-10-15T10:00:00Z" },
        { id: "D271", kind: "decision", opened: "2026-10-15T10:30:00Z" },
        { id: "s3-tool", kind: "decision", opened: "2026-10-15T11:00:00Z" },
      ],
    };

    expect(labels(state)["s3-tool"]).toBe("D272");
  });

  test("a cloud card whose id is a legacy card's number keeps it, and the legacy card shows its own id", () => {
    const state: JsonObject = {
      decisions: [
        { id: "D209", ref: "D211", kind: "decision", opened: "2026-10-01T10:00:00Z" },
        { id: "D211", kind: "decision", opened: "2026-10-15T10:00:00Z" },
      ],
    };

    const shown = rows(numberState(state));

    expect(Object.fromEntries(shown.map((r) => [r.id, r.ref]))).toEqual({ D209: "D209", D211: "D211" });

    for (const card of shown) {
      expect(find(rows(state), card.ref ?? "")?.id).toBe(card.id);
      expect(find(shown, card.ref ?? "")?.id).toBe(card.id);
    }
  });

  test("a legacy card with a word id whose number is a cloud card's id is numbered anew", () => {
    const state: JsonObject = {
      decisions: [
        { id: "s3-tool", ref: "D211", kind: "decision", opened: "2026-10-01T10:00:00Z" },
        { id: "D211", kind: "decision", opened: "2026-10-15T10:00:00Z" },
      ],
    };

    const shown = rows(numberState(state));

    expect(Object.fromEntries(shown.map((r) => [r.id, r.ref]))).toEqual({ "s3-tool": "D212", D211: "D211" });
    expect(find(rows(state), "D211")?.id).toBe("D211");
  });
});
