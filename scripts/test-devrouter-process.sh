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
preparing_helper=""
preparing_group=""

cleanup() {
  [ -n "$preparing_helper" ] && kill -KILL "$preparing_helper" 2>/dev/null || true
  [ -n "$preparing_group" ] && kill -KILL -- "-$preparing_group" 2>/dev/null || true
  [ -n "$preparing_helper" ] && wait "$preparing_helper" 2>/dev/null || true
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

status_output="$($HELPER status --name "$name")"
grep -Fq '{"name":"'"$name"'","status":"running"}' <<<"$status_output"
"$HELPER" stop --name "$name" >/dev/null
managed_pid=""
stopped_status="$($HELPER status --name "$name" 2>/dev/null || true)"
grep -Fq '{"name":"'"$name"'","status":"stopped"}' <<<"$stopped_status"

# Matching markers can precede more data than a pipe can buffer. Ownership
# checks must consume the complete environment before judging pipeline status.
large_environment="$(printf '%65536s' '' | tr ' ' x)"
run_helper "large-environment" env -i \
  "DEVROUTER_PROCESS_NAME=$name" \
  DEVROUTER_PROCESS_FINGERPRINT=large-environment \
  "PADDING=$large_environment" /bin/sleep 300
read -r managed_pid _ _ <"$state_file"
large_environment_pid="$managed_pid"
"$HELPER" status --name "$name" >/dev/null
run_helper "large-environment" env -i \
  "DEVROUTER_PROCESS_NAME=$name" \
  DEVROUTER_PROCESS_FINGERPRINT=large-environment \
  "PADDING=$large_environment" /bin/sleep 300
read -r managed_pid _ _ <"$state_file"
[ "$managed_pid" = "$large_environment_pid" ]
"$HELPER" stop --name "$name" >/dev/null
managed_pid=""
unset large_environment

printf '999999 999999 200-1\n' >"$state_file"
if "$HELPER" status --name "$name" >"$test_dir/drifted-status.json" 2>/dev/null; then
  echo "stale process state was incorrectly reported as healthy" >&2
  exit 1
fi
grep -Fq '{"name":"'"$name"'","status":"drifted"}' "$test_dir/drifted-status.json"
rm -f "$state_file"
export WORKSPACE=workspace-a
export DEVROUTER_WORKSPACE=workspace-a
run_default_helper "${command[@]}"
read -r default_pid _ default_fingerprint <"$state_file"
legacy_fingerprint="$({
  printf 'format\0devrouter-process-v2\0name\0%s\0' "$name"
  printf 'workspace\0set\0workspace-a\0devrouter-workspace\0set\0workspace-a\0'
  printf 'adapter-sha256\0unset\0'
  for argument in "${command[@]}"; do printf 'argv\0%s\0' "$argument"; done
} | sha256sum | awk '{print $1}')"
[ "$default_fingerprint" = "$legacy_fingerprint" ]
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

export PREP_TEST_DIR="$test_dir"
prepare="printf 'prepared\\n' >> \"\$PREP_TEST_DIR/prepared\""
run_prepared() {
  "$HELPER" ensure --name "$name" --match "$pattern" --log "$log_file" \
    --prepare-command "$prepare" "$@" -- "${command[@]}"
}

# Both missing and forged state must refuse a foreign process before preparation.
if run_prepared; then
  echo "foreign state incorrectly allowed preparation" >&2
  exit 1
fi
[ ! -e "$test_dir/prepared" ]
rm -f "$state_file"
if run_prepared; then
  echo "foreign process incorrectly allowed preparation" >&2
  exit 1
fi
[ ! -e "$test_dir/prepared" ]
kill -KILL -- "-$foreign_pid"
wait "$foreign_pid" 2>/dev/null || true
foreign_pid=""

for invalid_action in stop status; do
  if "$HELPER" "$invalid_action" --name "$name" --prepare-command ':'; then
    echo "preparation accepted for $invalid_action" >&2
    exit 1
  fi
done
for empty_command in '' '   '; do
  if "$HELPER" ensure --name "$name" --match "$pattern" --prepare-command "$empty_command" -- "${command[@]}"; then
    echo "empty preparation command accepted" >&2
    exit 1
  fi
done
if "$HELPER" ensure --name "$name" --match "$pattern" --prepare-command; then
  echo "missing preparation value accepted" >&2
  exit 1
fi
[ ! -e "$state_file" ]

run_prepared
read -r managed_pid _ prepared_fingerprint <"$state_file"
prepared_pid="$managed_pid"
run_prepared
read -r managed_pid _ _ <"$state_file"
[ "$managed_pid" = "$prepared_pid" ]
[ "$(wc -l < "$test_dir/prepared")" -eq 1 ]
# A trailing newline is part of the exact command identity.
prepare+=$'\n'
run_prepared
read -r managed_pid _ changed_prepared_fingerprint <"$state_file"
[ "$managed_pid" != "$prepared_pid" ]
[ "$changed_prepared_fingerprint" != "$prepared_fingerprint" ]
[ "$(wc -l < "$test_dir/prepared")" -eq 2 ]
run_prepared --fingerprint caller-owned
read -r managed_pid _ _ <"$state_file"
explicit_pid="$managed_pid"
prepare='exit 47'
run_prepared --fingerprint caller-owned
read -r managed_pid _ _ <"$state_file"
[ "$managed_pid" = "$explicit_pid" ]
[ "$(wc -l < "$test_dir/prepared")" -eq 3 ]

# Replacing an owned group must stop even its TERM-ignoring child before preparing.
run_helper before-preparation "${term_ignoring_command[@]}"
read -r managed_pid _ _ <"$state_file"
export PREP_OLD_GROUP="$managed_pid"
prepare='if ps -eo pgid=,stat= | awk -v expected="$PREP_OLD_GROUP" '\''$1 == expected && $2 !~ /^Z/ { found = 1 } END { exit(found ? 0 : 1) }'\''; then exit 48; fi; [ ! -e /proc/$$/fd/9 ]; printf "ordered\n" > "$PREP_TEST_DIR/ordered"'
run_prepared
read -r managed_pid _ _ <"$state_file"
[ -s "$test_dir/ordered" ]
! group_alive "$PREP_OLD_GROUP"

wait_for_file() {
  local attempt
  for attempt in {1..100}; do
    [ ! -s "$1" ] || return 0
    sleep 0.1
  done
  echo "timed out waiting for preparation marker $1" >&2
  return 1
}

# Nested foreground waits are interruptible; the innermost child ignores TERM.
cat > "$test_dir/nested-preparation.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ ! -e /proc/$$/fd/9 ]
printf '%s\n' "$BASHPID" > "$PREP_TEST_DIR/preparation-group"
bash -c 'bash -c '\''trap "" TERM; printf "%s\n" "$BASHPID" > "$PREP_TEST_DIR/nested-child"; while :; do sleep 1; done'\'' & wait' &
wait
EOF
prepare='exec bash "$PREP_TEST_DIR/nested-preparation.sh"'
"$HELPER" ensure --name "$name" --match "$pattern" --log "$log_file" \
  --prepare-command "$prepare" -- "${command[@]}" > "$test_dir/cancel.out" 2>&1 &
preparing_helper=$!
wait_for_file "$test_dir/preparation-group"
read -r preparing_group < "$test_dir/preparation-group"
wait_for_file "$test_dir/nested-child"
read -r nested_child < "$test_dir/nested-child"
[ ! -e "$state_file" ]
! group_alive "$managed_pid"
managed_pid=""

# Contenders cannot enter either active preparation or its TERM grace period.
if DEVROUTER_PROCESS_LOCK_TIMEOUT_SECONDS=0 "$HELPER" stop --name "$name" 2> "$test_dir/lock.err"; then
  echo "lock released during preparation" >&2
  exit 1
else
  [ "$?" -eq 1 ]
fi
kill -TERM "$preparing_helper"
sleep 0.1
if DEVROUTER_PROCESS_LOCK_TIMEOUT_SECONDS=0 "$HELPER" status --name "$name" 2> "$test_dir/cancel-lock.err"; then
  echo "lock released before TERM-ignoring child cleanup" >&2
  exit 1
else
  [ "$?" -eq 1 ]
fi
kill -TERM "$preparing_helper"
cancel_status=0
wait "$preparing_helper" || cancel_status=$?
[ "$cancel_status" -eq 143 ]
preparing_helper=""
! group_alive "$preparing_group"
[ ! -e "/proc/$preparing_group" ]
preparing_group=""
[ ! -e "$state_file" ]
# Container init owns orphan zombie reaping; require it within a bounded interval.
for attempt in {1..50}; do
  [ -e "/proc/$nested_child" ] || break
  sleep 0.1
done
[ ! -e "/proc/$nested_child" ]
! pgrep -f -- "$pattern" > /dev/null
"$HELPER" status --name "$name" > /dev/null

# A failing preparation can leave children: cleanup must finish before returning.
run_helper before-failed-preparation "${command[@]}"
read -r managed_pid _ _ <"$state_file"
before_failure_pid="$managed_pid"
prepare='bash "$PREP_TEST_DIR/nested-preparation.sh" & while [ ! -s "$PREP_TEST_DIR/nested-child" ]; do sleep 0.1; done; exit 49'
rm -f "$test_dir/nested-child" "$test_dir/preparation-group"
if run_prepared 2> "$test_dir/preparation-failed.err"; then
  echo "failed preparation launched a runtime" >&2
  exit 1
else
  [ "$?" -eq 1 ]
fi
read -r nested_child < "$test_dir/nested-child"
! ps -o stat= -p "$nested_child" | grep -Eq '^[[:space:]]*[^Z[:space:]]'
[ ! -e "$state_file" ]
! group_alive "$before_failure_pid"
managed_pid=""
! pgrep -f -- "$pattern" > /dev/null

# A shell returning zero while its foreground contract is incomplete is not success.
prepare='bash "$PREP_TEST_DIR/nested-preparation.sh" & while [ ! -s "$PREP_TEST_DIR/nested-child" ]; do sleep 0.1; done; exit 0'
rm -f "$test_dir/nested-child" "$test_dir/preparation-group"
if run_prepared 2> "$test_dir/preparation-incomplete.err"; then
  echo "preparation with surviving children launched a runtime" >&2
  exit 1
else
  [ "$?" -eq 1 ]
fi
read -r nested_child < "$test_dir/nested-child"
! ps -o stat= -p "$nested_child" | grep -Eq '^[[:space:]]*[^Z[:space:]]'
[ ! -e "$state_file" ]
! pgrep -f -- "$pattern" > /dev/null

# Concurrent ensures prepare once, then the lock waiter reuses the published runtime.
prepare='sleep 1; printf "prepared\n" >> "$PREP_TEST_DIR/concurrent-prepared"'
run_prepared &
first_reconcile=$!
run_prepared &
second_reconcile=$!
wait "$first_reconcile"
wait "$second_reconcile"
read -r managed_pid _ _ <"$state_file"
[ "$(wc -l < "$test_dir/concurrent-prepared")" -eq 1 ]
"$HELPER" stop --name "$name" > /dev/null
managed_pid=""

echo "devrouter-process reconciliation tests passed"
