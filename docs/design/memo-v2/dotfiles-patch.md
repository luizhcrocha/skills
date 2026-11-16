# The dotfiles change for memo v2

What changes in `luizhcrocha/dotfiles` (bookmark `nix`) for memo v2: step 7 of [migration.md](migration.md). This file describes the change. Nobody in the skills repo makes it. It lands as its own change in the dotfiles, by a session working there.

The paths and line numbers were read from `nix@origin` at `b34d53cce55f` on 2026-11-16.

The change has four parts:

| Part | Files |
| :-- | :-- |
| (a) The groups | New `config/tstack/groups.toml` |
| (b) The two config files in `~/.config/tstack/` | New `modules/dev/tstack-memo.nix` |
| (c) The memo step | `bin/entropic-update` |
| (d) memo-dream leaves | `modules/hosts/cr-sede-pc.nix`, `bin/memo-dream-night` (deleted) |

## (a) `config/tstack/groups.toml`

The file exactly as [design.md](design.md#groups) shows it:

```toml
# Groups of repositories that work together. A repository is named by its
# origin, owner/repo, the key memo already uses. Luiz defines the groups.

[groups.tooling]
about = "The tools every agent session runs on"
repos = ["luizhcrocha/skills", "luizhcrocha/fleet", "luizhcrocha/dotfiles"]

[groups.company]
about = "The company's products and automations"
repos = ["coelhorocha/custom-mcp-servers", "coelhorocha/durable-automations", "coelhorocha/chimr"]
```

## (b) `modules/dev/tstack-memo.nix`

Every `.nix` file under `modules/` is a flake-parts module (`flake.nix`, the dendritic layout), so a new file needs no import line. The module follows `modules/dev/fleet-clan-hosts.nix`: one home-manager attrset given to `homeManager.workstation` and `homeManager.mac`, the two profiles that run Claude Code (`modules/dev/claude.nix`). The runner and server profiles get nothing.

```nix
# memo's two config files in ~/.config/tstack/ (tstack's
# docs/design/memo-v2/design.md, "The scope and group definitions").
#   groups.toml  the groups of repositories, from config/tstack/groups.toml
#   memo.toml    this machine's name in the flake, and the remote whose `memo`
#                bookmark carries the machine, group and user notes
# Both are store files, never out-of-store links to the checkout: memo must not
# read the checkout, which another jj writer can move to a commit with an older
# groups.toml. A change to either reaches memo at the next switch.
_:
let
  memoFiles =
    { osConfig, ... }:
    {
      xdg.configFile."tstack/groups.toml".source = ../../config/tstack/groups.toml;
      xdg.configFile."tstack/memo.toml".text = ''
        machine = "${osConfig.clan.core.settings.machine.name}"
        home_remote = "git@github.com:luizhcrocha/dotfiles"
      '';
    };
in
{
  flake.modules.homeManager.workstation = memoFiles;
  flake.modules.homeManager.mac = memoFiles;
}
```

Three facts this relies on, each checked on 2026-11-16:

- `clan.core.settings.machine.name` is the flake's name for the machine on NixOS and on nix-darwin. `nix eval --raw .#darwinConfigurations.mac.config.clan.core.settings.machine.name` prints `mac`, and the same for `nixosConfigurations.cr-sede-pc` prints `cr-sede-pc`. The Mac's host name is `Luizs-MacBook-Pro` (`bin/lib/machine-lib.sh`), which is why the host name is not used. `modules/dev/gate.nix` already reads the option at the NixOS level.
- `home_remote` is the dotfiles' `origin` as `git remote -v` prints it.
- A path literal (`../../config/tstack/groups.toml`) is copied into the store, so the installed file does not move with the checkout. The other files in `xdg.configFile` that link the checkout use `mkOutOfStoreSymlink` on purpose (`modules/desktop/dotfiles.nix`); this one must not.

home-manager writes `xdg.configFile` into `xdg.configHome`, which is `~/.config` on both systems. The Mac has no `XDG_CONFIG_HOME` in its environment (`modules/shell/nushell.nix`), so memo must read `${XDG_CONFIG_HOME:-$HOME/.config}/tstack/` there.

## (c) The memo step in `bin/entropic-update`

The step goes right after the pull, as [design.md](design.md#what-the-dotfiles-hold) places it: after the `fi` that ends the pull block (line 147) and before the `flake.lock` section. It uses the script's own helpers: `section` (defined in the script), and `warn` and `info` from `bin/lib/init.sh`. The script runs under `set -euo pipefail`, so every command that may fail ends in `|| true` or `|| warn`. It finds memo as `bin/memo-dream-night` finds the plugin today: `memo` on the PATH inside a Claude session, else the tstack install that `installed_plugins.json` names, which is how Luiz's terminal finds it.

```diff
@@ bin/entropic-update, after the pull @@
   git pull --ff-only origin "$BRANCH"
   if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
     warn "the checkout has local changes; the rebuild below includes them (tracked files only)"
   fi
 fi
 
+# ── memo: the notes of every store on this machine ──────────────────────────
+# tstack's memo keeps its notes outside every checkout and carries each store
+# on a `memo` bookmark: a repository's own remote for its notes, this repo's
+# remote for the machine, group and user notes. A fetch and a push need the SSH
+# key, so only a run someone is at syncs them: a landing, and this update.
+# memo is on the PATH inside a Claude session; from a terminal it is in the
+# plugin folder that installed_plugins.json names (as bin/memo-dream-night
+# found the plugin). A machine without tstack yet skips the step. Offline or
+# unapproved, `memo sync` says so and exits 0; the notes wait for the next run.
+section "Syncing memo's notes"
+memo_bin="$(command -v memo || true)"
+if [[ -z "$memo_bin" ]]; then
+  plugin_root="$(jq -r '.plugins["tstack@tstack"][0].installPath // empty' \
+    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json" 2>/dev/null || true)"
+  [[ -n "$plugin_root" && -x "$plugin_root/bin/memo" ]] && memo_bin="$plugin_root/bin/memo"
+fi
+if [[ -n "$memo_bin" ]]; then
+  "$memo_bin" sync --all || warn "memo sync failed: the notes stay on this machine until the next update"
+else
+  info "no memo on this machine yet: the memo step is skipped"
+fi
+
 # ── flake.lock: bump, and later commit ───────────────────────────────────────
```

The usage text gains one paragraph, after the one on the binary cache:

```diff
@@ usage() @@
 post-build hook uploads what this run built as it goes; the push adds the
 rest. Skipped on the Mac.
+
+After the pull it runs tstack's \`memo sync --all\`, which fetches and pushes
+the \`memo\` bookmark of every repository that has notes on this machine, and
+this repo's, which carries the machine, group and user notes. A machine
+without tstack skips it.
 EOF
```

The update commits nothing for memo, and `commit_paths` is unchanged.

## (d) memo-dream leaves

`bin/memo-dream-night` is deleted. The service and the timer leave `modules/hosts/cr-sede-pc.nix`. With them gone, the home-manager function no longer reads `config`, so it becomes a plain attrset:

```diff
@@ modules/hosts/cr-sede-pc.nix @@
-    home-manager.users.${config.entropic.user} =
-      { config, ... }:
-      {
-        home.sessionVariables = {
-          FLEET_TESTBOX_MINUTES = testboxMinutes;
-        };
-
-        # memo-dream reads the day's Claude sessions and writes memory notes.
-        # It runs here only, where most sessions and the fleets run (Luiz,
-        # 2026-11-13). The timer only wakes it: `night` itself waits for 45
-        # quiet minutes with no session writing, dreams once a night, and goes
-        # anyway at 06:30 when fleets keep sessions busy all night.
-        systemd.user.services.memo-dream = {
-          Unit.Description = "memo-dream: turn the day's Claude sessions into memory notes";
-          Service = {
-            Type = "oneshot";
-            Environment = [ "PATH=${config.entropic.session.unitPath}" ];
-            ExecStart = "${config.entropic.repo}/bin/memo-dream-night";
-            Nice = 10;
-          };
-        };
-        systemd.user.timers.memo-dream = {
-          Unit.Description = "Wake memo-dream every 15 minutes between 01:00 and 06:45";
-          Timer = {
-            OnCalendar = "*-*-* 01..06:00/15";
-            Persistent = false;
-          };
-          Install.WantedBy = [ "timers.target" ];
-        };
-      };
+    home-manager.users.${config.entropic.user}.home.sessionVariables = {
+      FLEET_TESTBOX_MINUTES = testboxMinutes;
+    };
     systemd.user.services.fleet-host.environment.FLEET_TESTBOX_MINUTES = testboxMinutes;
```

The outer `{ config, ... }:` of the file stays: `config.flake.modules` and `config.entropic.user` still use it. The switch stops and removes the two user units. `~/.local/state/tstack/memo-dream/` stays on disk; it holds no note that memo reads, and deleting it is not part of this change.

## (e) Order and checks

### Order

1. **The skills change lands first**: the v2 code with the land playbook's `memo sync`, and migration steps 1 to 4 run on the admin machine (cr-sede-pc). Step 4 must be done before any sync of the dotfiles' bookmark. It moves files between local stores, and a sync is a union by file name: a global note pushed under `user/` before step 4 moves it would come back into the user store at the next sync.
2. **The plugin updates** on each machine (`ai-tools-update`, daily, or `claude plugin update`), so `bin/memo` is v2 before its `entropic-update` runs. Under v1, `memo sync` is an unknown command: the step prints its usage error and one `WARN:` line, and nothing else happens.
3. **This dotfiles change lands**, the same day as step 1. In between, the memo-dream timer on cr-sede-pc finds no `scripts/memo-dream` in the v2 plugin, and `memo-dream-night` exits 1 every 15 minutes from 01:00 to 06:45, a failed unit with no other effect.
4. **`entropic-update` on cr-sede-pc** first. It installs the two files and pushes the machine, group and user stores to the dotfiles' `memo` bookmark, which the first push creates.
5. **`entropic-update` on each other machine**, which fetches them.

The dotfiles' own `.tstack/memo/` leaves the working tree in a separate change (migration step 6), not in this one.

### Checks

| Part | Before the switch, in the dotfiles checkout | After the switch, on the machine |
| :-- | :-- | :-- |
| (a) | `python3 -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb")))' config/tstack/groups.toml` prints the two groups | `readlink -f ~/.config/tstack/groups.toml` is a `/nix/store/` path, and `diff ~/.config/tstack/groups.toml config/tstack/groups.toml` prints nothing |
| (b) | `nix eval --raw '.#nixosConfigurations.cr-sede-pc.config.home-manager.users.luizrocha.xdg.configFile."tstack/memo.toml".text'` prints `machine = "cr-sede-pc"`, and the same under `darwinConfigurations.mac` prints `machine = "mac"` | `cat ~/.config/tstack/memo.toml`; `memo doctor` lists `machine:<name>` with its store |
| (c) | `bash -n bin/entropic-update`, `shellcheck bin/entropic-update`, `just test` | `entropic-update --no-cache-push` shows the "Syncing memo's notes" section; then `git ls-remote origin memo` names a commit, and `memo doctor` reports no note waiting for a sync |
| (d) | `nix eval '.#nixosConfigurations.cr-sede-pc.config.home-manager.users.luizrocha.systemd.user.timers' --apply builtins.attrNames` has no `memo-dream`; `rg memo-dream --glob '!.tstack'` finds nothing | `systemctl --user list-timers --all` lists no `memo-dream` |

One more check runs on a machine without tstack: the step prints "no memo on this machine yet" and the update goes on.

## Left for later

`config/jj/bin/clean` has a `notes` group that lands memo notes left on orphaned commits (`.tstack/memo`). Once every repository's store has left its working tree (migration step 6), no commit holds a note, and the group finds nothing. Removing it is a separate dotfiles change after step 6.
