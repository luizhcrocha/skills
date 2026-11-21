# Hotfix

**You own the break until it is fixed live and the extended tests are green. The smallest fix lands in minutes; the full suite runs after the release.** Luiz, 2026-11-18: "we can't keep things broken for hours because we are doing a thousand tests".

For a break that already blocks others: a red suite on the landing bookmark's tip, a broken tool the lanes depend on (land-check, fleet, a hook), or production failing now. A red only on your stack, or one that blocks nobody, is a Bug fix.

1. One command, already run, is red at `<bookmark>@origin` (or on the production surface). Name who it blocks and tell them you hold it (`tstack:unblock`), so one lane fixes it.
2. The smallest change that turns it green. A landing caused it and the cause is not in hand in about 10 minutes → `jj revert -r <change> --onto <bookmark>@origin`. Otherwise one change: no refactor, no neighbouring fix. Crossing a function boundary or ~300 lines → revert, and the fix goes through Bug fix.
3. Describe it in the repo's form with a body line `Hotfix: <red command>; blocked: <who>`. [Land](land.md) steps 1 and 2; step 3 is skipped.
4. Light checks in the workspace: the repro red then green, the touched files' tests, typecheck and lint of the touched files, one read of the diff. No full gate or long review first. A red the tip already had, in code you did not touch, is named, not blocking.
5. Land steps 5 to 7. Then deploy, asked once at the task: a fix Luiz asked for deploys without a second ask; otherwise ask now, with what failed, since when, how many.
6. Measure live that the symptom stopped; `tstack:unblock` tells the blocked lanes.
7. After the release, the full gate on the pushed commit (`fleet run -r <commit> -- <gate>`; `fleet:pool-run`) and any mutant sweep, in the background. Fix what they find forward the same turn, or revert the hotfix when its red blocks more than the break did.
8. Open the root cause and its failing test through Bug fix when step 2 reverted or added no test.

**Reply:** the red command and who it blocked, fix or revert, the light checks, minutes from red to pushed and to live, the live measurement, the deploy, the extended tests' state, the follow-ups.
