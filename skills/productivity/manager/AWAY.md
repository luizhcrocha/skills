# The user steps away

Read from the manager's [SKILL.md](SKILL.md) when the user announces any absence, on the page or in the session, and when they come back.

Any absence the user announces ("I'm out for half an hour", "back after lunch", "for the night"), on the page or in the session:

0. A long absence (a night, or more than a couple of hours): before they go, ask once for the away contract, in one message: what "done" means for each fleet's current work as checks, the permissions they pre-answer (commits, landings on the stack, which deploys if any), and the escape hatch (when to stop and write up why instead of pushing on). Record their answer in `standing.md` and send it to each coordinator with step 2. If they have already left, take nothing beyond the briefs and the pause list. A short break skips this step.
1. Note it on your page with its expected return (`fleet state <dir> set --now "user away until <time>: <what goes on>"`).
2. Tell each coordinator by `SendMessage`, in one message each: the user is away until about <time>; keep working inside the briefs; start a decision trail with `tstack:show-me-your-work` for the absence; what only the user can settle becomes a decision and waits; the pause list holds (pushes that rewrite history, deploys, deletions, messages to people).
3. Keep your own trail the same way for what you decide while they are out (landing turns, answers you gave from `standing.md`).
4. On their return (they write again, or the time passes and they reappear): each trail first gets the review `tstack:show-me-your-work` asks for (a Decider after a long absence). Then one page message, "While you were out", opening with **Attention**: every reviewer's flags, each naming its fleet and the rows. Then what landed, what each fleet decided on its own, and what waits on them now (`fleet fleets waiting`).
