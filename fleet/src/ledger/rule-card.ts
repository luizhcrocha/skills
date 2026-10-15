/**
 * The rule card (Luiz's decision always-scope a, #115): after an allow-kind answer the coordinator drafts one
 * autoMode.allow entry for that kind of command, has it reviewed, and asks with `--kind rule`. The card shows the
 * entry verbatim; Add this rule makes the hub append it to `autoMode.allow` of the user's settings
 * (hub/user-settings.ts), and Not now adds nothing. Nothing ever removes an entry: Luiz edits his settings himself.
 *
 * The fleet repo's packages/ledger/src/rule-card.ts checks a rule the same way: rule-card.cases.json beside this
 * file is byte-identical to the one beside that, and both repos' tests run every case.
 */
import type { Choice } from "./model.ts";

/** A rule card's kind. */
export const RULE_KIND = "rule";

/** The option that adds the rule. */
export const ADD_RULE = "add-rule";

/** The longest entry a rule card takes, in code points. */
export const RULE_MAX = 6000;

/** What a rule names to say what it leaves out. */
const NOT_COVERED = /not covered:/giu;

/** A `*` that stands at a word's edge (whitespace, or the text's start or end, beside it): a glob that spans spaces. */
const SPANNING_GLOB = /(?:^|\s)\*|\*(?:\s|$)/u;

/** A character the page would not show as itself: a control, format (zero-width, bidi, tag, BOM), private-use or
 * surrogate code point, or a line or paragraph separator. A line break and a tab are the rule's own. */
const INVISIBLE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Words that talk to the reader of the rule instead of bounding it. */
const TRIPWIRES: readonly RegExp[] = [/ignore\s+(?:the\s+)?(?:previous|above|prior)/iu, /(?:all|any|every)\s+commands?\s+(?:is|are)\s+(?:allowed|fine|ok)/iu];

/** A literal bound: a backticked span, or an absolute or `~/` path. */
const LITERAL_BOUND = /`[^`\n]+`|(?:^|[\s(["'=,:])~?\/[^\s/*]/u;

/** What a "Not covered:" says when it names nothing: none, nothing or n/a, with spaces and punctuation. */
const NAMES_NOTHING = /^(?:[\s\p{P}]|none|nothing|n\/a)*$/iu;

/** What the last "Not covered:" leaves out holds at least this many characters. */
const NOT_COVERED_MIN = 12;

/** Why a text cannot be a rule card's entry: the same codes in both repos (rule-card.cases.json). */
export type RuleFault = "empty" | "long" | "invisible" | "tripwire" | "glob" | "uncovered" | "thin" | "unbounded";

/** A rule card's two options, which the CLI sets itself. */
export const RULE_OPTIONS: readonly Choice[] = [
  { id: ADD_RULE, label: "Add this rule", consequence: "adds the rule above to autoMode.allow in your ~/.claude/settings.json; every session reads it at once" },
  { id: "deny", label: "Not now", consequence: "nothing is added; your note goes to the coordinator" },
];

/** Why `rule` cannot be a rule card's entry, as its code, or undefined; checked in this order. */
export function ruleFault(rule: string): RuleFault | undefined {
  if (rule.trim() === "") return "empty";

  if ([...rule].length > RULE_MAX) return "long";

  if (INVISIBLE.test(rule)) return "invisible";

  if (TRIPWIRES.some((re) => re.test(rule))) return "tripwire";

  if (SPANNING_GLOB.test(rule)) return "glob";
  const last = [...rule.matchAll(NOT_COVERED)].at(-1);

  if (last === undefined) return "uncovered";
  const left = rule.slice(last.index + last[0].length).trim();

  if ([...left].length < NOT_COVERED_MIN || NAMES_NOTHING.test(left)) return "thin";

  return LITERAL_BOUND.test(rule.slice(0, last.index)) ? undefined : "unbounded";
}

const WHY: Readonly<Record<Exclude<RuleFault, "long">, string>> = {
  empty: "the rule is empty: write the autoMode.allow entry in the file",
  invisible: "the rule holds a character the page would not show as itself (a control, zero-width, bidi, tag or private-use character): write it in plain text",
  tripwire: 'the rule talks to its reader ("ignore the previous ...", "all commands are allowed") instead of bounding the kind: say what it allows, by literal paths and subcommands',
  glob: "the rule has a `*` glob that spans spaces (a `*` standing as a word, or at one's edge): name the literal paths and subcommands it allows instead",
  uncovered: 'the rule does not say what it does not cover: end it with "Not covered: ..." (the writes, deletions and secrets that look like the kind but are not)',
  thin: `the rule's last "Not covered:" names too little: at least ${String(NOT_COVERED_MIN)} characters of the writes, deletions and secrets that look like the kind but are not, never just "none"`,
  unbounded: 'the rule names no literal bound before its "Not covered:": a backticked command or subcommand, or an absolute or ~/ path',
};

/** Why `rule` cannot be a rule card's entry, in words, or undefined (`ruleFault`). */
export function whyNoRule(rule: string): string | undefined {
  const fault = ruleFault(rule);

  if (fault === "long") return `the rule has ${String([...rule].length)} characters, and a rule card takes at most ${String(RULE_MAX)}: bound it more tightly`;

  return fault === undefined ? undefined : WHY[fault];
}

/** Whether an answer to a rule card adds its rule: it begins with add-rule. */
export function addsRule(answer: string): boolean {
  return answer.trim().toLowerCase().startsWith(ADD_RULE);
}
