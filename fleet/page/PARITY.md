# The page in Solid: feature parity

Every feature of the dashboard page before the rewrite (the hand-written `assets/dashboard.html` of
tstack 1.0.3), one row each, with how the Solid page was checked to keep it. Rows marked **new** or
**changed** are what the rewrite adds or redesigns on purpose.

How a row was checked:

- **core**: `skills/productivity/coordinator/tests/page.test.mjs`, run against the `fleet-core` script
  the build emits from `src/core.ts` (50 tests at the rewrite, 52 now; changed since only where a row
  marked new or changed says so), and the page's own `test/queue.test.ts` on the same rules.
- **dom**: `test/inplace.test.tsx` and, for the chat, `test/chat.test.tsx` (happy-dom, through the
  stream's own handlers), by test name.
- **cdp**: `test/browser.test.ts` and, for the chat, `test/chat-browser.test.ts` (the built template in
  headless Chromium, fed by a real event
  stream from `test/harness.ts`), and the real run on a scratch hub.
- **shot**: `test/screens.ts`, old and new template on the same fixtures (`test/fixtures.ts`), at
  390×900 and 1280×900, light and dark; compared side by side and by pixel count (every view but
  the redesigned panel differs from the old in under 0.1% of its pixels: font hinting). For the chat,
  `test/screens.ts --chat` on `chatView` and `chatConversation` (a day and a half: a decision's answer and
  its acknowledgement, a worker's report, a side chat, a long status, a reply), named `chat-*`.
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
| **new** A permission (a call auto mode refused): the call as an `sh` block, its cause, the rule and the file it goes into, then allow-once / deny and a note; the hub's refusal to grant shown on the form; counted and named as a permission | dom (`permission.test.tsx`) |
| Grilling: questions in reading order, recommendation, own answer (typing picks it), later; sent and waiting; settled folded; answer again per question | core (`grillState`, `grillAnswerText`); dom "an open <details>" |
| A half-written answer survives every state update, and is kept per decision and revision across reloads | dom "a half-written answer" |
| Answer sent: "Your answer", read or not by the host, its replies; Answer again; Ask in the chat; Change my answer | core (`pendingAnswer`, `awaiting`); read |
| Read-only copy says why it cannot answer | read |
| **new** `/` at the start of a field that writes words to the session lists the skills under that field, as the composer does (narrowed as typed, arrows, Enter or Tab pick into it, Escape closes, a tap picks; combobox, listbox and `aria-activedescendant`): a grilling question's own answer, and the note on a decision or an action. Picking keeps the draft and, in a grilling, chooses "My answer". The answer goes as typed (`Q1: /tstack:tdd …`, the note on its own line); the coordinator and the manager run it with the Skill tool, an answer's before acting on the decision. One list is open on the page at a time, and it survives a state update | dom `"/" opens its own list` (both fields), "a picked skill is kept as the decision's draft", "a click on a skill picks it", "one list is open at a time", "a decision's answer that starts with a /command"; cdp "a decision's note", "a grilling's own answer"; real run on a scratch hub; shot (390, 1280) |
| **new (2026-10-02)** On a manager's page a fleet's decision opens on the manager's own decision page, `#decision/<fleet>/<id>`, for Luiz: each one sent him to that fleet's page and back. The page is the fleet's in a frame, `/f/<fleet>/?embed=1#decision/<id>` (the decision alone: no masthead, chat, toasts, notifications or back link; a worker or another view opens the fleet's page beside), sized by the height it posts (`{fleetEmbed, height}`), which the manager takes only from that frame | core (`decisionRoute`, `decisionHref`, `parseFleetDecision`, `findRows`, `parseEmbedMessage` in `test/queue.test.ts`; `decisionRoute` in page.test.mjs, which now takes the fleet form on a manager's page only); dom `embed.test.tsx` "on the manager's page a fleet's decision opens on the manager's own page…", "the frame is sized by the height it reports…", "…the Stuck box and the finder open a fleet's decision on the manager's own page", "on a fleet's own page a <fleet>/<id> address names no decision", "embedded, a fleet's page is its decision alone…", "embedded, a fleet message makes no notification…", "viewed normally…"; read (a real run in headless Chromium at 390 and 1280, not kept as a test) |
| **new (2026-10-02)** The manager's decision page, its own or a fleet's, steps to the previous and next of what waits on the user in the order of "Waits on you" (`queueOf`), "N of M waiting on you"; once the one shown is answered (posted from the frame as `{fleetEmbed, answered}` once nothing is left to answer, sent on the page, or gone from the queue on the next state) it says "Answered. Next: <title>" with Next focused, and stays (when going on is turned off: see the next row); decided or gone from the state since, its neighbours are the ones around where it waited. The Stuck box and the finder open a fleet's decision there too; on a fleet's own page `#decision/<fleet>/<id>` names no decision | core (`queueOf` in `test/queue.test.ts`: in order, answered, decided, gone from the state); dom `embed.test.tsx` "previous and next walk…", "turned off, an answer sent in the frame…", "turned off, a fleet's decision that leaves the queue…", "…answered and then gone from the next state keeps Next…", "…answered and then decided, keeps Next…", "…says nothing else waits when it was the last", "embedded, a grilling tells the manager it was answered only once nothing is left to answer" |
| **new (2026-10-02)** The manager's decision page goes on to the next of what waits on the user once the one shown is answered, as a switch in the queue's row, "Go to the next once answered" (`role="switch"`, kept in this browser as `decision-advance`, on unless turned off). On, an answer (from the frame, sent on the page, or gone from the queue on the next state) opens the next, focuses the decision's page (`#decision`), and says there "Answered <ref> <title>." (`role="status"`), with Previous back to the one answered; moving to another decision any other way clears that note. With nothing next it stays and says "Answered. Nothing else waits on you."; off, it is the row above | dom `embed.test.tsx` "an answer sent in the frame goes on to the next…", "going to another decision by any other way clears the note…", "a fleet's decision that leaves the queue on the next state goes on to the next", "going on is a setting kept in this browser, on unless turned off", "…says nothing else waits when it was the last"; read (a real run in headless Chromium at 390 and 1280, not kept as a test: answered in the frame it lands on the next with the note and focus on `#decision`; switched off, it stays with "Answered. Next" and Next focused; the switch stays off after a reload) |
| **fix (2026-10-02)** On a manager's page a fleet's open item is in "Waits on you" (and the queue, the lead, the masthead and the fleet's "N on you") exactly when that fleet's own page puts it there: the summary sends each open item's chat in that fleet (`said`) and a grilling's open questions, and `awaiting` runs the fleet's rule on them (`asItsFleet`). Before, a grilling waited on the fleet whatever was left to answer, and an answer the fleet replied to without recording sent the item back to the user | core, the fleet's own page against the manager's on one ledger and chat, for every kind (`fleet/test/waits.test.ts`); dom `embed.test.tsx` "a fleet's grilling waits on the user on the manager's page while its own page would…" |
| **changed (2026-10-02)** A fleet's decision in the manager's frame, for Luiz: "Change my answer" did nothing there (it fills the chat, and the frame has none) and "Ask in the chat" sent him to the fleet's page. Both now open a box on the decision's page ("To the coordinator", prefilled `About "<title>": I want to change my answer. ` or `About "<title>": `, caret at the end, Send and Cancel) that posts to the fleet's chat as its composer does (no `decision`, so `to` is the coordinator), as a reply to the decision's thread when it has one from the user or the coordinator (`re`, which also goes to the coordinator), so the thread ("In the chat") shows it and the answer; a decision with no thread shows the message sent from the frame and its replies until a reload. Then "Sent to the coordinator. Its reply shows above, in the chat."; a refusal keeps the text with the reason. Another of the fleet's decisions linked on the page (Replaces, A newer decision) opens on the manager's page (`{fleetEmbed, open}`), and Ctrl/⌘K in the frame opens the manager's finder (`{fleetEmbed, finder}`). The selection a touch made is placed the touch way (`touch` in the select message, and in the evidence frame's) | core (`parseEmbedMessage` in `test/queue.test.ts`); dom `embed.test.tsx` "embedded, Change my answer writes to the fleet's coordinator in the frame…", "embedded, Ask in the chat writes in the frame too…", "embedded, a message the server refuses stays…", "embedded, another decision's link asks the manager to open it, and Ctrl+K…", "on the manager's page, the fleet's frame opens another of its decisions…", "a touch selection in a fleet's frame puts the toolbar below it…", "embedded, a pointer of touch marks the selection…"; fleet `test/chat.test.ts` "the user's reply to their own answer, or to the coordinator's reply to it, goes to the coordinator…"; read (a real run in headless Chromium at 390 and 1280, not kept as a test) |
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
| **changed (2026-10-01)** A messenger's layout, for Luiz's report from his phone: "Chat is looking like a log, without clear separation." The viewer's messages (`from: user`) sit on the right in bubbles tinted with the accent; the fleet's on the left, under the sender's name and spawn colour (`colourOfId`; the worker's name still opens it, with its status pill). No bubble is wider than 80% of the log; no full-width cards, no left borders. Messages run in the order sent (`src/chatlog.ts`, `chatRows`); threads are kept as reply quotes instead of nesting | dom "the viewer's messages and the fleet's are told apart"; cdp "at 390 px / at 1280 px the viewer's messages sit on the right and the fleet's on the left, none wider than 80%"; shot `chat-{390,1280}-{light,dark}{,-top}`, old and new template |
| **new** Consecutive messages of one sender within five minutes share one name and time; the bubbles of a run are stacked with tightened corners | dom "a run of one sender within five minutes is one name and time"; dom "a new message is appended in place" (the run grows on the same nodes); shot |
| **new** A separator per day: Today, Yesterday, the weekday and date, the year when not this one (the time beside a name is the time of day) | dom "the viewer's messages and the fleet's are told apart, each under a day"; shot `-top` |
| **changed** A reply shows a one-line quote of what it answers (sender in their colour, the first line), unless that message is right above it; a tap scrolls there and marks it. Replaces the nested indentation and "Answering <name>" | dom "a reply quotes what it answers on one line", "a reply is appended at the end, quoting what it answers"; cdp (tap size) |
| Side chats as links where their last message falls, side chat view with Back, the quote of a page excerpt in the bubble | core (`sidesOf`); dom "a side chat is a link where its last message falls" |
| Message: Reply (a button beside a fleet bubble, on hover with a mouse, once per run on a touch screen; a tap on any fleet bubble replies to it), the reply being written outlined, mention chips, waiting / not read / answered under the viewer's own | shot; core (`unreadBy`); dom "a new message is appended in place" (`.replying`) |
| **changed (2026-10-01)** Decision activity is left out of the chat by default, for Luiz: the chat aggregates the control plane, and decision answers in it are clutter. A message that carries `decision` (an answer, a grilling's answers, a note, or the fleet's message about one) and every message whose `re` chain leads to one (`decisionTrail`). They stay in `chat.jsonl` (the record, and what wakes the sessions); only the view changes | dom "decision activity is left out by default", "a later reply to the decision's thread joins it, and stays out of the chat"; cdp "decision activity: left out of the chat…" |
| **new** "Decision activity" switch under the chat's head (a row that lines up with the tabs), off by default, remembered per browser (`chat-decisions`, through the page's guarded storage); while off it says how many are hidden. On, each is a one-line marker that links to the decision: "You answered D18 · …", "coordinator on D18: …" | dom "decision activity is left out by default, a marker each when asked for, and remembered"; cdp (reload keeps it); shot `chat-*-activity` |
| **new** The decision's page shows its thread under the question, "In the chat": the viewer's answers and notes on the right, the fleet's replies on the left, in the chat's bubbles (`src/DecisionThread.tsx`, mounted once in `DecisionPage`) | dom "a decision's page holds its thread"; cdp; shot `chat-*-decision` |
| **changed** The finder's hit on decision activity the chat leaves out opens the decision's page | dom "the finder leads to a decision's page" |
| Phone first: every control in the chat (Reply, a reply's quote, the switch, a side chat, a marker, a name, close, send) is at least 44 px each way at 390 px | cdp "on a phone every control in the chat is at least 44 px each way" |
| Messages append without rebuilding the conversation (every row keeps its node; a run's earlier bubble is updated in place); the chat keeps its scroll, or stays at its end when it was there; the draft, the open reply and the caret lists survive | dom "a chat message is appended", "a new message is appended in place"; cdp "a chat event appends one message", "a chat event is appended in place: the rows keep their nodes, the chat its scroll, the composer its draft" |
| **changed** Read up to the newest fleet message while in view; the Chat tab's unread badge counts decision activity only while the chat shows it (the Decisions tab and the notifications cover it) | core (`unreadCount`); dom "the Chat tab counts unread decision activity only while the chat shows it" |
| Screen reader announcement of a live message (not of decision activity the chat leaves out) | read |
| Composer: draft kept across reloads and every update, grows to eight lines, Enter / Shift+Enter / coarse pointer, IME, Escape blurs | core (`keyOf`); dom "a typed chat draft"; cdp |
| @mention list: opens on "@", narrows, arrows, Enter/Tab pick, Escape dismisses, tap | core (`mentionAt`, `filterRoster`, `insertMention`) |
| "To" line from `chat/preview`; reply and quote chips; read-only and deaf notes; send errors keep the draft | read |
| **fix (2026-10-02)** The most a message can be, for Luiz: a 78 KB message from a fleet's decision on the manager's page was refused (413, the limit was 16 KiB) with only "a message is at most 16 KiB". The limit is 256 KiB, given by the stream's `hello` (`max_bytes`); every composer that posts to `chat` (the chat's and a side chat's, a decision's answer, a grilling's, the box in the manager's frame) weighs the JSON body's UTF-8 bytes against it before sending and, over it, sends nothing, keeps the text and says on its own error line "This message is N KiB; the most a message can be is 256 KiB. Shorten it, or put the long part in a file and give its path."; the server's 413 says the same, and is shown the same way. With no `hello` yet the page sends and the server decides | core (`tooBig`); dom `limit.test.tsx` (each composer, over the limit and refused with 413), `embed.test.tsx` "embedded, a message over the limit stays…", "embedded, a 413 from the server shows its words…"; cdp `chat-browser.test.ts` "a draft over the limit the stream's hello gives…" |
| Message <worker> from its sheet starts the text with its @name | read |
| **new** `/` at the start of a message lists the skills the session can run (name, argument hint, description) from `GET skills`, narrowed as typed; arrows, Enter or Tab pick, Escape closes; a tap list above the keyboard on a phone; picking inserts `/<plugin:skill> `; any `/text` is still sendable | dom "a leading / lists", "arrows move through the skills", "a /command is sent as typed"; core (`commandAt`, `filterSkills`, `insertCommand`) |
| The composer's list is the page's one caret list (`src/carets.ts`, `src/CaretList.tsx`), shared with the decision page's fields; the composer (the main chat and a side chat, one field) adds `@` | dom (the composer's tests above, unchanged); cdp "the chat's composer" |
| **new** Hub `GET /f/<fleet>/skills` (plugins installed and enabled, user and project skills, 60 s cache), and the host and workers running a `/skill` message with the Skill tool | fleet/test/hub.test.ts (fixture HOME: two plugins, one disabled, a user skill, a project skill; a `/` chat round trip) |

## Text and code

Free text that can carry code is shown in one small format (`src/text.ts`; fleet/SPEC.md, "Text on
the page"): paragraphs, inline code, fenced blocks with a language. Luiz (2026-10-01): a decision's
"What to do" was one monospace slab mixing prose and a nushell command.

| Feature | Checked |
|---|---|
| **new** Where: a decision's question, why, reason and options' consequences, `--manual`, a grilling question's body, a roadblock's detail, every chat message (mentions stay chips, in the words; in code they are their text) | dom `code.test.tsx` "a chat message's code is a block in the bubble…"; shot `code-*` |
| **new** Paragraphs on a blank line, inline code, fences with and without a language (none: plain), an unclosed fence runs to the end; no other markup and no HTML: the parser returns strings and the page renders text nodes and spans | `text.test.ts` (paragraphs, inline code, fences, "text that looks like HTML stays text"); dom (an HTML-looking message has no `b` or `script`) |
| **new** Text with no backtick shows exactly as before (one paragraph, pre-wrap). An old `--manual` with none: one whose every non-empty line is a command (not a sentence) is one `nu` block, A22's four lines included; anything else (prose among the commands) is the old monospace slab | `text.test.ts` "an old --manual…", "an unfenced --manual of command lines only (A22)…"; dom "an old one-command --manual is one nu block…"; shot `code-*-legacy` |
| **new** A code block: the language as its label, highlighting in the page's tokens (both themes), a Wrap switch (off), horizontal scroll inside the block (never the page), a Copy button per block, at least 44 px on a touch screen, that copies exactly the code (`navigator.clipboard.writeText` in the click, else the code selected and copied with `execCommand`, else left selected), "Copied" for 2 s | dom "Copy writes exactly…", "without the clipboard (plain http)…", "each block has its own button…"; cdp "at 390 px a block scrolls inside itself…", "Copy puts exactly the block's code on the clipboard…"; shot `code-{390,1280}-{light,dark}-{modal,legacy,chat}` |
| **new** A block is keyed by its content: a state update that leaves it as it was keeps its node, its Wrap and its "Copied" | dom "a block keeps its node…"; cdp "a block keeps its node and its wrap switch through a state event" |
| **new** Languages: nu (the page's own grammar, `src/langs.ts`: commands at a pipeline's head, flags, `$vars` and cell paths, the four string kinds, `$"…(expr)"` with the expression highlighted as nu, records, closures' parameters, pipes, numbers with units, comments), sh/bash, ts, js, json, toml, nix and rust (the page's own, small), python, sql, diff, yaml | `text.test.ts` "nu: a variable, a flag, a string, interpolation, a closure, a record, a comment", "the fleet's other languages…" |

**The highlighter: @tanstack/highlight 1.0.0** (the latest on npm, MIT, no dependencies), its `core`
entry with one import per language, over sugar-high 2.5.0 (latest, MIT). Read from both packages'
published source, by the criteria in order:

1. Nushell: neither ships it. @tanstack/highlight takes a language as `defineLanguage({name, aliases,
   tokenize(code, ctx)})`, any code returning `{start, end, className}` ranges, with `ctx.tokenize` to
   hand a substring to another language: a hand-written scanner with states, and the `(expr)` of an
   interpolation tokenized as nu again. sugar-high takes only `ParseOptions` (keyword sets, comment and
   quote hooks) for its JS-shaped lexer: `$"..."` came out as `$` and a string, and nested interpolation
   is out of reach.
2. The fleet's languages: @tanstack/highlight has sh, ts, js, json, toml, python, sql, diff, yaml, not
   rust or nix; sugar-high has those and rust, not nix. Nix is the page's own either way; rust is a
   small scanner here.
3. Size: core and the full language set, 6.2 KB gzipped for @tanstack/highlight against 5.8 KB for
   sugar-high, 0.4 KB apart, so size does not decide. The built template grew from 298,660 to 329,233
   bytes (+30.6 KB; `gzip -9` 92,403 to 103,248, +10.8 KB), the highlighter and its languages 8.4 KB of it gzipped.
4. Solid: both tokenize a string synchronously with no framework; @tanstack/highlight's `tokenize`
   returns `{className, value}` tokens, which the page renders as spans (no `innerHTML`).
5. Theming: classes; the page maps them to its own tokens (`.t-keyword`, `.t-string`...), both themes.
   sugar-high writes an inline style per token.

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
| **changed (2026-10-01)** Selection toolbar, for Luiz: it sat over the selection and blocked copying, the browser's menu with Copy out of reach. Now Copy (first; the code blocks' clipboard handling), then Reply (quote) and Side chat where the chat can be written, on text selected in the page, the chat or the evidence frame. Never over the selection: above its first line with a mouse, below its last when there is no room above; below on a touch screen, 30 px clear for the handles and the phone's callout; inside the viewport's width (`toolPlace`). It listens to no `contextmenu` or `copy` and prevents nothing in the text (passive `pointerdown`/`pointerup`/`touchend`); it shows once the selection rests (release plus 250 ms), never during a drag; it closes on a right-click (the browser's menu then opens with Copy), Escape, a scroll, or a press elsewhere. Read-only copies get Copy alone | core (`excerptOf`); cdp `seltool-browser.test.ts` "selecting a chat message / a decision's text" (the bar off the selection's rects, `contextmenu` reaching the document with `defaultPrevented` false, Copy equal to the selection), "Escape and a scroll close the bar", "on a phone the bar sits below the selection"; shot `sel-{390,1280}-{light,dark}-{chat,decision}` |
| **changed (2026-10-02)** Selection toolbar on a fleet's decision shown on the manager's page, for Luiz: in the frame (`?embed=1`) selecting text showed no bar, and the manager is where he acts. The framed page tells the manager of a selection on the decision's page (once it rests, 180 ms) and passes on its evidence frame's, placed in the page, as `{fleetEmbed, select: {text, rect, from}}` (`text` empty once cleared); the manager takes it from that frame only, places the bar over the frame (`toolPlace`, shifted by the frame's box), and closes it when the frame's selection is cleared. Copy copies from the manager; Reply and Side chat put the quote, from "<where>, in <fleet>", on the manager's composer addressed to that fleet's coordinator (`@<fleet>`, as its sheet's Message button does). Outside the frame nothing changes | core (`parseEmbedMessage` in `test/queue.test.ts`: a selection, cleared, malformed); dom `embed.test.tsx` "text selected in a fleet's frame shows the manager's toolbar over it, and Reply writes to that fleet's coordinator", "Side chat on text selected in a fleet's frame…", "a selection from anything but the fleet's frame is ignored…", "embedded, the fleet's page tells the manager of text selected in it…", "embedded, the fleet's page passes its evidence frame's selection on…"; read (a real run in headless Chromium at 390 and 1280, not kept as a test: a phrase dragged in the frame's question shows the bar 8 px above it, Copy fills the clipboard, Reply leaves `@billing ` and the quote on the composer, sent as `{text: "@billing …", quote}`) |

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
