#!/bin/sh

set -eu

OFFICIAL_INSTALLER_URL="https://chatgpt.com/codex/install.sh"

usage() {
  echo "Usage: $0 RELEASE_VERSION" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

release_version=$1
if ! printf '%s\n' "$release_version" |
  grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-alpha(\.[0-9]+){0,2}|-beta(\.[0-9]+)?)?$'; then
  echo "Invalid exact Codex release version." >&2
  exit 2
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64)
    target="aarch64-apple-darwin"
    ;;
  Darwin:x86_64 | Darwin:amd64)
    target="x86_64-apple-darwin"
    ;;
  *)
    echo "Owned Codex runtime installation currently supports macOS only." >&2
    exit 2
    ;;
esac

runtime_root="$HOME/Library/Application Support/Codex Task Console/codex-runtime"
standalone_home="$runtime_root/standalone-home"
installer_bin="$runtime_root/installer-bin"
installer_home="$runtime_root/installer-home"
candidate="$standalone_home/packages/standalone/releases/$release_version-$target/bin/codex"

for owned_path in "$runtime_root" "$standalone_home" "$installer_bin" "$installer_home"; do
  if [ -L "$owned_path" ]; then
    echo "Owned Codex runtime installation path must not be a symbolic link." >&2
    exit 1
  fi
done

mkdir -p "$runtime_root" "$standalone_home" "$installer_bin" "$installer_home"
chmod 0700 "$runtime_root" "$standalone_home" "$installer_bin" "$installer_home"

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/ctc-codex-installer.XXXXXX")
installer_path="$temporary_directory/install.sh"
cleanup() {
  rm -rf "$temporary_directory"
}
cleanup_after_signal() {
  trap - EXIT HUP INT TERM
  cleanup
  exit 1
}
trap cleanup EXIT
trap cleanup_after_signal HUP INT TERM

curl -fsSL --proto '=https' --tlsv1.2 \
  -o "$installer_path" "$OFFICIAL_INSTALLER_URL"

# Fail closed if the downloaded official installer no longer exposes the
# exact-release, isolated-home, isolated-bin, and checksum contracts used here.
grep -F 'Usage: install.sh [--release VERSION]' "$installer_path" >/dev/null
grep -F 'BIN_DIR="${CODEX_INSTALL_DIR:-$HOME/.local/bin}"' "$installer_path" >/dev/null
grep -F 'CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"' "$installer_path" >/dev/null
grep -F 'verify_archive_digest' "$installer_path" >/dev/null
grep -F 'codex-package_SHA256SUMS' "$installer_path" >/dev/null

# Putting installer-bin on this child process PATH triggers the official
# installer's existing no-profile-update path. The constrained PATH also hides
# unrelated package-manager installs from its optional conflict workflow.
CODEX_HOME="$standalone_home" \
CODEX_INSTALL_DIR="$installer_bin" \
CODEX_NON_INTERACTIVE=1 \
HOME="$installer_home" \
PATH="$installer_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  /bin/sh "$installer_path" --release "$release_version"

release_directory="$standalone_home/packages/standalone/releases/$release_version-$target"
for owned_path in \
  "$runtime_root" \
  "$standalone_home" \
  "$standalone_home/packages" \
  "$standalone_home/packages/standalone" \
  "$standalone_home/packages/standalone/releases" \
  "$release_directory" \
  "$release_directory/bin" \
  "$candidate"; do
  if [ -L "$owned_path" ]; then
    echo "Owned Codex release path must not contain symbolic links." >&2
    exit 1
  fi
done

if [ ! -f "$candidate" ] || [ ! -x "$candidate" ]; then
  echo "Owned Codex release binary was not installed at its versioned path." >&2
  exit 1
fi

actual_version=$("$candidate" --version)
if [ "$actual_version" != "codex-cli $release_version" ]; then
  echo "Owned Codex release binary reported an unexpected version." >&2
  exit 1
fi

printf 'Installed inactive owned Codex candidate %s at:\n%s\n' \
  "$release_version" "$candidate"
