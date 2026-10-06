#!/usr/bin/env bash
# Deterministic manifest/apply tests. All mutation stays inside temporary repos.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.agents/skills/worktree-reclaim"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/worktree-reclaim-manifest-test.XXXXXX")"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'chmod -R u+w "$TEST_ROOT" 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT
export HOME="$TEST_ROOT/home" WORKTREE_RECLAIM_DEVROUTER_HOME="$TEST_ROOT/devrouter-home"
mkdir -p "$HOME"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local actual="$1" expected="$2"
  [[ "$actual" == *"$expected"* ]] || fail "expected [$actual] to contain [$expected]"
}

assert_not_contains() {
  local actual="$1" unexpected="$2"
  [[ "$actual" != *"$unexpected"* ]] || fail "expected [$actual] not to contain [$unexpected]"
}

make_stub() {
  local path="$1"
  shift
  printf '%s\n' '#!/usr/bin/env bash' "$@" > "$path"
  chmod +x "$path"
}

STUBS="$TEST_ROOT/bin"
mkdir -p "$STUBS"
# These single-quoted lines are the generated stub body.
# shellcheck disable=SC2016
make_stub "$STUBS/gh" \
  'branch=""' \
  'while [ $# -gt 0 ]; do if [ "$1" = --head ]; then branch="$2"; break; fi; shift; done' \
  'case "$branch" in' \
  '  feat/one) printf "MERGED 1 %s\n" "$TEST_HEAD_ONE" ;;' \
  '  feat/two) printf "MERGED 2 %s\n" "$TEST_HEAD_TWO" ;;' \
  '  *) exit 0 ;;' \
  'esac'
# These single-quoted lines are the generated stub body.
# shellcheck disable=SC2016
make_stub "$STUBS/devpod" \
  'if [ "${WORKTREE_RECLAIM_TEST_DEVPOD_FAIL:-}" = 1 ]; then exit 1; fi' \
  'if [ -n "${WORKTREE_RECLAIM_TEST_SESSION_FILE:-}" ]; then' \
  '  printf '\''{"type":"session_meta","payload":{"cwd":"%s"}}\n'\'' "$WORKTREE_RECLAIM_TEST_SESSION_CWD" > "$WORKTREE_RECLAIM_TEST_SESSION_FILE"' \
  '  python3 -c '\''import os,sys; now=int(sys.argv[2]); os.utime(sys.argv[1], (now, now))'\'' "$WORKTREE_RECLAIM_TEST_SESSION_FILE" "$WORKTREE_RECLAIM_NOW_EPOCH"' \
  'fi' \
  'if [ "${1:-}" = list ]; then printf "[]\n"; exit 0; fi' \
  'echo "unexpected devpod mutation in manifest test" >&2' \
  'exit 1'
make_stub "$STUBS/devsy" "echo '[]'"
export PATH="$STUBS:$PATH" WORKTREE_RECLAIM_NO_DEVROUTER=1
# Each case needs live stub answers, not a bulk PR listing cached by an earlier case.
export WORKTREE_RECLAIM_PR_CACHE_TTL=0

REPO="$TEST_ROOT/repo"
WT_ONE="$TEST_ROOT/worktree-one"
WT_TWO="$TEST_ROOT/worktree-two"
git init -q "$REPO"
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "Worktree Reclaim Manifest Test"
printf 'fixture\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm "test: seed fixture"
git -C "$REPO" branch -M main
git -C "$REPO" remote add origin git@github.com:example/manifest-test.git
git -C "$REPO" worktree add -qb feat/one "$WT_ONE" main
git -C "$REPO" worktree add -qb feat/two "$WT_TWO" main

if "$SKILL_DIR/scripts/reclaim.sh" "$REPO" --verify-only > "$TEST_ROOT/primary.out" 2>&1; then
  fail "expected reclaim to reject the primary checkout"
fi
assert_contains "$(cat "$TEST_ROOT/primary.out")" "primary checkout is never a reclaim target"

export TEST_HEAD_ONE TEST_HEAD_TWO
TEST_HEAD_ONE=$(git -C "$WT_ONE" rev-parse HEAD)
TEST_HEAD_TWO=$(git -C "$WT_TWO" rev-parse HEAD)

CODEX_STORE="$TEST_ROOT/codex"
CLAUDE_STORE="$TEST_ROOT/claude"
mkdir -p "$CODEX_STORE" "$CLAUDE_STORE"
export WORKTREE_RECLAIM_CODEX_SESSIONS_DIR="$CODEX_STORE"
export WORKTREE_RECLAIM_CLAUDE_PROJECTS_DIR="$CLAUDE_STORE"
export WORKTREE_RECLAIM_NOW_EPOCH=2000000000

MANIFEST="$TEST_ROOT/candidates.json"
"$SKILL_DIR/scripts/fleet-audit.sh" "$REPO" --active-within 7d --all-history --manifest > "$MANIFEST"
HASH=$(python3 "$SKILL_DIR/scripts/manifest.py" hash "$MANIFEST")

JSON_REPORT="$TEST_ROOT/report.json"
"$SKILL_DIR/scripts/fleet-audit.sh" "$REPO" --active-within 7d --all-history --json > "$JSON_REPORT"
python3 - "$JSON_REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert set(report) == {"activeWithin", "history", "rows"}
expected_row = {"repo", "path", "branch", "verdict", "codes", "reason", "extra", "session_provider", "session_age_seconds", "size_kb"}
assert all(set(row) == expected_row for row in report["rows"])
PY

count=$(python3 - "$MANIFEST" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["candidateCount"])
PY
)
[ "$count" -eq 2 ] || fail "expected two manifest candidates, got $count"

ID_ONE=$(python3 - "$MANIFEST" "$WT_ONE" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
print(next(row["id"] for row in manifest["candidates"] if row["path"] == sys.argv[2]))
PY
)
SUBSET="$TEST_ROOT/subset.json"
python3 "$SKILL_DIR/scripts/manifest.py" select "$MANIFEST" --expected-sha256 "$HASH" --id "$ID_ONE" > "$SUBSET"
SUBSET_HASH=$(python3 "$SKILL_DIR/scripts/manifest.py" hash "$SUBSET")

result=$("$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH")
assert_contains "$result" "Targets : 1"
assert_contains "$result" "$WT_ONE"
assert_not_contains "$result" "$WT_TWO"
assert_contains "$result" "Dry run only"

export WORKTREE_RECLAIM_TEST_DEVPOD_FAIL=1
if "$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH" > "$TEST_ROOT/devpod-fail.out" 2>&1; then
  fail "expected unavailable DevPod ownership evidence to fail closed"
fi
assert_contains "$(cat "$TEST_ROOT/devpod-fail.out")" "cannot list DevPods"
unset WORKTREE_RECLAIM_TEST_DEVPOD_FAIL

mkdir -p "$CODEX_STORE/2033/05/18"
SESSION="$CODEX_STORE/2033/05/18/recent.jsonl"
export WORKTREE_RECLAIM_TEST_SESSION_FILE="$SESSION"
export WORKTREE_RECLAIM_TEST_SESSION_CWD="$WT_ONE"
if "$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH" > "$TEST_ROOT/preflight-session.out" 2>&1; then
  fail "expected activity created during target preflight to abort before mutation"
fi
assert_contains "$(cat "$TEST_ROOT/preflight-session.out")" "session evidence changed during preflight"
unset WORKTREE_RECLAIM_TEST_SESSION_FILE WORKTREE_RECLAIM_TEST_SESSION_CWD
rm "$SESSION"

ZERO_HASH=$(printf '0%.0s' {1..64})
if "$SKILL_DIR/scripts/apply-manifest.sh" "$MANIFEST" --sha256 "$ZERO_HASH" > "$TEST_ROOT/wrong-hash.out" 2>&1; then
  fail "expected a wrong manifest hash to fail"
fi
assert_contains "$(cat "$TEST_ROOT/wrong-hash.out")" "SHA-256 mismatch"

TAMPERED="$TEST_ROOT/tampered.json"
cp "$MANIFEST" "$TAMPERED"
printf ' ' >> "$TAMPERED"
if "$SKILL_DIR/scripts/apply-manifest.sh" "$TAMPERED" --sha256 "$HASH" > "$TEST_ROOT/tampered.out" 2>&1; then
  fail "expected a modified manifest to fail"
fi
assert_contains "$(cat "$TEST_ROOT/tampered.out")" "SHA-256 mismatch"

# A trim manifest belongs to devrouter; the skill refuses to apply one.
TRIM="$TEST_ROOT/trim.json"
python3 - "$MANIFEST" "$TRIM" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["action"] = "trim"
for row in manifest["candidates"]:
    row["paths"] = ["node_modules"]
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
    handle.write("\n")
PY
TRIM_HASH=$(python3 "$SKILL_DIR/scripts/manifest.py" hash "$TRIM")
if "$SKILL_DIR/scripts/apply-manifest.sh" "$TRIM" --sha256 "$TRIM_HASH" > "$TEST_ROOT/trim.out" 2>&1; then
  fail "expected the skill to refuse a trim manifest"
fi
assert_contains "$(cat "$TEST_ROOT/trim.out")" "devrouter workspace trim"

export WORKTREE_RECLAIM_NOW_EPOCH=2000086401
if "$SKILL_DIR/scripts/apply-manifest.sh" "$MANIFEST" --sha256 "$HASH" > "$TEST_ROOT/expired.out" 2>&1; then
  fail "expected an expired manifest to fail"
fi
assert_contains "$(cat "$TEST_ROOT/expired.out")" "maximum allowed age"
export WORKTREE_RECLAIM_NOW_EPOCH=2000000000

printf '{"type":"session_meta","payload":{"cwd":"%s"}}\n' "$WT_ONE" > "$SESSION"
python3 - "$SESSION" "$WORKTREE_RECLAIM_NOW_EPOCH" <<'PY'
import os, sys
now = int(sys.argv[2])
os.utime(sys.argv[1], (now, now))
PY
if "$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH" > "$TEST_ROOT/recent.out" 2>&1; then
  fail "expected new agent activity to make the manifest stale"
fi
assert_contains "$(cat "$TEST_ROOT/recent.out")" "inside the protected window"

python3 - "$SESSION" "$WORKTREE_RECLAIM_NOW_EPOCH" <<'PY'
import os, sys
old = int(sys.argv[2]) - 8 * 86400
os.utime(sys.argv[1], (old, old))
PY

printf 'new local commit\n' > "$WT_TWO/after-approval.txt"
git -C "$WT_TWO" add after-approval.txt
git -C "$WT_TWO" commit -qm "test: move second target after approval"
if "$SKILL_DIR/scripts/apply-manifest.sh" "$MANIFEST" --sha256 "$HASH" --yes > "$TEST_ROOT/stale-head.out" 2>&1; then
  fail "expected one stale target to abort the entire batch"
fi
assert_contains "$(cat "$TEST_ROOT/stale-head.out")" "Nothing from this batch was reclaimed"
[ -d "$WT_ONE" ] || fail "first target was reclaimed before the stale second target was detected"
[ -d "$WT_TWO" ] || fail "stale second target was reclaimed"

TEST_HEAD_TWO=$(git -C "$WT_TWO" rev-parse HEAD)
export TEST_HEAD_TWO
"$SKILL_DIR/scripts/fleet-audit.sh" "$REPO" --active-within 7d --all-history --manifest > "$MANIFEST"
HASH=$(python3 "$SKILL_DIR/scripts/manifest.py" hash "$MANIFEST")
ID_ONE=$(python3 - "$MANIFEST" "$WT_ONE" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
print(next(row["id"] for row in manifest["candidates"] if row["path"] == sys.argv[2]))
PY
)
python3 "$SKILL_DIR/scripts/manifest.py" select "$MANIFEST" --expected-sha256 "$HASH" --id "$ID_ONE" > "$SUBSET"
SUBSET_HASH=$(python3 "$SKILL_DIR/scripts/manifest.py" hash "$SUBSET")

STALE_WT="$TEST_ROOT/stale-registration"
git -C "$REPO" worktree add -qb feat/stale "$STALE_WT" main
mv "$STALE_WT" "$STALE_WT.moved"

result=$("$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH" --yes)
assert_contains "$result" "Applied approved manifest set: 1 target(s) reclaimed, 0 already done."
[ ! -d "$WT_ONE" ] || fail "approved target still exists after apply"
[ -d "$WT_TWO" ] || fail "unselected worktree was removed"
git -C "$REPO" show-ref --verify --quiet refs/heads/feat/one && fail "approved branch was retained"
listed=$(git -C "$REPO" worktree list --porcelain)
assert_contains "$listed" "$STALE_WT"

# The apply left a receipt, so re-running the same approved manifest after an
# interruption reports the gone target as done instead of stale.
RECEIPT="$REPO/.git/worktree-reclaim/receipts/$SUBSET_HASH/$ID_ONE.json"
[ -f "$RECEIPT" ] || fail "expected a receipt at $RECEIPT"
python3 - "$RECEIPT" "$SUBSET_HASH" "$ID_ONE" <<'PY'
import json, sys
receipt = json.load(open(sys.argv[1]))
assert receipt["kind"] == "worktree-reclaim-receipt" and receipt["schemaVersion"] == 1
assert receipt["manifestSha256"] == sys.argv[2] and receipt["candidateId"] == sys.argv[3]
assert receipt["steps"] == ["worktree-removed", "branch-deleted"]
PY
result=$("$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH" --yes)
assert_contains "$result" "DONE  $ID_ONE"
assert_contains "$result" "0 target(s) reclaimed, 1 already done."

# Without a receipt a vanished target stays a failure.
rm "$RECEIPT"
if "$SKILL_DIR/scripts/apply-manifest.sh" "$SUBSET" --sha256 "$SUBSET_HASH" > "$TEST_ROOT/gone.out" 2>&1; then
  fail "expected a target that vanished without a receipt to be stale"
fi
assert_contains "$(cat "$TEST_ROOT/gone.out")" "STALE $ID_ONE"

printf 'PASS: manifest hash/age, exact selection, JSON report, trim refusal, live activity, all-target preflight, scoped apply, and receipts\n'
