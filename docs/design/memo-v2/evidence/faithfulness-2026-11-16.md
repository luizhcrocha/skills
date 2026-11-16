# Faithfulness check of memo's rewritten summaries, 2026-11-16

This file records one measurement. It is the reason for [ADR 0007](../../../adr/0007-summaries-quote-notes.md).

## Method

The method is the one tape used on its Haiku summaries ([tape.md](../../tape.md), "Faithfulness").

- **Population.** The 259 summaries in the custom-mcp-servers store: 244 at level 1 and 15 at level 2. Interactive sessions wrote all of them in the middle of their work, on Opus or Fable, as answers to memo's compaction tasks. That is the writer the approved direction names ("the writing session's model").
- **Sample.** 30 summaries drawn with Python's `random.Random(30)`: 28 of the level-1 summaries and 2 of the level-2 summaries, in proportion.
- **Sources.** For each summary, exactly the lines it covers: about 16 notes for level 1, about 16 level-1 summaries for level 2.
- **Reviewer.** One Opus Reviewer at high effort ([models.md](../../../models.md)), read-only. It compared each claim of a summary with that summary's sources and nothing else.
- **Findings counted.** Invented (a claim, label, number, name, causal link or attribution that no source supports), reversed (the opposite of the source), overstated (progress shown further along than the source says), and wrong copy (a number, id, path or name copied wrongly). Loss by compression alone is not a finding. A decision of Luiz that the summary drops whole is counted apart.

## Result

| Measure | Count |
| :-- | :-- |
| Summaries with at least one invented claim | 8 of 30 |
| of those, clear errors | 4 (S04, S19, S25, S30) |
| of those, small errors (a wrong owner, a date, an "only", an attribution) | 4 (S06, S11, S14, S20) |
| Reversed meanings | 0 |
| Overstated progress | 3 (S01, S05, S12) |
| Wrong copies | 1 (S13) |
| Decisions of Luiz dropped whole | about 17: 8 at level 1 in 6 summaries, about 9 in the 2 level-2 summaries |
| Summaries with no invented, overstated or wrongly copied claim | 18 of 30 |

The bar that tape set for relying on summaries is at most 1 invented fact in 30. tape's Haiku summaries had 5. These have 8 by the strict count and 4 or 5 by the count of clear errors.

## The worst findings

The findings are described here without their text, because the notes belong to a company repository and this repository is public.

1. **S25, invented.** The summary says that one ruling replaced a rebuild job. The only source about that job gives its measured size and duration and says nothing of a replacement. A pending job reads as a cancelled one.
2. **S13, wrong copy.** The summary says that a change stays off the main branch until one decision card is answered. The source names a different card. The card in the summary is in no source.
3. **S04, invented.** The summary says that deploys go through one coordinator. The sources say that this coordinator deleted a spike, and the one line about deploys says that Luiz's plain deploy command works alone. A deletion became a deploy rule.
4. **S19, invented.** The summary says that a push to one workflow file is allowed only while the workflows are disabled. The source says that the Manager accepts such a push without Luiz's yes only in that state. Without the qualifier, an exemption reads as a ban.
5. **S30 (level 2), invented attribution.** The summary puts Luiz's name and two dates before a list that includes the deploy rule of finding 3. Its sources, one of which is the summary of finding 3, name neither Luiz nor those dates. The invented line was copied one level up.

## Pattern

- The errors sit in the short items at the end of a line, where a qualifier is cut. The cut words are of the kind "pending", "priority", "without Luiz's yes" and "deletion".
- A prefix such as "Luiz:" or a date spreads over items that do not carry it.
- Dropped decisions cluster where a summary spends its characters on note ids, and at level 2, where 16 lines of several decisions each go into 280 characters.
- An invented level-1 line survives into level 2.

## Limits of this measurement

- One reviewer, one run, one store. The skills store has 1 summary and the global store has 49 of 4 to 7 notes each. Neither was sampled.
- The summaries were written under the old rules, which ask the writer to "give a minor item two words rather than dropping it". That rule produces the short items where most errors sit.
- The sample and the reviewer's full table are not committed, because the source lines are notes of a company repository. The store is not under version control, so the seed above rebuilds the sample only while the store still holds the same 259 summaries.
