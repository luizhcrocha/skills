---
name: bye
description: "End this session for good: check for undone work, stop its processes and subagents, tell work-graph and the agents that depend on it, clean up, close its Rex tab. Use for /bye."
disable-model-invocation: true
---

# Bye

Luiz is done with this session. `/bye` is his go for every step below except one: undone work found in step 1 waits for his answer. [`/seeya`](../seeya/SKILL.md) runs steps 1 to 4 and suspends instead of closing.

1. **Look for undone work.** List each of these that you find: an ask of his not done, a promise not kept, a jj change not landed or not described, a background task or subagent still working, a reply owed to another agent. None → step 2. Any → stop here and ask with a ```text fleet:ask fence: the list, then `- 1. finish it first`, `- 2. leave it (record where it sits) and go on`. Go on only on his answer.
2. **Stop what runs.** For each background Bash, Monitor and subagent you started, let one that ends within a minute finish and stop the rest with TaskStop. Close each Rex tab you opened (`fleet tab run`, a dev server), and free each gate token or lease you hold.
3. **Tell who depends on it.** Write one handoff line: what landed (bookmark, change ids), what did not and where it sits (workspace, change id), and what is still open. Work worth picking up again gets a `tstack:handoff` file first, with its path in the line. Send it with `fleet msg ask work-graph "<name> is ending: <line>. Tell whoever waits on this work."`. Send the same line with `fleet msg ask <agent>` to each agent you know waits on you, and answer each open thread of yours with it.
4. **Clean up.** Prune your landed workspaces ([Workspace prune](../../../local/tuca-mode/workspace-prune.md)), abandon the empty changes you made, and delete your scratch files. Unlanded work stays where step 3 said it is.
5. **Close the tab.** Write the final reply first: what stopped, who was told, and what was left and where. Then make the last tool call `rex window close -s "$REX_SESSION" "$(rex whoami --json | jq -r .window_id)"`. It ends this process, so nothing after it runs. Outside Rex (`REX_SESSION` unset), say the session is ready to close.
