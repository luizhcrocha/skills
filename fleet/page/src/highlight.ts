/**
 * Code highlighting for the page's code blocks, by @tanstack/highlight's core (tokens from a string, no
 * framework, no HTML): its own languages for sh, ts, js, json, toml, python, sql, diff and yaml, and the
 * page's for nu, nix and rust (`langs.ts`). A language it does not know is shown plain.
 */
import { createHighlighter, type HighlightToken } from "@tanstack/highlight/core";
import { diff } from "@tanstack/highlight/languages/diff";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { python } from "@tanstack/highlight/languages/python";
import { shell } from "@tanstack/highlight/languages/shell";
import { sql } from "@tanstack/highlight/languages/sql";
import { toml } from "@tanstack/highlight/languages/toml";
import { ts } from "@tanstack/highlight/languages/ts";
import { yaml } from "@tanstack/highlight/languages/yaml";

import { nix, nu, rust } from "./langs.ts";

const highlighter = createHighlighter({ languages: [nu, shell, ts, js, json, toml, nix, python, sql, rust, diff, yaml] });

export type { HighlightToken };

/** The tokens of `code` in language `lang` (a tag such as "nu", "bash", "typescript"); one plain token when the language is unknown or "". */
export function tokensOf(code: string, lang: string): HighlightToken[] {
  if (!lang) return [{ value: code }];

  return highlighter.tokenize(code, { lang }).tokens;
}

/** Whether the page highlights `lang`. */
export function knowsLanguage(lang: string): boolean {
  return lang !== "" && highlighter.normalizeLanguage(lang) !== "plaintext";
}
