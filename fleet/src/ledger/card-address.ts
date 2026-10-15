/**
 * A decision card's address on a page: the one grammar the CLI, the hub's pages and the cloud page share. Pure,
 * with no imports, so the page's browser bundle takes it as it is (fleet/page/src/core.ts imports this file).
 *
 *     #decision/<card>             a card of the page's own ledger
 *     #decision/<fleet>/<card>     a card of fleet <fleet>: another fleet's on a manager's page, the page's own on
 *                                  a fleet's page that knows its name
 *     <card> = <number>[-<slug>]   the card's number lowercased ("d219", "p64", "a78"), and a short kebab-case
 *                                  of its title ("d219-pick-the-database"), only ever read for show
 *            | <id>                the card's own id, the address the pages wrote before numbers ("shares-503")
 *
 * Each segment is URI-encoded. A `<card>` resolves (`findCard`) to the card whose id it is exactly, so every
 * address written before stays the one it named; else to the card whose number it starts with, whatever slug
 * follows it, so an address whose title changed since still opens. A card is written by number only when it has
 * a number and a title that makes a slug, so a number written bare ("d3") never meets an old id that reads the
 * same ("d3", from before the machine's numbers) as an address the pages give out.
 *
 * The pair: this file and the fleet repo's `apps/page/src/views/card-link.ts` (the cloud page) are one grammar in
 * two copies; `fleet/test/card-address.cases.json` here and that repo's `apps/page/src/views/card-link.cases.json`
 * are one set of cases each copy is tested against. Change both together.
 */

/** A card as an address needs it: its id, its number (`ref`, "D219") and its title. */
export interface Addressed {
  readonly id: string;
  readonly ref?: string | null | undefined;
  readonly title?: string | null | undefined;
}

/** A card's number: a decision kind's letter (`ledger/numbers.ts` PREFIX) and digits. */
const NUMBER = /^[DAISGNP]\d+$/u;

/** A `<card>` segment that starts with a number: the number, then a slug or nothing. Any case. */
const BY_NUMBER = /^([DAISGNP]\d+)(?:-.*)?$/iu;

/** What a segment may hold once decoded: an id (`ledger/validate.ts` ID); a slug is made of the same. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/** A fleet's id, which may hold the "@" of a peer's. */
const FLEET = /^[A-Za-z0-9_.@-]+$/u;

/** The words a slug keeps at most. */
const SLUG_WORDS = 6;

/** A slug's length at most. */
const SLUG_LENGTH = 48;

/**
 * A short kebab-case of `title`: lowercase ASCII words (accents dropped: "decisão" is "decisao"), at most six
 * and 48 characters, cut between words. "" when the title has no letter or digit.
 */
export function cardSlug(title: string | null | undefined): string {
  const words = (title ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w !== "")
    .slice(0, SLUG_WORDS);

  let slug = "";

  for (const w of words) {
    const next = slug === "" ? w : `${slug}-${w}`;

    if (next.length > SLUG_LENGTH) return slug === "" ? w.slice(0, SLUG_LENGTH) : slug;
    slug = next;
  }

  return slug;
}

/** The `<card>` segment of `card`, decoded: "d219-pick-the-database" when it has a number and a slug, else its id. */
export function cardSegment(card: Addressed): string {
  const ref = card.ref ?? "";
  const slug = cardSlug(card.title);

  return NUMBER.test(ref) && slug !== "" ? `${ref.toLowerCase()}-${slug}` : card.id;
}

/** The address of `card`, of fleet `fleet` (null or "": the page's own ledger, named by no fleet). */
export function cardHash(card: Addressed, fleet?: string | null): string {
  const seg = encodeURIComponent(cardSegment(card));

  return fleet ? `#decision/${encodeURIComponent(fleet)}/${seg}` : `#decision/${seg}`;
}

/** What a card's address names: the fleet it was written with (null: none), and its `<card>` segment, decoded. */
export interface CardAddress {
  readonly fleet: string | null;
  readonly card: string;
}

/** `text` decoded, when it decodes and `rule` allows it. */
function decoded(text: string, rule: RegExp): string | null {
  try {
    const v = decodeURIComponent(text);

    return rule.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The card a location hash names (`#decision/<card>`, `#decision/<fleet>/<card>`), or null when it names none. */
export function parseCardHash(hash: string | null | undefined): CardAddress | null {
  const m = /^#decision\/([^/]+)(?:\/([^/]+))?$/u.exec(hash ?? "");

  if (!m) return null;
  const [, first = "", second] = m;

  if (second === undefined) {
    const card = decoded(first, SEGMENT);

    return card === null ? null : { fleet: null, card };
  }

  const fleet = decoded(first, FLEET);
  const card = decoded(second, SEGMENT);

  return fleet === null || card === null ? null : { fleet, card };
}

/** The number a `<card>` segment starts with ("d219-old-title" is "D219"), or null when it starts with none. */
export function cardNumberOf(card: string): string | null {
  return BY_NUMBER.exec(card)?.[1]?.toUpperCase() ?? null;
}

/** The row of `rows` the `<card>` segment `card` names: the one whose id it is, else the one whose number it starts with. */
export function findCard<T extends { readonly id: string; readonly ref?: string | null | undefined }>(rows: readonly T[], card: string): T | undefined {
  const exact = rows.find((r) => r.id === card);

  if (exact !== undefined) return exact;
  const num = cardNumberOf(card);

  return num === null ? undefined : rows.find((r) => r.ref === num);
}

/**
 * Whether id `id` reads as a card's address by number and slug ("a1-deploy"): `findCard` reads an id first, so
 * the card given it would take the address of card A1 titled "Deploy". A bare number ("d1") is no address the
 * pages give out.
 */
export function readsAsAddress(id: string): boolean {
  return cardNumberOf(id) !== null && id.includes("-");
}
