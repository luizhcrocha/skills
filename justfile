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

_deps-fleet:
    cd fleet && bun install --frozen-lockfile --silent

_deps-page:
    cd fleet/page && bun install --frozen-lockfile --silent

# The repo scripts (sync-upstream) against throwaway git repos
test-scripts:
    python3 -m unittest discover -s scripts/tests -v

# The TypeScript lint pack's RuleTester suites (anti-slop fork, tstack rules), on the pinned Oxlint
test-lint-ts: _deps-lint
    cd lint/ts && node run-tests.mjs

# The coordinator's scripts and dashboard page
test-coordinator:
    python3 -m unittest discover -s skills/productivity/coordinator/tests -p 'test_*.py'
    node --test 'skills/productivity/coordinator/tests/*.test.mjs'

# The coordinator's page.test.mjs alone: the built page's rules that need no browser
test-coordinator-page:
    node --test skills/productivity/coordinator/tests/page.test.mjs

# The fleet oracle: the model-based test of the ledger (FLEET_MODEL_SEED=N replays a sequence) and the golden traces
test-fleet:
    python3 -m unittest discover -s fleet/oracle -p 'test_*.py'

# The TypeScript fleet (fleet/): its own checks, then the oracle against it
test-fleet-ts: test-fleet-ts-own test-fleet-ts-oracle

# The TypeScript fleet's own checks: strict types, the lint/ts packs, its tests (bun --parallel=4: four worker processes, a fresh global per file)
test-fleet-ts-own: _deps-fleet _deps-lint
    cd fleet && ./node_modules/.bin/tsc --noEmit -p . && ./node_modules/.bin/oxlint -c .oxlintrc.json --deny-warnings src test && bun test --parallel=4

# The oracle's golden traces and model test run against the TypeScript fleet
test-fleet-ts-oracle: _deps-fleet
    FLEET_ORACLE_IMPL='{"state": "{{justfile_directory()}}/fleet/bin/fleet state", "chat": "{{justfile_directory()}}/fleet/bin/fleet chat", "fleets": "{{justfile_directory()}}/fleet/bin/fleet fleets", "subst": {"{{justfile_directory()}}/skills/productivity/coordinator": "$SKILL"}}' python3 -m unittest discover -s fleet/oracle -p 'test_*.py'

# Build the dashboard page (fleet/page, Solid 2.0) into the coordinator's template, assets/dashboard.html; commit the result
build-page:
    cd fleet/page && bun install --frozen-lockfile --silent && bun build.ts

# The dashboard page (fleet/page): strict types, the lint/ts packs, the committed template against a fresh build, then its DOM tests and its headless-Chromium tests (skipped without Chromium), four bun worker processes
test-page: _deps-page _deps-lint
    cd fleet/page && ./node_modules/.bin/tsc --noEmit -p . && ./node_modules/.bin/oxlint -c .oxlintrc.json --deny-warnings src test build.ts && bun build.ts --check && TZ=UTC bun test --conditions browser --timeout 20000 --parallel=4

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

# Load the checkout into the installed plugin: bump the patch version, then update
reinstall:
    python3 -c "import json,pathlib; p=pathlib.Path('.claude-plugin/plugin.json'); d=json.loads(p.read_text()); a,b,c=map(int,d['version'].split('.')); d['version']=f'{a}.{b}.{c+1}'; p.write_text(json.dumps(d,indent=2)+'\n'); print(d['version'])"
    claude plugin update tstack@tstack
