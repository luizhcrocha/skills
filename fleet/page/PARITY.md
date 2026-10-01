# The page in Solid: feature parity

Every feature of the dashboard page before the rewrite (the hand-written `assets/dashboard.html` of
tstack 1.0.3), one row each, with how the Solid page was checked to keep it. Rows marked **new** or
**changed** are what the rewrite adds or redesigns on purpose.

How a row was checked:

- **core**: `skills/productivity/coordinator/tests/page.test.mjs`, unchanged, 50 tests, run against
  the `fleet-core` script the build emits from `src/core.ts`.
- **dom**: `test/inplace.test.tsx` (happy-dom, through the stream's own handlers), by test name.
- **cdp**: `test/browser.test.ts` (the built template in headless Chromium, fed by a real event
  stream from `test/harness.ts`), and the real run on a scratch hub.
- **shot**: `test/screens.ts`, old and new template on the same fixtures (`test/fixtures.ts`), at
  390×900 and 1280×900, light and dark; compared side by side and by pixel count (every view but
  the redesigned panel differs from the old in under 0.1% of its pixels: font hinting).
- **read**: ported line by line from the old script, behaviour read against it.

## Masthead and navigation

| Feature | Checked |
|---|---|
| Fleet mark, project name, status pill | shot |
| Switcher: Manager and every fleet, this page's own fleet always listed and selected; a change navigates | shot; dom "the switcher keeps its selection"; cdp |
| **changed (1.0.3)** "↑ Manager" and the switcher's Manager entry open the manager's own page: `/f/<manager>/` on the hub, `STATE.manager.url` off it, `/` (or its own `/f/<id>/`) on the manager's page | read (`managerPage` in `model.ts`, from 1.0.3's) ; shot (link shown) |
| Search button and Ctrl/⌘K open the finder | read; shot |
| Bell with unread badge (99+), muted stroke when sound is off | shot; dom "notification settings" (muted) |
| Tabs (Decisions, Plan, Fleet/Fleets, Links, Log, Chat) with `aria-current`; a bottom dock on a phone | shot (390 and 1280) |
| Tab badges: decisions waiting (red when one blocks), open roadblocks, unread chat (`aria-label` "Chat, N unread") | shot |
| Two-row phone header (1.0.2): name, search and bell on the first row, switcher and Manager on the second | shot (390) |
| Tab title "(N!) Fleet Board" and the favicon with the unread count | read |
| One view at a time from the address; old one-scroll anchors (#roadmap, #tokens, #activity, #agent-x) lead to their view and scroll there | core (`viewOf`); read |
| Leaving a view scrolls to the top; a decision's page takes focus | read |

## Decisions view

| Feature | Checked |
|---|---|
| Lead sentence and its detail (blocks work, answers waiting to be recorded) | core (`leadOf`); shot |
| Stuck box: answers not recorded, chats not read, silent workers, here and per fleet, with links | core (`stuckOf`); shot (silent worker) |
| Goal; Now line with "said N ago", greyed and "not updated for" when stale; "Latest from the log" under a stale one | core (`staleNow`); shot |
| Now line naming a closed decision ("it no longer waits on anyone") | core (`closedInNow`); read |
| Glance: running (names open the worker), current, next, "and N more" | core (`glanceOf`); shot |
| Started / updated | shot |
| Decision lists: Waits on you / Waiting / Done, with counts, remembered per browser | core (`bucketOf`, `decisionRows`); shot |
| Held by the fleet (`--hold`): under Waiting with "With the fleet: <reason>" and a "with the fleet" pill, never stuck; its page shows the reason and when it was held; a reply to an answer no longer hands an item back, a revision after it does; what waits named by kind ("1 decision and 1 action wait on you") | core (`awaiting`, `isHeld`, `kindCount`, `stuckOf`); dom (`held.test.tsx`) |
| A row: number, title, state pills (grilling count, answered and not read, with the manager, blocks work), new/changed mark, kind, fleet; question or decision; origin, why, asked/changed/closed | core; shot |
| Totals: a fleet's and a manager's figures, alert colours, tooltips, spend | shot (both roles) |
| Plan usage meters on a manager's page, reset and read times | core (`usageOf`); shot (manager) |

## Decision's page

| Feature | Checked |
|---|---|
| Back link, pills, title, origin (milestone, step, worker), asked/changed, "Replaces" | shot (#decision/d1) |
| Notes: decided / withdrawn, replaced, with the manager, changed since you last looked | read |
| Question, what it blocks / meanwhile, recommended with reason | shot |
| Evidence frame: sandboxed, page tokens and theme, sized by its height, reloaded only on a new revision; its text selection reaches the toolbar | read |
| "Open to decide" pages for the decision | read |
| Forms per kind (decision options + none + note, input, secret reference or set by hand, action done), errors, posting tagged with the decision | core (`answerText`); shot |
| Grilling: questions in reading order, recommendation, own answer (typing picks it), later; sent and waiting; settled folded; answer again per question | core (`grillState`, `grillAnswerText`); dom "an open <details>" |
| A half-written answer survives every state update, and is kept per decision and revision across reloads | dom "a half-written answer" |
| Answer sent: "Your answer", read or not by the host, its replies; Answer again; Ask in the chat; Change my answer | core (`pendingAnswer`, `awaiting`); read |
| Read-only copy says why it cannot answer | read |
| **new** `/` at the start of a field that writes words to the session lists the skills under that field, as the composer does (narrowed as typed, arrows, Enter or Tab pick into it, Escape closes, a tap picks; combobox, listbox and `aria-activedescendant`): a grilling question's own answer, and the note on a decision or an action. Picking keeps the draft and, in a grilling, chooses "My answer". The answer goes as typed (`Q1: /tstack:tdd …`, the note on its own line); the coordinator and the manager run it with the Skill tool, an answer's before acting on the decision. One list is open on the page at a time, and it survives a state update | dom `"/" opens its own list` (both fields), "a picked skill is kept as the decision's draft", "a click on a skill picks it", "one list is open at a time", "a decision's answer that starts with a /command"; cdp "a decision's note", "a grilling's own answer"; real run on a scratch hub; shot (390, 1280) |
| Left without the `/` list, on purpose: an input decision's value and a secret's reference are data, so a leading `/` stays literal text; the finder and the worker search (`f-q`) are searches, not words to a session | dom and cdp "the fields whose text is data or a search open no list on /" |

## Plan, Fleet, Links, Log

| Feature | Checked |
|---|---|
| Roadmap: milestones, step dots and states, a step with a worker opens it, decision chips | shot (with `--extra` views) |
| Roadblocks: sorted, severity, a title with a worker opens it, Decide link; held for later | shot |
| A manager's coordinators: strip per fleet, facts, session last active, not reading its chat, lanes, Open its page; the gate line | shot (manager) |
| Worker filters: search, status, milestone, skill, model; count of active ones; clear; a toggle on a phone; remembered | dom "a worker filter's choice" |
| Worker table (a strip per worker in a narrow card): name opens it, task, skill, model (policy warning), status, lane, tokens, time, seen/active (silent in red), Brief and report expanded and remembered | dom "a state that changes one worker", "an expanded brief"; shot |
| Tokens by worker chart with axis and hover tooltip | shot |
| Links: pages, dev servers, what the machine serves, up/down, fleet, "For" decision | shot |
| Log: newest first, narrowed by the worker filters, "needs you", worker names open it, Open Dn | shot |

## Chat

| Feature | Checked |
|---|---|
| Docked beside the page at ≥1100px, collapsible and remembered (collapsed by default when unavailable); an overlay below, with a history entry (Back closes), focus returned, the page inert, Tab kept inside, Escape closes | shot (390 chat, 1280); read |
| Connection state (Connecting, Live, Reconnecting, Unavailable), "as <login>", the unavailable note | shot |
| Threads ordered by latest message, replies under what they answer, side chats as links, side chat view with Back | core (`fold`, `sidesOf`); dom "a reply joins its thread" |
| Message: sender (worker name opens it), status pill, time, Reply (and tap to reply), Answering, About <decision>, quote, mention chips, waiting / not read / answered | shot; core (`unreadBy`) |
| Messages append without rebuilding the conversation; it stays at its end when it was there | dom "a chat message is appended"; cdp "a chat event appends one message" |
| Read up to the newest fleet message while in view; unread badge | core (`unreadCount`); read |
| Screen reader announcement of a live message | read |
| Composer: draft kept across reloads and every update, grows to eight lines, Enter / Shift+Enter / coarse pointer, IME, Escape blurs | core (`keyOf`); dom "a typed chat draft"; cdp |
| @mention list: opens on "@", narrows, arrows, Enter/Tab pick, Escape dismisses, tap | core (`mentionAt`, `filterRoster`, `insertMention`) |
| "To" line from `chat/preview`; reply and quote chips; read-only and deaf notes; send errors keep the draft | read |
| Message <worker> from its sheet starts the text with its @name | read |
| **new** `/` at the start of a message lists the skills the session can run (name, argument hint, description) from `GET skills`, narrowed as typed; arrows, Enter or Tab pick, Escape closes; a tap list above the keyboard on a phone; picking inserts `/<plugin:skill> `; any `/text` is still sendable | dom "a leading / lists", "arrows move through the skills", "a /command is sent as typed"; core (`commandAt`, `filterSkills`, `insertCommand`) |
| The composer's list is the page's one caret list (`src/carets.ts`, `src/CaretList.tsx`), shared with the decision page's fields; the composer (the main chat and a side chat, one field) adds `@` | dom (the composer's tests above, unchanged); cdp "the chat's composer" |
| **new** Hub `GET /f/<fleet>/skills` (plugins installed and enabled, user and project skills, 60 s cache), and the host and workers running a `/skill` message with the Skill tool | fleet/test/hub.test.ts (fixture HOME: two plugins, one disabled, a user skill, a project skill; a `/` chat round trip) |

## Notifications

| Feature | Checked |
|---|---|
| Every event and fleet message is a notification; "about me" or everything; important = waits on the viewer | core (`noticeOf`, `unreadNotice`) |
| List with unread dots, needs you, Open link, time; a click reads one; Mark all read; Clear | shot (panel) |
| One toast for all that arrived ("and N more"), sticky while important, 7 s otherwise, opens what it is about; under the masthead on a phone | core (`toastOf`); read |
| Chime (important: three notes), unlock on first touch, "Click anywhere once" note, Test sound | read |
| Browser alerts while hidden, permission flow, the one-line reason when unsupported (http, iPhone, other) | read |
| **changed** The panel opens on the list. The settings sit behind a gear beside Mark all read and Clear, open in place as compact rows (segments: Notify about to me / everything; Sound, Toasts, Browser alerts off / important / all; Browser alerts disabled with its reason when unsupported; Test sound an icon beside Sound); folded, one muted line sums them up and opens them; open or closed is remembered | dom "the notification settings sit behind the gear"; shot `*-panel` and `*-panel-settings`, old vs new, 390 and 1280 |

## Finder, sheets, selection

| Feature | Checked |
|---|---|
| Finder: every decision, link, coordinator (and its index), roadblock, step, worker, message, log line; prefixes d l r p w c f; numbers first; arrows, Enter, Ctrl+Enter new tab, click, backdrop | core (`findRows`, `findRank`); read |
| Worker sheet and a coordinator's sheet: facts, lane, brief and report, Message, Open its page, Close, backdrop; stays open across updates and closes when the worker is gone | dom "an open worker sheet"; cdp |
| Selection toolbar: Reply (quote) and Side chat on text selected in the page, the chat or the evidence frame; follows the scroll | core (`excerptOf`); read |

## Live data

| Feature | Checked |
|---|---|
| One EventSource: `hello` (write permission, login), `state`, `chat`; replay window; reconnect with backoff and `?after=`; poll `state.json` while down; retry a minute after unavailable | cdp; real run |
| A state is applied only when its content changed; rows reconciled by id, so unchanged rows keep their DOM | dom "a state that changes one worker", "a new worker adds one row"; cdp (marked node) |
| Per-fleet browser storage under the hub (`fleet:/f/<fleet>/`) | dom (draft key) |
| Rendered without a state: "No fleet state embedded" | read |

## Known differences

- The old page fell back to `webkitAudioContext`; the Solid page uses `AudioContext` only (Safari has it since 14.1).
- "N min ago" everywhere now refreshes every 30 s; before, only `<time>` elements did, the rest on the next state.
