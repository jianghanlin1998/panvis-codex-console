# JIT Context Packet / Compiler — Core Contract

This is one bounded foundation slice inside the JIT Context Packet / Compiler
product stage. It defines the provider-neutral structured DATA boundary that a
future trusted integration can pass toward execution. It is not the operational
Context Engine integration.

## Trust and access precondition

`compileJitContextPacket` consumes content that an upstream boundary has already
authorized and classified. The compiler does not establish ACL access,
provenance authenticity, Project-rule authority, repository/runtime observation
authenticity, human acceptance, Promoted Context acceptance, or deterministic
evidence verification. Structurally valid caller-supplied DATA proves only its
shape. The compiler validates and narrows its own packet contract; it never
widens access.

The intended future sequence remains:

```text
ACL
-> execution/profile narrowing
-> trusted retrieval
-> trusted selection
-> Context Packet Core
-> deterministic execution-input serialization and UTF-8 byte preflight
-> provider serialization
-> execution
```

The two public schemas and the compiler have deliberately different meanings:

- `JitContextPacketCompilationInputSchema.parse(...)` validates compilation-input
  DATA shape only. It does not prove that ACL authorization or trusted source
  classification occurred.
- `JitContextPacketSchema.parse(...)` validates packet DATA shape only. A caller
  can construct packet-shaped JSON, including the required literal
  `reasonIncluded` values, without using the compiler. Parser success therefore
  proves neither compiler origin nor operational injection safety.
- `compileJitContextPacket(...)` produces one deterministic detached packet from
  the supplied captured DATA under the caller's pre-established trusted
  integration precondition. Compiler success still does not authenticate
  external provenance.

No parser-based compiler-origin, trust, authorization, signature, or capability
bridge exists in this slice.

## Profiles and fixed structure

The exact profiles are:

- `STANDARD_SUBTASK_EXECUTION`
- `FRESH_INDEPENDENT_QA`
- `FOCUSED_RE_QA`

Standard execution always emits these sections in this structural order:

1. `CANONICAL_PROJECT_RULES`
2. `REPOSITORY_RUNTIME_EVIDENCE`
3. `PROJECT_CORE`
4. `BIG_TASK_CONTRACT`
5. `SUBTASK_CONTRACT`
6. `ACCEPTANCE_CRITERIA`
7. `EXECUTION_INTENT`
8. `ACTIVE_PROJECT_CONTEXT`
9. `ACTIVE_BIG_TASK_CONTEXT`
10. `ACTIVE_SUBTASK_CONTEXT`

Both QA profiles always emit:

1. `CANONICAL_PROJECT_RULES`
2. `REPOSITORY_RUNTIME_EVIDENCE`
3. `PROJECT_CORE`
4. `BIG_TASK_CONTRACT`
5. `SUBTASK_CONTRACT`
6. `ACCEPTANCE_CRITERIA`
7. `LOCKED_INVARIANTS`
8. `QA_INSTRUCTIONS`
9. `BOUNDED_RETEST_TARGETS`

Empty list sections remain present. Section position is structural and is not a
truth, authority, importance, recency, or budget ranking.

Every section has a fixed compiler-generated `reasonIncluded` value derived
from its section type. Callers cannot supply or override it.

## Task and context projection

The compiler validates the exact ID hierarchy `Project -> Big Task -> Subtask`.
It projects only stable model-relevant task fields. Operational Project
concurrency and Subtask status, maturity, start policy, and delegation policy do
not enter task sections. Big Task and Subtask acceptance criteria remain
separate and retain stored order. Standard execution intent is derived only
from the canonical Subtask's `recommendedReasoningLevel` and `promptSeed`; QA
packets do not expose it.

Standard execution accepts the three already-selected S2B2 ACTIVE buckets. Each
item must be ACTIVE and match the exact Project, Big Task, or Subtask scope for
its supplied bucket. A malformed, wrong-scope, non-ACTIVE, or duplicate-ID item
fails closed. Valid item order and provenance are preserved exactly. The
compiler does not sort, rank, deduplicate, merge, apply latest-wins, or resolve
conflicting human-readable content.

Fresh Independent QA and Focused Re-QA structurally exclude ACTIVE Context
Items, Digests, Promoted Context, raw history, prior chat, prior reasoning,
prior Handoffs, prior self-assessment, and standard execution intent. Focused
Re-QA requires at least one canonical `BoundedRetestTarget`; Fresh QA may contain
zero or more.

## Deferred operational layers

Canonical Project-rule and repository/runtime-evidence blocks carry only
bounded `sourceReference`, `title`, and `body` DATA. Their slot names do not
authenticate their provenance. S2D6a `DeterministicEngineeringFactData` is not
automatically converted into trusted evidence. S2D5a snapshot-shaped DATA is
not an input and no accepted Promoted Context field or retrieval bridge exists.

For every Packet text block, `sourceReference` and `title` remain
trim-normalized and non-empty. A valid `body` preserves the caller's original
string and whitespace exactly, must be nonblank after trimming, and is bounded
to 4,000 JavaScript UTF-16 code units before any trimming. These DATA-shape
rules add no trust, provenance, authorization, or compiler-origin semantics.

The packet contains no raw history, chat, Digest, search result, Promoted
Context payload, provider message array, final prompt string, Codex request, or
budget result. Packet Core itself performs no measurement, truncation, pruning,
or enforcement. The downstream Execution Input Preflight V0 serializes the
exact Console-owned context text, measures its UTF-8 byte length, applies a
40,000-byte normal target and 64,000-byte absolute cap, and blocks only above
the cap. Bytes are not tokens. Provider-reported actual token usage remains a
separate post-start accounting signal.

Compilation is pure and deterministic. Runtime inputs pass through the shared
fail-closed structural-capture boundary, successful output is detached from
caller input, and the packet and every nested array/object are frozen.
