---
name: review
description: "Review changes since a fixed point (default: the landing bookmark's remote) on two axes, Standards and Spec, in parallel, or as a Deep review that keeps only findings a run proves. Use to review a branch, stack, PR or WIP, \"review since X\", \"tear this apart\", \"stress test this\", a contested design."
---

Two-axis review of the diff between `@` and a fixed point:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-luizrocha-skills`.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a bookmark, `master@origin`, a change id, a commit, a tag). If they named none, it is the landing bookmark's remote, `<bookmark>@origin`, with the bookmark named by the repo's own docs (`CLAUDE.md`, `AGENTS.md`, `README.md`, the justfile): `master` in most repos, `nix` in dotfiles. Docs silent → `trunk()`.

Capture the diff command once:

- `jj diff --from <fixed> --to @` when the fixed point is an ancestor of `@` (`jj log -r '<fixed> & ::@'` prints it).
- `jj diff -r '<fixed>..@'` otherwise (the stack is behind the fetched bookmark): it diffs from the fork point, so upstream's newer commits stay out.

Note the commits now, before anyone reads the diff: `jj log -r '<fixed>..@' -T 'change_id.short() ++ "@" ++ commit_id.short() ++ "\n"'` prints each change with the commit this review reads, and the report carries that list as its `Read:` line. Taken at the end instead, it names a fix squashed in during the review as reviewed. `jj log -p -r '<fixed>..@'` shows the commits one revision at a time.

Before going further, confirm the fixed point resolves (`jj log -r '<fixed>' -n 1`) and the diff is non-empty. A bad revision or empty diff should fail here, not inside two parallel sub-agents.

In a repo without jj: the fixed point defaults to `origin/<default branch>`, the diff is `git diff <fixed>...HEAD` (three-dot, against the merge-base), the commits `git log <fixed>..HEAD --oneline`, the check `git rev-parse <fixed>`.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the change descriptions (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the bookmark name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`. A `REVIEW.md` at the repo's root goes to both sub-agents: it lists what failure looks like in this repo.

If the diff touches TypeScript, also call the Skill tool with "lang-ts" and pass its relevant rules to the Standards sub-agent as a standards source, ranked below any repo-documented standard.

When the user asks for a stricter bar ("thermo-nuclear", "harsh maintainability review"), add the maintainability lens ([references/maintainability.md](references/maintainability.md)) as a standards source, ranked below the repo's standards and above the smell baseline.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation, and always a Nit. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Both in one message: `general-purpose` agents playing the Reviewer role ([models.md](../../../docs/models.md)), in the background. Each reads the code itself through the diff command and writes nothing.

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

Both sub-agents tag each finding Important, Nit or Pre-existing:

- **Important** breaks behaviour, data, money, permissions or the spec. It carries its proof (a breaking input, a failing test, or a trace with file and line) and `Caught by:` the cheapest check that would have caught it with no reader (`type`, `lint`, `test`, `property`, `model` or `none`), with the rule it breaks in one line. No proof: it is a question, not a finding.
- **Nit** is everything else, style, naming, smells and risks that need a future change to matter. Report the count and a list of one line each, and no fix round starts for them.
- **Pre-existing** was there before this diff. It goes to follow-ups.

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. For each line of the repo's REVIEW.md the diff touches, say whether its check exists and covers this change. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

After the reports, list the Important findings by `Caught by:`. The fix adds that check, red first. A finding that matches a memo gotcha, or that an earlier review of this repo already raised, is a candidate for its check: `tstack:lint-evolve` for `lint`; for `model`, the repo's formal specs, and suggest `/create-formal-verification-skill` to Luiz when none covers it, since he invokes it himself. A rule worth keeping becomes a line in the repo's REVIEW.md.

End with a one-line summary: Important and Nit counts per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

The report's last line is `Read: <change>@<commit>, ...`, the list step 1 noted, unchanged.

In a fleet with `fleet` on PATH, record the review in the ledger before the stack lands, so `land-check` finds it: `fleet state <dashboard-dir> event --kind reviewed --findings <N> --proven <P> --changes "<change>@<commit>,..." "<what was reviewed, and with what>"`, the `--changes` being the report's `Read:` line (step 1), N the findings of both axes (0 when there were none), and P the Important ones that carry a proof. A bare change id is refused. `land-check` passes a change only while `jj interdiff` from that commit to its current one is empty: a fix squashed in after the review needs a re-check of that interdiff, recorded at the commit the re-check read.

### 6. Bug hunt: the option for a diff over about 2,000 lines

Two readers over a diff that size skim it. When the diff has more than about 2,000 changed lines (lockfiles and generated files left out), offer a bug hunt instead of, or after, the two axes; it hunts defects, not standards:

1. **Slices.** Cut the diff into slices of about 300 lines along module seams (one module and its tests per slice), never mid-function.
2. **Readers that over-report.** Two `general-purpose` Reviewers per slice, in parallel, each told to list every place the code could be wrong (a claim: file and line, what breaks, the input that breaks it), with no filtering: a false claim costs one look, a missed one ships.
3. **A second look.** One fresh Reviewer per slice reads both lists against the code and keeps the claims it cannot rule out, each with why.
4. **Claim-only provers.** One Verifier ([models.md](../../../docs/models.md)) per kept claim, given the claim alone (not the reader's reasoning), writes a failing test or a repro that shows it. A claim no prover can show is reported as unproven, not as a finding.

Its cost, as an estimate: for 2,000 lines, about 7 slices, 14 readers and 7 second looks at about 60k tokens each, plus one prover per kept claim at about 80k, so about 1.5 million tokens, five to ten times the two axes. Say that cost when you offer it, and run it only on a yes, or when the coordinator's Integrate rule calls for it. Report the proven findings, then the unproven claims, and record it as a `reviewed` event with the proven count.

### 7. Deep review: the pass that tries to break the change

For a contested design, a risky diff, or the areas the fleet plugin's coordinator names in its Review levels (INTEGRATE.md). It replaces the two axes. Adapted from pstack's interrogate (poteto, MIT): a finding survives only when a run proves it.

1. **State the intent.** One paragraph from the user's message, the change descriptions and the spec (step 2). Unsure: ask before spawning.
2. **Three finders in parallel.** `general-purpose` Reviewers, one per angle: security; concurrency and state; spec and tests. Each gets the intent, the diff command, the repo's REVIEW.md and its own jj workspace at the stack's head, and this brief: "Break this change. Prove each finding with a run against the real code: a failing test in the repo's own test tools, or the output of the repo's own command. Report the title, the exact command, the output it printed, the output the intent requires, and `Caught by:` the cheapest check that would have caught it with no reader (`type`, `lint`, `test`, `property`, `model` or `none`). Leave out style, naming, structure and risks that need a future change to matter. A claim you could not run goes under Unproven with why. No findings is a valid result."
3. **One verifier.** A fresh Verifier ([models.md](../../../docs/models.md)) reruns each command in the finder's workspace. A finding stays when the output shows the failure and the failure breaks the intent. Merge findings that share a root cause.
4. **Report.** The intent; the verified findings, which are Important, each with its command, output, how it breaks the intent and the finders that found it; Unproven, each with its trace (file and line) when it has one, so a real risk no one could run is not lost; for each finder, the count dropped and why; the `Read:` line. Apply nothing. Outside a fleet the user decides; in a fleet the coordinator sends the Important findings to a FIX round and rules on each Unproven claim, as a FIX, a follow-up or a decision for Luiz. A verdict line ends the report: LAND, or FIX when an Important finding stands.

No standalone attack or forging scripts: a safety classifier refused them on 2026-10-16, and a refused act is never routed around. A proof is a test in the repo's own tools. Delete the finders' workspaces after the report, keeping any test the fix adopts. Record it as in step 5, with the verified findings and the Unproven claims in `--findings`, and only the verified ones in `--proven`.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

For a UI diff that adds or changes motion (transitions, keyframes, Motion, springs, gestures), also run `tstack:review-animations` on it and add its findings table and verdict after the summary.
