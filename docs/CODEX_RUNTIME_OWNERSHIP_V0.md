# Codex Runtime Ownership V0

Codex Task Console owns its Codex CLI runtime selection. `PATH`, the Codex
binary bundled with ChatGPT Desktop, the standalone installer's `current`
symlink, and its visible-command symlink are not execution authority. The
ambient ChatGPT-bundled version may change or differ from the Console candidate
without changing Console runtime selection.

## Local runtime state

On macOS, runtime files live outside the repository under:

```text
~/Library/Application Support/Codex Task Console/codex-runtime/
  standalone-home/
    packages/standalone/releases/<version>-<target>/bin/codex
  installer-bin/
  active.json
```

The production resolver derives the executable from this trusted root, an exact
release version, and an official platform target. The runtime root must be a
private directory, and every owned component from that root through the binary
must be a real directory or regular file rather than a symlink. The resolver
canonicalizes the confined path, observes device, inode, mode, size, and
nanosecond timestamps before execution, and requires the same file and path
identities after the version check. Replacement of the executable, release
directory, or runtime root during that check fails closed.

The resolver runs the canonical path directly with no shell. The check is
bounded to five seconds and 4,096 output bytes, requires exit status zero, and
accepts stdout only as exact `codex-cli <version>` with no ending, one LF, or
one CRLF. Additional stdout is rejected. Stderr is never used as authority or
included in public errors. Each version check uses a new private disposable
directory under the canonical system temporary root. The child receives only
isolated `HOME`, `CODEX_HOME`, `TMPDIR`, and `PATH` directories beneath that
root; it does not receive normal user Codex/auth/home state or the ambient
process environment. The disposable state is removed after both success and
failure, and inability to establish isolation fails the check closed.

`CTC_CODEX_BINARY` is a development/test override only. It must be an absolute,
canonical, regular executable and must report the exact version owned by the
Console's `TESTED_CODEX_VERSION` contract. Callers cannot supply another
expected version. The override is rejected unless `NODE_ENV` is exactly
`development` or `test`; setting it in an unset or production environment fails
closed and does not replace the owned selector. It never falls back to `PATH`
or `codex`.

## Exact-release installation

Run the repository wrapper with an explicit version:

```sh
pnpm codex:runtime:install -- 0.148.0-alpha.9
```

The wrapper downloads the [official standalone installer](https://chatgpt.com/codex/install.sh)
over HTTPS to a temporary file, checks that the installer still exposes the
required exact-release, isolated-home, isolated-bin, and checksum contracts,
then invokes it with `--release`. The wrapper scopes `CODEX_HOME` to
`standalone-home` and `CODEX_INSTALL_DIR` to `installer-bin` for that installer
process only. It also gives the installer a private runtime-owned `HOME`, so an
installer profile mutation cannot reach the user's normal shell profiles. A
constrained child `PATH` uses the installer's no-profile-update path. The
wrapper rejects owned-root and final-release symlink components, cleans its
download on normal or trapped signal exit, and accepts only the exact versioned
candidate path as a regular executable. The official installer verifies release
metadata and SHA-256 checksums; the wrapper also verifies the final versioned
binary's exact version.

Installation creates a candidate but never writes `active.json` and never
activates the candidate.

## Selector, activation, and rollback

`active.json` is untrusted machine-local input with one strict schema:

```json
{
  "schemaVersion": 1,
  "active": { "version": "...", "target": "..." },
  "previous": { "version": "...", "target": "..." }
}
```

`active` and `previous` may each be `null`, but may not name the same non-null
selection. No other or duplicate fields are accepted. Invalid UTF-8, malformed
or trailing JSON, oversized input, directories, FIFOs, and symlinks are
rejected. The selector contains no paths, credentials, compatibility status, or
release registry.

Reads open `active.json` with no-follow and nonblocking flags, read at most
4,097 bytes from that descriptor, and compare descriptor, path, and runtime-root
identity before accepting one stable observation. A replacement during the
observation fails closed rather than combining or following files.

Updates use an exclusive local `.active.lock`; a concurrent activation or
rollback contender fails with `SELECTOR_MUTATION_BUSY` rather than performing a
lost update. After confirming the runtime root identity, the owner writes a
same-directory mode-`0600` temporary file, file-`fsync`s and closes it, then
atomically renames it over `active.json`. Failure before rename preserves the
previous selector and cleans the current temporary file. No directory `fsync`
is claimed: the guarantee is atomic visibility and pre-rename failure
preservation, not persistence of a successful rename across sudden power loss.
An abrupt process death can leave `.active.lock`; it must be removed only after
confirming no selector mutation is running.

Activation verifies the exact candidate first, then moves the old `active` to
`previous`. Activating the same selection is a no-op. Rollback verifies
`previous` locally before atomically swapping `active` and `previous`; it does
not reinstall or use the network.

Activation is only a B-level selector operation. A candidate is not compatible
merely because installation and `--version` succeed. The future C-lite check
must validate the current Console-consumed stable App Server contract, followed
by explicit human approval, before operational activation. Until then,
execution remains fail-closed. Future compatibility wording should describe an
unseen candidate as `UNVALIDATED`, not as proven incompatible; that semantic
cleanup belongs to C-lite, not this module.

The locally installed `0.148.0-alpha.9` candidate remains inactive after this
hardening. Runtime Ownership Fresh Independent QA and acceptance are required
before C-lite may rely on this authority boundary; this module contains no
automatic activation path or compatibility-approval token.

## Authentication boundary

Installer-only `CODEX_HOME` controls installation layout only. Future owned
binary execution does not force that installation home, so normal Codex
configuration and authentication remain separate. This implementation does not
read, copy, hash, log, or modify normal credentials, does not create a login,
and does not make a model or provider request. Runtime binaries, `active.json`,
installer artifacts, machine paths, and secrets remain outside Git.
