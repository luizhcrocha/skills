# Tasks for the tstack plugin. Needs only python3 (3.11+), node and jj/git,
# which the machine provides; there is no dev shell.

default:
    @just --list

# Sync the upstreams in upstreams.toml, keeping local changes (--dry-run, --upstream NAME, --list-unmapped)
sync-upstream *args:
    python3 scripts/sync_upstream.py {{args}}

# Every test in the repo
test: test-scripts test-coordinator test-lint-ts

# The repo scripts (sync-upstream) against throwaway git repos
test-scripts:
    python3 -m unittest discover -s scripts/tests -v

# The TypeScript lint pack's RuleTester suites (anti-slop fork, tstack rules), on the pinned Oxlint
test-lint-ts:
    cd lint/ts && npm install --no-audit --no-fund --prefer-offline --silent && node run-tests.mjs

# The coordinator's scripts and dashboard page
test-coordinator:
    python3 -m unittest discover -s skills/productivity/coordinator/tests -p 'test_*.py'
    node --test 'skills/productivity/coordinator/tests/*.test.mjs'

# The lang-* skills' sources tables as JSON (--skill NAME, --stale DAYS)
lang-sources *args:
    python3 scripts/lang-sources {{args}}

# The lint rule registry, lint/registry.toml (validate, list, show, stale, record, set-status, add)
lint-registry *args:
    python3 scripts/lint-registry {{args}}

# Validate the plugin and marketplace manifests
validate:
    claude plugin validate .claude-plugin/plugin.json
    claude plugin validate .claude-plugin/marketplace.json

# Load the checkout into the installed plugin: bump the patch version, then update
reinstall:
    python3 -c "import json,pathlib; p=pathlib.Path('.claude-plugin/plugin.json'); d=json.loads(p.read_text()); a,b,c=map(int,d['version'].split('.')); d['version']=f'{a}.{b}.{c+1}'; p.write_text(json.dumps(d,indent=2)+'\n'); print(d['version'])"
    claude plugin update tstack@tstack
