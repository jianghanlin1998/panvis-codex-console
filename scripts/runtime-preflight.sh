#!/bin/sh

# Source this file before Node-dependent repository commands:
#   . ./scripts/runtime-preflight.sh
#
# It prefers a compatible direct runtime. When Codex exposes a pnpm wrapper
# but omits Node from PATH, it derives Node from that wrapper's adjacent runtime
# layout without embedding a machine-specific absolute path.

_ctc_runtime_preflight_main() {
  _ctc_node_rule='>=24.0.0'
  _ctc_pnpm_rule='>=11.16.0 <12.0.0'
  _ctc_bundled_attempted=no

  _ctc_node_path=$(command -v node 2>/dev/null || :)
  _ctc_node_version=
  _ctc_node_ok=false
  if [ -n "$_ctc_node_path" ] && [ -x "$_ctc_node_path" ]; then
    _ctc_node_version=$("$_ctc_node_path" --version 2>/dev/null || :)
    if _ctc_node_version_supported "$_ctc_node_version"; then
      _ctc_node_ok=true
    fi
  fi

  _ctc_pnpm_path=$(command -v pnpm 2>/dev/null || :)

  # Bundled Node discovery deliberately depends only on finding pnpm, not on
  # pnpm already matching the preferred packageManager patch version.
  if [ "$_ctc_node_ok" != true ] && [ -n "$_ctc_pnpm_path" ] && [ -x "$_ctc_pnpm_path" ]; then
    _ctc_bundled_attempted=yes
    _ctc_try_bundled_node "$_ctc_pnpm_path"

    if [ "$_ctc_node_ok" != true ] && command -v readlink >/dev/null 2>&1; then
      _ctc_resolved_pnpm=$_ctc_pnpm_path
      _ctc_link_limit=0
      while [ -L "$_ctc_resolved_pnpm" ] && [ "$_ctc_link_limit" -lt 20 ]; do
        _ctc_link_target=$(readlink "$_ctc_resolved_pnpm" 2>/dev/null || :)
        [ -n "$_ctc_link_target" ] || break
        case "$_ctc_link_target" in
          /*) _ctc_resolved_pnpm=$_ctc_link_target ;;
          *)
            case "$_ctc_resolved_pnpm" in
              */*) _ctc_resolved_pnpm=${_ctc_resolved_pnpm%/*}/$_ctc_link_target ;;
              *) _ctc_resolved_pnpm=$_ctc_link_target ;;
            esac
            ;;
        esac
        _ctc_link_limit=$((_ctc_link_limit + 1))
      done
      if [ "$_ctc_resolved_pnpm" != "$_ctc_pnpm_path" ]; then
        _ctc_try_bundled_node "$_ctc_resolved_pnpm"
      fi
    fi
  fi

  # Re-read both tools after recovery so the reported and validated runtime is
  # exactly what subsequent commands in the sourced shell will use.
  _ctc_node_path=$(command -v node 2>/dev/null || :)
  _ctc_node_version=
  _ctc_node_ok=false
  if [ -n "$_ctc_node_path" ] && [ -x "$_ctc_node_path" ]; then
    _ctc_node_version=$("$_ctc_node_path" --version 2>/dev/null || :)
    if _ctc_node_version_supported "$_ctc_node_version"; then
      _ctc_node_ok=true
    fi
  fi

  _ctc_pnpm_path=$(command -v pnpm 2>/dev/null || :)
  _ctc_pnpm_version=
  _ctc_pnpm_ok=false
  if [ -n "$_ctc_pnpm_path" ] && [ -x "$_ctc_pnpm_path" ]; then
    _ctc_pnpm_version=$("$_ctc_pnpm_path" --version 2>/dev/null || :)
    if _ctc_pnpm_version_supported "$_ctc_pnpm_version"; then
      _ctc_pnpm_ok=true
    fi
  fi

  if [ "$_ctc_node_ok" != true ] || [ "$_ctc_pnpm_ok" != true ]; then
    printf 'runtime-preflight: Node path=%s version=%s\n' \
      "${_ctc_node_path:-unavailable}" "${_ctc_node_version:-unavailable}" >&2
    printf 'runtime-preflight: pnpm path=%s version=%s\n' \
      "${_ctc_pnpm_path:-unavailable}" "${_ctc_pnpm_version:-unavailable}" >&2
    printf 'runtime-preflight: supported Node %s; supported pnpm %s; bundled recovery attempted=%s\n' \
      "$_ctc_node_rule" "$_ctc_pnpm_rule" "$_ctc_bundled_attempted" >&2
    return 1
  fi

  printf 'runtime-preflight: Node %s; pnpm %s.\n' \
    "$_ctc_node_version" "$_ctc_pnpm_version"
}

_ctc_node_version_supported() {
  _ctc_version=${1#v}
  _ctc_major=${_ctc_version%%.*}
  _ctc_remainder=${_ctc_version#*.}
  [ "$_ctc_remainder" != "$_ctc_version" ] || return 1
  _ctc_minor=${_ctc_remainder%%.*}
  _ctc_patch=${_ctc_remainder#*.}
  [ "$_ctc_patch" != "$_ctc_remainder" ] || return 1
  case "$_ctc_major:$_ctc_minor:$_ctc_patch" in
    *[!0-9:]*) return 1 ;;
  esac
  [ -n "$_ctc_major" ] && [ -n "$_ctc_minor" ] && [ -n "$_ctc_patch" ] || return 1
  [ "$_ctc_major" -ge 24 ]
}

_ctc_pnpm_version_supported() {
  _ctc_version=$1
  _ctc_major=${_ctc_version%%.*}
  _ctc_remainder=${_ctc_version#*.}
  [ "$_ctc_remainder" != "$_ctc_version" ] || return 1
  _ctc_minor=${_ctc_remainder%%.*}
  _ctc_patch=${_ctc_remainder#*.}
  [ "$_ctc_patch" != "$_ctc_remainder" ] || return 1
  case "$_ctc_major:$_ctc_minor:$_ctc_patch" in
    *[!0-9:]*) return 1 ;;
  esac
  [ -n "$_ctc_major" ] && [ -n "$_ctc_minor" ] && [ -n "$_ctc_patch" ] || return 1
  [ "$_ctc_major" -eq 11 ] && [ "$_ctc_minor" -ge 16 ]
}

_ctc_try_bundled_node() {
  _ctc_candidate_pnpm=$1
  case "$_ctc_candidate_pnpm" in
    */*) _ctc_candidate_pnpm_dir=${_ctc_candidate_pnpm%/*} ;;
    *) return ;;
  esac

  _ctc_candidate_node_dir=$(
    CDPATH= cd -- "$_ctc_candidate_pnpm_dir/../../node/bin" 2>/dev/null && pwd -P
  ) || _ctc_candidate_node_dir=
  [ -n "$_ctc_candidate_node_dir" ] || return
  [ -x "$_ctc_candidate_node_dir/node" ] || return

  _ctc_candidate_version=$("$_ctc_candidate_node_dir/node" --version 2>/dev/null || :)
  if _ctc_node_version_supported "$_ctc_candidate_version"; then
    PATH="$_ctc_candidate_node_dir:$PATH"
    export PATH
    _ctc_node_ok=true
  fi
}

_ctc_runtime_preflight_main
_ctc_runtime_preflight_status=$?

unset -f _ctc_runtime_preflight_main _ctc_node_version_supported 2>/dev/null || true
unset -f _ctc_pnpm_version_supported _ctc_try_bundled_node 2>/dev/null || true
unset _ctc_node_rule _ctc_pnpm_rule _ctc_bundled_attempted
unset _ctc_node_path _ctc_node_version _ctc_node_ok
unset _ctc_pnpm_path _ctc_pnpm_version _ctc_pnpm_ok
unset _ctc_version _ctc_major _ctc_minor _ctc_patch _ctc_remainder
unset _ctc_resolved_pnpm _ctc_link_limit _ctc_link_target
unset _ctc_candidate_pnpm _ctc_candidate_pnpm_dir
unset _ctc_candidate_node_dir _ctc_candidate_version

if [ "$_ctc_runtime_preflight_status" -eq 0 ]; then
  unset _ctc_runtime_preflight_status
  return 0 2>/dev/null || exit 0
fi

unset _ctc_runtime_preflight_status
return 1 2>/dev/null || exit 1
