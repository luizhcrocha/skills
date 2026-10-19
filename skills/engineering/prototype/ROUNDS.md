# Prototype rounds

Use this when a prototype lives over several review rounds: the reviewer keeps a preview tab open on the live page, marks it with the `picasso` skill (Luiz's picasso plugin), and each round answers those marks. A **round** is whole: built and verified away from the preview, then swapped in at once, so the reviewer's tab only ever shows a finished round. A simple mark does not wait for a round: it takes the fast lane below.

The targets come from a measured case, the Processos case of 2026-10-19. Two marks took 48 minutes there: unseen for 25, then queued behind the round's backlog and its full checks. So:

- A mark gets a reply on the page within 5 minutes of its delivery to your session.
- A simple mark is fixed and live on the preview within 15 minutes of its delivery.

Picasso delivers marks in batches: a batch goes 3 minutes after the reviewer's last change, when the reviewer moves to another page of the app, or when the reviewer sends it now. To send at once, the reviewer presses the send button on picasso's rail or Cmd/Ctrl+Shift+Enter (picasso's README; the `picasso` CLI has no send command). Tell the reviewer this once, at the first round.

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

The start button copies the request (the next round's text) to the clipboard and opens the fleet page so the reviewer pastes it into the chat. With `post: true` it sends the request straight to the fleet page's chat endpoint, which the hub accepts only from an origin listed in its config (the coordinator skill's DASHBOARD.md, "Posting from a prototype page", has the call and the list); keep `post: false` until the page's origin is listed, and fall back to copy-and-open when the POST fails.

Reference implementations in coelhorocha/custom-mcp-servers, on prototype changes rather than master (find them with `jj log -r 'files(glob:"**/RoundHint.tsx")'`): `apps/casos/src/prototypes/mapa/RoundHint.tsx` (Solid, on the project's kit) and the plain-JS `servers/case-analysis/tasks/lab-teoria/page/round-hint.js` (no dependencies, its own CSS).

Done when the card renders on every page at 1440 and 390 px and changing the JSON by hand shows on the page within 30 s.

## The watch

Marks reach you only through a live picasso watch of your session that hears the preview's page-id. Under `fleet preview`, serve the preview in root mode (`fleet preview <dir> set --root`, then stop and start the preview): a preview under the hub's address shares the hub's page-id, so no watch can take its marks alone. Arm the watch when you arm the chat watch, and confirm it before every round:

1. Claim the page: `picasso claim <page-id> --as <role>`.
2. Start push: invoke the `picasso` skill. Invoking it starts a monitor that delivers each batch of marks into the chat, with no timeout to rearm.
3. Without push (no `picasso:picasso` in your skills list, `claude -p`, or the Monitor tool off), run `picasso watch --page-id <page-id> --timeout 600` with `run_in_background`, and rearm it on every exit. After a batch, rearm with `--after <cursor>` from its output. After a timeout (`"code": "timeout"`), rearm with the last cursor you had, or with no `--after`. A timeout that is not rearmed leaves no watch: in the 2026-10-19 case, that is how two marks went unseen for 25 minutes.
4. Confirm it: `fleet preview <dir> status` warns when no live watch hears the preview's page-id. Without a fleet preview, `picasso claims` must show your session `present`, with `watches` above 0 and the page-id in its claims.

Done when the preview runs in root mode and `fleet preview <dir> status` prints no watch warning, or, without a fleet preview, `picasso claims` shows the watch.

## Workers and the preview

Under `fleet preview`, the updater merges every worker's workspace into the preview every 3 s (the `coordinator` skill's DASHBOARD.md, the preview rows). Half-built work would then show on the reviewer's page. So:

- Add every round worker and fast-lane worker out of the preview: `fleet ws <dir> add <worker> --no-preview`.
- Check a worker's change on its own preview: `fleet preview <dir> start --per-worker <worker>` serves its workspace alone, at the address `start` prints. Stop it after the check: `fleet preview <dir> stop --per-worker <worker>`.
- Put the change live only once it passes: `fleet preview <dir> include <worker>`. The merge keeps it until it lands, so a later round does not remove it. Pruning the workspace (`fleet ws <dir> prune --apply`) drops it from the merge, so do not prune a fast-lane workspace before its fix lands.

On a plain preview workspace (no `fleet preview`), the preview serves only the change its `@` is on. Check a worker's change on a dev server of its own, in its workspace, on a free port. Put it live with `jj new <change>` in the preview's workspace.

## The mark fast lane

A mark goes ahead of every backlog item and of the round being built:

1. **Reply at once**, before reading code: `picasso mark-reply <id> "<what will change>"`. A mark that needs a decision, another agent or a round gets that reply instead (step 1 of a round). Done when the mark has a reply within 5 minutes of its delivery.
2. **Fix it alone.** One change per mark, or per batch of marks that arrived together, given to a fresh worker added out of the preview (worker sizing, step 2 of a round; "Workers and the preview"). On a plain preview, the worker builds on the change the preview serves, so the fixes stack. The fix never folds into the round's backlog. Done when the change is described.
3. **Check only what it touches**, before it goes live: a scoped run of the round check (step 4 of a round) on the worker's own preview, on the pages the mark touches at the default width and scheme, with a `--check` for the mark. Done when every line passes.
4. **Ship it live**: `fleet preview <dir> include <worker>`, or `jj new <change>` in a plain preview's workspace. Done when the fix shows on the preview.
5. **Close it**: reply naming the change, then `picasso mark-done <id>`.

## Running a round

1. **Collect the marks.** Read the open marks with `picasso marks` (the `picasso` skill). After a sidecar restart, read them again with `picasso marks`, since the push watch can miss events across a restart. Sort each mark into one of five places and reply on the mark (`picasso mark-reply <id> "<text>"`) saying which and what will change:
   - the fast lane, for a simple fix (data, copy, visibility, one view);
   - this round, by number;
   - another agent, when it is a pipeline or data problem in an area that agent owns (name it);
   - a decision, when the design question is really a choice for the reviewer: open it on the fleet page through the `coordinator` skill, with your recommendation;
   - dropped, with the reason ("this helps little, I propose dropping it" is a valid reply).

   Done when every open mark has a reply.
2. **Brief the round.** List the round's items in priority order, and a hold list of work paused until a decision. Give the round a fresh worker, and ask for its report at about 120k tokens of context, finished or not: a round's checks and screenshots fill a context fast. In the 2026-10-19 case, five workers reached 190k to 240k tokens, and each paid a handoff. Its brief carries `LAYOUT.md`, the contract and the round check's absolute path, so it starts without rereading the series. In the round JSON, raise `round` by one, set `state` to `"building"`, `next` to what is coming, and `updated` to now. Done when the card on the live page says building.
3. **Build in a second workspace.** Build the round in a workspace of its own, out of the preview (`fleet ws <dir> add <worker> --no-preview`, or `jj workspace add` on a plain preview), never in the preview's. A mark that arrives meanwhile takes the fast lane, or folds into the hold list. After each item, run the round check on the pages it touches, at its defaults. Done when every item in the brief is built or reported as left out.
4. **Verify** with the round check, `scripts/round-check.mjs` in this skill's folder (SKILL.md gives its absolute path), in headless Chromium, never the reviewer's browser. Every worker runs this script and writes none of its own. In the 2026-10-19 case, a hand-written one split each URL on `=`, cut `?l=` off and opened no page, so its checks proved nothing. Pass each page as its full URL, query included:

   ```sh
   node <skill dir>/scripts/round-check.mjs --out <scratchpad>/round-N --page 'https://host:7508/processos?l=123' --wait main --check '<expression true when the mark is fixed>'
   ```

   Its defaults are the scoped check of a fast-lane fix or a built item: one width (1440) and one scheme (light), on the pages the change touches. Before the swap, run the full matrix once on the round's own preview: every page with `--scheme light,dark --width 1440,390`. `--criteria <selector>` reads the criteria tab's numbers into each line; `--check` takes one expression per mark the round answers (for example, counting cut labels or overlapping nodes). It writes `summary.txt` in `--out`, one line per load with its path, result and screenshot, and exits 1 when a load fails, the browser dies or a page hangs past `--timeout`. Screenshots that show client data stay in the scratchpad. Done when every line of the summary passes.
5. **Swap.** Under `fleet preview`, run `fleet preview <dir> include <round worker>`; the fast-lane fixes stay in the merge beside it. On a plain preview, first rebase the round onto the last fast-lane fix the preview serves, so the swap keeps every fix: `jj rebase -b <round change> -o <last fix>`. Then, in the preview's workspace, run `jj workspace update-stale` and `jj new <round change>`. The full matrix ran on the round's own preview, without the fast-lane fixes, so check the combined one now: a scoped run of the round check on the preview's address, on the pages the round and the fast-lane fixes touch, with their `--check`s. Done when that run passes, the reviewer's page serves the new round, and the round card still loads.
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
