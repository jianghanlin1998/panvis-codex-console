# Codex Runtime Ownership V0

Codex Task Console owns its Codex CLI runtime selection. `PATH`, the Codex
binary bundled with ChatGPT Desktop, the standalone installer's `current`
symlink, and its visible-command symlink are not execution authority. The
ambient ChatGPT-bundled version may change or differ from the Console candidate
without changing Console runtime selection.

## Local runtime state

On macOS, runtime files live outside the repository beneath the shared Console
Application Support root:

```text
~/Library/Application Support/Codex Task Console/  # current-user-owned, real, 0700
  codex-runtime/
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
pnpm codex:runtime:install -- 0.153.3
```

Before creating the shared Console root, the wrapper requires the existing
`$HOME/Library/Application Support` parent to be canonical, current-user-owned,
non-symlink, and stable by filesystem identity. A missing, symlinked, or
noncanonical parent fails before `Codex Task Console` is created. The wrapper
creates only that direct child, revalidates the parent, and then requires the
shared root to be a canonical, current-user-owned, non-symlink real directory
with exact mode `0700`. An existing owner-owned root is tightened
non-recursively; wrong-owner, symlink, non-directory, or noncanonical roots fail
closed. The wrapper does not create or chmod `HOME`, `Library`, or `Application
Support`, and does not chmod unrelated children. Existing runtime-owned child
privacy rules are unchanged.

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
merely because installation and `--version` succeed. The C-lite check
must validate the current Console-consumed stable App Server contract, followed
by explicit human approval, before operational activation. Until then,
execution remains fail-closed. Future compatibility wording should describe an
unseen candidate as `UNVALIDATED`, not as proven incompatible; that semantic
cleanup belongs to C-lite, not this module.

Historically, the initial `0.148.0-alpha.9` candidate remained inactive until
Runtime Ownership and C-lite acceptance. Those baseline milestones are accepted.
The current selector and upgrade evidence are recorded below; this module still
contains no automatic activation path or compatibility-approval token.

## Authentication boundary

Installer-only `CODEX_HOME` controls installation layout only. Future owned
binary execution does not force that installation home, so normal Codex
configuration and authentication remain separate. This implementation does not
read, copy, hash, log, or modify normal credentials, does not create a login,
and does not make a model or provider request. Runtime binaries, `active.json`,
installer artifacts, machine paths, and secrets remain outside Git.

## 2026-09-07 runtime upgrade

Hanlin approved upgrading the Console-owned runtime to `0.153.3` and rechecking
interfaces, permissions and the selected Astra model. The official exact-release
wrapper installed the canonical `aarch64-apple-darwin` candidate; the desktop
executable was not adopted. The old `0.148.0-alpha.9` release is retained.

The new isolated, non-experimental generators produced 1,010 files (304 JSON
Schema files). The authoritative aggregate SHA-256 is
`e8284c5cb8157554a3dd1e035aadbd4325aea501af56887e9c2e12eb1b9b9448`.
C-lite passed the consumed contract, including the added internal task-config
read/binding used to disable configured external MCP tools. The public Console
API and response shapes are unchanged. Production changes are limited to
`compatibility.ts`, `c-lite-compatibility.ts` and `live-execution.ts`; related
version fixtures, deterministic tests and canonical state/docs are updated.

An exact-runtime, no-model probe confirmed both thread sandbox representations,
allowed work-directory/private-temp writes, and denied source, sibling, parent,
HOME, CODEX_HOME, symlink-escape and read-only writes, plus loopback network
connections. A synthetic MCP sentinel
exposed an existing startup gap on both releases; explicit per-task disable
flags repaired it without editing user configuration. The prior
`orchestrator.mcp.enabled=false` flag alone did not disable configured servers.
The [upstream config merger](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/config/src/merge.rs)
also explains why an empty override table does not remove existing entries.

One bounded real diagnostic used the owned candidate, existing ChatGPT login,
the configured local proxy and inherited `gpt-6-astra` / `xhigh`. It completed
with the expected JSON response and no tools: 12,692 total tokens (12,677 input,
15 output). Thread `01a07a16-59ab-78e1-99a8-7e723911360d`, turn
`01a07a16-5a0f-78e2-ba5a-bbd13286c5fe`. Child and temporary directory were cleaned.
This was separate from the original stopped AI Update Board planning intake;
that intake was not retried and its unknown historical usage remains unknown.

Activation completed at `2026-09-07T04:33:34.938Z`: active `0.153.3`, previous
`0.148.0-alpha.9`. The production resolver read back the exact owned runtime;
the daemon remains stopped. Final verification passed 155 files /4,638 tests
with four workers (345.33 s), public hygiene, lint, typecheck, build, local-control
executable E2E and diff checks. The initial full run found two outdated mock
version values; corrected fixtures passed focused checks and the full rerun
without changing assertions. `CURRENT_STATE.md` records the current operation.
Rollback requires a stopped daemon, the matching pre-upgrade Console code
(`3832331edaab0243be9c1582fa49c2fa38008647`) and the existing
`rollbackOwnedCodexRuntime()` selector operation. Swapping only the runtime
without its matching tested-version pin fails closed. The old pair also restores
its known Astra incompatibility and configured-MCP startup gap; it is not a
route for continuing the Board pilot. Retain task records and
never restore the old database backup as part of runtime rollback.

Only macOS arm64 was exercised; Windows behavior is not claimed. This upgrade
is implementation/operational verification, not a new Fresh Independent QA
acceptance of the entire Console or an end-to-end AI Update Board delivery.
