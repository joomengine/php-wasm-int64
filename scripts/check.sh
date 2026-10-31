#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_dir"

for tool in bash git jq node; do
  command -v "$tool" >/dev/null || { printf 'Missing validation prerequisite: %s\n' "$tool" >&2; exit 1; }
done

mapfile -t shell_files < <(git ls-files --cached --others --exclude-standard '*.sh' | sort -u)
for file in "${shell_files[@]}"; do bash -n "$file"; done
if command -v shellcheck >/dev/null; then
  shellcheck --external-sources --severity=warning "${shell_files[@]}"
elif [[ ${CI:-false} == true ]]; then
  printf 'CI requires shellcheck.\n' >&2
  exit 1
else
  printf 'shellcheck is unavailable locally; CI requires it.\n' >&2
fi

mapfile -t module_files < <(git ls-files --cached --others --exclude-standard '*.mjs' | sort -u)
for file in "${module_files[@]}"; do node --check "$file"; done

mapfile -t json_files < <(git ls-files --cached --others --exclude-standard '*.json' | sort -u)
for file in "${json_files[@]}"; do jq empty "$file"; done

mapfile -t patch_files < <(git ls-files --cached --others --exclude-standard '*.patch' | sort -u)
for file in "${patch_files[@]}"; do git apply --numstat "$file" >/dev/null; done

mapfile -t php_files < <(git ls-files --cached --others --exclude-standard '*.php' | sort -u)
if command -v php >/dev/null; then
  for file in "${php_files[@]}"; do php -l "$file"; done
elif [[ ${CI:-false} == true ]]; then
  printf 'CI requires PHP CLI for fixture syntax validation.\n' >&2
  exit 1
else
  printf 'Native PHP is unavailable locally; CI validates PHP fixture syntax.\n' >&2
fi

mapfile -t contract_tests < <(git ls-files --cached --others --exclude-standard 'tests/*.test.mjs' 'tests/**/*.test.mjs' | sort -u)
if ((${#contract_tests[@]})); then node --test "${contract_tests[@]}"; fi
git diff --check
printf 'Source checks passed. Compiled runtime tests are a separate required CI job.\n'
