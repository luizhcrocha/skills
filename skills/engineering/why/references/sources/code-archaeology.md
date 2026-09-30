# Code Archaeology (jj + `gh` + in-repo)

## What this source contains

- Change history: descriptions, dates, authors, diffs (jj, colocated with git)
- PR descriptions, review comments, and discussion threads (via `gh`)
- Inline code comments, TODOs, FIXMEs, deprecation notes
- Tests. Names and assertions often encode the edge cases that motivated a change
- Related files modified in the same change (co-change signal)
- CHANGELOG entries, release notes in the repo
- Issue/ticket IDs mentioned in change descriptions and PR bodies

The most trustworthy source, tied directly to the code. Everything that went through the repo should be here. The repo's docs, ADRs and `CONTEXT.md` belong to the long-form documents investigator; you still read their history here when a doc changed alongside the code.

## How to search it

Every repo of Luiz's is a jj repo colocated with git: a detached git HEAD is normal. Read history with jj:

```
# Changes touching the file, newest first
jj log -r '::@' -- <file>

# Compact: change id, commit id, date, subject
jj log -r '::@' --no-graph -T 'change_id.short() ++ " " ++ commit_id.short() ++ " " ++ author.timestamp().format("%Y-%m-%d") ++ " " ++ description.first_line() ++ "\n"' -- <file>

# Who last touched each line (no range flag: slice the output)
jj file annotate <file> | sed -n '<start>,<end>p'

# Pickaxe: changes that added or removed a line containing this text
jj log -r 'diff_lines(substring:"<exact text>", "<file>")'
jj log -r 'diff_lines_added(substring:"<exact text>")'

# Changes whose description names it
jj log -r 'description(substring-i:"<word>")'

# One change in full: description and diff
jj show <change>

# The file's diff across a range of changes
jj diff --from <old> --to <new> -- <file>
```

jj does not follow renames. When the file was moved, find the move with `jj log -r 'diff_lines(substring:"<a distinctive line>")'` and continue under the old path, or use git on the colocated repo: `git log --follow --oneline -- <file>`. In a repo without jj, git throughout: `git log --follow -p`, `git log -S`/`-G`, `git blame -L`, `git show`.

For each substantive change, pull the PR context. Run `gh` from the repo's main workspace (a secondary jj workspace has no `.git`):

```
# The PR that carried a commit
gh pr list --search <commit sha> --state all

# Full PR context: body, review comments, linked issues
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews,files
```

The `reviews` and `comments` fields are where the real signal is. Many of Luiz's repos land straight on trunk without PRs; then the change description is the record.

Look for in-code evidence:

```
# TODOs and FIXMEs near the target
rg -n -C2 '(TODO|FIXME|HACK|XXX|NOTE)' <target_file>

# Related tests. Names often encode the "why"
rg -l '<symbol>' --glob '*test*'
```

## What good evidence looks like here

- A change description or PR that explains the problem being solved, not just the change ("This fixes the pagination bug that caused X")
- A long review thread where alternatives were debated
- An inline comment near the target line that explains a non-obvious constraint
- A test named `test_handles_edge_case_when_X` that reveals an edge case motivating the code
- A description that references a ticket or incident ID
- A CHANGELOG entry that summarizes the user-visible rationale

## Common pitfalls

- **Squash-merge flatlands.** If the repo squashes PRs, individual commits in the branch history are lost. Fall back to PR body and comments.
- **Rewritten history.** jj rewrites changes freely before they land; a change id is stable, a commit id is not. Cite both, and prefer what is on trunk.
- **Misleading descriptions.** "Small refactor" sometimes hides an intentional behavior change. Look at the diff, not the message.
- **Cargo-culted patterns.** The author may have copied a pattern without understanding why. Check if the pattern originated earlier in the codebase and investigate *that* change.
- **Bot commits and auto-merges.** Dependabot, Renovate, and automated backports usually don't carry motivation. Skip them when trying to find intent.
- **Treating code as evidence of intent.** The code itself isn't evidence for why it exists. Evidence comes from descriptions, PRs, comments, tests, docs. Don't cite "the function is named X" as evidence of intent.

## What to return

Every change/PR/comment that bears on the question, with:
- The exact text (quoted)
- The change id and commit id / PR number / file:line
- Author and date
- Whether it's direct (explicitly addresses the question) or circumstantial
