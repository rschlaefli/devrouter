#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${DEVROUTER_PROCESS_HELPER:-$ROOT/bin/devrouter-process}"

if [ ! -r "/proc/$$/environ" ]; then
  echo "devrouter-process tests skipped: Linux /proc is unavailable"
  exit 0
fi

test_dir="$(mktemp -d)"
name="test-$$"
state_file="$test_dir/devrouter-process-$name.state"
log_file="$test_dir/process.log"
pattern="devrouter-process-test-$$"
managed_pid=""
foreign_pid=""

cleanup() {
  [ -n "$managed_pid" ] && kill -KILL -- "-$managed_pid" 2>/dev/null || true
  [ -n "$foreign_pid" ] && kill -KILL -- "-$foreign_pid" 2>/dev/null || true
  [ -n "$foreign_pid" ] && wait "$foreign_pid" 2>/dev/null || true
  rm -rf "$test_dir"
}
trap cleanup EXIT

export DEVROUTER_PROCESS_STATE_DIR="$test_dir"
export DEVROUTER_PROCESS_TERM_TIMEOUT_SECONDS=1
export DEVROUTER_PROCESS_KILL_TIMEOUT_SECONDS=2

group_alive() {
  ps -eo pgid=,stat= | awk -v expected="$1" '
    $1 == expected && $2 !~ /^Z/ { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

stop_managed_for_test() {
  local pgid="$1"
  local attempt

  kill -KILL -- "-$pgid" 2>/dev/null || true
  for ((attempt = 1; attempt <= 20; attempt += 1)); do
    group_alive "$pgid" || return 0
    sleep 0.1
  done
  echo "test process group $pgid did not stop" >&2
  return 1
}

run_helper() {
  local fingerprint="$1"
  shift
  "$HELPER" ensure \
    --name "$name" \
    --match "$pattern" \
    --fingerprint "$fingerprint" \
    --log "$log_file" \
    -- "$@"
}

run_default_helper() {
  "$HELPER" ensure \
    --name "$name" \
    --match "$pattern" \
    --log "$log_file" \
    -- "$@"
}

command=(bash -c "exec -a '$pattern' sleep 300")
run_helper "100-1" "${command[@]}" &
first_reconcile=$!
run_helper "100-1" "${command[@]}" &
second_reconcile=$!
wait "$first_reconcile"
wait "$second_reconcile"
read -r first_pid _ _ <"$state_file"
managed_pid="$first_pid"
[ "$(pgrep -fc -- "$pattern")" = "1" ]

run_helper "100-1" "${command[@]}"
read -r matching_pid matching_pgid matching_fingerprint <"$state_file"
[ "$matching_pid" = "$first_pid" ]

printf '%s %s\n' "$matching_pid" "$matching_pgid" >"$state_file"
if run_helper "100-1" "${command[@]}" 2>"$test_dir/missing-fingerprint.err"; then
  echo "state without a fingerprint was incorrectly accepted" >&2
  exit 1
fi
grep -Fq "Invalid state while an unowned '$name' process is running" "$test_dir/missing-fingerprint.err"
kill -0 "$matching_pid"
printf '%s %s %s\n' "$matching_pid" "$matching_pgid" "$matching_fingerprint" >"$state_file"

run_helper "200-1" "${command[@]}"
read -r changed_pid _ _ <"$state_file"
[ "$changed_pid" != "$first_pid" ]
if kill -0 "$first_pid" 2>/dev/null; then
  echo "old process group survived a fingerprint change" >&2
  exit 1
fi
managed_pid="$changed_pid"

stop_managed_for_test "$managed_pid"
printf '999999 999999 200-1\n' >"$state_file"
run_helper "300-1" "${command[@]}"
read -r stale_replacement_pid _ _ <"$state_file"
[ "$stale_replacement_pid" != "999999" ]
managed_pid="$stale_replacement_pid"

term_ignoring_command=(
  bash
  -c
  "trap 'exit 0' TERM; bash -c 'trap \"\" TERM; exec -a \"$pattern\" sleep 300' & wait"
)
run_helper "350-1" "${term_ignoring_command[@]}"
read -r term_ignoring_pid _ _ <"$state_file"
managed_pid="$term_ignoring_pid"
run_helper "360-1" "${command[@]}"
if group_alive "$term_ignoring_pid"; then
  echo "TERM-ignoring child survived process-group replacement" >&2
  exit 1
fi
read -r managed_pid _ _ <"$state_file"

stop_managed_for_test "$managed_pid"
managed_pid=""
rm -f "$state_file"
export WORKSPACE=workspace-a
export DEVROUTER_WORKSPACE=workspace-a
run_default_helper "${command[@]}"
read -r default_pid _ default_fingerprint <"$state_file"
managed_pid="$default_pid"
run_default_helper "${command[@]}"
read -r matching_default_pid _ matching_default_fingerprint <"$state_file"
[ "$matching_default_pid" = "$default_pid" ]
[ "$matching_default_fingerprint" = "$default_fingerprint" ]
export DEVROUTER_WORKSPACE=workspace-b
run_default_helper "${command[@]}"
read -r changed_workspace_pid _ changed_workspace_fingerprint <"$state_file"
[ "$changed_workspace_pid" != "$default_pid" ]
[ "$changed_workspace_fingerprint" != "$default_fingerprint" ]
managed_pid="$changed_workspace_pid"

export DEVROUTER_PROCESS_ADAPTER_SHA256="$(printf 'a%.0s' {1..64})"
run_default_helper "${command[@]}"
read -r adapter_a_pid _ adapter_a_fingerprint <"$state_file"
[ "$adapter_a_pid" != "$changed_workspace_pid" ]
managed_pid="$adapter_a_pid"
run_default_helper "${command[@]}"
read -r matching_adapter_pid _ matching_adapter_fingerprint <"$state_file"
[ "$matching_adapter_pid" = "$adapter_a_pid" ]
[ "$matching_adapter_fingerprint" = "$adapter_a_fingerprint" ]
export DEVROUTER_PROCESS_ADAPTER_SHA256="$(printf 'b%.0s' {1..64})"
run_default_helper "${command[@]}"
read -r adapter_b_pid _ adapter_b_fingerprint <"$state_file"
[ "$adapter_b_pid" != "$adapter_a_pid" ]
[ "$adapter_b_fingerprint" != "$adapter_a_fingerprint" ]
managed_pid="$adapter_b_pid"

export DEVROUTER_PROCESS_FINGERPRINT_ENV=PUBLIC_ORIGIN
unset PUBLIC_ORIGIN
run_default_helper "${command[@]}"
read -r origin_unset_pid _ origin_unset_fingerprint <"$state_file"
[ "$origin_unset_pid" != "$adapter_b_pid" ]
managed_pid="$origin_unset_pid"
export PUBLIC_ORIGIN=""
run_default_helper "${command[@]}"
read -r origin_empty_pid _ origin_empty_fingerprint <"$state_file"
[ "$origin_empty_pid" != "$origin_unset_pid" ]
[ "$origin_empty_fingerprint" != "$origin_unset_fingerprint" ]
managed_pid="$origin_empty_pid"
run_default_helper "${command[@]}"
read -r matching_empty_pid _ matching_empty_fingerprint <"$state_file"
[ "$matching_empty_pid" = "$origin_empty_pid" ]
[ "$matching_empty_fingerprint" = "$origin_empty_fingerprint" ]
export PUBLIC_ORIGIN="https://runtime-origin.example.invalid"
run_default_helper "${command[@]}"
read -r origin_value_pid _ origin_value_fingerprint <"$state_file"
[ "$origin_value_pid" != "$origin_empty_pid" ]
[ "$origin_value_fingerprint" != "$origin_empty_fingerprint" ]
managed_pid="$origin_value_pid"

export FIRST_PUBLIC_ORIGIN="https://first-origin.example.invalid"
export SECOND_PUBLIC_ORIGIN="https://second-origin.example.invalid"
export DEVROUTER_PROCESS_FINGERPRINT_ENV=SECOND_PUBLIC_ORIGIN,FIRST_PUBLIC_ORIGIN,SECOND_PUBLIC_ORIGIN
run_default_helper "${command[@]}"
read -r sorted_origin_pid _ sorted_origin_fingerprint <"$state_file"
[ "$sorted_origin_pid" != "$origin_value_pid" ]
managed_pid="$sorted_origin_pid"
export DEVROUTER_PROCESS_FINGERPRINT_ENV=FIRST_PUBLIC_ORIGIN,SECOND_PUBLIC_ORIGIN
run_default_helper "${command[@]}"
read -r reordered_origin_pid _ reordered_origin_fingerprint <"$state_file"
[ "$reordered_origin_pid" = "$sorted_origin_pid" ]
[ "$reordered_origin_fingerprint" = "$sorted_origin_fingerprint" ]

export UNDECLARED_RUNTIME_VALUE=first
export API_TOKEN=first-secret-value
run_default_helper "${command[@]}"
read -r undeclared_first_pid _ undeclared_first_fingerprint <"$state_file"
[ "$undeclared_first_pid" = "$sorted_origin_pid" ]
export UNDECLARED_RUNTIME_VALUE=second
export API_TOKEN=second-secret-value
run_default_helper "${command[@]}"
read -r undeclared_second_pid _ undeclared_second_fingerprint <"$state_file"
[ "$undeclared_second_pid" = "$sorted_origin_pid" ]
[ "$undeclared_second_fingerprint" = "$undeclared_first_fingerprint" ]

for raw_value in \
  "https://runtime-origin.example.invalid" \
  "https://first-origin.example.invalid" \
  "https://second-origin.example.invalid" \
  "first-secret-value" \
  "second-secret-value"; do
  if grep -R -Fq "$raw_value" "$test_dir"; then
    echo "environment value leaked into process state or logs" >&2
    exit 1
  fi
done
export DEVROUTER_PROCESS_FINGERPRINT_ENV=FIRST_PUBLIC_ORIGIN,API_TOKEN
if run_default_helper "${command[@]}" 2>"$test_dir/secret-name.err"; then
  echo "secret-like fingerprint name was incorrectly accepted" >&2
  exit 1
fi
grep -Fq "rejects secret-like name 'API_TOKEN'" "$test_dir/secret-name.err"
kill -0 "$managed_pid"

unset WORKSPACE DEVROUTER_WORKSPACE DEVROUTER_PROCESS_ADAPTER_SHA256
unset DEVROUTER_PROCESS_FINGERPRINT_ENV PUBLIC_ORIGIN FIRST_PUBLIC_ORIGIN SECOND_PUBLIC_ORIGIN
unset UNDECLARED_RUNTIME_VALUE API_TOKEN

stop_managed_for_test "$managed_pid"
managed_pid=""
rm -f "$state_file"

setsid bash -c "exec -a '$pattern' sleep 300" >/dev/null 2>&1 </dev/null &
foreign_pid=$!
if run_helper "400-1" "${command[@]}"; then
  echo "foreign process was incorrectly accepted" >&2
  exit 1
fi
kill -0 "$foreign_pid"

printf '%s %s %s\n' "$foreign_pid" "$foreign_pid" "400-1" >"$state_file"
if run_helper "400-1" "${command[@]}"; then
  echo "forged foreign state was incorrectly accepted" >&2
  exit 1
fi
kill -0 "$foreign_pid"

echo "devrouter-process reconciliation tests passed"
