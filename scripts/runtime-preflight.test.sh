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

assert_pass() {
  _case_name=$1
  _case_path=$2
  if ! PATH="$_case_path" /bin/sh -c '. "$1" >/dev/null' sh "$_test_preflight"; then
    fail "$_case_name"
  fi
  _test_count=$((_test_count + 1))
}

assert_fail() {
  _case_name=$1
  _case_path=$2
  if PATH="$_case_path" /bin/sh -c '. "$1"' sh "$_test_preflight" >/dev/null 2>&1; then
    fail "$_case_name"
  fi
  _test_count=$((_test_count + 1))
}

# 1. Compatible direct Node and the preferred pnpm patch pass unchanged.
make_fake_runtime "$_test_tmp/direct/node" 'v24.1.0'
make_fake_runtime "$_test_tmp/direct/pnpm" '11.16.0'
_test_direct=$(
  PATH="$_test_tmp/direct" /bin/sh -c \
    '. "$1" >/dev/null && command -v node && node --version && pnpm --version' \
    sh "$_test_preflight"
) || fail 'compatible direct runtime failed'
_test_direct_expected=$(printf '%s\n%s\n%s' "$_test_tmp/direct/node" 'v24.1.0' '11.16.0')
[ "$_test_direct" = "$_test_direct_expected" ] || fail 'compatible direct Node was not preferred'
_test_count=$((_test_count + 1))

# 2. pnpm 11.19 still permits adjacent bundled Node discovery and updates PATH.
_test_bundle_1119="$_test_tmp/bundle-1119/dependencies"
make_fake_runtime "$_test_bundle_1119/node/bin/node" 'v24.19.0'
make_fake_runtime "$_test_bundle_1119/bin/fallback/pnpm" '11.19.0'
_test_bundled=$(
  PATH="$_test_bundle_1119/bin/fallback" /bin/sh -c \
    '. "$1" >/dev/null && command -v node && node --version && pnpm --version' \
    sh "$_test_preflight"
) || fail 'pnpm patch mismatch suppressed bundled Node discovery'
_test_bundled_expected=$(printf '%s\n%s\n%s' \
  "$_test_bundle_1119/node/bin/node" 'v24.19.0' '11.19.0')
[ "$_test_bundled" = "$_test_bundled_expected" ] || fail 'bundled Node was not exposed after recovery'
_test_count=$((_test_count + 1))

# 3. The preferred pnpm patch also recovers adjacent bundled Node.
_test_bundle_1116="$_test_tmp/bundle-1116/dependencies"
make_fake_runtime "$_test_bundle_1116/node/bin/node" 'v24.2.0'
make_fake_runtime "$_test_bundle_1116/bin/fallback/pnpm" '11.16.0'
assert_pass 'pnpm 11.16 did not recover bundled Node' "$_test_bundle_1116/bin/fallback"

# 4. Compatible direct Node remains preferred over an adjacent fallback.
_test_preferred="$_test_tmp/preferred/dependencies"
make_fake_runtime "$_test_preferred/direct/node" 'v24.3.0'
make_fake_runtime "$_test_preferred/node/bin/node" 'v25.0.0'
make_fake_runtime "$_test_preferred/bin/fallback/pnpm" '11.19.0'
_test_preferred_result=$(
  PATH="$_test_preferred/direct:$_test_preferred/bin/fallback" /bin/sh -c \
    '. "$1" >/dev/null && command -v node && node --version' sh "$_test_preflight"
) || fail 'compatible direct Node failed with bundled fallback present'
_test_preferred_expected=$(printf '%s\n%s' "$_test_preferred/direct/node" 'v24.3.0')
[ "$_test_preferred_result" = "$_test_preferred_expected" ] || fail 'bundled Node replaced compatible direct Node'
_test_count=$((_test_count + 1))

# 5. Node 23 fails whether direct or adjacent to pnpm.
make_fake_runtime "$_test_tmp/node-23-direct/node" 'v23.9.0'
make_fake_runtime "$_test_tmp/node-23-direct/pnpm" '11.19.0'
assert_fail 'direct Node 23 unexpectedly passed' "$_test_tmp/node-23-direct"
_test_node_23_bundle="$_test_tmp/node-23-bundle/dependencies"
make_fake_runtime "$_test_node_23_bundle/node/bin/node" 'v23.9.0'
make_fake_runtime "$_test_node_23_bundle/bin/fallback/pnpm" '11.19.0'
assert_fail 'bundled Node 23 unexpectedly passed' "$_test_node_23_bundle/bin/fallback"

# 6-8. pnpm below the floor, at the next major, or malformed fails closed.
for _test_bad_version in 11.15.9 12.0.0 11.19.x; do
  _test_bad_dir="$_test_tmp/pnpm-$(printf '%s' "$_test_bad_version" | tr . -)"
  make_fake_runtime "$_test_bad_dir/node" 'v24.1.0'
  make_fake_runtime "$_test_bad_dir/pnpm" "$_test_bad_version"
  assert_fail "pnpm $_test_bad_version unexpectedly passed" "$_test_bad_dir"
done

# 9. A pnpm wrapper without adjacent Node fails when no direct Node exists.
_test_missing_node="$_test_tmp/missing-node/dependencies"
make_fake_runtime "$_test_missing_node/bin/fallback/pnpm" '11.19.0'
if _test_diagnostics=$(PATH="$_test_missing_node/bin/fallback" /bin/sh -c \
  '. "$1"' sh "$_test_preflight" 2>&1); then
  fail 'missing adjacent Node unexpectedly passed'
fi
case "$_test_diagnostics" in
  *'Node path=unavailable version=unavailable'*"pnpm path=$_test_missing_node/bin/fallback/pnpm version=11.19.0"*'supported Node >=24.0.0; supported pnpm >=11.16.0 <12.0.0; bundled recovery attempted=yes'*) ;;
  *) fail 'failure diagnostics were incomplete' ;;
esac
_test_count=$((_test_count + 1))

# 10. No pnpm fails even with compatible direct Node.
make_fake_runtime "$_test_tmp/no-pnpm/node" 'v24.1.0'
assert_fail 'missing pnpm unexpectedly passed' "$_test_tmp/no-pnpm"

# 11. The upper end of supported pnpm 11 remains accepted.
make_fake_runtime "$_test_tmp/pnpm-1199/node" 'v24.1.0'
make_fake_runtime "$_test_tmp/pnpm-1199/pnpm" '11.99.7'
assert_pass 'pnpm 11.99.7 unexpectedly failed' "$_test_tmp/pnpm-1199"

# 12. A symlinked wrapper resolves its real adjacent bundled Node layout.
_test_symlink_bundle="$_test_tmp/symlink-target/dependencies"
make_fake_runtime "$_test_symlink_bundle/node/bin/node" 'v24.4.0'
make_fake_runtime "$_test_symlink_bundle/bin/fallback/pnpm-real" '11.19.0'
mkdir -p "$_test_tmp/symlink-bin"
ln -s "$_test_symlink_bundle/bin/fallback/pnpm-real" "$_test_tmp/symlink-bin/pnpm"
assert_pass 'symlinked pnpm wrapper did not recover adjacent Node' "$_test_tmp/symlink-bin:/bin:/usr/bin"

printf 'runtime-preflight tests: %s passed.\n' "$_test_count"
