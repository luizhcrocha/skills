/**
 * `show`: the ledger as text, then the command cheat sheet. It writes nothing (open-10).
 */
import type { Message } from "../chat/store.ts";
import { answeredGrill, failedAnswer, failureWords } from "../health.ts";
import { pyRepr } from "../json.ts";
import { EVENT_KINDS, MODELS, NEEDS, SEVERITIES, SKILLS } from "./commands.ts";
import type { Ledger } from "./model.ts";
import { EFFORTS } from "./roles.ts";
import { AGENT_STATUSES, ASKS, SHARED_KINDS, STATUSES, STEP_STATUSES, WORKSPACE_MODES } from "./validate.ts";

/** The command cheat sheet `show` ends with: each command with the values its flags take. */
export const CHEATSHEET = `
commands (fleet state DIR <command>; an unknown ID creates the row, a known ID changes the fields given):
  set [--status ${STATUSES.join("|")}] [--now TEXT] [--goal G] [--workspaces ${WORKSPACE_MODES.join("|")}]
  milestone ID --title T
  step ID --milestone M --title T [--status ${STEP_STATUSES.join("|")}] [--agent A]
        [--before STEP | --after STEP] [--remove REASON]
  agent ID --task T --milestone M [--name N] [--skill ${SKILLS.join("|")}] [--model ${MODELS.join("|")}]
        [--effort ${EFFORTS.join("|")}] [--lane PATH...] [--step S] [--brief B] [--status ${AGENT_STATUSES.join("|")}]
        [--task-id ID | --tokens N --duration-ms N] [--report R] [--log TEXT] [--important]
  roadblock ID --title T --detail D --severity ${SEVERITIES.join("|")} --needs ${NEEDS.join("|")} [--agent A]
        [--decision D] [--resolved | --open]
  decision ID --kind ${SHARED_KINDS.join("|")} --title T --question Q --why W [--blocking | --not-blocking]
        [--option "KEY: label | consequence"]... [--same-options] [--recommend R --reason WHY] [--secret NAME] [--manual TEXT]
        [--body FILE | --no-body] [--agent A] [--supersedes ID] [--log TEXT] [--asks ${ASKS.join("|")}]
        [--decide ANSWER --resolution HOW | --withdraw REASON | --hold REASON | --unhold]
        --manual: its commands in a fenced block (\`\`\`nu), any prose outside it; one bare command line needs none
  event [--kind ${EVENT_KINDS.join("|")}] [--agent A] [--important] TEXT   (a note is \`event --kind note TEXT\`)
  park [--agent A]... REASON     stop every live worker row (or those named) in one command
  keep ID [TEXT | --drop REASON] what must outlive a compaction: a queued ask, a hunk, a workspace
  link ID --url U --title T [--kind dev|page] [--decision D] [--note N] | --drop R   a dev server or a purpose-built page
  grill ID --title T --ask "TITLE | QUESTION | RECOMMENDATION | WHY"... [--of Q]   a grilling round, answered on the page
        [--answer "Q3: ..."] [--drop "Q4: why"] [--revise "Q3: T | Q | R | W"] [--reason "Q3: why"] [--done SUMMARY]
  step next --milestone M --title T   the next free step id, printed
  show
  --no-render on any command writes state.json without rendering; -q renders without saying so`;

function width(text: string, n: number): string {
  const length = [...text].length;

  return length >= n ? text : text + " ".repeat(n - length);
}

function right(text: string, n: number): string {
  const length = [...text].length;

  return length >= n ? text : " ".repeat(n - length) + text;
}

/** The lines `show` prints; `said`, the chat, tells an action the user answered as failed. */
export function showLines(ledger: Ledger, said: readonly Message[] = []): string[] {
  const lines: string[] = [];
  const role = ledger.role === "manager" ? ", manager" : "";
  const shared = ledger.workspace_mode === "shared" ? ", shared working copy" : "";
  lines.push(`${ledger.project} [${ledger.status}${role}${shared}] ${ledger.now}`);

  for (const m of ledger.roadmap) {
    const done = m.steps.filter((s) => s.status === "done").length;
    lines.push(`  ${m.id} ${m.title} (${done}/${m.steps.length})`);

    for (const s of m.steps) {
      const agent = s.agent ?? "";
      lines.push(`    ${width(s.id, 6)} ${width(s.status, 8)} ${s.title}${agent === "" ? "" : `  @${agent}`}`);
    }
  }

  for (const a of ledger.agents) {
    const rounds = (a.rounds ?? 1) > 1 ? `  round ${pyRepr(a.rounds ?? 1)}` : "";
    const lane = a.lane.join(",");
    lines.push(
      `  agent ${width(a.id, 16)} ${width(a.status, 8)} ${width(a.skill ?? "none", 15)} ${width(a.model ?? "opus", 6)} ${width(a.effort === undefined || a.effort === "" ? "-" : a.effort, 6)} ` +
        `${right(pyRepr(a.tokens ?? 0), 8)} tok  lane=${lane === "" ? "-" : lane}${rounds}`,
    );
  }

  for (const r of ledger.roadblocks) {
    lines.push(
      `  ${r.ref ?? ""} roadblock ${r.id} ${r.resolved ? "resolved" : "OPEN"} [${r.severity}, needs ${r.needs}] ${r.title}`,
    );
  }

  for (const d of ledger.decisions ?? []) {
    let status = d.status === "open" ? (d.blocking === true ? "OPEN, blocking" : "OPEN") : d.status;

    if (d.status === "open" && d.asks === "manager") status += ", with the manager";

    if (d.status === "open" && d.held !== undefined && d.held !== null && d.held !== "") status += `, held by the fleet (${d.held})`;

    if (answeredGrill(d)) status += ", answered, waiting to be recorded";
    const failed = failedAnswer(d, said);

    if (failed !== undefined) status += `, failed for the user (#${failed.id}: ${failureWords(failed)})`;
    const answer = d.answer ?? "";
    const outcome = answer !== "" ? answer : (d.resolution ?? "");
    lines.push(`  ${d.ref ?? ""} decision ${d.id} ${status} [${d.kind}] ${d.title ?? "None"}${outcome === "" ? "" : `: ${outcome}`}`);
  }

  for (const l of ledger.links ?? []) lines.push(`  ${l.ref ?? ""} link ${l.id} [${l.kind}] ${l.title ?? "None"}: ${l.url ?? "None"}`);

  for (const k of ledger.kept ?? []) lines.push(`  kept ${k.id}: ${k.text}`);
  lines.push(`  ${ledger.events.length} events, updated ${ledger.updated ?? ""}`);
  lines.push(CHEATSHEET);

  return lines;
}
