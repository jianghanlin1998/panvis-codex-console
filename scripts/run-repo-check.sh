#!/bin/sh

set -eu

_ctc_check_repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)

if [ "${CTC_DEV_ENVIRONMENT_READY:-}" != "$_ctc_check_repo_root" ]; then
  printf '%s\n' \
    'run-repo-check: DEV_ENVIRONMENT_NOT_PREPARED: source scripts/dev-environment-preflight.sh once from the repository root.' >&2
  exit 2
fi

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'run-repo-check: expected exactly one of public, lint, typecheck, test, or build.' >&2
  exit 2
fi

cd "$_ctc_check_repo_root"

case "$1" in
  public)
    ./scripts/check-public-repo-hygiene.sh
    ;;
  lint)
    ./node_modules/.bin/eslint . --max-warnings 0
    ;;
  typecheck)
    ./node_modules/.bin/tsc --noEmit --pretty false
    ;;
  test)
    ./node_modules/.bin/vitest run --maxWorkers=4
    ;;
  build)
    ./node_modules/.bin/tsc -b \
      packages/shared/tsconfig.build.json \
      packages/domain/tsconfig.build.json \
      packages/orchestration/tsconfig.build.json \
      packages/storage/tsconfig.build.json \
      packages/codex-adapter/tsconfig.build.json \
      packages/local-control/tsconfig.build.json \
      --pretty false
    ;;
  *)
    printf 'run-repo-check: unsupported check: %s\n' "$1" >&2
    exit 2
    ;;
esac
