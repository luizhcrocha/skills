---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question, lay out its choices with what each leads to, and give your recommended answer with its reason: the evidence behind it, and what it costs or rules out. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>, because <the reason and its evidence>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>, because <the reason and its evidence>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## On a fleet dashboard

When this session runs a coordinator's or a manager's dashboard, the rounds go on its page, where each question has its own answer and none is lost among chat messages. The dashboard's state CLI is the plugin's `${CLAUDE_PLUGIN_ROOT}/fleet/bin/fleet state` (`fleet state` below, run by that path):

- A round: `fleet state <dir> grill <id> --title "<what is being decided>" --ask "<title> | <question, with its choices and what each leads to> | <recommended answer> | <why: the reason, the evidence (a file, a figure, a finding), and what it costs or rules out>"`, one `--ask` per frontier question. The page shows the reason under the recommendation; a question without one reads as a guess. A reason missed in an earlier round: `--reason "Q3: why"`. Follow-ups: `--of Q2` on the command that asks them. Then tell the user the page (`<dashboard url>#decision/<id>`), in one line.
- Answers arrive in the chat watch as `[<id>]` lines of `Q3: ...`. Record each: `--answer "Q3: <their words>"`. A question that stopped mattering: `--drop "Q4: why"`; one you would now ask differently: `--revise "Q3: <title> | <question> | <recommendation> | <why>"`.
- The frontier is empty and the user has confirmed: `--done "<what was agreed>"`.
