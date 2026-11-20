---
description: "Explain a piece of work plainly (what, how, why) in one conversational account. Use for \"explain this change\", \"walk me through this PR\", or \"help me understand X\"."
disable-model-invocation: ~
---

- Orient from the diff: `jj show <change>`, `gh pr diff <n>`. When one reason is enough, read the change description, the PR body or `tstack:recall` instead of running `why`'s full sweep.
