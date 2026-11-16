# memo

TLC reached 7,776 states, more than the chart budget of 500, so the chart draws only the bug paths: 12 states and 11 arrows.

## NeverTwice breaks
The shortest path has 11 steps:
0. A holds notes none. B holds notes none. B reads notes none
1. a session on A writes note 1: A holds notes 1. B holds notes none. B reads notes none
2. a session on A writes note 2: A holds notes 1, 2. B holds notes none. B reads notes none
3. a session on A writes note 3: A holds notes 1, 2, 3. B holds notes none. B reads notes none
4. a session on A writes note 4: A holds notes 1, 2, 3, 4. B holds notes none. B reads notes none
5. B receives the files of A: A holds notes 1, 2, 3, 4. B holds notes 1, 2, 3, 4. B reads notes 1, 2, 3, 4
6. a session on A writes summary 10 of notes 2-3: A holds notes 1, 2, 3, 4 and summaries 10. B holds notes 1, 2, 3, 4. B reads notes 1, 2, 3, 4
7. a session on B writes summary 11 of notes 1-2: A holds notes 1, 2, 3, 4 and summaries 10. B holds notes 1, 2, 3, 4 and summaries 11. B reads notes 1, 2, 3, 4
8. a session on B corrects note 2 with note 5: A holds notes 1, 2, 3, 4 and summaries 10. B holds notes 1, 2, 3, 4, 5 and summaries 11. B reads notes 1, 4, 5 and the count of summary 11 (notes 1-2), over budget
9. a session on B writes summary 12 of notes 3-4: A holds notes 1, 2, 3, 4 and summaries 10. B holds notes 1, 2, 3, 4, 5 and summaries 11, 12. B reads notes 3, 5 and the count of summary 12 (notes 3-4), over budget
10. a session on B writes summary 21 of notes 1-4: A holds notes 1, 2, 3, 4 and summaries 10. B holds notes 1, 2, 3, 4, 5 and summaries 11, 12, 21. B reads notes 1, 5 and the count of summary 21 (notes 1-4)
11. B receives the files of A: A holds notes 1, 2, 3, 4 and summaries 10. B holds notes 1, 2, 3, 4, 5 and summaries 10, 11, 12, 21. B reads notes 1, 3, 5 and the count of summary 21 (notes 1-4)

## Rules that hold
WithinBudget, OnlyLiveNotes, Accounted, NewestWordForWord, KeptNotesStay, NoBrokenSummary, WriteNeverRefused, SameFilesSameRead, SettledMeansEqual, NoDeadlock, FilesOnlyGrow
