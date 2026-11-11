#!/usr/bin/env bash
# Reads origin, moves master forward to the given commit and pushes it, as a tstack release. Refuses a rewind, and a
# commit on the way that carries an attribution line, as the owner's rule is no attribution. A failed or interrupted
# push sets master back.
set -euo pipefail

W=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd -P)
refuse() { echo "push-master: $*" >&2; exit 1; }

[ "$#" -eq 1 ] && [[ $1 =~ ^[0-9a-f]{40}$ ]] || refuse "usage: push-master.sh <40-hex commit>"
COMMIT=$1

jj -R "$W" git fetch --remote origin
WAS=$(jj -R "$W" log -r master --no-graph -T commit_id) || refuse "master does not read as one commit"

[ -n "$(jj -R "$W" log -r "master@origin & ::$COMMIT" --no-graph -T commit_id)" ] ||
  refuse "master@origin is not an ancestor of $COMMIT"

ATTRIBUTED='description(regex:"(?im)^[ \\t]*(claude-session|co-authored-by)[ \\t]*:|^[ \\t]*(🤖[ \\t]*)?generated with (\\[claude code\\]\\([^)\\s]*\\)|claude code)[ \\t]*$")'
carrying=$(jj -R "$W" log -r "(master@origin..$COMMIT) & $ATTRIBUTED" --no-graph -T 'commit_id ++ "\n"')
[ -z "$carrying" ] || refuse "these commits carry an attribution line: $carrying"

restore() {
  jj -R "$W" bookmark set master --allow-backwards -r "$WAS" ||
    refuse "$1, and master stays at $COMMIT: it did not go back to $WAS"
  refuse "$1; master is back at $WAS"
}
trap 'trap - INT TERM HUP; restore "interrupted"' INT TERM HUP
jj -R "$W" bookmark set master -r "$COMMIT"
jj -R "$W" git push --remote origin --bookmark master || { trap - INT TERM HUP; restore "the push failed"; }
trap - INT TERM HUP
