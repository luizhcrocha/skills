# Pause safely

**You own a clean stop. Leave a checkpoint a cold start can resume from.** Explicit only: on "keep going", "going to bed, keep going" or "don't stop", there is no pause.

1. Stop at a safe boundary: finish the current atomic step or back out of it. Start nothing new. Stop background subagents, or record which are still running and where they write.
2. Take no irreversible action to pause: no push, no bookmark move, no PR.
3. Make the work durable. jj already snapshots the working copy; describe it so it reads as unfinished: `jj describe -m "wip: <what>"` on `@` (split unrelated edits apart first). A broken tree says so in one line of the description.
4. Record what the next session would pay to rediscover as memo notes: the decisions and their why, the gotchas, and one `open` thread naming the resume point (`memo note open "<line>"`, per `tstack:memo`).
5. Write the handoff with `tstack:handoff`: intent, what you were doing, progress and what is verified, current state, next steps, key files, gotchas. It points at the change ids, the memo notes and any decision trail instead of repeating them.

**Reply:** where you are in the loop, what is on disk and what was only in your head (paths and change ids, no diff dumps), the wip change and whether its tree is sound, the handoff path, and the first action on resume. This is a pause, not a final report.
