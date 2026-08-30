# Codex App Server C-lite Compatibility Check V0

## Purpose and authority

C-lite answers one question: does the exact trusted Console-owned Codex
candidate expose the App Server protocol contract currently consumed by Codex
Task Console?

C-lite depends on ACCEPTED Console-Owned Codex Runtime Ownership V0. It derives
the repository-tested release and current platform target, then calls Runtime
Ownership's candidate resolver. The resolver's canonical `OWNED_RELEASE` path
is the only executable authority. C-lite does not use ambient `PATH`, the active
selector, or a caller-supplied binary. The candidate must report exactly
`codex-cli 0.148.0-alpha.9`; any other version fails closed and requires
revalidation.

## Bounded check

C-lite invokes the canonical owned binary directly, without a shell, for only:

```text
app-server generate-ts --out <private-root>/schemas/typescript
app-server generate-json-schema --out <private-root>/schemas/json-schema
```

Neither command includes `--experimental`. Every check creates a mode-`0700`
disposable root beneath the canonical operating-system temporary directory.
The generator subprocesses receive only private `HOME`, `CODEX_HOME`, `TMPDIR`,
and `PATH` directories beneath that root. Generated TypeScript and JSON Schema
artifacts are parsed in place and removed after success or failure. Failure to
establish isolation or clean the disposable root makes the result incompatible.
No generated bundle is checked in or retained as runtime authority.

Compatibility is semantic and limited to the methods declared in
`protocol.ts`: the supported client requests and `initialized` notification;
the consumed thread, goal, turn, item, delta, usage, completion, and
request-resolution notifications; and command-execution and file-change
approval requests. Validation also covers the currently consumed required
request parameters and initialization, thread, turn, text-input, token-usage,
and approval shapes. Unrelated additive schema surface does not fail C-lite or
expand Console support.

The result is a small sanitized record containing compatibility, the exact
tested version, runtime target, owned-candidate authority, schema-generation
and consumed-contract outcomes, excluded experimental capabilities, a bounded
schema provenance hash, and a typed failure classification. It never includes
raw subprocess output, credential data, private paths, generated schemas, or
ambient environment content.

## Explicit non-goals and downstream gate

C-lite does not install, activate, select, or roll back Codex; mutate
`active.json` or `.active.lock`; start App Server; perform the initialization
handshake; create or resume a thread; start, interrupt, or stream a turn; handle
live approvals; access credentials; call a model/provider; implement transport,
persistence, orchestration, worktrees, UI, or another provider.

Live Codex App Server execution remains blocked until C-lite completes
comprehensive hardening, independent QA, and explicit acceptance.
