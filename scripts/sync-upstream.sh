#!/usr/bin/env bash
# Sync from the upstreams in upstreams.toml, keeping local changes.
# See scripts/sync_upstream.py. Flags: --dry-run, --upstream NAME,
# --list-unmapped, --all-unmapped.
set -euo pipefail
exec python3 "$(dirname "$0")/sync_upstream.py" "$@"
