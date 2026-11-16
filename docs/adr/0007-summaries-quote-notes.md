# A summary keeps notes word for word and never rewrites them

Status: accepted by Luiz on 2026-11-16, with one addition of his: the line that counts the notes a summary hides also names their most distinctive words. It changes one point of the direction he approved earlier that day (older notes shown "as summaries", OptMem's way), because the check he asked for failed.

Luiz asked for a faithfulness check before the start read relies on summaries. The check ran on 2026-11-16 on 30 of the 259 summaries in custom-mcp-servers, which interactive sessions on Opus or Fable wrote. An Opus Reviewer compared each summary with the exact lines it was written from. 8 of the 30 summaries state something their sources do not: 4 clearly (a pending job shown as cancelled, a rule about deletions shown as a rule about deploys) and 4 in a small way (a wrong owner, a date, an "only"). 3 more overstate progress and 1 copies an id wrongly. The bar from tape's check is 1 in 30, and tape's Haiku summaries failed it with 5. One invented line was copied into the level-2 summary above it. The full result is in [the evidence file](../design/memo-v2/evidence/faithfulness-2026-11-16.md).

So a summary no longer rewrites. It names the notes it stands for and, among them, the few to keep in the start read. The start read prints those notes word for word and one line that counts the others. Every line a session reads at start is then a line some session wrote on purpose, and a superseded note stops being read the moment it is superseded.

The count line names up to 3 words of the notes it hides, such as "about deploy, R2, narinfo". memo takes them from a word count over the index, with no model, so the line can print only words that those notes contain.

A second test the same day put the two shapes side by side, with Haiku compressing 30 groups of 12 notes and 8 runs of 144 ([the evidence](../design/memo-v2/evidence/compress-2026-11-16.md)). A rewritten line states something false in 5 of 30 cases at level 1 and in 5 of 8 at level 2. Quoted notes state nothing false at either level.

## Considered options

- **Rewritten summaries under stricter rules, shown only after a new check passes.** Rejected by Luiz. The errors sit where a qualifier is cut from a short item ("pending", "priority", "without Luiz's yes") and where a prefix such as "Luiz:" spreads over items that do not carry it. Rules can forbid both, but two populations have now failed the bar, and a summary at level 2 must drop most of what is under it.
- **No summaries.** The start read would show only the newest notes and a count. Rejected: a decision from two months ago would reach a session only when the session thinks to search for it.

## Consequences

- A summary compresses less than a rewritten line. About 4 lines stand for 12 notes, where one rewritten line stood for 16. In the second test a rewritten line carried 4.4 of a group's 8 main facts in 277 bytes, and three quoted notes carried 2.9 in 654 bytes.
- What a summary does not keep is reachable only by `memo zoom` and `memo recall`. The words on the count line tell a session whether to look.
- A quoted note can be stale: true when written, and contradicted by a later note. It was the one fault of quoted notes in the second test, in 1 of 30 cases at level 1 and 2 of 8 at level 2. A compaction task over summaries tells the session to retire or supersede such a note.
- The 309 rewritten summaries of the old stores stay on disk for zoom and recall. The start read does not show them.
