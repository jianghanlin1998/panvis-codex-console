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
release version, and an official platform target. It canonicalizes the path,
rejects traversal and symlink escape, requires a regular readable executable,
and runs only a bounded `--version` check. The exact output must be
`codex-cli <version>`.

`CTC_CODEX_BINARY` is a development/test override only. It must be an absolute,
canonical, regular executable and must report the exact operationally expected
tested version. It never falls back to `PATH` or `codex`.

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
process only. A constrained child `PATH` uses the installer's no-profile-update
path. The official installer verifies release metadata and SHA-256 checksums;
the wrapper also verifies the final versioned binary's exact version.

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

`active` and `previous` may each be `null`; no other fields are accepted. The
selector contains no paths, credentials, compatibility status, or release
registry. Updates use a same-directory mode-`0600` temporary file, file `fsync`,
and atomic rename so a failed write does not partially overwrite the selector.

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

## Authentication boundary

Installer-only `CODEX_HOME` controls installation layout only. Future owned
binary execution does not force that installation home, so normal Codex
configuration and authentication remain separate. This implementation does not
read, copy, hash, log, or modify normal credentials, does not create a login,
and does not make a model or provider request. Runtime binaries, `active.json`,
installer artifacts, machine paths, and secrets remain outside Git.
