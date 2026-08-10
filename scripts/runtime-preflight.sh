#!/bin/sh

# Source this file before Node-dependent repository commands:
#   . ./scripts/runtime-preflight.sh
#
# It prefers a compatible direct runtime. When Codex exposes its bundled pnpm
# wrapper but omits Node from PATH, it derives Node from that wrapper's adjacent
# runtime layout without embedding a machine-specific absolute path.

_ctc_runtime_preflight_main() {
  _ctc_required_node_major=24
  _ctc_required_pnpm=11.16.0

  _ctc_node_path=$(command -v node 2>/dev/null || :)
  _ctc_node_version=
  _ctc_node_ok=false
  if [ -n "$_ctc_node_path" ] && [ -x "$_ctc_node_path" ]; then
    _ctc_node_version=$("$_ctc_node_path" --version 2>/dev/null || :)
    _ctc_node_major=${_ctc_node_version#v}
    _ctc_node_major=${_ctc_node_major%%.*}
    case "$_ctc_node_major" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$_ctc_node_major" -ge "$_ctc_required_node_major" ]; then
          _ctc_node_ok=true
        fi
        ;;
    esac
  fi

  _ctc_pnpm_path=$(command -v pnpm 2>/dev/null || :)
  _ctc_pnpm_version=
  _ctc_pnpm_ok=false
  if [ -n "$_ctc_pnpm_path" ] && [ -x "$_ctc_pnpm_path" ]; then
    _ctc_pnpm_version=$("$_ctc_pnpm_path" --version 2>/dev/null || :)
    if [ "$_ctc_pnpm_version" = "$_ctc_required_pnpm" ]; then
      _ctc_pnpm_ok=true
    fi
  fi

  if [ "$_ctc_node_ok" != true ] && [ "$_ctc_pnpm_ok" = true ]; then
    case "$_ctc_pnpm_path" in
      */*) _ctc_pnpm_dir=${_ctc_pnpm_path%/*} ;;
      *) _ctc_pnpm_dir= ;;
    esac

    _ctc_bundled_node_dir=
    if [ -n "$_ctc_pnpm_dir" ]; then
      _ctc_bundled_node_dir=$(
        CDPATH= cd -- "$_ctc_pnpm_dir/../../node/bin" 2>/dev/null && pwd -P
      ) || _ctc_bundled_node_dir=
    fi

    if [ -n "$_ctc_bundled_node_dir" ] && [ -x "$_ctc_bundled_node_dir/node" ]; then
      _ctc_candidate_version=$("$_ctc_bundled_node_dir/node" --version 2>/dev/null || :)
      _ctc_candidate_major=${_ctc_candidate_version#v}
      _ctc_candidate_major=${_ctc_candidate_major%%.*}
      case "$_ctc_candidate_major" in
        ''|*[!0-9]*) ;;
        *)
          if [ "$_ctc_candidate_major" -ge "$_ctc_required_node_major" ]; then
            PATH="$_ctc_bundled_node_dir:$PATH"
            export PATH
            _ctc_node_path=$(command -v node 2>/dev/null || :)
            _ctc_node_version=$("$_ctc_node_path" --version 2>/dev/null || :)
            _ctc_node_ok=true
          fi
          ;;
      esac
    fi
  fi

  if [ "$_ctc_node_ok" != true ] || [ "$_ctc_pnpm_ok" != true ]; then
    printf '%s\n' \
      "runtime-preflight: compatible Node >=24 and pnpm 11.16.0 could not be established." >&2
    return 1
  fi

  printf 'runtime-preflight: Node %s; pnpm %s.\n' \
    "$_ctc_node_version" "$_ctc_pnpm_version"
}

_ctc_runtime_preflight_main
_ctc_runtime_preflight_status=$?

unset -f _ctc_runtime_preflight_main 2>/dev/null || true
unset _ctc_required_node_major _ctc_required_pnpm
unset _ctc_node_path _ctc_node_version _ctc_node_major _ctc_node_ok
unset _ctc_pnpm_path _ctc_pnpm_version _ctc_pnpm_ok _ctc_pnpm_dir
unset _ctc_bundled_node_dir _ctc_candidate_version _ctc_candidate_major

if [ "$_ctc_runtime_preflight_status" -eq 0 ]; then
  unset _ctc_runtime_preflight_status
  return 0 2>/dev/null || exit 0
fi

unset _ctc_runtime_preflight_status
return 1 2>/dev/null || exit 1
