# Tasks for the tstack plugin. Needs only python3 (3.11+), node, bun and jj/git,
# which the machine provides; there is no dev shell.

default:
    @just --list

# Sync the upstreams in upstreams.toml, keeping local changes (--dry-run, --upstream NAME, --list-unmapped)
sync-upstream *args:
    python3 scripts/sync_upstream.py {{args}}

# Every test in the repo, the suites in parallel, each one's output grouped under its PASS/FAIL line (--jobs 1 runs them one by one)
test *args:
    python3 scripts/gates all {{args}}

# Only the suites whose inputs changed in REVSET (default: the stack, master@origin..@), in parallel; scripts/gates SCOPE says which (--dry-run)
test-changed revset='master@origin..@' *args:
    python3 scripts/gates changed '{{revset}}' {{args}}

# The installs the suites share; scripts/gates runs each once before the suites, so none races another in one node_modules
_deps-lint:
    cd lint/ts && bun install --frozen-lockfile --silent

# The repo scripts and hooks against throwaway git repos, sharded across $TSTACK_TEST_JOBS processes (scripts/unittest_shards.py)
[env("GIT_CONFIG_GLOBAL", "/dev/null")]
[env("GIT_CONFIG_NOSYSTEM", "1")]
test-scripts:
    python3 scripts/unittest_shards.py -s scripts/tests -v

# The TypeScript lint pack's RuleTester suites (anti-slop fork, tstack rules), on the pinned Oxlint
[env("GIT_CONFIG_GLOBAL", "/dev/null")]
[env("GIT_CONFIG_NOSYSTEM", "1")]
test-lint-ts: _deps-lint
    cd lint/ts && node run-tests.mjs

# The lang-* skills' sources tables as JSON (--skill NAME, --stale DAYS)
lang-sources *args:
    python3 scripts/lang-sources {{args}}

# The lint rule registry, lint/registry.toml (validate, list, show, stale, record, set-status, add)
lint-registry *args:
    python3 scripts/lint-registry {{args}}

# Vendor a lint pack into a repo, or update it by 3-way merge (--repo DIR add LANG|auto, update, status, wiring, remove)
lint-vendor *args:
    python3 scripts/lint-vendor {{args}}

# Validate the plugin and marketplace manifests
validate:
    claude plugin validate .claude-plugin/plugin.json
    claude plugin validate .claude-plugin/marketplace.json
    for m in mods/*/; do claude plugin validate "$m" || exit 1; done

# The vendored mods' own `claude plugin test` suites (mods/, synced from upstreams.toml)
test-mods:
    for m in mods/*/; do claude plugin test "$m" || exit 1; done

# Load master on GitHub into the installed plugin: refresh the marketplace, then update
reinstall:
    claude plugin marketplace update tstack
    claude plugin update tstack@tstack
