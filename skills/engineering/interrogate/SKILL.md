---
name: interrogate
description: "Adversarial review: three fresh Opus reviewers, each on its own lens (correctness and security, maintainability, intent), try to break a change, and the lead sorts their findings into a verdict. Use for \"interrogate\", \"adversarial review\", \"tear this apart\", \"stress test this\", \"find blind spots\", a contested design, or a thermo-nuclear / harsh maintainability review."
---

# Interrogate

Spawn three reviewers to adversarially review a change. Each gets the same prompt, rubric and code, and one of three lenses. Claude Code has one model family, so the diversity comes from the lenses: each reviewer looks for a different kind of failure. Adapted from poteto's pstack (MIT); the maintainability lens folds in cursor-team-kit's thermo-nuclear code quality review (Cursor, MIT).

The deliverable is a synthesized verdict. Never apply changes: the user decides what to act on.

`tstack:review` is the routine two-axis check against standards and spec; this is the pass that tries to break the change.

## Step 1, Determine scope

- The user points at files, a diff or a revision → that.
- Otherwise the stack since the landing bookmark's remote, `<bookmark>@origin`, the bookmark named by the repo's docs (`master` in most repos, `nix` in dotfiles; docs silent → `trunk()`). The diff is `jj diff --from <fixed> --to @` when the fixed point is an ancestor of `@`, else `jj diff -r '<fixed>..@'`; the commits `jj log -r '<fixed>..@'`.
- In a repo without jj: `git diff <fixed>...HEAD`, `origin/<default branch>` by default.

An empty diff stops here. Note the context files a reviewer needs to understand the code (callers, types, the module the change sits in) as paths.

## Step 2, State the intent

Before spawning reviewers, state the intent explicitly. Derive it from the user's message, the change descriptions, the originating issue or spec (as `tstack:review` step 2 finds it), a PR description if one exists, and the code itself.

Write one clear paragraph, and list the spec sources you found as paths or links. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn reviewers

All three in one message: `general-purpose` agents on Opus (`model: "opus"`), in the background (in the foreground in a `claude -p` run, which can exit before a background reviewer returns). Each writes nothing in the repo.

| Reviewer | Lens |
|----------|------|
| A | [references/lenses/correctness.md](references/lenses/correctness.md): correctness and security |
| B | [references/lenses/maintainability.md](references/lenses/maintainability.md): maintainability, code judo, spaghetti, abstraction quality |
| C | [references/lenses/intent.md](references/lenses/intent.md): does the change do what its intent says, all of it and only it |

Fill [references/reviewer-prompt.md](references/reviewer-prompt.md) for each with:

1. The stated intent, plus the spec sources for reviewer C.
2. The code: the diff command and the context file paths; paste the diff too when it is under about 500 lines.
3. The review rubric from [references/rubric.md](references/rubric.md).
4. `{LENS_CONTENTS}`: that reviewer's lens file.

The prompt, rubric and code are the same for all three; only the lens differs.

A small diff you don't trust, whose safety rests on one fact (a shared primitive, a wire format, a teardown path, a cache), also gets `tstack:blast-radius`, run by you while the reviewers work.

## Step 4, Synthesize

As results come back, build a unified picture:

1. **Parse all findings** from the reviewers.
2. **Identify consensus.** Findings raised by 2+ reviewers independently, from different lenses, are highest signal.
3. **Identify lone findings.** Still worth reading, but weight them by how concrete the evidence is.
4. **Deduplicate.** Reviewers may describe the same issue differently. Merge these and note which reviewers raised it.
5. **Note disagreements.** If one reviewer flags something and another explicitly says the opposite, that's useful context for the verdict.

## Step 5, Lead judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. The verdict is a decisive single role: when this session is not on Fable, hand this step to one `general-purpose` agent on the default Fable (`model: "fable"`) with the intent, the diff command, the three reviews and the synthesis from step 4, and present its verdict after checking the findings it leans on. If Fable is unavailable (usage or session limit, credits, a model error), rerun that agent on Opus (`model: "opus"`) and say so in the reply. Read [references/lead-judgment.md](references/lead-judgment.md) for the full framework; where it says "model", read "reviewer". Check the findings you lean on against the code: trace the call site, run the repro.

Categorize every finding using these buckets:

- **Act on.** Real issues affecting correctness, security, or maintainability given the actual goals. These would block a real PR.
- **Consider.** Legitimate points, but you're not sure they outweigh the cost of addressing them right now. Worth the user's attention.
- **Noted.** Technically valid but not actionable. Context-dependent, premature optimization, or low-impact given the current stage.
- **Dismissed.** Wrong, nitpicky, or missing context. Brief explanation why.

For each finding, include which reviewer(s) raised it, the category, and a one-line rationale for the categorization.

## Output format

Write the verdict through `tstack:unslop`, in this structure:

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer A (correctness and security): Opus, [N findings]
- Reviewer B (maintainability): Opus, [N findings]
- Reviewer C (intent): Opus, [N findings]

### Act On
[Findings that should be addressed. For each: description, which reviewers raised it, why it matters.]

### Consider
[Findings worth thinking about. For each: description, which reviewers raised it, tradeoff involved.]

### Noted
[Valid but low-priority. Brief list.]

### Dismissed
[Rejected findings with brief rationale.]

### Agreement Map
[Where did reviewers agree across lenses, where did they diverge, and what does the pattern tell us?]

The blast-radius safety fact, when you ran it, goes after the Agreement Map with the rung it reached.
