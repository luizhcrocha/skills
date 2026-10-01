/**
 * What an answer to a decision may be (Python's `decisions.answer_refusal`): the dashboard server asks
 * before it stores an answer given on the page. An unknown or closed decision refuses with its reason;
 * a secret takes a reference or an item name, never the value.
 */
import { join } from "node:path";

import { asArray, asObject, asString, truthy, type JsonObject } from "../json.ts";
import { readObject } from "../registry.ts";
import { find } from "./numbers.ts";

const REFERENCE = /^op:\/\/[^/\n]+\/[^/\n]+\/[^/\n]+(\/[^/\n]+)?$/;

const VALUE_PREFIX = /^(?:sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abposr]-|AKIA|AIza|eyJ|-----BEGIN)/;

const NAME_MAX = 120;

/** Why a secret's answer is refused when it reads as the value itself. */
export const NOT_A_VALUE =
  "that reads as the secret's value; give an op://vault/item/field reference or the name of the 1Password item, never the value";

/** Whether `text` could be a secret's value rather than a pointer to it. */
export function readsAsAValue(text: string): boolean {
  if ([...text].length > NAME_MAX) return true;

  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (VALUE_PREFIX.test(word.replace(/^["'`(]+/, ""))) return true;

    if ([...word].length >= 20 && /[A-Za-z]/.test(word) && /\d/.test(word)) return true;
  }

  return false;
}

/** Why the answer `text` to decision `id` of DIR is refused, or undefined when the chat may store it. */
export function answerRefusal(root: string, id: string, text: string): string | undefined {
  const state = readObject(join(root, "state.json")) ?? {};

  const rows = (asArray(state["decisions"]) ?? []).flatMap((d) => {
    const o = asObject(d);
    const did = asString(o?.["id"]);

    return o === undefined || did === undefined ? [] : [{ id: did, ref: asString(o["ref"]) ?? "", row: o }];
  });

  const item: JsonObject | undefined = find(rows, id)?.row;

  if (item === undefined) return `unknown decision '${id}'`;

  if (item["status"] !== "open") {
    const resolution = item["resolution"];

    return `${asString(item["title"]) ?? ""} is already ${asString(item["status"]) ?? ""}: ${truthy(resolution) ? (asString(resolution) ?? "") : "no reason recorded"}`;
  }

  if (item["kind"] === "secret") {
    const answer = text.trim();

    if (!REFERENCE.test(answer) && readsAsAValue(answer)) return NOT_A_VALUE;
  }

  return undefined;
}
