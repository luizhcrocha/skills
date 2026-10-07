# Prototype rounds

Use this when a prototype lives over several review rounds: the reviewer keeps a preview tab open on the live page, marks it with the `picasso` skill (Luiz's picasso plugin), and each round answers those marks. A **round** is whole: built and verified away from the preview, then swapped in at once, so the reviewer's tab only ever shows a finished round.

A project's standing UI rules (its ADRs, read through the `domain-modeling` skill) apply on top of this file.

## Before the first round

Write the contract before any view, so another team can build the same view natively from it:

- A typed data contract with a version constant (`CONTRACT_VERSION`). Every node and edge carries whether it is real or simulated.
- A fixture builder that checks every reference resolves before it writes the fixture.
- `LAYOUT.md`: what is drawn where, what a click does, and every state of each view. The project's standing UX rules go at its top (for example: things open in context, navigation only on explicit intent, the side pane is a stack with breadcrumbs kept in the URL).
- A criteria tab on the page: each proof and disproof criterion with a number computed from the fixture, so the page reports whether the model works as well as how it looks.

Done when the fixture builder runs clean and `LAYOUT.md` covers every view. The standalone page stays the reference and the fallback once a native build exists.

## The round card

Every page of the prototype shows a round card, bottom left. Build it once and keep it:

- It reads `<name>-round.json`, a static file served beside the page (Casos: `public/prototipo/mapa-round.json`), on load and every 30 s. Shape: `{round, state, next, updated, post}`, with `state` `"building"` or `"idle"`, `next` a sentence on what is coming, `updated` an ISO timestamp, `post` a boolean. The coordinator edits this file directly; changing it never needs a rebuild.
- It always shows the round number and the state in words: building, with what is coming, or idle. When idle, the start-next-round button shows with no click to reveal it.
- It folds to a chip, and the folded state is remembered per browser (`localStorage`). On a phone it becomes a full-width strip.
- It publishes its height as a CSS variable on the root element, and the page's bottom-anchored elements offset by it, so nothing sits under the card.
- Labels are in the page's language. Casos uses "Rodada N" and "Começar a próxima rodada".

The start button copies the request (the next round's text) to the clipboard and opens the fleet page so the reviewer pastes it into the chat. With `post: true` it sends the request straight to the fleet page's chat endpoint, which works only if the hub accepts a cross-origin chat POST; keep `post: false` until it does, and fall back to copy-and-open when the POST fails.

Reference implementations in coelhorocha/custom-mcp-servers, on prototype changes rather than master (find them with `jj log -r 'files(glob:"**/RoundHint.tsx")'`): `apps/casos/src/prototypes/mapa/RoundHint.tsx` (Solid, on the project's kit) and the plain-JS `servers/case-analysis/tasks/lab-teoria/page/round-hint.js` (no dependencies, its own CSS).

Done when the card renders on every page at 1440 and 390 px and changing the JSON by hand shows on the page within 30 s.

## Running a round

1. **Collect the marks.** Read the open marks with `picasso marks` (the `picasso` skill). After a sidecar restart, read them again with `picasso marks`, since the push watch can miss events across a restart. Sort each mark into one of four places and reply on the mark (`picasso mark-reply <id> "<text>"`) saying which:
   - this round, by number;
   - another agent, when it is a pipeline or data problem in an area that agent owns (name it);
   - a decision, when the design question is really a choice for the reviewer: open it on the fleet page through the `coordinator` skill, with your recommendation;
   - dropped, with the reason ("this helps little, I propose dropping it" is a valid reply).

   Done when every open mark has a reply.
2. **Brief the round.** List the round's items in priority order, and a hold list of work paused until a decision. Give it to the round worker; for round two onward, resume the same worker with `SendMessage` so it keeps its context. In the round JSON, raise `round` by one, set `state` to `"building"`, `next` to what is coming, and `updated` to now. Done when the card on the live page says building.
3. **Build in a second workspace.** The preview serves one jj workspace; build the round in another (`jj workspace add`), never in the preview's. Marks that arrive meanwhile fold into the round being built, or into the hold list. Done when every item in the brief is built or reported as left out.
4. **Verify.** Use headless Chromium only, never the reviewer's browser. Load every page at 1440 and 390 px, in light and dark, with 0 page errors, and run one scripted check per mark the round answers (for example, counting cut labels or overlapping nodes at every zoom level). Screenshots that show client data stay in the scratchpad. Done when every check passes.
5. **Swap.** In the preview's workspace run `jj workspace update-stale`, then `jj new <round change>`. Done when the reviewer's page serves the new round and its card still loads.
6. **Close the marks.** Reply on each mark the round answered, naming the round, then `picasso mark-done <id>`. A mark is closed only after it has its reply. Set the round JSON's `state` to `"idle"`, `next` to the proposed next round or empty, and `updated` to now. Done when no mark answered by this round is open.
7. **Report.** Keep it short: what changed, mark by mark; what is real and what is simulated; what is still rough; what was left out and why; what waits on the reviewer.

Every few rounds, sweep all open marks against the live page and close each one the page already satisfies, with a reply naming the round that did it.

## Kinds of round

- **Variant rounds** may open the series: 2 to 4 structurally different variants behind `?v=`, with the picker from [PICKER.md](PICKER.md). Once the reviewer picks, a merge round folds the picks into one prototype, and later rounds evolve that one.
- **Design rounds** change only presentation; features wait for the next feature round. Audit first in `DESIGN-AUDIT.md`: per view, what competes for attention and what can wait behind a click. Count the elements on each view before and after, take screenshots in light, dark and at 390 px, and report the counts as measured when a target is missed.
- **Terminology rounds** come before any renaming. Write `TERMINOLOGY.md`: each term, its definition in the project's domain docs (`CONTEXT.md` and the ADRs, through the `domain-modeling` skill), where the page uses it, and each collision with one proposed resolution. Rename nothing until the reviewer decides.

## Real and simulated

- The data marks each node and edge real or simulated. The page says it once, at page level, and each simulated item carries a quiet marker that shows on hover or focus. A badge on every row clutters the page.
- A simulated item names a generic author or adopter ("Agent (simulated)", "Agency A"), never a real person.
- A write path that needs an access change goes to the reviewer as a decision before it is built; until then the write is simulated and labelled so.

## Client data

Fixtures and screenshots with client data are gitignored. Exported text keeps a party's category and drops names and phone numbers. Real data is served only behind the tailnet.
