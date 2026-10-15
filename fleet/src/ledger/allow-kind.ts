/**
 * Allow once and save this kind (Luiz's decision always-scope a, #115), in a module of its own so the page reads the
 * same words and the same rule as the CLI: allow-kind grants exactly as allow-once does, and the coordinator then
 * drafts one autoMode.allow rule for this kind of command, has it reviewed, and opens a rule card (rule-card.ts)
 * that Luiz adds himself.
 */

/** The option that grants the call once and asks the coordinator for a rule for its kind. */
export const ALLOW_KIND = "allow-kind";

/** allow-kind's label, the same on every page. */
export const ALLOW_KIND_LABEL = "Allow once and save this kind";

/** The plain line under allow-kind, for a card of `count` calls. */
export function allowKindWords(count: number): string {
  return `allows ${count > 1 ? "these calls" : "this call"} now; then I draft a rule for this kind of command for you to add`;
}

/** Whether a permission offers allow-kind: a Bash call whose opener did not hold it to once (`--once`). */
export function offersKind(refusal: { readonly tool: string; readonly once?: boolean | undefined }): boolean {
  return refusal.tool === "Bash" && refusal.once !== true;
}
