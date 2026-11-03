/**
 * The ids of what a permission offers beyond its one call, and the rule for the old option. No imports: the page's
 * `fleet-core` script bundles this module, and allow-kind.ts's JSON reader would bring effect/Option with it.
 */

/** The option that grants the call and its kind for 24 hours from the tap. */
export const ALLOW_24H = "allow-24h";

/** The option that grants the call once and asks the coordinator for a rule for its kind. */
export const ALLOW_KIND = "allow-kind";

/** Whether a permission offers allow-kind: a Bash call whose opener did not hold it to once (`--once`). */
export function offersKind(refusal: { readonly tool: string; readonly once?: boolean | undefined }): boolean {
  return refusal.tool === "Bash" && refusal.once !== true;
}
