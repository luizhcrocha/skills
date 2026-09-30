# lang-nix sources

The refresher reads this table, checks each source for a newer release, and updates the version in SKILL.md and here.

| item | kind | version targeted | checked on | source |
|---|---|---|---|---|
| Nix | language/tool | 2.35.2 (tags only, no GitHub releases) | 2026-09-30 | https://github.com/NixOS/nix/tags |
| Determinate Nix | tool | 3.22.5 (installed on Luiz's machines) | 2026-09-30 | https://github.com/DeterminateSystems/nix-src/releases |
| Lix | tool | 2.95.3 (not used; noted) | 2026-09-30 | https://github.com/lix-project/lix/tags |
| NixOS | tool | 26.05 "Yarara" stable; nixos-unstable is 26.11-dev | 2026-09-30 | https://nixos.org/manual/nixos/stable/release-notes |
| home-manager | tool | `release-26.05` branch (no GitHub releases) | 2026-09-30 | https://github.com/nix-community/home-manager/blob/release-26.05/release.json |
| devenv | tool | 2.4.0 (dotfiles pins v2.2.2) | 2026-09-30 | https://github.com/cachix/devenv/releases , https://devenv.sh/reference/yaml-options/ , https://devenv.sh/common-patterns/ , https://devenv.sh/tasks/ , https://devenv.sh/tests/ |
| nixfmt | tool | 1.5.0 (RFC 166 style) | 2026-09-30 | https://github.com/NixOS/nixfmt/releases |
| nixfmt-tree | tool | treefmt wrapper around nixfmt | 2026-09-30 | https://github.com/NixOS/nixfmt#nix-fmt |
| deadnix | tool | 1.3.2 | 2026-09-30 | https://github.com/astro/deadnix/tags |
| statix | tool | 0.5.8 (2023, maintenance mode) | 2026-09-30 | https://github.com/oppiliappan/statix |
| nixd | tool | 2.9.3 | 2026-09-30 | https://github.com/nix-community/nixd/releases |
| nil | tool | snapshot 2026-07-23 | 2026-09-30 | https://github.com/oxalica/nil/releases |
| nix-unit | tool | 2.35.1 | 2026-09-30 | https://github.com/nix-community/nix-unit/releases , https://nix-community.github.io/nix-unit/ |
| nix flake check | doc | `--no-build`, `--all-systems` | 2026-09-30 | https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-flake-check |
| NixOS VM tests | doc | `pkgs.testers.runNixOSTest`, `.driverInteractive` | 2026-09-30 | https://github.com/NixOS/nixpkgs/blob/master/nixos/doc/manual/development/writing-nixos-tests.section.md (also `nixos/lib/testing/interactive.nix`) |
| clan-core | tool | tracks `main`, pinned through flake.lock (no releases) | 2026-09-30 | https://git.clan.lol/clan/clan-core , https://clan.lol/docs |

## Luiz's repos read

- `~/repos/luizhcrocha/dotfiles`, bookmark `nix` (read with `git show nix:<path>`): README, `default/claude/CLAUDE.md`, justfile (`check` = `nix fmt -- --ci` + `nix flake check --no-build`, `test`, `vm`), `flake.nix` (clan-core 26.05 with follows, home-manager and stylix release-26.05, `nixpkgs-unstable` for a few packages, devenv pinned by tag without follows, atuin by tag), dendritic `modules/` layout, `modules/desktop/dotfiles.nix` (mkOutOfStoreSymlink `link` helper, `configNotLinked`), `pkgs/default.nix` overlay and `pkgs/uv.nix` release-binary pattern, `modules/flake/formatter.nix` (`nixfmt-tree`), the `nixvm` skill. Memo export for the gotchas.
- `~/repos/coelhorocha/custom-mcp-servers` `devenv.nix` / `devenv.yaml`: nixos-26.05 plus a purpose-named unstable input `nixpkgs-ocr`, release-binary `atlas` derivation, Modal CLI wrapped as its binary, tasks graph with `execIfModified`, processes with `ready`, secretspec with the 1Password provider enabled.
- `~/repos/entropic-br/troti` `devenv.nix` / `devenv.yaml`: nixos-26.05 only, services (postgres, redis, temporal), processes with `after` and `ready`, `troti:*` tasks, secretspec deliberately off at eval time (it would prompt 1Password on every shell entry and fail in agent sessions).

## Open questions

- No repo runs deadnix or statix, and none has git hooks. Add deadnix to the dotfiles' `just check`?
- custom-mcp-servers enables secretspec in `devenv.yaml` while troti keeps it off at eval time for agent sessions; which is the standard?
- Unstable input naming: `nixpkgs-unstable` (dotfiles) vs purpose-named `nixpkgs-ocr` (custom-mcp-servers). Both keep the pick narrow and commented; pick one name?
- The dotfiles pin devenv v2.2.2; the latest is 2.4.0.
- No doc in the dotfiles says agents must not switch; the rule here comes from memo notes and the nixvm skill. Confirm it belongs in the dotfiles' CLAUDE.md too.
- custom-mcp-servers' `devenv.nix` repeats the `LD_LIBRARY_PATH` value and comment three times.
- No repo has nix-unit tests or `runNixOSTest` checks; nixvm is the dotfiles' VM path.
