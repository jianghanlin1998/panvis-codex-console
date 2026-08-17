# JIT trusted repository source snapshot

`TrustedRepositorySourceReader.readTrustedRepositorySourceSnapshotForSubtask(subtaskId)`
is the direct producer boundary for one trusted repository source family. The
reader is constructed with `TaskStorage`, resolves the canonical Project from
the supplied canonical Subtask ID through the accepted coherent storage-origin
snapshot, and obtains the repository only from that durable Project. Callers
cannot supply a repository path, Project, source class, or alternate location
to the read operation.

Only durable `PATH` repositories are supported. The configured path is resolved
through filesystem reality and must itself designate the exact Git worktree
root reported by local Git. The reader does not walk upward from a nested or
ordinary directory. `REFERENCE` fails closed: there is no URL translation,
local-checkout guessing, clone, fetch, API call, or other resolver.

The resolved worktree directory's device/inode identity is captured and checked
before and after every Git probe and canonical-rule read. A rename/replacement
that substitutes another directory during a read fails closed rather than
combining the configured Project with the substitute repository. A configured
symlink may resolve to the exact worktree root; subsequent symlink retargeting
does not redirect that read because probes use the already-resolved root.

## Producer-owned source families

Classification is structural and owned by this producer:

- `canonicalProjectRules` corresponds to `CANONICAL_PROJECT_RULE`.
- `repositoryRuntimeEvidence` corresponds to `REPO_RUNTIME_EVIDENCE`.

The only canonical Project-rule file is the exact repository-root
`AGENTS.md`. The producer does not search nested `AGENTS.md`, documentation,
README, CLAUDE, contribution guidance, package metadata, or Git history. A
missing or empty root file produces an empty rules array. An existing source
must be a safely opened regular UTF-8 file; symlinks, directories, special
files, unsafe replacement, unreadable content, and content incompatible with
the accepted packet text-block contract fail closed.

The regular-file observation compares path/open-file device and inode identity,
mode, size, modification/change timestamps, and bytes before and after the
read. It then repeats the observation and requires identical bytes. This
detects ordinary replacement, truncate/grow, in-place edit, removal, and
file-type drift without following a symlink or accepting a partial/mixed read.

Rule text is not summarized, rewritten, ranked, or semantically classified.
Text longer than 4,000 JavaScript UTF-16 code units is split into deterministic
ordered parts without splitting a surrogate pair. Each part remains within the
accepted Packet Core body bound, and ordered concatenation reproduces the
complete source text. Chunk boundaries shift deterministically when needed to
keep representable whitespace runs lossless. Content that cannot be represented
at all under Packet Core's nonblank-per-block rule fails closed; it is never
silently trimmed or truncated.

The repository/runtime evidence is bounded fixed-template output containing:

- the exact local HEAD commit SHA;
- attached branch name or explicit `DETACHED` state;
- the local `refs/remotes/origin/<Project.defaultBranch>` SHA or deterministic
  `NOT_PRESENT` state;
- clean/dirty state and counts for tracked, untracked, and unmerged entries,
  without filenames; and
- producer/probe Node version, OS/platform, architecture, and Git version.

The origin/default-branch observation is only the existing local
remote-tracking ref. It is never represented as live origin or GitHub truth.
Runtime values describe the producer environment, not target-repository
requirements, language, framework, or toolchain compatibility.

## Safety and trust boundary

All Git calls use argument-vector process execution with shell interpolation
disabled. Git-control variables inherited from the producer process are removed
case-insensitively; the probe supplies only controlled
`GIT_CONFIG_GLOBAL=<platform null device>`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_OPTIONAL_LOCKS=0`, and `GIT_TERMINAL_PROMPT=0` values. Ordinary runtime
variables such as `PATH` remain available. System/global Git configuration is
therefore excluded, while explicit command-line configuration disables
fsmonitor, untracked-cache, and submodule recursion behavior from target-local
configuration. Paging is disabled.

HEAD, attached/detached branch state, and worktree records come from one local
porcelain-v2 status observation. The default-branch local tracking ref and the
stable canonical-rule content are observed alongside it. The producer repeats
that complete observation and requires equal HEAD, branch, tracking-ref,
worktree counts, and rule bytes. Detected concurrent ref, index, worktree, rule,
or root drift fails closed. This is bounded stability detection, not an atomic
filesystem/Git transaction: it does not claim to detect a value that changes
and cycles back to the identical observed value between samples.

The command set is local and read-only. The producer performs no network
request and does not fetch, mutate the worktree or index, update HEAD or refs,
change Git configuration, or write repository files. No mutating lock is
acquired. Generated source references do not repeat machine-specific absolute
paths, and public failures use a small sanitized vocabulary without raw paths,
Git stderr, process details, credentials, environment values, or storage
internals.

`tracked changes` counts porcelain-v2 ordinary (`1`) and rename/copy (`2`)
records. A rename/copy's second path token is not another record. `untracked
entries` counts emitted `?` records under `--untracked-files=all`, and
`unmerged/conflict entries` counts `u` records. Ignored entries are not emitted,
and submodule changes are excluded by `--ignore-submodules=all`. Filenames are
never copied into model-facing evidence.

The returned snapshot, repository reference, arrays, and text blocks are
recursively frozen and detached. Trust exists only when the result is obtained
directly from this verified producer operation. Equal-shaped serialized DATA
is ordinary DATA: no parser, trust marker, verification flag, signature,
attestation, or capability upgrades it to producer output. The API accepts no
caller-controlled `candidateClass` and exposes no generic classifier.

This slice does not compile or assemble a `JitContextPacket`, invoke QA profile
narrowing operationally, retrieve Promoted Context, or convert observations to
S2D6a `DeterministicEngineeringFactData`. It adds no QA-instruction, locked-
invariant, bounded-retest-target, Task Contract, or acceptance-criteria
producer. Those sources and final operational packet integration remain
deferred.
