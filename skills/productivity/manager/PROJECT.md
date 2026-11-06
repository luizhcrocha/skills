# The project and its coordinators

Read from the manager's [SKILL.md](SKILL.md) when the user starts you for a project that does not exist yet, or asks for a coordinator on part of the project's work.

You manage one project, a row of the cloud's registry with a page at `<cloud>/p/<id>`. When the user starts you for a project that does not exist yet, make it in the repo the work starts in:

1. `fleet project new "<title>"` makes it and prints its id (the title's, or the one `--id <id>` gives) and its page. An id already taken is refused; when the user meant that project, go on to step 2 with its id.
2. `fleet project manage <id>` makes this repo's team the project's manager team, waits until this machine's host service has moved its ledger folder to the cloud, and prints `Your ledger is <dir>.` That folder is `<dir>` in Setup.

A project that exists already starts at step 2. `fleet project list` names this machine's projects and their teams. A standing manager whose agent file names `fleet.project` is made the manager by `fleet team start`, and its opening names the ledger.

## Add a coordinator to the project

When the user asks for a coordinator on part of the project's work, start one as a standing agent of the project. Run this in the repo the coordinator works in, not in yours, as a Bash call with `timeout: 300000`: the join waits up to 30 s and the start up to 2 min, past the Bash tool's default 120 s.

```
cd <repo>; fleet team add <name> --project <id> --mission "<what it is to do>"
```

`<name>` is its team's id: lower-case letters, digits and `-`, starting with a letter, at most 32 characters. A name is one per machine, as a team's ledger folder is found by name alone: pick one no other team here uses (`fleet fleets list` lists them). `add` refuses a name whose ledger is another project's or repo's team, naming that team. The mission is one line of plain text, at most 2000 characters. The command writes `.fleet/agents/<name>.json` in that repo, joins the project as team `<name>`, and opens a new tab named `<name>` in that repo's rex session, with a shell tab `<name> cmd` beside it in that repo. The coordinator opens with `/tstack:tuca-mode <mission>` and its ledger; a manager with `/tstack:tuca-mode /tstack:manager <mission>` and its ledger, which tuca-mode reads as this skill, the mission its first task. The user sees the new tab in the Rex app and the new team in the project's room and on its page. `--role manager` adds a manager instead. `--no-start` only writes the file, for `fleet team start <name>` later.

The agent file lands in that repo's working copy: jj snapshots it into the change open there, and that repo's coordinator commits it or ignores it, as the repo prefers.

- **Untrusted repo.** The refusal that names `--trust` gets a permission card, never an action card (Luiz, 10-31, #450). Run the same `add` line with `--trust` as one Bash call: one line, no pipe, no wrapper, the fleet CLI by its absolute path (`${CLAUDE_PLUGIN_ROOT}` expanded), so `cd <repo>; <plugin root>/fleet/bin/fleet team add <name> --project <id> --mission "<mission>" --trust`, with no `|`, `*`, `\` or `$` in the mission. The hook opens no card for a call with a character outside plain ASCII (an accent: write "nao", not "não") or a word such as token, secret or password, so keep the mission to plain words. `--trust` writes Claude Code's own settings, so auto mode refuses the call as self-modification, and the plugin's hook opens a permission card for that exact call. Check its `decisions` row ([PROGRAMS.md](../coordinator/PROGRAMS.md)), then tell the user the card is on the page. Once the allow arrives in your chat watch, run the same call again, unchanged. The trust stays the user's ("Whose is what"): the card is how they give it.
- **Killed midway.** A run the tool killed leaves the file. The same `add` again sees the file as `add` writes it and starts it; a file written by hand or for another mission is refused.
- **No tab.** A start that gave the agent no tab removes the file, and the `.fleet` folders it made; a file that was there before this `add` stays. Fix what the refusal names, then run `add` again.
- **A startup prompt.** An agent waiting on one keeps its tab and its file. The user answers it in the Rex app (`fleet team attach`), then `fleet team start <name>` sends the opening.
- **Auto mode refuses the launch.** That is a permission card for the user, never a retry. It reaches you as a `[hub]` line and a refusal draft: ask the user with the command it gives, as "Whose is what" says.
