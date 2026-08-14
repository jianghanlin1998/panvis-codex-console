# S2C1 QA clean-context profile

S2C1 defines a pure deterministic pre-retrieval eligibility contract for QA context. `AllowedContextSet` remains the maximum ACL ceiling. A QA profile can only narrow candidates that a trusted upstream boundary has already allowed; `includedByProfile: true` means only that the profile does not exclude that candidate. It is never a profile-based access grant. Model instructions may request less context but cannot widen this deterministic boundary, and excluded content must not be retrieved first and hidden only by a prompt instruction.

Both `FRESH_INDEPENDENT_QA` and `FOCUSED_RE_QA` include only these candidate classes:

- `CANONICAL_PROJECT_RULE`
- `TASK_CONTRACT`
- `ACCEPTANCE_CRITERIA`
- `LOCKED_INVARIANT`
- `REPO_RUNTIME_EVIDENCE`
- `QA_INSTRUCTION`
- `BOUNDED_RETEST_TARGET`

They exclude generic `ACTIVE_CONTEXT_ITEM`, `DIGEST`, `PROMOTED_CONTEXT`, and `RAW_HISTORY`, plus `PRIOR_RAW_CHAT`, `PRIOR_REASONING`, `PRIOR_HANDOFF`, and `PRIOR_SELF_ASSESSMENT`. Authority, maturity, status, and semantically important-looking source references do not override candidate class. Unknown profile or candidate-class values fail closed.

Focused re-QA can receive a bounded factual retest target containing exactly `findingId` (128 characters), `violatedInvariant` (1,000), `affectedContract` (256), and a validated `repairedSha`. Fields are trimmed, non-empty, bounded, and strict; repair reasoning, reproduction strategy, prior PASS judgments, full Handoffs, raw chat, chain-of-thought, implementation notes, and all other extra fields are rejected structurally without semantic text inspection.

Candidate descriptors contain metadata only: `candidateClass`, `sourceReference`, and the strict structured retest target only for `BOUNDED_RETEST_TARGET`. The intended later flow is trusted provenance classification, profile evaluation, and only then content retrieval or injection. `narrowContextCandidatesForQa` preserves input order and duplicates, returns only supplied candidate references, exposes included and excluded decisions, and never sorts, deduplicates, synthesizes, retrieves, or mutates candidates.

S2C1 does not determine provenance. Future integration must derive candidate class from trusted deterministic source provenance; a model or untrusted caller relabeling prior chat as a Task Contract is not an approved mechanism. Classification, retrieval, and compiler integration remain deferred.

This slice does not filter S2B1 or S2B2 storage output and does not add thread/history retrieval, Handoff injection, Promoted Context, Context Digest injection, Context Packet compilation, persistence, SQL, schemas, or migrations. Those layers must consume this narrowing contract only after their own separately approved provenance and ACL work exists.
