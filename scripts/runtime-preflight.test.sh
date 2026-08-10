#!/bin/sh

set -eu

_test_repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
_test_preflight="$_test_repo_root/scripts/runtime-preflight.sh"
_test_tmp=$(mktemp -d "${TMPDIR:-/tmp}/ctc-runtime-preflight.XXXXXX")
_test_tmp=$(CDPATH= cd -- "$_test_tmp" && pwd -P)
trap 'rm -rf -- "$_test_tmp"' EXIT HUP INT TERM
_test_count=0

fail() {
  printf 'runtime-preflight test failed: %s\n' "$1" >&2
  exit 1
}

make_fake_runtime() {
  _fake_path=$1
  _fake_version=$2
  mkdir -p "${_fake_path%/*}"
  printf '%s\n' '#!/bin/sh' "printf '%s\\n' '$_fake_version'" >"$_fake_path"
  chmod +x "$_fake_path"
}

pass() {
  _test_count=$((_test_count + 1))
}

# 1. The current task environment must resolve the repository requirements.
_test_current=$(
  /bin/sh -c '. "$1" >/dev/null && node --version && pnpm --version' sh "$_test_preflight"
) || fail 'current environment did not resolve'
_test_current_node=$(printf '%s\n' "$_test_current" | sed -n '1p')
_test_current_pnpm=$(printf '%s\n' "$_test_current" | sed -n '2p')
_test_current_major=${_test_current_node#v}
_test_current_major=${_test_current_major%%.*}
case "$_test_current_major" in
  ''|*[!0-9]*) fail 'current environment returned an invalid Node version' ;;
esac
[ "$_test_current_major" -ge 24 ] || fail 'current environment returned incompatible Node'
[ "$_test_current_pnpm" = '11.16.0' ] || fail 'current environment returned incompatible pnpm'
pass

# 2. A deliberately empty PATH must fail before any package command runs.
mkdir -p "$_test_tmp/empty"
if PATH="$_test_tmp/empty" /bin/sh -c '. "$1"' sh "$_test_preflight" >/dev/null 2>&1; then
  fail 'empty PATH unexpectedly passed'
fi
pass

# 3. Compatible direct Node and pnpm are accepted unchanged.
make_fake_runtime "$_test_tmp/direct/node" 'v24.1.0'
make_fake_runtime "$_test_tmp/direct/pnpm" '11.16.0'
_test_direct=$(
  PATH="$_test_tmp/direct" /bin/sh -c \
    '. "$1" >/dev/null && command -v node && node --version && pnpm --version' \
    sh "$_test_preflight"
) || fail 'compatible direct runtime failed'
_test_direct_expected=$(printf '%s\n%s\n%s' "$_test_tmp/direct/node" 'v24.1.0' '11.16.0')
[ "$_test_direct" = "$_test_direct_expected" ] || fail 'direct runtime PATH changed unexpectedly'
pass

# 4. A compatible Node adjacent to a pnpm fallback wrapper is added to PATH.
_test_bundle="$_test_tmp/bundle/dependencies"
make_fake_runtime "$_test_bundle/node/bin/node" 'v24.14.0'
make_fake_runtime "$_test_bundle/bin/fallback/pnpm" '11.16.0'
_test_bundled=$(
  PATH="$_test_bundle/bin/fallback" /bin/sh -c \
    '. "$1" >/dev/null && command -v node && node --version && pnpm --version' \
    sh "$_test_preflight"
) || fail 'compatible bundled runtime failed'
_test_bundled_expected=$(printf '%s\n%s\n%s' \
  "$_test_bundle/node/bin/node" 'v24.14.0' '11.16.0')
[ "$_test_bundled" = "$_test_bundled_expected" ] || fail 'bundled runtime was not resolved deterministically'
pass

# 5. An incompatible Node cannot pass without another compatible runtime.
make_fake_runtime "$_test_tmp/bad-node/node" 'v23.9.0'
if PATH="$_test_tmp/bad-node" /bin/sh -c '. "$1"' sh "$_test_preflight" >/dev/null 2>&1; then
  fail 'incompatible Node unexpectedly passed'
fi
pass

# 6. Missing or incompatible pnpm fails even with compatible Node.
make_fake_runtime "$_test_tmp/bad-pnpm/node" 'v24.1.0'
if PATH="$_test_tmp/bad-pnpm" /bin/sh -c '. "$1"' sh "$_test_preflight" >/dev/null 2>&1; then
  fail 'missing pnpm unexpectedly passed'
fi
make_fake_runtime "$_test_tmp/bad-pnpm/pnpm" '11.15.0'
if PATH="$_test_tmp/bad-pnpm" /bin/sh -c '. "$1"' sh "$_test_preflight" >/dev/null 2>&1; then
  fail 'incompatible pnpm unexpectedly passed'
fi
pass

printf 'runtime-preflight tests: %s passed.\n' "$_test_count"
