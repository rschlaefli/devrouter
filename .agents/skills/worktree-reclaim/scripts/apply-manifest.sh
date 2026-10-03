#!/usr/bin/env bash
# Validate and reclaim exactly one approved, content-addressed candidate set.
# Dry-run by default. No mutation occurs until every selected row passes the
# same fresh preflight in one batch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-sessions.sh
. "$SCRIPT_DIR/lib-sessions.sh"

manifest="${1:-}"
[ -n "$manifest" ] || {
  echo "usage: apply-manifest.sh MANIFEST --sha256 SHA [--max-age 24h] [--yes]" >&2
  exit 2
}
shift

expected_sha=""; max_age="24h"; execute=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha256) expected_sha="${2:?--sha256 needs a digest}"; shift 2 ;;
    --max-age) max_age="${2:?--max-age needs a duration}"; shift 2 ;;
    --yes) execute=1; shift ;;
    -h|--help)
      echo "usage: apply-manifest.sh MANIFEST --sha256 SHA [--max-age 24h] [--yes]" >&2
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$expected_sha" ] || { echo "--sha256 is required" >&2; exit 2; }

dur_seconds() {
  python3 - "$1" <<'PY'
import re, sys
m = re.fullmatch(r"(\d+)\s*([smhd]?)", sys.argv[1].strip())
if not m:
    sys.exit(2)
print(int(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)])
PY
}

max_age_secs=$(dur_seconds "$max_age") || {
  echo "bad --max-age: $max_age (use e.g. 30m, 24h, 7d)" >&2
  exit 2
}

# devrouter owns runtimes, so when it can apply manifests it applies this one,
# with this skill's session check as the per-target veto. Set
# WORKTREE_RECLAIM_NO_DEVROUTER=1 to force the skill's own path, which keeps
# every tree with runtime evidence.
if [ "${WORKTREE_RECLAIM_NO_DEVROUTER:-0}" != 1 ] && command -v devrouter >/dev/null 2>&1 \
  && devrouter workspace reclaim --help >/dev/null 2>&1; then
  echo "Delegating to devrouter workspace reclaim (session veto: $SCRIPT_DIR/session-veto.sh)."
  delegate=(devrouter workspace reclaim --manifest "$manifest" --sha256 "$expected_sha" --max-age "$max_age"
    --veto-command "$SCRIPT_DIR/session-veto.sh")
  [ "$execute" -eq 1 ] && delegate+=(--yes)
  exec "${delegate[@]}"
fi

records=$(mktemp "${TMPDIR:-/tmp}/worktree-reclaim-records.XXXXXX")
session_cache=$(mktemp "${TMPDIR:-/tmp}/worktree-reclaim-sessions.XXXXXX")
WORKTREE_RECLAIM_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worktree-reclaim-run.XXXXXX")"
export WORKTREE_RECLAIM_RUN_DIR
trap 'rm -rf "$records" "$session_cache" "$WORKTREE_RECLAIM_RUN_DIR"' EXIT

validate_args=(
  python3 "$SCRIPT_DIR/manifest.py" validate "$manifest"
  --expected-sha256 "$expected_sha"
  --max-age-seconds "$max_age_secs"
  --records "$records"
)
"${validate_args[@]}"

exec 3<"$records"
IFS= read -r -d '' active_secs <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
IFS= read -r -d '' all_history <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
IFS= read -r -d '' actual_sha <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }

ids=(); repos=(); paths=(); branch_refs=(); heads=(); common_dirs=(); git_dirs=()
while IFS= read -r -d '' id <&3; do
  IFS= read -r -d '' repo <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
  IFS= read -r -d '' path <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
  IFS= read -r -d '' branch_ref <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
  IFS= read -r -d '' head <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
  IFS= read -r -d '' common_dir <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
  IFS= read -r -d '' git_dir <&3 || { echo "REFUSING: validated records are incomplete" >&2; exit 1; }
  ids+=("$id"); repos+=("$repo"); paths+=("$path"); branch_refs+=("$branch_ref")
  heads+=("$head"); common_dirs+=("$common_dir"); git_dirs+=("$git_dir")
done
exec 3<&-

[ "${#ids[@]}" -gt 0 ] || { echo "REFUSING: validated selection is empty" >&2; exit 1; }

receipt_path() {
  printf '%s/worktree-reclaim/receipts/%s/%s.json' "${common_dirs[$1]}" "$actual_sha" "${ids[$1]}"
}

# A target that is already gone counts as done only when this same approved
# manifest left a receipt for that exact candidate, path and HEAD. A target
# that vanished any other way stays a failure.
already_done() {
  local i="$1" file
  [ -e "${paths[$i]}" ] && return 1
  file="$(receipt_path "$i")"
  [ -f "$file" ] || return 1
  python3 - "$file" "$actual_sha" "${ids[$i]}" "${paths[$i]}" "${heads[$i]}" <<'PY'
import json, sys
path, sha, cid, target, head = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as handle:
        receipt = json.load(handle)
except (OSError, ValueError):
    sys.exit(1)
ok = (
    isinstance(receipt, dict)
    and receipt.get("kind") == "worktree-reclaim-receipt"
    and receipt.get("schemaVersion") == 1
    and receipt.get("manifestSha256") == sha
    and receipt.get("candidateId") == cid
    and receipt.get("path") == target
    and receipt.get("head") == head
)
sys.exit(0 if ok else 1)
PY
}

refresh_session_index() {
  if ! build_session_index "$session_cache" "$active_secs" "$all_history"; then
    echo "REFUSING: current Codex/Claude session evidence could not be indexed." >&2
    exit 1
  fi
}

check_active_sessions() {
  local i session provider age
  session_failures=0
  for i in "${!ids[@]}"; do
    [ -n "${done_flags[$i]}" ] && continue
    session=$(session_last_activity "$session_cache" "${paths[$i]}")
    if [ -z "$session" ]; then
      continue
    fi
    IFS=$'\t' read -r provider age < <(printf '%s\n' "$session")
    if ! [[ "$age" =~ ^[0-9]+$ ]]; then
      echo "STALE ${ids[$i]} — ${paths[$i]} — unreadable session age" >&2
      session_failures=$((session_failures + 1))
    elif [ "$age" -le "$active_secs" ]; then
      echo "STALE ${ids[$i]} — ${paths[$i]} — $provider activity ${age}s ago is inside the protected window" >&2
      session_failures=$((session_failures + 1))
    fi
  done
  [ "$session_failures" -eq 0 ]
}

refresh_session_index

echo "Manifest : $manifest"
echo "SHA-256 : $actual_sha"
echo "Targets : ${#ids[@]}"
echo "Freshness: maximum manifest age $max_age; current Git, forge, worktree, and session evidence required"
echo

done_flags=(); done_count=0
for i in "${!ids[@]}"; do
  if already_done "$i"; then
    done_flags[i]=1; done_count=$((done_count + 1))
  else
    done_flags[i]=""
  fi
done

failures=0; preflight_outputs=()
if ! check_active_sessions; then
  failures="$session_failures"
fi

for i in "${!ids[@]}"; do
  if [ -n "${done_flags[$i]}" ]; then
    preflight_outputs[i]=""
    echo "DONE  ${ids[$i]} — ${paths[$i]} — receipt from this manifest"
    continue
  fi
  if ! verify_output=$(
    "$SCRIPT_DIR/reclaim.sh" "${paths[$i]}" \
      --expect-repo "${repos[$i]}" \
      --expect-branch "${branch_refs[$i]}" \
      --expect-head "${heads[$i]}" \
      --expect-common-dir "${common_dirs[$i]}" \
      --expect-git-dir "${git_dirs[$i]}" 2>&1
  ); then
    echo "STALE ${ids[$i]} — ${paths[$i]}" >&2
    printf '%s\n' "$verify_output" | sed 's/^/  /' >&2
    failures=$((failures + 1))
    continue
  fi
  preflight_outputs[i]="$verify_output"
  echo "VALID ${ids[$i]} — ${paths[$i]}"
done

if [ "$failures" -gt 0 ]; then
  echo >&2
  echo "REFUSING: $failures selected target(s) are stale. Nothing from this batch was reclaimed." >&2
  echo "Run a new fleet audit and approve the new manifest hash and selection." >&2
  exit 1
fi

refresh_session_index
if ! check_active_sessions; then
  echo >&2
  echo "REFUSING: session evidence changed during preflight. Nothing from this batch was reclaimed." >&2
  echo "Run a new fleet audit and approve the new manifest hash and selection." >&2
  exit 1
fi

echo
echo "All selected targets passed one complete preflight before mutation."

for i in "${!ids[@]}"; do
  [ -n "${done_flags[$i]}" ] && continue
  echo
  echo "== ${ids[$i]} — ${paths[$i]}"
  reclaim_args=(
    "$SCRIPT_DIR/reclaim.sh" "${paths[$i]}"
    --expect-repo "${repos[$i]}"
    --expect-branch "${branch_refs[$i]}"
    --expect-head "${heads[$i]}"
    --expect-common-dir "${common_dirs[$i]}"
    --expect-git-dir "${git_dirs[$i]}"
  )
  if [ "$execute" -eq 1 ]; then
    reclaim_args+=(--yes --receipt "$(receipt_path "$i")" --manifest-sha256 "$actual_sha" --candidate-id "${ids[$i]}")
    "${reclaim_args[@]}"
  else
    printf '%s\n' "${preflight_outputs[$i]}"
  fi
done

if [ "$execute" -eq 1 ]; then
  echo
  echo "Applied approved manifest set: $((${#ids[@]} - done_count)) target(s) reclaimed, $done_count already done."
else
  echo
  echo "Dry run only. Re-run this exact command with --yes after approving the manifest SHA-256."
fi
