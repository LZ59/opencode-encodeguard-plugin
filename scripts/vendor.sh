#!/usr/bin/env bash
# Keep src/v2/upstream/ in step with the opencode sources it was vendored from.
#
#   scripts/vendor.sh status              recorded tag vs latest upstream tag
#   scripts/vendor.sh sync <tag>          fast-forward the vendored tree to <tag>
#   scripts/vendor.sh verify              offline: tree == pristine + patches
#   scripts/vendor.sh patches             regenerate scripts/vendor/patches/
#   scripts/vendor.sh fetch                populate scripts/vendor/.cache/opencode
#
# The vendored tree is described by scripts/vendor/manifest.txt:
#
#   verbatim  byte-identical to upstream; sync overwrites it
#   patched   pristine upstream + scripts/vendor/patches/<path>.patch
#   shim      never overwritten; the local file is authoritative
#
# A sync that cannot apply a patch fails loudly instead of leaving the tree
# half-updated, so upstream changes to patched files always show up as a
# conflict you resolve by hand.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

VENDOR_DIR="scripts/vendor"
MANIFEST="$VENDOR_DIR/manifest.txt"
PATCH_DIR="$VENDOR_DIR/patches"
CACHE="$VENDOR_DIR/.cache/opencode"
UPSTREAM_SRC="packages/core/src"
TREE="src/v2/upstream"
UPSTREAM_URL="https://github.com/sst/opencode.git"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
# `diff` exits 1 to mean "files differ"; under `pipefail` that would abort the
# caller, so every report path goes through this helper.
changed_lines() { diff -u "$1" "$2" | grep -E '^[-+][^-+]' | sed 's/^/           /' || true; }
rows() { grep -E "^(verbatim|patched|shim)[[:space:]]" "$MANIFEST"; }
paths_of() { rows | awk -F'\t' -v k="$1" '$1 == k { print $2 }'; }
recorded_tag() { grep -m1 '^# tag:' "$MANIFEST" | awk '{ print $3 }'; }
recorded_commit() { grep -m1 '^# commit:' "$MANIFEST" | awk '{ print $3 }'; }

ensure_cache() {
  if [ ! -d "$CACHE/.git" ]; then
    note "cloning $UPSTREAM_URL (single branch) into $CACHE"
    mkdir -p "$(dirname "$CACHE")"
    git clone --filter=blob:none --no-checkout "$UPSTREAM_URL" "$CACHE" >/dev/null
  fi
}

fetch_tag() {
  ensure_cache
  git -C "$CACHE" cat-file -e "refs/tags/$1^{commit}" 2>/dev/null && return 0
  git -C "$CACHE" fetch --quiet --filter=blob:none --depth 1 origin "refs/tags/$1:refs/tags/$1" \
    || git -C "$CACHE" fetch --quiet --filter=blob:none origin "+refs/tags/$1:refs/tags/$1"
}

# Export <tag>:packages/core/src into <dir>, stripped so that <dir>/<relative path>
# matches the paths used in scripts/vendor/manifest.txt.
export_src() {
  local tag="$1" dir="$2"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$CACHE" archive "$tag" "$UPSTREAM_SRC" | tar -x -C "$dir" --strip-components=3
  [ -d "$dir/tool" ] || die "export of $tag:$UPSTREAM_SRC produced no sources"
}

commit_of() { git -C "$CACHE" rev-parse "refs/tags/$1^{commit}"; }

# Write the tag/commit provenance back into the manifest header.
record_tag() {
  local tag="$1" commit="$2" tmp
  tmp="$(mktemp)"
  sed -e "s|^# tag:.*|# tag:    $tag|" -e "s|^# commit:.*|# commit: $commit|" "$MANIFEST" >"$tmp"
  mv "$tmp" "$MANIFEST"
}

# latest v2.x.y tag on the upstream remote
latest_tag() {
  ensure_cache
  git -C "$CACHE" ls-remote --tags --refs origin \
    | sed -n 's|.*refs/tags/\(v2\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -u -V | tail -1
}

# ---------------------------------------------------------------- commands --

cmd_fetch() {
  fetch_tag "$(recorded_tag)"
  note "cache ready: $CACHE @ $(recorded_tag)"
}

cmd_status() {
  local old new latest
  old="$(recorded_tag)"
  latest="$(latest_tag)"
  new="$latest"
  note "recorded: $old  ($(recorded_commit))"
  note "latest:   $new"
  if [ "$old" = "$new" ]; then
    note "already on the latest upstream tag"
    return 0
  fi
  fetch_tag "$old"
  fetch_tag "$new"
  local a b
  a="$(mktemp -d)"; b="$(mktemp -d)"
  export_src "$old" "$a"
  export_src "$new" "$b"
  note ""
  note "upstream changes to files this plugin vendors ($old -> $new):"
  local found=0
  while IFS=$'\t' read -r kind path; do
    [ -f "$a/$path" ] || [ -f "$b/$path" ] || continue
    if [ ! -f "$b/$path" ]; then
      note "  REMOVED  $path"; found=1; continue
    fi
    if [ ! -f "$a/$path" ]; then
      note "  ADDED    $path"; found=1; continue
    fi
    if ! cmp -s "$a/$path" "$b/$path"; then
      note "  CHANGED  [$kind] $path"
      changed_lines "$a/$path" "$b/$path"
      found=1
    fi
  done < <(rows)
  [ "$found" = 1 ] || note "  (none)"
  note ""
  note "review, then run: scripts/vendor.sh sync $new"
  rm -rf "$a" "$b"
}

cmd_sync() {
  local new="${1:-}"
  [ -n "$new" ] || die "usage: scripts/vendor.sh sync <tag>"
  local old; old="$(recorded_tag)"
  fetch_tag "$new"

  local pristine; pristine="$(mktemp -d)"
  export_src "$new" "$pristine"

  # pristine copy of the tag we are leaving, so we can report what moved
  local before; before=""
  if [ "$old" != "$new" ]; then
    fetch_tag "$old"
    before="$(mktemp -d)"
    export_src "$old" "$before"
  fi

  local conflict=0
  while IFS=$'\t' read -r kind path; do
    case "$kind" in
      verbatim)
        [ -f "$pristine/$path" ] || die "upstream removed $path; drop it from the manifest"
        cp "$pristine/$path" "$TREE/$path"
        ;;
      patched)
        [ -f "$pristine/$path" ] || die "upstream removed $path; drop it from the manifest"
        local p="$PATCH_DIR/$path.patch"
        [ -f "$p" ] || die "missing patch for $path"
        cp "$pristine/$path" "$TREE/$path"
        if ! git apply -p1 --directory="$TREE" --whitespace=nowarn "$p" 2>/dev/null; then
          conflict=1
          note "  CONFLICT $path — patch does not apply to $new"
          changed_lines "$TREE/$path" "$pristine/$path"
          cp "$pristine/$path" "$TREE/$path"   # leave pristine so the conflict is inspectable
        fi
        ;;
      shim)
        : # local file is authoritative
        ;;
    esac
  done < <(rows)

  if [ -n "$before" ]; then
    note "upstream moved ($old -> $new):"
    while IFS=$'\t' read -r _ path; do
      [ -f "$before/$path" ] && [ -f "$pristine/$path" ] || continue
      cmp -s "$before/$path" "$pristine/$path" && continue
      note "  CHANGED  $path"
    done < <(rows)
    rm -rf "$before"
  fi

  record_tag "$new" "$(commit_of "$new")"

  if [ "$conflict" = 1 ]; then
    rm -rf "$pristine"
    note ""
    die "patches conflicted — resolve in $TREE, then run: scripts/vendor.sh patches"
  fi

  # The committed patches were written against $old. Show what each patched
  # file still contributes on top of $new — an upstream change that absorbed,
  # moved or invalidated one of our hunks shows up here as a missing or
  # relocated hunk — then rewrite the patch set against $new so verify agrees.
  note ""
  note "patched files, their delta from $new pristine:"
  while IFS=$'\t' read -r _ path; do
    [ -f "$pristine/$path" ] || continue
    note "  $path"
    changed_lines "$pristine/$path" "$TREE/$path"
  done < <(rows | grep '^patched')
  rm -rf "$pristine"
  cmd_patches

  note ""
  note "synced to $new; verifying"
  cmd_verify
  npm run typecheck
  npm run smoke
}

cmd_verify() {
  local tag; tag="$(recorded_tag)"
  if [ ! -d "$CACHE/.git" ]; then
    note "no upstream cache; skipping byte comparison (run scripts/vendor.sh fetch)"
  else
    fetch_tag "$tag"
    local pristine; pristine="$(mktemp -d)"
    export_src "$tag" "$pristine"
    local bad=0
    while IFS=$'\t' read -r kind path; do
      case "$kind" in
        verbatim)
          cmp -s "$pristine/$path" "$TREE/$path" || { note "  DRIFT verbatim $path"; bad=1; }
          ;;
        patched)
          # patch(pristine, tree) is by construction the canonical form of
          # "pristine + our edit"; comparing it to the committed patch catches
          # both local edits to the tree and stale patches, with no need to
          # actually apply anything.
          local computed; computed="$(mktemp)"
          diff -u --label "a/$path" --label "b/$path" "$pristine/$path" "$TREE/$path" >"$computed" || true
          if ! cmp -s "$computed" "$PATCH_DIR/$path.patch"; then
            note "  DRIFT patched $path"; bad=1
          fi
          rm -f "$computed"
          ;;
        shim)
          grep -q 'Shim:' "$TREE/$path" || { note "  DRIFT shim $path lost its // Shim: marker"; bad=1; }
          ;;
      esac
    done < <(rows)
    rm -rf "$pristine"
    [ "$bad" = 0 ] || die "vendored tree drifted from manifest ($tag)"
  fi
  note "verify ok against $tag"
}

cmd_patches() {
  local tag; tag="$(recorded_tag)"
  fetch_tag "$tag"
  local pristine; pristine="$(mktemp -d)"
  export_src "$tag" "$pristine"
  rm -rf "$PATCH_DIR"
  local n=0
  while IFS=$'\t' read -r _ path; do
    [ -f "$pristine/$path" ] || continue
    cmp -s "$pristine/$path" "$TREE/$path" && continue
    mkdir -p "$PATCH_DIR/$(dirname "$path")"
    diff -u --label "a/$path" --label "b/$path" "$pristine/$path" "$TREE/$path" \
      >"$PATCH_DIR/$path.patch" || true
    n=$((n + 1))
  done < <(rows | grep '^patched')
  rm -rf "$pristine"
  note "regenerated $n patch(es) against $tag"
}

case "${1:-status}" in
  fetch)   cmd_fetch ;;
  status)  cmd_status ;;
  sync)    shift; cmd_sync "${1:-}" ;;
  verify)  cmd_verify ;;
  patches) cmd_patches ;;
  *)       die "unknown command '${1}' (fetch|status|sync <tag>|verify|patches)" ;;
esac
