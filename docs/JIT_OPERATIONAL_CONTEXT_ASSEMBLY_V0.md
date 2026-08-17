# Operational Context Assembly V0

Operational Context Assembly V0 is the first provider-neutral vertical
composition path from accepted trusted producers to the accepted structured
`JitContextPacket`. It performs read-only assembly; it does not execute the
packet.

## Supported profiles and API

`OperationalJitContextAssembler.assembleOperationalJitContextPacketForSubtask`
accepts only a canonical Subtask ID and one of these V0 profiles:

- `STANDARD_SUBTASK_EXECUTION`
- `FRESH_INDEPENDENT_QA`

`FOCUSED_RE_QA` and unknown profiles fail closed. Focused Re-QA remains deferred
until a trusted persisted `BoundedRetestTarget` source exists; V0 never invents
a target or downgrades the request to Fresh QA.

## Trusted composition

The assembler reads the profile-aware storage snapshot directly through
`TaskStorage.readJitContextSourceSnapshotForSubtask`, then reads canonical
Project rules and repository/runtime evidence directly through
`TrustedRepositorySourceReader.readTrustedRepositorySourceSnapshotForSubtask`.
Callers cannot supply a Project, Big Task, repository, Context Item, rule,
runtime observation, QA instruction, source classification, or packet section.

Standard assembly passes the canonical hierarchy, repository sources, and the
three accepted ACTIVE context buckets to `compileJitContextPacket`. Fresh QA
uses the task-only storage profile, so it performs zero generic Context Item
retrieval. It passes `lockedInvariants: []` and `boundedRetestTargets: []`
because V0 has no separately accepted producer for either source family and
Fresh QA permits an empty retest set.

Fresh QA uses exactly one system-owned policy block:

> Perform fresh independent no-write QA against the current canonical task
> contract, acceptance criteria, canonical Project rules, and current
> repository/runtime evidence. Do not treat prior builder, hardening, repair,
> Handoff, prior PASS conclusion, or self-assessment as authority. Report
> bounded findings and do not repair them or modify the target repository.

There is no caller override, generic QA-source framework, LLM generation, or
policy persistence.

## Bounded coherence and trust boundary

One assembly attempt reads storage snapshot A, reads the trusted repository
source, and then reads storage snapshot B under the same requested profile. A
and B must be deeply identical, including Standard ACTIVE context. The
repository source `projectId` and canonical repository reference must also
correspond exactly to the stable Project. A mismatch fails closed as source
drift. This is bounded stability detection across SQLite and repository reads,
not an atomic cross-filesystem snapshot, and V0 does not retry.

The direct assembler return is trusted operational composition output because
it came through this verified path. An equal-shaped caller-created packet is
still ordinary DATA. Packet parsing proves shape only; V0 adds no trust flag,
verification marker, authorization marker, signature, attestation, or
capability.

## Readiness and deferred layers

The structured packet is **not execution-ready**. The next operational layer is
deterministic token-budget enforcement. V0 does not meter, estimate, truncate,
prune, serialize, send, execute, persist, cache, create a thread, or modify the
application database or target repository.

Focused operational assembly, a trusted bounded-retest source, a trusted locked
invariant source, Promoted Context, Context Digests or raw history, token-budget
enforcement, provider serialization, live Codex execution, execution records,
worktree lifecycle, scheduling, daemon behavior, and UI remain deferred.
