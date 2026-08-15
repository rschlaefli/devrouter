#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PACKAGE_JSON="$ROOT_DIR/package.json"
EXAMPLE_REPO="$(cd -- "$ROOT_DIR/examples/routing" && pwd -P)"
PROMPT_DIR="$ROOT_DIR/upgrade-prompts"
DIST_FILE="$ROOT_DIR/dist/devrouter.js"

fail() {
  echo "package smoke failed: $*" >&2
  exit 1
}

[[ -f "$PACKAGE_JSON" ]] || fail "package.json is missing"
[[ -f "$EXAMPLE_REPO/.devrouter.yml" ]] || fail "routing example config is missing"
[[ -f "$DIST_FILE" ]] || fail "dist/devrouter.js is missing; run pnpm build first"
[[ -d "$PROMPT_DIR" ]] || fail "upgrade-prompts directory is missing"

TMP_BASE="${TMPDIR:-/tmp}"
[[ -d "$TMP_BASE" && -w "$TMP_BASE" ]] || fail "temporary directory is not writable: $TMP_BASE"
WORK_ROOT="$(mktemp -d "${TMP_BASE%/}/devrouter-package-smoke.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  rm -rf -- "$WORK_ROOT" 2>/dev/null || true
  exit "$status"
}

trap cleanup EXIT HUP INT TERM

PACK_LOG="$WORK_ROOT/pnpm-pack.log"
TAR_MEMBERS="$WORK_ROOT/tar-members.txt"
TAR_LISTING="$WORK_ROOT/tar-listing.txt"
REQUIRED_MEMBERS="$WORK_ROOT/required-members.txt"
EXPECTED_MEMBERS="$WORK_ROOT/expected-members.txt"
BROKEN_MEMBERS="$WORK_ROOT/tar-members-missing-required-entry.txt"
INSTALL_ROOT="$WORK_ROOT/install"
PACKAGE_DIR="$INSTALL_ROOT/node_modules/@devrouter/cli"
PROBE_CWD="$WORK_ROOT/probe-cwd"
PROBE_DIR="$WORK_ROOT/probes"

mkdir -p "$INSTALL_ROOT" "$PROBE_CWD" "$PROBE_DIR" "$WORK_ROOT/home" "$WORK_ROOT/npm-cache"

PACKAGE_VERSION="$(node - "$PACKAGE_JSON" <<'NODE'
const fs = require('node:fs');

const packageJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('package.json version is missing');
}
process.stdout.write(packageJson.version);
NODE
)"

node - "$PACKAGE_JSON" "$ROOT_DIR" "$PROMPT_DIR" "$REQUIRED_MEMBERS" "$EXPECTED_MEMBERS" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [, , packageJsonPath, rootDir, promptDir, requiredOutputPath, expectedOutputPath] = process.argv;
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const binTargets = typeof packageJson.bin === 'string'
  ? [packageJson.bin]
  : Object.values(packageJson.bin ?? {});

if (binTargets.length === 0 || binTargets.some((target) => typeof target !== 'string')) {
  throw new Error('package.json must declare at least one binary target');
}

const normalizeMember = (target) => {
  const normalized = target.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`binary target escapes the package: ${target}`);
  }
  return `package/${normalized}`;
};

const prompts = fs.readdirSync(promptDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .sort();

if (prompts.length === 0) {
  throw new Error('no upgrade prompts found');
}

const required = new Set([
  ...binTargets.map(normalizeMember),
  'package/dist/devrouter.js',
  ...prompts.map((prompt) => `package/upgrade-prompts/${prompt}`),
]);

const missingSource = [...required]
  .map((member) => member.slice('package/'.length))
  .filter((relativePath) => !fs.existsSync(path.join(rootDir, relativePath)));

if (missingSource.length > 0) {
  throw new Error(`required source files are missing: ${missingSource.join(', ')}`);
}

const expected = new Set(['package/package.json', ...required]);
const addPackagedPath = (relativePath) => {
  const absolutePath = path.resolve(rootDir, relativePath);
  const rootPrefix = `${path.resolve(rootDir)}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error(`package.files entry escapes the repository: ${relativePath}`);
  }

  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    expected.add(`package/${path.relative(rootDir, absolutePath).split(path.sep).join('/')}`);
    return;
  }

  if (!stat.isDirectory()) {
    throw new Error(`package.files entry is not a file or directory: ${relativePath}`);
  }

  for (const entry of fs.readdirSync(absolutePath)) {
    addPackagedPath(path.join(relativePath, entry));
  }
};

for (const entry of packageJson.files ?? []) {
  addPackagedPath(entry);
}

for (const metadataFile of ['README.md', 'LICENSE', 'LICENSE.md', 'NOTICE']) {
  if (fs.existsSync(path.join(rootDir, metadataFile))) {
    expected.add(`package/${metadataFile}`);
  }
}

fs.writeFileSync(requiredOutputPath, `${[...required].sort().join('\n')}\n`);
fs.writeFileSync(expectedOutputPath, `${[...expected].sort().join('\n')}\n`);
NODE

echo "Packing @devrouter/cli $PACKAGE_VERSION from $ROOT_DIR"
if ! (cd "$ROOT_DIR" && pnpm pack --pack-destination "$WORK_ROOT") >"$PACK_LOG" 2>&1; then
  cat "$PACK_LOG" >&2
  fail "pnpm pack failed"
fi

TARBALLS=()
while IFS= read -r tarball; do
  [[ -n "$tarball" ]] && TARBALLS+=("$tarball")
done < <(find "$WORK_ROOT" -maxdepth 1 -type f -name '*.tgz' -print | sort)

[[ "${#TARBALLS[@]}" -eq 1 ]] || fail "expected one packed tarball, found ${#TARBALLS[@]}"
TARBALL="${TARBALLS[0]}"

tar -tzf "$TARBALL" | sed '/\/$/d' | sort -u >"$TAR_MEMBERS"
tar -tvzf "$TARBALL" >"$TAR_LISTING"

assert_exact_members() {
  local actual_file="$1"
  local expected_file="$2"

  if cmp -s "$actual_file" "$expected_file"; then
    return 0
  fi

  diff -u "$expected_file" "$actual_file" >&2 || true
  return 1
}

assert_exact_members "$TAR_MEMBERS" "$EXPECTED_MEMBERS" || fail "packed assets are incomplete"

REMOVED_MEMBER="$(sed -n '1p' "$REQUIRED_MEMBERS")"
grep -Fvx "$REMOVED_MEMBER" "$TAR_MEMBERS" >"$BROKEN_MEMBERS"
if assert_exact_members "$BROKEN_MEMBERS" "$EXPECTED_MEMBERS" >"$WORK_ROOT/missing-member-check.log" 2>&1; then
  fail "the tarball member checker did not reject a missing required member"
fi
echo "Negative member check passed: rejected missing $REMOVED_MEMBER"

assert_tar_executable() {
  local member="$1"
  if ! awk -v expected="$member" '$NF == expected { found = 1; executable = substr($1, 1, 4) == "-rwx" } END { exit !(found && executable) }' "$TAR_LISTING"; then
    fail "packed binary is not executable: $member"
  fi
}

while IFS= read -r member; do
  [[ "$member" == package/* ]] || fail "unexpected member path: $member"
done <"$REQUIRED_MEMBERS"

while IFS= read -r member; do
  case "$member" in
    package/bin/*|package/dist/*) assert_tar_executable "$member" ;;
  esac
done <"$REQUIRED_MEMBERS"

echo "Packed tarball verified: $TARBALL"

if ! (
  cd "$PROBE_CWD"
  HOME="$WORK_ROOT/home" npm_config_cache="$WORK_ROOT/npm-cache" \
    npm install --ignore-scripts --no-audit --no-fund --prefix "$INSTALL_ROOT" --no-save "$TARBALL"
) >"$WORK_ROOT/npm-install.log" 2>&1; then
  cat "$WORK_ROOT/npm-install.log" >&2
  fail "isolated tarball installation failed"
fi

[[ -d "$PACKAGE_DIR" ]] || fail "installed package directory is missing: $PACKAGE_DIR"
PACKAGE_DIR="$(cd -- "$PACKAGE_DIR" && pwd -P)"
[[ -x "$INSTALL_ROOT/node_modules/.bin/devrouter" ]] || fail "installed devrouter binary is not executable"
[[ -x "$INSTALL_ROOT/node_modules/.bin/devrouter-process" ]] || fail "installed devrouter-process binary is not executable"

assert_installed_binary() {
  local binary="$1"
  local resolved

  resolved="$(node - "$binary" <<'NODE'
const fs = require('node:fs');
process.stdout.write(fs.realpathSync(process.argv[2]));
NODE
)"

  case "$resolved" in
    "$PACKAGE_DIR"/*) ;;
    *) fail "installed binary resolves outside the temporary package: $binary -> $resolved" ;;
  esac
}

assert_installed_binary "$INSTALL_ROOT/node_modules/.bin/devrouter"
assert_installed_binary "$INSTALL_ROOT/node_modules/.bin/devrouter-process"

DEVROUTER_BIN="$INSTALL_ROOT/node_modules/.bin/devrouter"
INSTALLED_PROMPT_DIR="$PACKAGE_DIR/upgrade-prompts"

run_probe() {
  local name="$1"
  shift
  local output="$PROBE_DIR/$name.txt"

  if ! (cd "$PROBE_CWD" && "$@") >"$output" 2>&1; then
    cat "$output" >&2
    fail "probe failed: $name"
  fi
}

run_probe help "$DEVROUTER_BIN" --help
grep -Fq 'Usage: devrouter' "$PROBE_DIR/help.txt" || fail "help probe did not identify devrouter"
grep -Fq 'workspace' "$PROBE_DIR/help.txt" || fail "help probe omitted workspace command"

run_probe version "$DEVROUTER_BIN" -V --repo "$EXAMPLE_REPO"
grep -Fq "Installed CLI version: $PACKAGE_VERSION" "$PROBE_DIR/version.txt" || fail "version probe used the wrong package version"
grep -Fq "Local repo version ($EXAMPLE_REPO/.devrouter.yml):" "$PROBE_DIR/version.txt" || fail "version probe used the wrong repository path"

run_probe upgrade "$DEVROUTER_BIN" upgrade --repo "$EXAMPLE_REPO"
grep -Fq "Prompt source: $INSTALLED_PROMPT_DIR" "$PROBE_DIR/upgrade.txt" || fail "upgrade probe did not use packaged prompts"
grep -Fq "Current version: $PACKAGE_VERSION" "$PROBE_DIR/upgrade.txt" || fail "upgrade probe used the wrong current version"
grep -Fq 'No newer upgrade targets are available.' "$PROBE_DIR/upgrade.txt" || fail "upgrade probe returned an unexpected target status"

run_probe inspect "$DEVROUTER_BIN" repo inspect --repo "$EXAMPLE_REPO" --json
node - "$PROBE_DIR/inspect.txt" "$EXAMPLE_REPO" <<'NODE'
const fs = require('node:fs');

const [, , outputPath, expectedRepoPath] = process.argv;
const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
const requiredFields = [
  'repoPath',
  'scripts',
  'apps',
  'services',
  'env',
  'devcontainer',
  'devrouter',
  'agentGuidance',
  'issues',
];

for (const field of requiredFields) {
  if (!(field in report)) {
    throw new Error(`inspection JSON is missing ${field}`);
  }
}

if (report.repoPath !== expectedRepoPath) {
  throw new Error(`inspection JSON repoPath mismatch: ${report.repoPath}`);
}

for (const field of ['scripts', 'apps', 'services', 'agentGuidance', 'issues']) {
  if (!Array.isArray(report[field])) {
    throw new Error(`inspection JSON field is not an array: ${field}`);
  }
}

for (const field of ['env', 'devcontainer', 'devrouter']) {
  if (report[field] === null || typeof report[field] !== 'object' || Array.isArray(report[field])) {
    throw new Error(`inspection JSON field is not an object: ${field}`);
  }
}
NODE

echo "Installed package verified from temporary cwd: $PROBE_CWD"
echo "Package smoke passed; temporary artifacts will be removed on exit."
