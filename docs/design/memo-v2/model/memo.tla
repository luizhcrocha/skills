------------------------------- MODULE memo -------------------------------
(* One scope's store of memo v2, held on one or two machines.

   A store is a set of files that only grows. A note file is a number in
   Notes, and a larger number is a newer note. A summary file is a number in
   DOMAIN Covers. It stands for the files it covers (notes, lower summaries,
   or both) and names the notes under it that stay in the start read (Keeps).
   Mark(x) is the file that takes x out of the live set: a retirement, or the
   `supersedes` line of a correcting note.

   Machines exchange files by set union. With no bookmark, one machine
   receives the files of another (Sync): the plain union, which no part of
   the design does directly. With a bookmark, a machine fetches the
   bookmark's files (Fetch) and sends its own (Push), and the bookmark takes
   a push only from a machine that already holds every file of the bookmark:
   the `memo` bookmark that carries every store, never pushed by force.

   StartRead is the design's selection, a function of the file set alone:
   the notes a session reads word for word at start for this scope, and the
   summaries whose count line it reads, within Budget lines. *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Machines,   \* the machines that hold a copy of this store
  Bookmarks,  \* the remote bookmarks that carry the store between machines. No session writes on one
  Notes,      \* note ids
  Covers,     \* summary id |-> the ids it covers (notes and lower summaries)
  Keeps,      \* summary id |-> the notes under it that it keeps in the start read
  Retirable,  \* the ids a session may correct or retire in this model
  Budget,     \* lines the scope's slice holds
  TopRule     \* "leaves": v2's rule. "direct": today's rule (the summary that covers more ids wins)

VARIABLES
  files,      \* files[h]: the files that machine or bookmark h holds
  read        \* read[m]: what a session on machine m reads at start

vars == <<files, read>>

Sums == DOMAIN Covers
Mark(x) == 100 + x
Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Holders == Machines \cup Bookmarks
AllFiles == UNION {files[h] : h \in Holders}
\* The newest quarter of a slice's lines belongs to the newest notes outside a summary. No task offers them.
Reserve == Budget \div 4

----------------------------------------------------------------------------
(* The view of one file set F *)

Dead(F) == {x \in Notes \cup Sums : Mark(x) \in F}
LiveNotes(F) == (F \cap Notes) \ Dead(F)

\* A summary stands for its files only while every summary under it is still there and not retired.
RECURSIVE Usable(_, _)
Usable(s, F) ==
  /\ s \in F
  /\ Mark(s) \notin F
  /\ \A c \in Covers[s] : c \in Sums => Usable(c, F)

\* Every note id a summary stands for, live or not. A summary covers notes, lower summaries, or both.
RECURSIVE Span(_)
Span(s) == UNION {IF c \in Notes THEN {c} ELSE Span(c) : c \in Covers[s]}
Leaves(s, F) == Span(s) \cap LiveNotes(F)

Size(s) == IF TopRule = "leaves" THEN Cardinality(Span(s)) ELSE Cardinality(Covers[s])
Claims(s) == IF TopRule = "leaves" THEN Span(s) ELSE Covers[s]
First(C) == CHOOSE s \in C : \A t \in C : Size(s) > Size(t) \/ (Size(s) = Size(t) /\ s <= t)

\* The summaries in effect: the largest first, and never two that claim one id.
RECURSIVE Pick(_, _, _)
Pick(cands, chosen, claimed) ==
  IF cands = {} THEN chosen
  ELSE LET s == First(cands) IN
       IF Claims(s) \cap claimed = {}
       THEN Pick(cands \ {s}, chosen \cup {s}, claimed \cup Claims(s))
       ELSE Pick(cands \ {s}, chosen, claimed)

Newest(x) == IF x \in Notes THEN x ELSE Max(Span(x))
NewestOf(C) == CHOOSE x \in C : \A y \in C : Newest(y) <= Newest(x)

\* A note costs one line. A summary costs one line for each live note it keeps, and one for its count.
Cost(x, live) == IF x \in Notes THEN 1 ELSE Cardinality(Keeps[x] \cap live) + 1
RECURSIVE Total(_, _)
Total(C, live) ==
  IF C = {} THEN 0 ELSE LET x == CHOOSE y \in C : TRUE IN Cost(x, live) + Total(C \ {x}, live)

\* The newest items of C that fit in the room.
RECURSIVE Suffix(_, _, _)
Suffix(C, room, live) ==
  IF C = {} THEN {}
  ELSE LET x == NewestOf(C) IN
       IF Cost(x, live) > room THEN {} ELSE {x} \cup Suffix(C \ {x}, room - Cost(x, live), live)

\* Over its slice: the oldest notes outside a summary leave first, and the notes a summary keeps stay.
\* The newest notes outside a summary are taken first, up to the reserve. Then the summaries, newest
\* first. More notes outside a summary are taken only when every summary fits.
Evict(roots, live) ==
  LET loose == roots \cap Notes
      sums  == roots \cap Sums
      head  == Suffix(loose, Reserve, live)
      room  == Budget - Total(head, live)
      shown == Suffix(sums, room, live)
      rest  == IF shown = sums THEN Suffix(loose \ head, room - Total(shown, live), live) ELSE {}
  IN head \cup shown \cup rest

Kids(s, live) == (Covers[s] \cap live) \cup (Covers[s] \cap Sums)
\* Room left: open the newest summary whose lines fit, again and again.
RECURSIVE Open(_, _)
Open(C, live) ==
  LET can == {s \in C \cap Sums : Total((C \ {s}) \cup Kids(s, live), live) <= Budget} IN
  IF can = {} THEN C ELSE LET s == NewestOf(can) IN Open((C \ {s}) \cup Kids(s, live), live)

\* The cover: the coarsest items that stand for every live note.
Roots(F) ==
  LET live     == LiveNotes(F)
      ineffect == Pick({s \in Sums : Usable(s, F) /\ Span(s) \cap live # {}}, {}, {})
      covered  == UNION {Covers[s] : s \in ineffect}
      under    == UNION {Span(s) : s \in ineffect}
  IN (ineffect \ covered) \cup (live \ under)

\* What a session reads: notes word for word, and the count line of each summary shown.
ReadOf(F) ==
  LET live     == LiveNotes(F)
      roots    == Roots(F)
      over     == Total(roots, live) > Budget
      chosen   == IF over THEN Evict(roots, live) ELSE Open(roots, live)
  IN
  [ own    |-> chosen \cap Notes,
    notes  |-> (chosen \cap Notes) \cup UNION {Keeps[s] \cap live : s \in chosen \cap Sums},
    counts |-> chosen \cap Sums,
    over   |-> over ]

----------------------------------------------------------------------------
(* What sessions do *)

\* Every step ends with each machine's start read computed again from its files.
Reads == read' = [m \in Machines |-> ReadOf(files'[m])]

Unwritten == Notes \ AllFiles
NextNote == CHOOSE n \in Unwritten : \A k \in Unwritten : n <= k

\* A session writes a note. Nothing about the store's size can stop it.
AddNote(m) ==
  /\ Unwritten # {}
  /\ files' = [files EXCEPT ![m] = @ \cup {NextNote}]

WriteNote(m) == AddNote(m) /\ Reads

\* A session answers a compaction task: it covers items of its coarsest cover, never the newest
\* note, and names the notes to keep.
CanSummarize(m, s) ==
  /\ s \notin AllFiles
  /\ LET F == files[m] IN
     /\ LiveNotes(F) # {}
     /\ Covers[s] \subseteq (LiveNotes(F) \cup {c \in Sums : Usable(c, F)})
     /\ \A c \in Covers[s] : \A t \in F \cap Sums : Usable(t, F) => c \notin Covers[t]
     /\ Max(LiveNotes(F)) \notin Covers[s]
     /\ Keeps[s] \subseteq Leaves(s, F)

Summarize(m, s) ==
  /\ CanSummarize(m, s)
  /\ files' = [files EXCEPT ![m] = @ \cup {s}]
  /\ Reads

\* A session corrects a note with a new line.
Supersede(m, n) ==
  /\ n \in Retirable \cap LiveNotes(files[m])
  /\ Unwritten # {}
  /\ files' = [files EXCEPT ![m] = @ \cup {Mark(n), NextNote}]
  /\ Reads

\* A session retires a note that is not knowledge, or a summary that keeps the wrong notes.
CanRetire(m, x) == x \in Retirable \cap files[m] /\ Mark(x) \notin files[m]

Retire(m, x) ==
  /\ CanRetire(m, x)
  /\ files' = [files EXCEPT ![m] = @ \cup {Mark(x)}]
  /\ Reads

\* Machine m receives every file machine o holds. Machines exchange this way only where no bookmark carries the store.
CanSync(m, o) == Bookmarks = {} /\ m # o /\ ~(files[o] \subseteq files[m])

Sync(m, o) ==
  /\ CanSync(m, o)
  /\ files' = [files EXCEPT ![m] = @ \cup files[o]]
  /\ Reads

\* Machine m fetches the bookmark and takes in every file it lacks.
CanFetch(m, b) == ~(files[b] \subseteq files[m])

Fetch(m, b) ==
  /\ CanFetch(m, b)
  /\ files' = [files EXCEPT ![m] = @ \cup files[b]]
  /\ Reads

\* Machine m pushes. The bookmark refuses a push from a machine that lacks one of its files, and no push is forced.
CanPush(m, b) == files[b] \subseteq files[m] /\ files[b] # files[m]

Push(m, b) ==
  /\ CanPush(m, b)
  /\ files' = [files EXCEPT ![b] = files[m]]
  /\ Reads

\* Nothing is left to write, summarize, retire or exchange.
Settled ==
  /\ Unwritten = {}
  /\ \A m \in Machines, s \in Sums : ~CanSummarize(m, s)
  /\ \A m \in Machines, x \in Notes \cup Sums : ~CanRetire(m, x)
  /\ \A m, o \in Machines : ~CanSync(m, o)
  /\ \A m \in Machines, b \in Bookmarks : ~CanFetch(m, b) /\ ~CanPush(m, b)

Quiet == Settled /\ UNCHANGED vars

Init ==
  /\ files = [h \in Holders |-> {}]
  /\ read = [m \in Machines |-> [own |-> {}, notes |-> {}, counts |-> {}, over |-> FALSE]]

Next ==
  \/ \E m \in Machines : WriteNote(m)
  \/ \E m \in Machines, s \in Sums : Summarize(m, s)
  \/ \E m \in Machines, n \in Notes : Supersede(m, n)
  \/ \E m \in Machines, x \in Notes \cup Sums : Retire(m, x)
  \/ \E m, o \in Machines : Sync(m, o)
  \/ \E m \in Machines, b \in Bookmarks : Fetch(m, b) \/ Push(m, b)
  \/ Quiet

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* The rules *)

Lines(m) == Cardinality(read[m].notes) + Cardinality(read[m].counts)
\* The live notes a shown summary counts without showing them.
Behind(s, m) == Leaves(s, files[m]) \ read[m].notes

\* The start read of a scope never holds more lines than its slice.
WithinBudget == \A m \in Machines : Lines(m) <= Budget

\* Every line read word for word is a live note of the store: nothing corrected, retired or rewritten.
OnlyLiveNotes == \A m \in Machines : read[m].notes \subseteq LiveNotes(files[m])

\* No live note is told twice: two summaries shown together never stand for the same note,
\* and a summary shown never stands for a note that is also shown on its own.
NeverTwice ==
  \A m \in Machines : \A s \in read[m].counts :
    /\ \A t \in read[m].counts : s # t => Span(s) \cap Span(t) = {}
    /\ \A n \in read[m].own : n \notin Span(s)

\* A live note is read, or counted by one summary shown, or left out only when the store is over
\* budget (the count line then says so).
Accounted ==
  \A m \in Machines : \A n \in LiveNotes(files[m]) \ read[m].notes :
    \/ \E s \in read[m].counts : n \in Behind(s, m)
    \/ read[m].over

\* The newest live note is always read word for word.
NewestWordForWord ==
  \A m \in Machines : LiveNotes(files[m]) # {} => Max(LiveNotes(files[m])) \in read[m].notes

\* While a store is over its slice, a note outside a summary is read beyond the reserve only when every
\* summary of the cover is shown: a kept note never leaves to make room for a note outside a summary.
KeptNotesStay ==
  \A m \in Machines :
    LET roots == Roots(files[m])
        loose == roots \cap Notes
        head  == Suffix(loose, Reserve, LiveNotes(files[m]))
    IN (read[m].over /\ read[m].own \ head # {}) => (roots \cap Sums) \subseteq read[m].counts

\* A summary shown still has every summary it was written from, and is not retired.
NoBrokenSummary ==
  \A m \in Machines : \A s \in read[m].counts :
    /\ s \notin Dead(files[m])
    /\ \A c \in Covers[s] : c \in Sums => (c \in files[m] /\ c \notin Dead(files[m]))

\* While a note is left to write, every machine can add it to its store: no state refuses a write for space.
WriteNeverRefused == Unwritten # {} => \A m \in Machines : ENABLED AddNote(m)

\* Two machines that hold the same files read the same lines.
SameFilesSameRead == \A m, o \in Machines : files[m] = files[o] => read[m] = read[o]

\* When nothing is left to do, every machine and every bookmark holds the same files: a refused push
\* is followed by a fetch and a push that gets through, and no file stays on one machine.
SettledMeansEqual == Settled => \A h, k \in Holders : files[h] = files[k]

\* No step removes a file, from a machine or from a bookmark.
FilesOnlyGrow == [][\A h \in Holders : files[h] \subseteq files'[h]]_vars

----------------------------------------------------------------------------
(* The summaries each config allows. A TLC config cannot hold a function. *)

\* life.cfg: 11 is the summary of the three oldest notes and keeps note 3.
\* 21 is a later summary of 11 and of note 4, and keeps note 3 too.
CoversLife == (11 :> {1, 2, 3}) @@ (21 :> {11, 4})
KeepsLife == (11 :> {3}) @@ (21 :> {3})

\* merge.cfg: 11 and 12 are summaries of two notes each, and 21 is the summary of 11 and 12.
\* 10 is a summary that another machine wrote earlier over notes 2 and 3, across 11 and 12.
CoversMerge == (10 :> {2, 3}) @@ (11 :> {1, 2}) @@ (12 :> {3, 4}) @@ (21 :> {11, 12})
KeepsMerge == (10 :> {2}) @@ (11 :> {1}) @@ (12 :> {3}) @@ (21 :> {1})
=============================================================================
