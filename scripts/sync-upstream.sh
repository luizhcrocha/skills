#!/usr/bin/env bash
# Sync skills from the original repo (mattpocock/skills), keeping local changes.
#
# How it works:
# - Only skills whose directory exists locally under the same path are synced;
#   renamed or local-only skills are never touched.
# - Files new upstream are copied in.
# - Files changed upstream are 3-way merged against the last-synced upstream
#   commit (recorded in .upstream-ref), so local edits survive. Real conflicts
#   get standard conflict markers for manual resolution.
# - On the first run (no .upstream-ref yet) files that already differ locally
#   are left alone and reported; the recorded ref makes future runs mergeable.
# - Nothing is ever deleted locally.
set -euo pipefail

UPSTREAM_URL="https://github.com/mattpocock/skills.git"
REF_FILE=".upstream-ref"

cd "$(git rev-parse --show-toplevel)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning upstream ($UPSTREAM_URL)..."
git clone --quiet "$UPSTREAM_URL" "$TMP/upstream"
NEW_SHA="$(git -C "$TMP/upstream" rev-parse HEAD)"

BASE_SHA=""
if [ -f "$REF_FILE" ]; then
  BASE_SHA="$(cat "$REF_FILE")"
  if ! git -C "$TMP/upstream" cat-file -e "$BASE_SHA" 2>/dev/null; then
    echo "warning: recorded base $BASE_SHA not found upstream; treating as first run" >&2
    BASE_SHA=""
  fi
fi

added=() updated=() merged=() conflicted=() skipped=()

while IFS= read -r file; do
  theirs="$TMP/upstream/$file"
  skill_dir="$(echo "$file" | cut -d/ -f1-3)" # skills/<bucket>/<skill>
  [ -d "$skill_dir" ] || continue             # skill not present locally

  if [ ! -f "$file" ]; then
    mkdir -p "$(dirname "$file")"
    cp "$theirs" "$file"
    added+=("$file")
    continue
  fi

  cmp -s "$file" "$theirs" && continue # already in sync

  if [ -n "$BASE_SHA" ] && git -C "$TMP/upstream" cat-file -e "$BASE_SHA:$file" 2>/dev/null; then
    git -C "$TMP/upstream" show "$BASE_SHA:$file" >"$TMP/base"
    if cmp -s "$TMP/base" "$theirs"; then
      continue # upstream unchanged since last sync; the diff is ours — keep it
    fi
    if cmp -s "$TMP/base" "$file"; then
      cp "$theirs" "$file" # we never touched it — take upstream as-is
      updated+=("$file")
      continue
    fi
    if git merge-file -L "local" -L "base" -L "upstream" "$file" "$TMP/base" "$theirs"; then
      merged+=("$file")
    else
      conflicted+=("$file")
    fi
  else
    skipped+=("$file") # differs locally and no base to merge from
  fi
done < <(git -C "$TMP/upstream" ls-files 'skills/')

echo "$NEW_SHA" >"$REF_FILE"

report() {
  local label="$1"
  shift
  local items=()
  local i
  for i in "$@"; do [ -n "$i" ] && items+=("$i"); done
  [ "${#items[@]}" -eq 0 ] && return 0
  echo
  echo "$label"
  printf '  %s\n' "${items[@]}"
}

echo
echo "Synced to upstream $NEW_SHA"
report "Added (new upstream files):" "${added[@]:-}"
report "Updated (upstream change, no local edits):" "${updated[@]:-}"
report "Merged (upstream + local changes combined):" "${merged[@]:-}"
report "CONFLICTED (fix conflict markers by hand):" "${conflicted[@]:-}"
report "Skipped (local differs, no merge base — review manually):" "${skipped[@]:-}"
echo
echo "Review with: git diff && git status"
