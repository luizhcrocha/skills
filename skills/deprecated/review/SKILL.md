---
name: review
description: "Two-axis review (Standards, Spec) of a diff, or a Deep review keeping only proven findings. Use for a branch, stack, PR, WIP, \"review since X\", \"tear this apart\", \"stress test this\", a contested design."
---

Review the diff between `@` and a fixed point on two axes:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue or spec?

Each axis runs in its own **parallel sub-agent**, started with a fresh context window, so neither pollutes the other. The axes stay separate to the end: code can follow every standard and build the wrong thing, or build the right thing against the conventions, and one merged report lets one axis mask the other. A Deep review (step 7) takes their place when the change is contested or risky.

## Process

### 1. Pin the fixed point

The fixed point is whatever the user named (a bookmark, `master@origin`, a change id, a commit, a tag). Unnamed, it is the landing bookmark's remote, `<bookmark>@origin`, with the bookmark the repo's docs name (`CLAUDE.md`, `AGENTS.md`, `README.md`, the justfile): `master` in most repos. When the docs are silent, it is `trunk()`.

Capture the diff command once:

- `jj diff --from <fixed> --to @` when the fixed point is an ancestor of `@` (`jj log -r '<fixed> & ::@'` prints it).
- `jj diff -r '<fixed>..@'` otherwise (the stack is behind the fetched bookmark): it diffs from the fork point, so upstream's newer commits stay out.

Note the commits before anyone reads the diff: `jj log -r '<fixed>..@' -T 'change_id.short() ++ "@" ++ commit_id.short() ++ "\n"'` prints each change with the commit this review reads, and the report carries the list as its `Read:` line. Taken at the end instead, it names a fix squashed in during the review as reviewed. `jj log -p -r '<fixed>..@'` shows the commits one revision at a time.

Confirm the fixed point resolves (`jj log -r '<fixed>' -n 1`) and the diff is non-empty, so a bad revision or an empty diff fails here, not inside two sub-agents.

Without jj: the fixed point defaults to `origin/<default branch>`, the diff is `git diff <fixed>...HEAD` (three-dot, against the merge-base), the commits `git log <fixed>..HEAD --oneline`, the check `git rev-parse <fixed>`.

### 2. Find the spec

The issue tracker comes from `docs/agents/issue-tracker.md`; when it is missing, tell the user to run `/setup-luizrocha-skills`. Look for the spec in this order:

1. Issue references in the change descriptions (`#123`, `Closes #45`, GitLab `!67`), fetched through that tracker's workflow.
2. A path the user passed.
3. A spec file under `docs/`, `specs/` or `.scratch/` matching the bookmark name or feature.
4. Ask the user. When there is none, skip the Spec sub-agent and say "no spec available" in the report.

### 3. Find the standards

List every file in the repo that documents how code should be written; `CODING_STANDARDS.md` and `CONTRIBUTING.md` always, when present. A root `REVIEW.md` goes to both sub-agents: it lists what failure looks like in this repo. Add, ranked below the repo's own standards:

- When the diff touches TypeScript, `lang-ts`'s relevant rules (Skill tool, "lang-ts").
- When the user asks for a stricter bar ("thermo-nuclear", "harsh maintainability review"), the maintainability lens, [references/maintainability.md](references/maintainability.md), ranked above the smell baseline.
- Always, the **smell baseline**, [SMELLS.md](SMELLS.md): Fowler's smells plus one of ours, each a Nit the repo's standards override.

### 4. Spawn both sub-agents in parallel

Both in one message, in the background: `general-purpose` agents in the Reviewer role ([models.md](../../../docs/models.md)). Each reads the code itself through the diff command, writes nothing, and gets the diff command, the commit list and these tags for every finding:

- **Important** breaks behaviour, data, money, permissions or the spec. It carries its proof (a breaking input, a failing test, or a trace with file and line) and `Caught by:` the cheapest check that would have caught it with no reader (`type`, `lint`, `test`, `property`, `model` or `none`), with the rule it breaks in one line. No proof: it is a question, not a finding.
- **Nit** is everything else: style, naming, smells, and risks that need a future change to matter. Report the count and one line each; no fix round starts for them.
- **Pre-existing** was there before this diff. It goes to follow-ups.

The **Standards** sub-agent also gets step 3's sources and the absolute path of SMELLS.md (it has no other access to the baseline), and this brief: "Report, per file or hunk where relevant, (a) every place the diff violates a documented standard, citing the standard (file and rule); (b) any baseline smell you spot, named, with the hunk quoted. Distinguish hard violations from judgement calls: documented-standard breaches can be hard violations; baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

The **Spec** sub-agent also gets the spec's path or fetched contents, and this brief: "Report (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. For each line of the repo's REVIEW.md the diff touches, say whether its check exists and covers this change. Under 400 words."

### 5. Aggregate

Present the reports under `## Standards` and `## Spec`, verbatim or lightly cleaned, never merged or reranked.

Then list the Important findings by `Caught by:`. The fix adds that check, red first. A finding that matches a memo gotcha, or that an earlier review of this repo already raised, is a candidate for its check: `tstack:lint-evolve` for `lint`; for `model`, the repo's formal specs, and suggest `/create-formal-verification-skill` to Luiz when none covers it, since he invokes it himself. A rule worth keeping becomes a line in the repo's REVIEW.md.

End with a one-line summary: Important and Nit counts per axis, and the worst issue within each axis, if any. Pick no single winner across axes. For a UI diff that adds or changes motion (transitions, keyframes, Motion, springs, gestures), also run `tstack:review-animations` and add its findings table and verdict after the summary. The report's last line is `Read: <change>@<commit>, ...`, step 1's list, unchanged.

In a fleet (`fleet` on PATH), record the review before the stack lands, as [LEDGER.md](LEDGER.md) says.

### 6. Bug hunt: the option for a diff over about 2,000 lines

Two readers over a diff that size skim it. Past about 2,000 changed lines (lockfiles and generated files left out), offer a bug hunt, instead of or after the two axes, stating the cost [BUG-HUNT.md](BUG-HUNT.md) gives; on a yes, or when the coordinator's Integrate rule calls for it, run it from that file.

### 7. Deep review: the pass that tries to break the change

For a contested design, a risky diff, or the areas the fleet coordinator's Review levels (INTEGRATE.md) name: three finders try to break the change, and a finding survives only when a run proves it. It replaces the two axes. Follow [DEEP.md](DEEP.md).
