---
name: explain
description: "Explain a piece of work plainly (what, how, why) as one conversational account. Use for \"explain this change to me\", \"help me really understand X\", \"walk me through this PR\"."
---

# Explain

**Explain what a thing is, how it works and why it is built that way, in one plain account at the person's pace. The goal is that they understand it, not that anything changes.** Adapted from poteto's pstack (MIT), where it is `teach`.

Explain sits on top of `tstack:how` and `tstack:why`: they do the digging, you do the teaching. Reword their findings freely, with one exception: `why`'s confidence language stays intact, since its hedges are findings, not style.

## 1. Pick what they should walk away with

Decide the few things they should understand. Choose them from why they are asking (about to change it, reviewing it, debugging it, new to it) and what they already know, both read from the conversation, not quizzed out of them. Skip what they plainly know. Put the depth where their question is. Done when you can name those few things in a line each (for yourself; they are not printed).

## 2. Let how and why do the digging

Read the work yourself first to get oriented: the diff (`jj show <change>`, `gh pr diff <n>`), the files, what it touches. Then:

- **`tstack:how`** for how it works, whenever there is more than a screen of code to understand.
- **`tstack:why`** only when the reasons are part of what they need: reviewing a design choice, about to change the code, or asking why. `why` always runs its full sweep (one investigator per evidence category, then a Decider as synthesizer), so it is the slow, thorough path. Put the narrowing in the ask itself (a scoped question about this change, not the whole subsystem). When one reason is enough, read it yourself instead: the change description (`jj log -r '::@' -- <path>`, `jj show`), the PR body, `tstack:recall`.

Run them in parallel when both are needed, and combine the results. Done when every point from step 1 is backed by what they or you found.

## 3. Explain

Start with a plain definition. Name the thing and say what it is in general terms, the way a senior engineer would say it out loud, with its common name if it has one. Then tie it to the case in front of you ("in X, we use this to ...") and build from there: how it works, the deeper reasons, the edge cases. For each part, explain the idea so it clicks: the problem it solves and how it actually works. Walk through what happens as the person does the thing (opens a long chat, scrolls up) when that is what makes it land. Listing functions and constants is reference, not teaching.

Give the smallest complete answer first, a sentence or two, then stop. Add layers when they ask. Framing labels ("the key insight", "at its core", "TL;DR") stay out; the words in these steps are directions to you, not headers to print.

Keep it a conversation. Offer to go deeper or move on, and follow their lead. When you would pause, stop and let them respond; say each thing plainly rather than announcing it as important or hard, and leave out quizzes and pacing theater. Running one-shot with no live human, deliver it cleanly and put any offer to go deeper at the end.

## 4. Show it

Open the diff, the code or the debugger when that is the fastest way to land a point. Draw when a picture lands faster than words, and build the picture up: for anything with three or more moving parts, draw a short series where each diagram redraws the last and adds one part, so the reader watches the system assemble (A to B; then A to B to C; then the return edge). One all-at-once diagram saved for the end is a reference, not teaching. Mermaid fits a flow or structure where labels carry the meaning. A spatial idea (layout, overlap, scroll position, before and after) or a series too long for the chat goes to `tstack:show-me` as a page, built up the same way. A single simple point needs no figure.

## How it reads

Write it through `tstack:unslop`, in plain spoken English, the way you'd explain it to a colleague. On top of unslop:

- Tight, not terse: cut filler and hedging, keep the part that makes it click. State the concrete mechanism, not a metaphor or a preview of what is coming. The target density: "Virtualization runs in two parts, one for rendering and one for loading from disk. When an item scrolls out past the buffer, both its DOM node and its in-memory data are evicted."
- Short sentences: prefer periods to commas, one or two commas a sentence, split piled-up clauses. No em dashes. Normal sentence case.
- One name per concept, kept throughout.
- No mirror sentences ("A without B, or B without A") and no tidy closers ("the rest follows").

**Reply:** the explanation itself, never a report about what you did. Lead with the main point, then the plain account of what it is, how it works and why, and the threads worth chasing with `how` or `why`.
