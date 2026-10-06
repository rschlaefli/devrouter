#!/usr/bin/env bash
# Shared classifier for worktree reclamation. Sourced by audit.sh, fleet-audit.sh
# and reclaim.sh so the delete path and the report path can never disagree — a
# reclaim that trusted a stale audit table would delete on a verdict nobody
# re-checked.
#
# classify_worktree <path> <branch-ref>  ->  "VERDICT<TAB>CODES<TAB>REASON"
#   RECLAIM : newest same-repository forge change merged, tree clean, nothing
#             local left unshipped, no runtime bound to the tree
#   KEEP    : anything unproven or unfinished (the default when in doubt)
#   PRUNE   : registration points at a directory that no longer exists
#   CODES   : comma-separated, sorted reason codes, or "-" when none apply.
#             Codes are stable machine values shared with devrouter's
#             `workspace cleanup --all-worktrees`; REASON wording is free.

CLASSIFY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Stashes live in the main repo's refs/stash and are SHARED by every worktree:
# `git stash list` returns identical entries from anywhere, so it can never
# attribute work to one worktree. Report at repo level; never use as a blocker.
repo_stash_report() {
  local n
  n=$(git stash list 2>/dev/null | grep -c . || true)
  [ "${n:-0}" -eq 0 ] && return 0
  echo "NOTE: $n repo-level stash entries (shared by ALL worktrees) — review before cleanup:"
  git stash list --format='  %gd | %gs' 2>/dev/null
  echo
}

_forge_from_origin() {
  local remote host extra
  case "${WORKTREE_RECLAIM_FORGE:-auto}" in
    github|gitlab) printf '%s\n' "$WORKTREE_RECLAIM_FORGE"; return ;;
    auto|"") ;;
    *) printf 'unknown\n'; return ;;
  esac

  remote=$(git remote get-url origin 2>/dev/null || true)
  case "$remote" in
    git@*:*) host="${remote#git@}"; host="${host%%:*}" ;;
    ssh://*|http://*|https://*) host="${remote#*://}"; host="${host#*@}"; host="${host%%/*}"; host="${host%%:*}" ;;
    *) host="" ;;
  esac

  # Self-hosted GitLab instances whose host name does not contain "gitlab".
  for extra in ${WORKTREE_RECLAIM_GITLAB_HOSTS:-}; do
    [ "$host" = "$extra" ] && { printf 'gitlab\n'; return; }
  done
  case "$host" in
    github.com|*github*) printf 'github\n' ;;
    gitlab.com|*gitlab*) printf 'gitlab\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

# Forge APIs fail transiently under bulk lookups (rate limits, timeouts). A
# failed call already fails closed to KEEP, but in a manifest preflight one
# such row aborts the whole batch, so retry a failing call before giving up.
_forge_retry() {
  local attempt
  for attempt in 1 2 3; do
    "$@" && return 0
    [ "$attempt" -lt 3 ] && sleep "${WORKTREE_RECLAIM_FORGE_RETRY_DELAY:-$((attempt * 2))}"
  done
  return 1
}

# A fleet audit or manifest apply classifies hundreds of worktrees. One bulk
# listing of recent same-repository PRs per repository, reused for a short TTL,
# replaces a GitHub request per worktree. A cached row is safe to act on:
# MERGED never reverts, a newer PR on the branch only makes the verdict stricter
# once the cache refreshes, and the local-HEAD-vs-merged-head check stays local.
# A branch missing from the listing counts as having no PR, which fails closed
# to KEEP; only a PR older than the listing window is misjudged that way.
_github_pr_bulk_file() {
  local ttl key file tmp
  ttl="${WORKTREE_RECLAIM_PR_CACHE_TTL:-600}"
  [ "$ttl" -gt 0 ] 2>/dev/null || return 1
  key=$(git remote get-url origin 2>/dev/null | shasum 2>/dev/null | cut -c1-16)
  [ -n "$key" ] || return 1
  file="${TMPDIR:-/tmp}/worktree-reclaim-prs-$key.tsv"
  if ! python3 -c 'import os,sys,time; sys.exit(0 if time.time() - os.path.getmtime(sys.argv[1]) < int(sys.argv[2]) else 1)' "$file" "$ttl" 2>/dev/null; then
    tmp=$(mktemp "$file.XXXXXX") || return 1
    if _forge_retry gh pr list --state all --limit "${WORKTREE_RECLAIM_PR_BULK_LIMIT:-1000}" \
      --json headRefName,state,number,headRefOid,isCrossRepository \
      -q '.[] | select(.isCrossRepository | not) | [.headRefName, .state, (.number | tostring), .headRefOid] | @tsv' > "$tmp" 2>/dev/null; then
      mv -f "$tmp" "$file"
    else
      rm -f "$tmp"
      return 1
    fi
  fi
  printf '%s\n' "$file"
}

# Every forge lookup applies the same two rules: changes from forks never count,
# and the newest change for the branch (highest number) decides, so an older
# merged PR cannot outvote a newer open one.
_github_pr() {
  local short="$1" out state num head bulk row
  command -v gh >/dev/null 2>&1 || return 1
  if bulk=$(_github_pr_bulk_file); then
    row=$(awk -F'\t' -v b="$short" '$1 == b && ($3 + 0) > best { best = $3 + 0; line = $0 } END { if (line != "") print line }' "$bulk")
    [ -z "$row" ] && return 0
    IFS=$'\t' read -r _ state num head < <(printf '%s\n' "$row")
    printf '%s|%s|%s|github\n' "$state" "$num" "$head"
    return 0
  fi
  out=$(_forge_retry gh pr list --head "$short" --state all --limit 100 \
    --json state,number,headRefOid,isCrossRepository \
    -q '[.[] | select(.isCrossRepository | not)] | max_by(.number) // empty | "\(.state) \(.number) \(.headRefOid)"' 2>/dev/null) || return 1
  [ -z "$out" ] && return 0
  read -r state num head < <(printf '%s\n' "$out")
  printf '%s|%s|%s|github\n' "$state" "$num" "$head"
}

_gitlab_mr() {
  local short="$1" encoded out row state num head
  command -v glab >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1
  encoded=$(jq -rn --arg v "$short" '$v | @uri') || return 1
  out=$(_forge_retry glab api --method GET \
    "projects/:fullpath/merge_requests?source_branch=$encoded&scope=all&state=all&per_page=100" \
    2>/dev/null) || return 1
  row=$(printf '%s' "$out" | jq -r '[.[] | select(.source_project_id == .target_project_id)] | max_by(.iid) // empty | [(.state | ascii_upcase), (.iid | tostring), (.sha // .diff_refs.head_sha // "")] | @tsv' 2>/dev/null) || return 1
  [ -z "$row" ] && return 0
  IFS=$'\t' read -r state num head < <(printf '%s\n' "$row")
  [ "$state" = "OPENED" ] && state="OPEN"
  printf '%s|%s|%s|gitlab\n' "$state" "$num" "$head"
}

_forge_change() {
  local short="$1" forge
  forge=$(_forge_from_origin)
  case "$forge" in
    github) _github_pr "$short" ;;
    gitlab) _gitlab_mr "$short" ;;
    *) return 1 ;;
  esac
}

# Disposable ignored paths use the shared worktree pattern grammar: relative to
# the worktree root, "/"-separated, "*" within one segment, "**" for zero or
# more whole segments, and a match also covers everything beneath the path.
_BUILTIN_DISPOSABLE_PATTERNS=(
  '**/node_modules' '**/.pnpm-store' '**/vendor/bundle' '**/.venv' '**/venv'
  '**/__pycache__' '**/.pytest_cache' '**/.mypy_cache' '**/.ruff_cache' '**/.tox'
  '**/target' '**/.gradle' '**/.terraform' '**/dist' '**/build' '**/out'
  '**/coverage' '**/.next' '**/.nuxt' '**/.output' '**/.svelte-kit' '**/.turbo'
  '**/.cache' '**/.parcel-cache' '**/.vite' '**/.husky/_' '**/tmp/cache'
  '**/.DS_Store' '**/Thumbs.db' '**/*.pyc' '**/*.pyo' '**/*.log'
  '**/*.tsbuildinfo' '**/.eslintcache' '**/.stylelintcache' '**/next-env.d.ts'
  '**/.rollup.cache' '**/.claude/.cc-writes' '**/.claude/scheduled_tasks.lock'
)

_pattern_is_valid() {
  local pattern="$1" segment
  case "$pattern" in ''|/*|*/|*//*|*\\*) return 1 ;; esac
  local IFS=/
  for segment in $pattern; do
    case "$segment" in ''|.|..) return 1 ;; esac
  done
  return 0
}

# Prints the extended regular expression for one valid pattern.
_pattern_regex() {
  local pattern="$1" regex="^" segment escaped i last
  local -a segments=()
  IFS=/ read -r -a segments <<< "$pattern"
  # A trailing "**" adds nothing: a match already covers everything beneath.
  while [ "${#segments[@]}" -gt 1 ] && [ "${segments[${#segments[@]}-1]}" = "**" ]; do
    unset "segments[$(( ${#segments[@]} - 1 ))]"
  done
  last=$(( ${#segments[@]} - 1 ))
  for i in "${!segments[@]}"; do
    segment="${segments[$i]}"
    if [ "$segment" = "**" ]; then
      regex="$regex([^/]+/)*"
      continue
    fi
    escaped=$(printf '%s' "$segment" | sed -e 's/[][\.^$+?(){}|]/\\&/g' -e 's/\*/[^\/]*/g')
    regex="$regex$escaped"
    [ "$i" -lt "$last" ] && regex="$regex/"
  done
  printf '%s(/.*)?$\n' "$regex"
}

# Converts one override line to the pattern grammar, or prints nothing for a
# comment, blank or invalid line. A line starting with "*/" uses the earlier
# shell-case syntax matched against "/<path>/"; it becomes "**/<rest>" with a
# trailing "/" or "/*" removed. An inner "*" keeps its one-segment meaning,
# which can only make the line match fewer paths.
normalize_override_pattern() {
  local line="$1"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in ''|'#'*) return 0 ;; esac
  if [ "${line#\*/}" != "$line" ]; then
    line="${line#\*/}"
    line="${line%/\*}"
    while [ "${line%/}" != "$line" ]; do line="${line%/}"; done
    line="**/$line"
  fi
  if _pattern_is_valid "$line"; then printf '%s\n' "$line"; fi
  return 0
}

# Loads the built-in list plus <git-common-dir>/info/worktree-reclaim-disposable
# into _DISPOSABLE_REGEXES. Sets _DISPOSABLE_LEGACY_LINES to the number of
# override lines that still use the earlier syntax.
_load_disposable_patterns() {
  local common="$1" line pattern
  _DISPOSABLE_REGEXES=()
  _DISPOSABLE_LEGACY_LINES=0
  for pattern in "${_BUILTIN_DISPOSABLE_PATTERNS[@]}"; do
    _DISPOSABLE_REGEXES+=("$(_pattern_regex "$pattern")")
  done
  [ -n "$common" ] && [ -f "$common/info/worktree-reclaim-disposable" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '*/'*) _DISPOSABLE_LEGACY_LINES=$((_DISPOSABLE_LEGACY_LINES + 1)) ;; esac
    pattern=$(normalize_override_pattern "$line")
    [ -n "$pattern" ] && _DISPOSABLE_REGEXES+=("$(_pattern_regex "$pattern")")
  done < "$common/info/worktree-reclaim-disposable"
}

# Prints a deprecation note when the repository override still uses the earlier
# "*/path/" syntax. Report-only; the lines keep working.
disposable_override_note() {
  local common
  common=$(git -C "${1:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  _load_disposable_patterns "$common"
  [ "$_DISPOSABLE_LEGACY_LINES" -gt 0 ] || return 0
  echo "NOTE: $common/info/worktree-reclaim-disposable has $_DISPOSABLE_LEGACY_LINES line(s) in the earlier '*/path/' syntax; rewrite them as worktree-relative patterns such as '**/path'."
  echo
}

_path_is_disposable() {
  local candidate="${1%/}" regex
  for regex in "${_DISPOSABLE_REGEXES[@]}"; do
    [[ "$candidate" =~ $regex ]] && return 0
  done
  return 1
}

matches_worktree_pattern() {
  local pattern="$1" candidate="${2%/}" regex
  _pattern_is_valid "$pattern" || return 1
  regex=$(_pattern_regex "$pattern")
  [[ "$candidate" =~ $regex ]]
}

# Runtime evidence: anything devrouter, DevPod or Devsy holds for an exact path.
# The skill never deletes a runtime; a tree with any such evidence stays KEEP so
# that devrouter, which owns those resources, tears it down. The inventory is
# built once per run when the caller exports WORKTREE_RECLAIM_RUN_DIR.
_runtime_inventory_file() {
  local common="$1" key file
  key=$(printf '%s' "$common" | shasum | cut -c1-16)
  if [ -n "${WORKTREE_RECLAIM_RUN_DIR:-}" ]; then
    file="$WORKTREE_RECLAIM_RUN_DIR/runtime-$key.tsv"
    [ -f "$file" ] && { printf '%s\n' "$file"; return 0; }
  else
    file=$(mktemp "${TMPDIR:-/tmp}/worktree-reclaim-runtime.XXXXXX") || return 1
  fi
  python3 "$CLASSIFY_SCRIPT_DIR/runtime-inventory.py" "$common" > "$file" 2>/dev/null \
    || printf '!error\tinventory\n' > "$file"
  printf '%s\n' "$file"
}

_runtime_evidence() {
  local path="$1" common="$2" file
  file=$(_runtime_inventory_file "$common") || { printf 'inventory unavailable\n'; return; }
  awk -F'\t' -v p="$path" '
    $1 == "!error" { print "cannot list " $2; exit }
    $1 == p { print $2; exit }
  ' "$file"
  [ -n "${WORKTREE_RECLAIM_RUN_DIR:-}" ] || rm -f "$file"
}

_worktree_lock_reason() {
  local target="$1" listing status
  listing=$(git -C "$target" worktree list --porcelain 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'ERROR\tworktree lock check failed — cannot prove the registration is unlocked\n'
    return
  fi
  printf '%s\n' "$listing" | awk -v target="$target" '
    /^worktree / { p=substr($0,10); in_target=(p==target) }
    in_target && /^locked/ { sub(/^locked[ ]*/, ""); print length($0) ? $0 : "locked"; exit }
    /^$/ { in_target=0 }
  '
}

classify_worktree() {
  # Bash 3.2 runs `read ... < <(classify_worktree ...)` with the caller's
  # temporary IFS, so reset it before any word splitting here.
  local IFS=$' \t\n'
  local path="$1" br="$2"
  local short="${br#refs/heads/}"
  local reasons="" pr_state="" pr_num="" pr_head="" pr_forge="" local_head=""
  local -a codes=()

  _add() { codes+=("$1"); reasons="${reasons:+$reasons; }$2"; }

  if [ ! -d "$path" ]; then
    printf 'PRUNE\t-\tdirectory gone; git worktree prune\n'; return
  fi
  path="$(cd "$path" && pwd -P)"

  local git_dir common_dir
  git_dir=$(git -C "$path" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)
  common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -z "$git_dir" ] || [ -z "$common_dir" ]; then
    printf 'KEEP\tgit-error\tnot a readable Git worktree\n'; return
  fi
  [ "$git_dir" = "$common_dir" ] && _add primary "primary checkout"

  # Live work on disk always wins, regardless of merge state. One status read
  # covers tracked, untracked and ignored paths; optional locks stay off so the
  # read never rewrites the index of a tree another process may be using.
  _load_disposable_patterns "$common_dir"
  local status_file entry xy entry_path dirty=0 untracked=0 ignored=0 ignored_examples=""
  status_file=$(mktemp "${TMPDIR:-/tmp}/worktree-reclaim-status.XXXXXX")
  if GIT_OPTIONAL_LOCKS=0 git -C "$path" status --porcelain=v1 -z --untracked-files=all --ignored=matching > "$status_file" 2>/dev/null; then
    while IFS= read -r -d '' entry; do
      [ "${#entry}" -lt 4 ] && continue
      xy="${entry:0:2}"; entry_path="${entry:3}"
      # Renames and copies carry their source path in the following entry.
      case "$xy" in R*|C*) IFS= read -r -d '' _ || true ;; esac
      case "$xy" in
        '??') untracked=$((untracked + 1)) ;;
        '!!')
          _path_is_disposable "$entry_path" && continue
          # An empty ignored file (e.g. a seeded placeholder .env) holds nothing to lose.
          [ -f "$path/$entry_path" ] && [ ! -L "$path/$entry_path" ] && [ ! -s "$path/$entry_path" ] && continue
          ignored=$((ignored + 1))
          [ "$ignored" -le 3 ] && ignored_examples="${ignored_examples:+$ignored_examples, }${entry_path%/}"
          ;;
        *) dirty=$((dirty + 1)) ;;
      esac
    done < "$status_file"
    [ "$dirty" -gt 0 ] && _add dirty "$dirty uncommitted change(s)"
    [ "$untracked" -gt 0 ] && _add untracked "$untracked untracked path(s)"
    [ "$ignored" -gt 0 ] && _add ignored-state "$ignored ignored local-state path(s): $ignored_examples$([ "$ignored" -gt 3 ] && printf ', ...' || true)"
  else
    _add git-error "git status failed — cannot prove the tree clean"
  fi
  rm -f "$status_file"

  # Git is idle only when no index lock and no operation marker exist.
  local markers name operation="" marker_path i=0
  local -a marker_names=(index.lock MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply sequencer)
  local -a marker_args=()
  for name in "${marker_names[@]}"; do marker_args+=(--git-path "$name"); done
  if markers=$(git -C "$path" rev-parse --path-format=absolute "${marker_args[@]}" 2>/dev/null); then
    while IFS= read -r marker_path; do
      name="${marker_names[$i]}"; i=$((i + 1))
      [ -n "$marker_path" ] && [ -e "$marker_path" ] || continue
      if [ "$name" = index.lock ]; then
        _add index-lock "index.lock present — another Git process may be writing"
      elif [ -z "$operation" ]; then
        operation="$name"
        _add operation-in-progress "Git operation in progress ($name)"
      fi
    done <<< "$markers"
  else
    _add git-error "git operation check failed — cannot prove Git is idle"
  fi

  local lock_reason
  lock_reason=$(_worktree_lock_reason "$path")
  case "$lock_reason" in
    ERROR$'\t'*) _add git-error "${lock_reason#*$'\t'}" ;;
    "") ;;
    *) _add locked "worktree locked ($lock_reason)" ;;
  esac

  # `git worktree remove` refuses a tree with initialized submodules, and their
  # repositories under <worktree-git-dir>/modules can hold unpushed commits
  # that this classifier does not inspect.
  [ -d "$git_dir/modules" ] && _add submodule "initialized submodule(s) — inspect and deinit before removing"

  local runtime
  runtime=$(_runtime_evidence "$path" "$common_dir")
  [ -n "$runtime" ] && _add runtime-present "runtime evidence ($runtime) — let devrouter tear it down"

  local_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
  if [ -z "$local_head" ] || ! git -C "$path" symbolic-ref -q HEAD >/dev/null 2>&1; then
    _add detached "detached or unreadable HEAD — verify the commit landed before removing"
    short="(detached)"
  fi

  # Merge state comes from the forge, not the commit graph: a squash merge leaves
  # no ancestry, so `git branch --merged` reports a merged branch as unmerged.
  local forge_ok=1 forge_result="" change_ref=""
  if [ "$short" != "(detached)" ]; then
    if forge_result=$(_forge_change "$short" 2>/dev/null); then
      if [ -n "$forge_result" ]; then
        IFS='|' read -r pr_state pr_num pr_head pr_forge < <(printf '%s\n' "$forge_result")
      fi
    else
      forge_ok=0
      _add forge-unavailable "forge lookup unavailable (missing CLI, unknown forge or repeated failure)"
    fi
  fi

  [ -n "$pr_num" ] && change_ref="$([ "$pr_forge" = "gitlab" ] && printf '!%s' "$pr_num" || printf '#%s' "$pr_num")"

  if [ "$short" != "(detached)" ] && [ "$forge_ok" -eq 1 ]; then
    case "$pr_state" in
      MERGED)
        # Forges auto-delete the remote branch on merge, so a missing upstream
        # here is EXPECTED and is not evidence of unpushed work. Compare against
        # the merged head SHA instead: local ahead of it = commits never shipped.
        if [ -z "$pr_head" ] || [ "$pr_head" = "null" ]; then
          _add head-beyond-merge "merged change $change_ref but head SHA unverifiable — cannot confirm local shipped"
        elif [ "$pr_head" != "$local_head" ] \
           && ! git -C "$path" merge-base --is-ancestor "$local_head" "$pr_head" 2>/dev/null; then
          _add head-beyond-merge "local HEAD diverges from merged change $change_ref head — unshipped commits"
        fi
        ;;
      OPEN) _add change-open "change $change_ref still open" ;;
      CLOSED) _add change-closed "change $change_ref closed without merge" ;;
      *) _add no-change "no same-repository forge change for the branch" ;;
    esac
  fi

  if [ "${#codes[@]}" -gt 0 ]; then
    printf 'KEEP\t%s\t%s\n' "$(printf '%s\n' "${codes[@]}" | LC_ALL=C sort -u | paste -sd, -)" "$reasons"
  else
    printf 'RECLAIM\t-\tMERGED %s, clean, all commits shipped\n' "$change_ref"
  fi
}

# Emits "path<TAB>branch" per registered worktree, main checkout excluded.
# The main-checkout filter lives inside awk with a literal string compare — a
# grep on the path would treat regex metacharacters in it (. + [ ] ( ) — common
# in worktree paths like `tool-0.0.32`) as operators and mis-exclude.
list_worktrees() {
  local main_wt; main_wt="$(git rev-parse --show-toplevel)"
  git worktree list --porcelain | awk -v main="$main_wt" '
    /^worktree /{p=substr($0,10)}
    /^branch /{b=substr($0,8)}
    /^detached/{b="(detached)"}
    /^$/{if(p!="" && p!=main){print p"\t"b}; p="";b=""}
    END{if(p!="" && p!=main)print p"\t"b}
  '
}
