---
name: lang-nix
description: "Nix rules and taste for tstack: flakes, NixOS and home-manager modules, devenv, the latest-release rule, nixfmt and flake checks, VM tests. Use when writing, reviewing or testing Nix code, a flake, or a devenv."
paths: ["**/*.nix", "**/flake.lock", "**/devenv.yaml"]
---

# lang-nix

## Version target

Nix 2.35.2 (Determinate Nix 3.22.5 on Luiz's machines), NixOS 26.05 with nixos-unstable at 26.11-dev, home-manager `release-26.05`, devenv 2.4.0, nixfmt 1.5.0, deadnix 1.3.2, nix-unit 2.35.1, checked 2026-09-30 ([sources](references/sources.md)).

A project's pinned inputs win. Read `flake.nix` and `flake.lock` (or `devenv.yaml` and `devenv.lock`) first: which nixpkgs branch, what follows what, and which inputs are pinned by tag. In the dotfiles, nixpkgs, disko, nix-darwin and flake-parts follow `clan-core`, so they move only with clan.

## Non-negotiables

- **Latest release, not stale stable** (Luiz's rule). A CLI added or touched in a flake, a NixOS module or a devenv is the upstream latest release. Check the registry (GitHub releases, PyPI, npm); if the pinned nixpkgs carries an older one, take it from an unstable input or from the upstream release binary, say which version went in and that it is the latest. Never hand over the older one with a note on upgrading.
- **Every unstable or upstream pick carries its reason** in a comment beside it, ending with when it can go ("drop once 26.05 catches up").
- **Nothing is applied to a real machine by an agent.** No `nixos-rebuild switch`, `entropic-switch` without `--dry-run`/`--build-only`, `clan machines update`, `darwin-rebuild switch`. Moving the dotfiles `nix` bookmark is a fleet deploy (every machine pulls `nix@origin`) and happens only when Luiz asks for it. Verify with the gates below and hand Luiz the switch command.
- `nix fmt` is clean and `nix flake check --no-build` evaluates before a change is done (dotfiles: `just check` runs both).
- `flake.lock` changes only through `nix flake update <input>` (or `devenv update`), in its own change or stated in the description; never edited by hand, never bumped wholesale as a side effect.
- Secrets never enter the store or a `.nix` file: clan vars in the dotfiles, `secretspec` with 1Password in devenv projects.

## Taste

- **One file, one concern.** The dotfiles are a dendritic flake-parts tree: every `.nix` under `modules/` is imported automatically (paths with a `/_` segment are skipped), and each file contributes to aggregates like `flake.modules.nixos.workstation` or `flake.modules.homeManager.base`. Adding a module is adding a file; nothing lists it. Hosts live in `modules/hosts/<name>.nix`, machine hardware in `machines/<host>/`.
- **Options at the boundary.** Repo-wide facts are options (`entropic.user`, `entropic.repo`) read through `config`, not literals scattered across modules. A module that others configure declares `options` with types; `lib.mkIf`, `lib.mkDefault` and `lib.mkForce` say priority explicitly.
- **Live config through out-of-store links.** Config an app reads (and especially one it rewrites) is linked into the checkout with `config.lib.file.mkOutOfStoreSymlink "${config.entropic.repo}/config/<app>"` (the `link` helper in `modules/desktop/dotfiles.nix`), so edits under `config/` and `bin/` are live without a rebuild. Never `home.file` for a file the app writes back.
- **Packages.** `pkgs/default.nix` is a thin overlay index (`inputs: final: prev: { x = final.callPackage ./x.nix { }; }`), one file per package. Private sources come in as arguments (`callPackage ./hum.nix { humSrc = inputs.hum; }`). A release binary is `stdenvNoCC.mkDerivation` over `fetchurl` with the vendor-published sha256 per platform (`pkgs/uv.nix` is the pattern), with a comment saying where the next version and hashes come from.
- **Unstable, narrowly.** A second input (`nixpkgs-unstable`, or a purpose-named one like `nixpkgs-ocr`) supplies only the packages that need it: `inherit (unstable) nushell yazi;` in the overlay, `pkgs-unstable = import inputs.nixpkgs-unstable { system = pkgs.stdenv.system; };` in devenv. Everything else stays on the stable pin.
- **devenv per project.** Tools in `packages`, languages through `languages.<lang>` (Python always with `uv.enable`, see `lang-py`), multi-step work as `tasks` with `after` and `execIfModified`, argument-taking commands as `scripts`, services as `processes` with a `ready` probe. A Python CLI with its own closure is wrapped as just its binary so it does not leak into the venv.
- **Style.** Small `let` blocks, `inherit` over `x = x;`, no `with pkgs;` over large scopes (it hides where names come from), `lib.` functions named in full. Comments say why a pin, override or workaround exists.

## Toolchain and gates

| job | tool | how |
|---|---|---|
| format | nixfmt (RFC 166 style) | `nix fmt` via the flake's `formatter` (`pkgs.nixfmt-tree` in the dotfiles); `nix fmt -- --ci` to check |
| evaluate | nix | `nix flake check --no-build` (evaluates every output, builds nothing) |
| build | nix | `nix build .#<pkg>`, `nix build .#nixosConfigurations.<host>.config.system.build.toplevel`, `entropic-switch --build-only` |
| lint | deadnix, statix | `nix run nixpkgs#deadnix -- .` for unused bindings; statix (last release 2023) only as advice |
| devenv | devenv | `devenv shell`, `devenv test`, `devenv tasks run <ns>` |

The package is `nixfmt`; `nixfmt-rfc-style` is now only an alias for it, and `nixfmt-classic` is gone. `nix flake check` without `--no-build` builds every `checks.<system>.*`, which is how VM tests and eval tests run in CI.

The lint pack is tstack's `lint/nix` (`statix.toml`), vendored with `lint-vendor add nix`; a lesson that repeats becomes a rule there through `tstack:lint-evolve`.

## Testing ladder

tstack's `tdd` owns the method and the rungs; this maps them to Nix.

| rung | tool |
|---|---|
| 0 static | `nix fmt -- --ci`, `nix flake check --no-build`, deadnix |
| 1 example | pure-eval tests of Nix functions with nix-unit (`testFoo = { expr = ...; expected = ...; };`, `nix-unit --flake .#tests`) or `lib.debug.runTests` |
| 2 integration | building the real thing: `nix build` of the package or the host's `toplevel`; `devenv test` runs `enterTest` with processes up |
| 3 golden | eval output compared against a committed file (a `checks` derivation diffing `builtins.toJSON` of a config); none standard |
| 4 to 7 | none standard for Nix; property and mutation testing belong to the code the flake builds |
| 8 simulation | NixOS VM tests: `pkgs.testers.runNixOSTest { nodes = ...; testScript = ...; }` in `checks.<system>.<name>`, `nix build .#checks.x86_64-linux.<name>`, `.driverInteractive` to poke at it; needs KVM |

For the dotfiles' desktop, use the `nixvm` skill (`~/repos/luizhcrocha/dotfiles/.claude/skills/nixvm/SKILL.md`, `just vm loop`): it boots `casa-pc` in QEMU with the repo 9p-shared, gives ssh, the journal, Hyprland IPC and screenshots, and is required for every change to `flake.nix`, `modules/**` or `machines/**` before Luiz applies it.

## Gotchas

- Moving the dotfiles `nix` bookmark ships every commit under it to the fleet; `master` there is the frozen Arch-era archive and is never set or pushed.
- clan's 26.05 pins nixpkgs, and with it 1Password and nushell (nushell 0.112 lacks `str lowercase`); a lock update alone cannot move them. Newer versions come through the unstable overlay.
- `atuin` is pinned to a tag and follows nixpkgs-unstable; `--flake-update` does not move it. A tool that 26.05 ships older than the one that wrote its state (atuin's DB) may refuse that state; check data compatibility before a downgrade.
- The devenv input deliberately has no nixpkgs follows, so it comes from the devenv cachix cache instead of building.
- A private flake input (hum, clipse) reaches a machine only after its repo is pushed and `nix flake update <input>` runs in the dotfiles; a Go input's `vendorHash` must be recomputed when its `go.sum` changes.
- Slow substitution is rarely the cache: clan-core sets `connect-timeout = 5` (overridden in `modules/nix/daemon.nix`), and a lock bumped on a machine that never pushed its closure builds locally.
- systemd user units get a minimal PATH without `/run/current-system/sw/bin`; give them a PATH or absolute `ExecStart`. Anything run through `$SHELL` is parsed by nushell: wrap it as `/bin/sh -c '...'`.
- The Mac uses `entropic-darwin-switch`; root cannot fetch the private `git+ssh` inputs.
- 1Password SSH needs a GUI click per program, so `clan machines update`, `jj git fetch` and private-input fetches stall headless.
- Each session that loads devenv's MCP server starts its own `devenv mcp` (about 4 GB); disable it in `.claude/settings.local.json` where unneeded.
- `tests/run-all.sh` in the dotfiles has a known red suite (`test-entropic-check-updates.sh`, 9 cases); a red run may not be your change.
