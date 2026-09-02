#!/bin/sh

set -eu

_test_repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
_test_tmp=$(mktemp -d "${TMPDIR:-/tmp}/ctc-dev-environment.XXXXXX")
_test_tmp=$(CDPATH= cd -- "$_test_tmp" && pwd -P)
trap 'rm -rf -- "$_test_tmp"' EXIT HUP INT TERM
_test_count=0

fail() {
  printf 'dev-environment-preflight test failed: %s\n' "$1" >&2
  exit 1
}

make_fake_runtime() {
  _fake_bin=$1
  mkdir -p "$_fake_bin"
  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "${1:-}" = "--version" ]; then' \
    "  printf '%s\\n' 'v24.19.0'" \
    '  exit 0' \
    'fi' \
    "printf '%s\\n' 'fake node only supports --version' >&2" \
    'exit 1' >"$_fake_bin/node"
  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "${1:-}" = "--version" ]; then' \
    "  printf '%s\\n' '11.19.0'" \
    '  exit 0' \
    'fi' \
    '[ "${pnpm_config_offline:-}" = true ] || exit 81' \
    '[ "${pnpm_config_pm_on_fail:-}" = ignore ] || exit 82' \
    '[ "${pnpm_config_verify_deps_before_run:-}" = error ] || exit 83' \
    '[ "$#" -eq 1 ] && [ "$1" = run ] || exit 84' \
    "printf '%s|%s\\n' \"\${CI:-non-ci}\" \"\$*\" >>\"\$CTC_TEST_PNPM_LOG\"" \
    'if [ -n "${CTC_TEST_PNPM_FAIL:-}" ]; then' \
    "  printf '%s\\n' 'raw fake pnpm detail' >&2" \
    '  exit 1' \
    'fi' \
    'exit 0' >"$_fake_bin/pnpm"
  chmod +x "$_fake_bin/node" "$_fake_bin/pnpm"
}

make_fake_tool() {
  _tool_path=$1
  mkdir -p "${_tool_path%/*}"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$_tool_path"
  chmod +x "$_tool_path"
}

make_fixture() {
  _fixture=$1
  mkdir -p "$_fixture/scripts" "$_fixture/node_modules/.pnpm" "$_fixture/node_modules/.bin"
  cp "$_test_repo_root/scripts/runtime-preflight.sh" "$_fixture/scripts/"
  cp "$_test_repo_root/scripts/dev-environment-preflight.sh" "$_fixture/scripts/"
  printf '%s\n' '{"name":"fixture","private":true}' >"$_fixture/package.json"
  printf '%s\n' "lockfileVersion: '9.0'" >"$_fixture/pnpm-lock.yaml"
  cp "$_fixture/pnpm-lock.yaml" "$_fixture/node_modules/.pnpm/lock.yaml"
  printf '%s\n' 'virtualStoreDir: .pnpm' >"$_fixture/node_modules/.modules.yaml"
  for _fixture_tool in vitest eslint tsc; do
    make_fake_tool "$_fixture/node_modules/.bin/$_fixture_tool"
  done
}

assert_fixture_pass() {
  _case_name=$1
  _fixture=$2
  _case_ci=$3
  if ! (
    cd "$_fixture"
    CI="$_case_ci" PATH="$_test_fake_bin:/bin:/usr/bin" \
      CTC_TEST_PNPM_LOG="$_test_pnpm_log" \
      /bin/sh -c '. ./scripts/dev-environment-preflight.sh >/dev/null'
  ); then
    fail "$_case_name"
  fi
  _test_count=$((_test_count + 1))
}

_test_fake_bin="$_test_tmp/fake-bin"
_test_pnpm_log="$_test_tmp/pnpm.log"
: >"$_test_pnpm_log"
make_fake_runtime "$_test_fake_bin"

# Prepared workspaces pass in normal and CI-like environments.
_test_prepared="$_test_tmp/prepared"
make_fixture "$_test_prepared"
assert_fixture_pass 'prepared non-CI workspace failed' "$_test_prepared" ''
assert_fixture_pass 'prepared CI-like workspace failed' "$_test_prepared" 'true'

# Repeated preflight is idempotent and leaves dependency metadata byte-identical.
_test_before_modules=$(cksum "$_test_prepared/node_modules/.modules.yaml")
_test_before_lock=$(cksum "$_test_prepared/node_modules/.pnpm/lock.yaml")
if ! (
  cd "$_test_prepared"
  PATH="$_test_fake_bin:/bin:/usr/bin" \
    CTC_TEST_PNPM_LOG="$_test_pnpm_log" \
    /bin/sh -c '. ./scripts/dev-environment-preflight.sh >/dev/null; . ./scripts/dev-environment-preflight.sh >/dev/null; [ "$CTC_DEV_ENVIRONMENT_READY" = "$(pwd -P)" ] && [ "$pnpm_config_offline" = true ] && [ "$pnpm_config_pm_on_fail" = ignore ]'
); then
  fail 'repeated preflight failed'
fi
[ "$_test_before_modules" = "$(cksum "$_test_prepared/node_modules/.modules.yaml")" ] || \
  fail 'repeated preflight changed .modules.yaml'
[ "$_test_before_lock" = "$(cksum "$_test_prepared/node_modules/.pnpm/lock.yaml")" ] || \
  fail 'repeated preflight changed the installed lockfile snapshot'
_test_count=$((_test_count + 1))

# Missing dependencies, required binaries, stale locks, and pnpm status failures fail closed.
_test_missing_modules="$_test_tmp/missing-modules"
make_fixture "$_test_missing_modules"
rm -rf -- "$_test_missing_modules/node_modules"
if _test_output=$(
  cd "$_test_missing_modules"
  PATH="$_test_fake_bin:/bin:/usr/bin" CTC_TEST_PNPM_LOG="$_test_pnpm_log" \
    /bin/sh -c '. ./scripts/dev-environment-preflight.sh' 2>&1
); then
  fail 'missing node_modules unexpectedly passed'
fi
case "$_test_output" in
  *'DEPENDENCIES_NOT_PREPARED: node_modules is missing'*) ;;
  *) fail 'missing node_modules did not return the actionable condition' ;;
esac
_test_count=$((_test_count + 1))

_test_missing_binary="$_test_tmp/missing-binary"
make_fixture "$_test_missing_binary"
rm -- "$_test_missing_binary/node_modules/.bin/vitest"
if _test_output=$(
  cd "$_test_missing_binary"
  PATH="$_test_fake_bin:/bin:/usr/bin" CTC_TEST_PNPM_LOG="$_test_pnpm_log" \
    /bin/sh -c '. ./scripts/dev-environment-preflight.sh' 2>&1
); then
  fail 'missing local binary unexpectedly passed'
fi
case "$_test_output" in
  *'DEPENDENCIES_NOT_PREPARED: required local binary vitest is missing or not executable'*) ;;
  *) fail 'missing local binary did not return the actionable condition' ;;
esac
_test_count=$((_test_count + 1))

_test_stale_lock="$_test_tmp/stale-lock"
make_fixture "$_test_stale_lock"
printf '%s\n' "lockfileVersion: '8.0'" >"$_test_stale_lock/pnpm-lock.yaml"
if _test_output=$(
  cd "$_test_stale_lock"
  PATH="$_test_fake_bin:/bin:/usr/bin" CTC_TEST_PNPM_LOG="$_test_pnpm_log" \
    /bin/sh -c '. ./scripts/dev-environment-preflight.sh' 2>&1
); then
  fail 'stale installed lock snapshot unexpectedly passed'
fi
case "$_test_output" in
  *'DEPENDENCIES_NOT_PREPARED: the installed lockfile snapshot does not match pnpm-lock.yaml'*) ;;
  *) fail 'stale installed lock snapshot did not return the actionable condition' ;;
esac
_test_count=$((_test_count + 1))

_test_status_failure="$_test_tmp/status-failure"
make_fixture "$_test_status_failure"
if _test_output=$(
  cd "$_test_status_failure"
  PATH="$_test_fake_bin:/bin:/usr/bin" CTC_TEST_PNPM_FAIL=1 \
    CTC_TEST_PNPM_LOG="$_test_pnpm_log" \
    /bin/sh -c '. ./scripts/dev-environment-preflight.sh' 2>&1
); then
  fail 'pnpm dependency-status failure unexpectedly passed'
fi
case "$_test_output" in
  *'DEPENDENCIES_NOT_PREPARED: installed dependencies do not match the manifests, lockfile, or workspace settings'*'raw fake pnpm detail'*)
    fail 'raw pnpm detail leaked through the environment result'
    ;;
  *'DEPENDENCIES_NOT_PREPARED: installed dependencies do not match the manifests, lockfile, or workspace settings'*) ;;
  *) fail 'pnpm dependency-status failure did not return the actionable condition' ;;
esac
_test_count=$((_test_count + 1))

# Real pnpm 11.19 validates the prepared snapshot without registry access and
# detects a manifest/lock mismatch in a disposable workspace.
_test_real_fixture="$_test_tmp/real-pnpm"
mkdir -p "$_test_real_fixture/scripts" "$_test_real_fixture/packages"
cp "$_test_repo_root/package.json" "$_test_repo_root/pnpm-workspace.yaml" \
  "$_test_repo_root/pnpm-lock.yaml" "$_test_real_fixture/"
cp "$_test_repo_root/scripts/runtime-preflight.sh" \
  "$_test_repo_root/scripts/dev-environment-preflight.sh" "$_test_real_fixture/scripts/"
for _test_package in "$_test_repo_root"/packages/*; do
  _test_package_name=${_test_package##*/}
  mkdir -p "$_test_real_fixture/packages/$_test_package_name"
  cp "$_test_package/package.json" "$_test_real_fixture/packages/$_test_package_name/"
  if [ -d "$_test_package/node_modules" ]; then
    ln -s "$_test_package/node_modules" \
      "$_test_real_fixture/packages/$_test_package_name/node_modules"
  fi
done

# Reuse the prepared dependency payload read-only while giving pnpm a fixture-
# local workspace-state snapshot. No install, store access, or download occurs.
mkdir "$_test_real_fixture/node_modules"
cp "$_test_repo_root/node_modules/.modules.yaml" \
  "$_test_repo_root/node_modules/.pnpm-workspace-state-v1.json" \
  "$_test_real_fixture/node_modules/"
ln -s "$_test_repo_root/node_modules/.pnpm" "$_test_real_fixture/node_modules/.pnpm"
ln -s "$_test_repo_root/node_modules/.bin" "$_test_real_fixture/node_modules/.bin"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const sourceRoot = process.argv[2];
  const fixtureRoot = process.argv[3];
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  value.projects = Object.fromEntries(
    Object.entries(value.projects).map(([key, project]) => [
      `${fixtureRoot}${key.slice(sourceRoot.length)}`,
      project,
    ]),
  );
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
' "$_test_real_fixture/node_modules/.pnpm-workspace-state-v1.json" \
  "$_test_repo_root" "$_test_real_fixture"
_test_real_modules_before=$(cksum "$_test_real_fixture/node_modules/.modules.yaml")
_test_real_lock_before=$(cksum "$_test_real_fixture/node_modules/.pnpm/lock.yaml")

for _test_ci in '' true; do
  if ! (
    cd "$_test_real_fixture"
    CI="$_test_ci" pnpm_config_registry='http://127.0.0.1:9' \
      /bin/sh -c '. ./scripts/dev-environment-preflight.sh >/dev/null; [ "$(pnpm config get enableGlobalVirtualStore)" = false ]; [ "$(pnpm config get verifyDepsBeforeRun)" = false ]; pnpm run >/dev/null'
  ); then
    fail "real pnpm prepared-workspace check failed for CI=$_test_ci"
  fi
done
[ "$_test_real_modules_before" = "$(cksum "$_test_real_fixture/node_modules/.modules.yaml")" ] || \
  fail 'real pnpm preflight changed .modules.yaml'
[ "$_test_real_lock_before" = "$(cksum "$_test_real_fixture/node_modules/.pnpm/lock.yaml")" ] || \
  fail 'real pnpm preflight changed the installed lockfile snapshot'
_test_count=$((_test_count + 1))

grep -F '"test": "vitest run --maxWorkers=4"' "$_test_repo_root/package.json" >/dev/null || \
  fail 'canonical package test script did not use four workers'
_test_count=$((_test_count + 1))

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  value.devDependencies.eslint = "^0.0.1";
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
' "$_test_real_fixture/package.json"
if _test_output=$(
  cd "$_test_real_fixture"
  pnpm_config_registry='http://127.0.0.1:9' \
    /bin/sh -c '. ./scripts/dev-environment-preflight.sh' 2>&1
); then
  fail 'real pnpm manifest/lock mismatch unexpectedly passed'
fi
case "$_test_output" in
  *'DEPENDENCIES_NOT_PREPARED: installed dependencies do not match the manifests, lockfile, or workspace settings'*) ;;
  *) fail 'real pnpm mismatch did not return the actionable condition' ;;
esac
_test_count=$((_test_count + 1))

printf 'dev-environment-preflight tests: %s passed.\n' "$_test_count"
