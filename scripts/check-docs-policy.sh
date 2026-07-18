#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCT_DOCS=(
  "README.md"
  "docs/README.md"
  "docs/GETTING_STARTED.md"
  "docs/DEVCONTAINER.md"
  "docs/REPO_ONBOARDING.md"
  "examples/routing/README.md"
  "examples/devcontainer/README.md"
  "examples/workspace/README.md"
)

CURRENT_GUIDANCE_SURFACES=(
  "${PRODUCT_DOCS[@]}"
  "AGENTS.md"
  ".agents/skills/devrouter/SKILL.md"
  ".agents/skills/devcontainer-onboarding/SKILL.md"
  ".agents/skills/devcontainer-onboarding/GOTCHAS.md"
  ".agents/skills/devcontainer-onboarding/REFERENCE.md"
  "src/core/agents-md.ts"
  "src/core/router.ts"
)

MANAGED_DEVCONTAINER_ROOTS=(
  "examples/devcontainer/.devcontainer"
  ".agents/skills/devcontainer-onboarding/references"
)

violations="false"

if grep -n -H -E -e 'Compatibility note:' -e 'older versions' -e 'v[0-9]+\.[0-9]+\.[0-9]+' "${PRODUCT_DOCS[@]}"; then
  echo
  echo "Docs policy violation: product docs contain migration/version-history markers."
  echo "Keep those details in CHANGELOG.md and upgrade-prompts/*.md only."
  violations="true"
fi

if grep -n -H -E -e '^### Agent Adaptation Prompt$' -e '^Agent adaptation prompt:' "${PRODUCT_DOCS[@]}"; then
  echo
  echo "Docs policy violation: product docs contain adaptation prompt blocks/references."
  echo "Keep adaptation prompts in CHANGELOG.md and upgrade-prompts/*.md only."
  violations="true"
fi

if grep -n -H -- '--env-map' "${CURRENT_GUIDANCE_SURFACES[@]}"; then
  echo
  echo "Docs policy violation: current guidance mentions removed --env-map CLI flag."
  echo "Use config-level dependency envMap examples instead. Historical mentions belong only in CHANGELOG.md or upgrade-prompts/*.md."
  violations="true"
fi

for root in "${MANAGED_DEVCONTAINER_ROOTS[@]}"; do
  dockerfile="$root/Dockerfile"
  devcontainer_json="$root/devcontainer.json"
  for required_file in "$dockerfile" "$devcontainer_json"; do
    if [ ! -f "$required_file" ]; then
      echo
      echo "Docs policy violation: missing managed devcontainer contract file: $required_file"
      violations="true"
    fi
  done
  if [ -f "$dockerfile" ] && grep -n -H -E -e '@devrouter/cli' -e 'devrouter-process' "$dockerfile"; then
    echo
    echo "Docs policy violation: a consumer Dockerfile installs or extracts devrouter artifacts."
    echo "Keep the image helper-free; devrouter ensure delivers its matching helper at runtime."
    violations="true"
  fi
  if [ -f "$devcontainer_json" ] && grep -n -H -- 'postStartCommand' "$devcontainer_json"; then
    echo
    echo "Docs policy violation: a managed devcontainer wires postStartCommand directly."
    echo "devrouter ensure must deliver the helper before invoking the repository adapter."
    violations="true"
  fi
done

release_count="$(grep -c -E '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md)"
prompt_ref_count="$(grep -c -E '^Agent adaptation prompt: \./upgrade-prompts/[0-9]+\.[0-9]+\.[0-9]+\.md$' CHANGELOG.md)"

if [ "$release_count" -ne "$prompt_ref_count" ]; then
  echo
  echo "Docs policy violation: CHANGELOG release/prompt-reference mismatch."
  echo "Releases: $release_count  Prompt references: $prompt_ref_count"
  violations="true"
fi

while read -r rel_path; do
  [ -f "$rel_path" ] || {
    echo
    echo "Docs policy violation: missing prompt file referenced by CHANGELOG: $rel_path"
    violations="true"
  }
done < <(sed -n 's/^Agent adaptation prompt: \(\.\/upgrade-prompts\/[0-9]\+\.[0-9]\+\.[0-9]\+\.md\)$/\1/p' CHANGELOG.md)

if [ "$violations" = "true" ]; then
  exit 1
fi

echo "Docs policy checks passed."
