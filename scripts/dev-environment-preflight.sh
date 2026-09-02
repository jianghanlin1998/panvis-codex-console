#!/bin/sh

# Source once from the repository root before Node-dependent development work:
#   . ./scripts/dev-environment-preflight.sh

_ctc_dev_environment_main() {
  _ctc_dev_repo_root=$(pwd -P)

  if [ ! -f "$_ctc_dev_repo_root/package.json" ] || \
    [ ! -f "$_ctc_dev_repo_root/pnpm-lock.yaml" ] || \
    [ ! -f "$_ctc_dev_repo_root/scripts/runtime-preflight.sh" ]; then
    printf '%s\n' \
      'dev-environment-preflight: REPOSITORY_ROOT_REQUIRED: run from the repository root.' >&2
    return 1
  fi

  . "$_ctc_dev_repo_root/scripts/runtime-preflight.sh" || return 1

  if [ ! -d "$_ctc_dev_repo_root/node_modules" ]; then
    _ctc_dev_dependencies_not_prepared 'node_modules is missing'
    return 1
  fi

  for _ctc_dev_metadata in .modules.yaml .pnpm/lock.yaml; do
    if [ ! -f "$_ctc_dev_repo_root/node_modules/$_ctc_dev_metadata" ]; then
      _ctc_dev_dependencies_not_prepared \
        "node_modules/$_ctc_dev_metadata is missing"
      return 1
    fi
  done

  if ! cmp -s \
    "$_ctc_dev_repo_root/pnpm-lock.yaml" \
    "$_ctc_dev_repo_root/node_modules/.pnpm/lock.yaml"; then
    _ctc_dev_dependencies_not_prepared \
      'the installed lockfile snapshot does not match pnpm-lock.yaml'
    return 1
  fi

  for _ctc_dev_tool in vitest eslint tsc; do
    if [ ! -x "$_ctc_dev_repo_root/node_modules/.bin/$_ctc_dev_tool" ]; then
      _ctc_dev_dependencies_not_prepared \
        "required local binary $_ctc_dev_tool is missing or not executable"
      return 1
    fi
  done

  _ctc_dev_pnpm=$(command -v pnpm 2>/dev/null || :)
  if ! pnpm_config_offline=true \
    pnpm_config_pm_on_fail=ignore \
    pnpm_config_verify_deps_before_run=error \
    "$_ctc_dev_pnpm" run >/dev/null 2>&1; then
    _ctc_dev_dependencies_not_prepared \
      'installed dependencies do not match the manifests, lockfile, or workspace settings'
    return 1
  fi

  pnpm_config_offline=true
  pnpm_config_pm_on_fail=ignore
  export pnpm_config_offline pnpm_config_pm_on_fail
  CTC_DEV_ENVIRONMENT_READY=$_ctc_dev_repo_root
  export CTC_DEV_ENVIRONMENT_READY
  printf 'dev-environment-preflight: READY: offline installed toolchain at %s.\n' \
    "$_ctc_dev_repo_root"
}

_ctc_dev_dependencies_not_prepared() {
  printf 'dev-environment-preflight: DEPENDENCIES_NOT_PREPARED: %s; request an approved offline frozen-lockfile preparation.\n' \
    "$1" >&2
}

_ctc_dev_environment_main
_ctc_dev_environment_status=$?

unset -f _ctc_dev_environment_main _ctc_dev_dependencies_not_prepared 2>/dev/null || true
unset _ctc_dev_repo_root _ctc_dev_metadata _ctc_dev_tool _ctc_dev_pnpm

if [ "$_ctc_dev_environment_status" -eq 0 ]; then
  unset _ctc_dev_environment_status
  return 0 2>/dev/null || exit 0
fi

unset _ctc_dev_environment_status
return 1 2>/dev/null || exit 1
