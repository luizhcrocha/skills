/**
 * What a permission offers beyond its one call, in a module of its own so the page reads the same words and the same
 * rule as the CLI.
 *
 * Allow for 24 hours (allow-24h) grants the call and the kind hooks/tstack-kind-match.py read from it, one task script's text, for 24 hours from the owner's
 * tap; the end time comes from that tap, so no card can name it. Each later call of the kind goes through `fleet grant
 * use` (cli/grant.ts).
 *
 * Allow once and save this kind (allow-kind, Luiz's decision always-scope a, #115) is on no new card; an answer on a
 * card still open stays valid: it grants exactly as allow-once does, and the coordinator then drafts one autoMode.allow
 * rule for this kind of command, has it reviewed, and opens a rule card (rule-card.ts) that Luiz adds himself.
 */
import { asObject, asString, type Json } from "../json.ts";

/** A kind as hooks/tstack-kind-match.py derives it: one task script's text, in a repo, across its workspaces. */
export type CallKind = {
  readonly action: "deploy" | "push";
  readonly repo: { readonly main: string; readonly origin: string | null };
  readonly task: string;
  readonly sha256: string;
};

const TASK = /^tasks\/grant\/(deploy|push)-[A-Za-z0-9_.-]+\.sh$/u;

const SHA256 = /^[0-9a-f]{64}$/u;

/** A kind from JSON, the matcher's or a ledger's; undefined when it is none. */
export function callKindOf(value: Json | undefined): CallKind | undefined {
  const kind = asObject(value);
  const action = asString(kind?.["action"]);
  const repo = asObject(kind?.["repo"]);
  const main = asString(repo?.["main"]);
  const origin = asString(repo?.["origin"])?.split(/\s/u)[0] ?? null;
  const task = asString(kind?.["task"]);
  const sha256 = asString(kind?.["sha256"]);

  if ((action !== "deploy" && action !== "push") || main === undefined || task === undefined || sha256 === undefined) return undefined;

  return TASK.exec(task)?.[1] === action && SHA256.test(sha256) ? { action, repo: { main, origin }, task, sha256 } : undefined;
}

/** The option that grants the call and its kind for 24 hours from the tap. */
export const ALLOW_24H = "allow-24h";

/** allow-24h's label, the same on every page. */
export const ALLOW_24H_LABEL = "Allow for 24 hours";

/** The repo's short name: its origin's last part, else the folder holding `.jj`. */
function repoName(repo: CallKind["repo"]): string {
  const from = repo.origin === null ? repo.main.replace(/\/\.jj\/repo$/u, "") : repo.origin;

  return from.split(/[/:]/u).at(-1)?.replace(/\.git$/u, "") ?? from;
}

/** The kind in plain words. */
export function kindWords(kind: CallKind): string {
  return `${kind.task.replace(/^.*\//u, "").replace(/\.sh$/u, "")} in repo ${repoName(kind.repo)}, from any workspace`;
}

/** The plain line under allow-24h. The end time is the tap's, so it says "from your tap". */
export function allow24hWords(kind: CallKind): string {
  return `${kindWords(kind)}, this script as it stands (${kind.task}, sha256 ${kind.sha256.slice(0, 12)}), for 24 hours from your tap. Every run is listed, and you can revoke it any time.`;
}

/** Whether a permission offers allow-24h: one Bash call its opener did not hold to once, of a kind the matcher read at the ask. */
export function offers24h(refusal: { readonly tool: string; readonly once?: boolean | undefined; readonly more?: readonly string[] | undefined; readonly kind?: CallKind | undefined }): boolean {
  return refusal.tool === "Bash" && refusal.once !== true && (refusal.more ?? []).length === 0 && refusal.kind !== undefined;
}


/** The option that grants the call once and asks the coordinator for a rule for its kind. */
export const ALLOW_KIND = "allow-kind";

/** Whether a permission offers allow-kind: a Bash call whose opener did not hold it to once (`--once`). */
export function offersKind(refusal: { readonly tool: string; readonly once?: boolean | undefined }): boolean {
  return refusal.tool === "Bash" && refusal.once !== true;
}
