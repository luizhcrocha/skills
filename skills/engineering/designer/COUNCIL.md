# Council

The council is a tab in `designers` (the [council](../council/SKILL.md) skill) that aligns the designers through `fleet council`. Apply its decisions as the council skill's rules say; your next gate shows Luiz their effect.

- **Register**, at start. `fleet council register <slug> --dossier <absolute path of dossier.md> --repo <repo>`. Done when `fleet council list` shows `<slug>`.
- **Card.** Keep the dossier's **Interfaces** card on the current design version (DOSSIER.md, Interfaces). Done when its first line names that version.
- **Inbox**, on every resume, before every gate, and when a council message arrives. Run `fleet council decisions --for <slug> --unacked` and `fleet council questions --for <slug> --open`. Apply each decision's constraint; a change to the design is a new design version, which voids the later approvals as DOSSIER.md's Voiding says. Then `fleet council ack C-<n> --as <slug> --result "no change"` (or `--result "design v<n>"`) and add the row to **Constraints**. Answer each open question with `fleet council answer Q-<n> --as <slug> "<answer>"`; a question that asks you to act is answered once the act is done. Done when both commands list nothing.
- **Check**, optional, before gate 1. `fleet council check <slug>`, then bring each finding to Luiz with the design. Done when he has seen every finding, or there was none.
- **Staffing.** Luiz may call a council on a few related designers waiting at gate 3. When its message names your part, make that part your `team.md` as a new team version, then go on from LAUNCH.md's fleet check.
