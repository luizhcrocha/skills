/**
 * A decision with a body to mark: perf's D30 ("Benchmark architecture"), its body trimmed from the real
 * one, and a revision of it that drops one sentence (R2's), moves a table row and puts a note at the top.
 * On a fleet's page (`marksView`) and on the manager's (`marksManagerView`, perf among its fleets).
 */
import { coordinatorView, managerView, type View } from "./fixtures.ts";

/** D30's body, as perf's ledger keeps it in decisions/d30.html. */
export const D30_BODY = `<h2>In short</h2>
<p class="lead">Reworked after your #100: this is now the architecture of the bench suite, not its settings. Please approve the idea, the model, the seams and the infrastructure picks.</p>
<p class="muted">As of 2026-10-10. Full draft: scratchpad bench-suite/design-v2.md.</p>
<h2>The idea</h2>
<p>A bench is a repeatable experiment for one pipeline step: fixed test inputs with answer keys, run through candidate models, scored by one shared metrics library. Every model call is saved, so a rerun is free; paying for a new call is an explicit choice with a reason and a cap. Every score goes into one history you can query.</p>
<h2>Infrastructure picks</h2>
<ul>
<li><b>Results history: Cloudflare D1</b>, a new database beside the ones the server already uses.</li>
<li><b>Saved calls and answer keys: lakeFS</b>, where the answer keys already live.</li>
<li><b>Metrics and graders: TypeScript in the repo.</b> Reporting: a command first, a page later.</li>
</ul>
<h2>Your questions</h2>
<table>
<thead><tr><th>Question</th><th>Recommended</th><th>Why</th></tr></thead>
<tbody>
<tr><td>Where does the results history live?</td><td>D1, with lakeFS keeping the full record</td><td>One shared, queryable place already run here; a local SQLite file would differ per machine.</td></tr>
<tr><td>Where do saved calls live?</td><td>lakeFS (not R2 alone)</td><td>Calls are the evidence behind a model change. R2 is faster but has no versions.</td></tr>
<tr><td>Does every test case block a new model, or only ones you mark critical?</td><td>Every case</td><td>Matches the rule that a model changes only when no gold question gets worse.</td></tr>
</tbody>
</table>`;

/** D30 revised without dropping a word: a note at the top, the history's row moved under the saved calls'. */
export const D30_MOVED = D30_BODY.replace("<h2>In short</h2>", '<p class="callout">Revision 2: perf reworked this after your marks.</p>\n<h2>In short</h2>').replace(
  /(<tr><td>Where does the results history live\?<\/td>.*?<\/tr>\n)(<tr><td>Where do saved calls live\?<\/td>.*?<\/tr>\n)/su,
  "$2$1",
);

/** D30 revised: a note at the top, R2's sentence gone, the history's row moved under the saved calls'. */
export const D30_REVISED = D30_MOVED.replace(" R2 is faster but has no versions.", "");

/** D30 as a decision of the fleet's ledger, opened and revised at `revised`. */
export const d30 = (revised: string): View => ({
  id: "d30",
  ref: "D30",
  kind: "decision",
  title: "Benchmark architecture: the idea, model and seams",
  question: "Approve the bench architecture?",
  why: "You asked for the design.",
  status: "open",
  blocking: false,
  asks: "user",
  opened: "2026-10-10T09:20:13Z",
  revised,
  body: true,
  options: [
    { id: "A", label: "Approve the architecture", consequence: "infra and perf build the seams" },
    { id: "B", label: "Revise it", consequence: "tell me what to change on the page" },
  ],
  recommend: "A",
});

/** perf's page with D30 open on it. */
export function marksView(now: number, revised = "2026-10-10T10:28:40Z"): View {
  const view = coordinatorView(now);

  return { ...view, named: { id: "perf", session: "Perf" }, decisions: [d30(revised)] };
}

/** The manager's page with perf among its fleets and D30 open there. */
export function marksManagerView(now: number): View {
  const view = managerView(now);
  const fleets = Array.isArray(view["coordinators"]) ? view["coordinators"].filter((c): c is View => c !== null && Object(c) === c && !Array.isArray(c)) : [];
  const billing = fleets[0] ?? {};
  const perf: View = { ...billing, id: "perf", url: "f/perf/", session: "perf", name: "perf", project: "Perf", decisions: [{ ...d30("2026-10-10T10:28:40Z"), body: undefined }], index: [] };

  return { ...view, coordinators: [...fleets, perf] };
}
