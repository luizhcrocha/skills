---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question, lay out its choices with what each means for the user, and give your recommended answer with its reason: the trade-off first, in plain words, then the evidence behind it. Then wait for the user's answers before the next round.

Format a round like so, each question one plain question with two to four lettered options, and the recommendation by its letter with the trade-off in one plain sentence (sources after it):

```
❓ **Q1** - **<a plain title>**: <one plain question that names the thing>

- **a)** <a few words>: <what that means for you>
- **b)** <a few words>: <what that means for you>

➡️ **a**, because <the trade-off in one plain sentence>. <sources: files, lines, ADRs, if any>

---

❓ **Q2** - **<a plain title>**: <one plain question>

- **a)** ...
- **b)** ...

➡️ **b**, because <the trade-off in one plain sentence>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent playing the Researcher role ([MODELS.md](../coordinator/MODELS.md)) to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## On a fleet dashboard

When this session runs a coordinator's or a manager's dashboard, the rounds go on its page, where each question has its own answer and none is lost among chat messages. The dashboard's state CLI is the plugin's `${CLAUDE_PLUGIN_ROOT}/fleet/bin/fleet state` (`fleet state` below, run by that path):

- A round: `fleet state <dir> grill <id> --title "<what is being decided, in plain words>" --body <context.html> --ask "<title> | <the question> | <option id> | <why, one plain sentence>" --option "Q1 a: <a few words> | <what that means for the user>" --option "Q1 b: ..."`, one `--ask` per frontier question and two to four `--option` for each (questions are numbered in the order asked: Q1, Q2, ... in the first round, on from the last in a later one). The page shows each question like a small decision: the options as cards, the recommended one marked, the reason as a callout. A question without a reason reads as a guess; one missed in an earlier round: `--reason "Q3: why"`. Follow-ups: `--of Q2` on the command that asks them. Then tell the user the page (`<dashboard url>#decision/<id>`), in one line.
- Write each question to be read cold on a phone (Luiz, on one written for engineers: "i was lost reading this question"):
  - the title a whole plain phrase, never a fragment;
  - one plain question that names the thing in plain words, never a table name as its subject, and never the options in its prose;
  - two to four options, each a few words and one line on what that means for the user;
  - the recommendation by the option's id, with one sentence that says the trade-off in plain words first; files and lines, ADR and decision numbers and internal terms after it or in the body (the page folds the sources);
  - no worker's id, every internal name glossed the first time, a case id with its name;
  - something the user decided or said named by its number, when, and what was chosen ("D18, 10-08: read-only until per-person login"), never "as you decided" alone: the page links the number;
  - the context the questions share, and any picture, in `--body`, shown once above the first question; for an architecture question, the what and the how of each option ([coordinator SKILL.md, Grillings and links](../coordinator/SKILL.md#grillings-and-links)).
- The grilling's own words change with `--title`, `--why` or `--body` on the open grilling, with `--log "what changed"`.
- Answers arrive in the chat watch as `[<id>]` lines of `Q3: ...`. Record each: `--answer "Q3: <their words>"`. A question that stopped mattering: `--drop "Q4: why"`; one you would now ask differently: `--revise "Q3: <title> | <question> | <option id> | <why>"` (its options stay unless given again with `--option`).
- A picture goes in the grilling's `--body` when a question has one of the show-me triggers ([coordinator SKILL.md, Decisions](../coordinator/SKILL.md#decisions)): parts that talk to each other (where data lives, a pipeline, an architecture choice) get a small inline SVG of the parts and arrows, what changes highlighted; three or more numbers to weigh get a table, one row per option; a change in behaviour gets a before/after table; content to judge gets real examples with images and captions; anything else stays plain words. The CLI warns when the words name such parts or carry three or more amounts and the body has no picture.
- A confirmation of what was agreed (a recap, amendments from the advisor) is one more question of the grilling, asked with `--ask` and answered on the page, never a chat message asking the user to say "confirm".
- Once every question is answered, record the grilling at once, before other work: `--done "<what was agreed>"`. Until it is recorded the page shows it as answered and waiting to be recorded, and `fleet state` says so at every command.
