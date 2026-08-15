# S2D3 Promoted Context acceptance authority policy

S2D3 defines only the authority requirement that a valid, promotion-eligible S2D2 candidate must satisfy before a future layer could accept it as Promoted Context. `evaluatePromotedContextAcceptanceRequirement(topology, candidate)` first delegates candidate and route evaluation to S2D2. Invalid candidates and invalid or ineligible S2D1 routes receive no actionable acceptance requirement and retain their closed failure reason.

Codex or another LLM may propose a candidate but can never accept it. The public requirement contract has exactly two values and no model, system, repository-source, confidence, or automatic-accept path:

- `DECISION`, `REQUIREMENT`, `CONSTRAINT`, `OPEN_QUESTION`, and `RISK` require `HUMAN_CONFIRMATION_REQUIRED` from the single authorized Console human.
- `ENGINEERING_FACT` requires `DETERMINISTIC_EVIDENCE_OR_HUMAN`. This permits a future separately approved deterministic-evidence verifier or explicit human confirmation; S2D3 does not validate evidence and does not auto-accept the candidate.

Human confirmation of an `OPEN_QUESTION` would mean only that the unresolved question is important durable cross-task context. It would not answer, resolve, close, or establish the question as a factual assertion.

For an eligible candidate, only its canonical S2D2 `kind` selects the requirement. The evaluator uses the detached candidate returned by S2D2 and never rereads the caller's potentially hostile `kind`. Audience kind, `sourceType`, title or body wording, source-reference wording, and evidence-reference presence, count, or wording do not change the requirement. Evidence references remain opaque references and are not deterministic proof.

The existing `ContextAuthoritySchema` values—`HUMAN`, `REPO_EVIDENCE`, `CODEX_CANDIDATE`, and `SYSTEM`—remain unchanged and are not S2D3 acceptance decisions. In particular, repository or system provenance does not establish that evidence passed a future acceptance verifier.

S2D3 creates no accepted or approval state, evidence-validation result, record, identity, actor, timestamp, rejection flow, persistence, SQL, migration, storage API, Audit Event, or Context Item. It performs no I/O, Git, filesystem, network, time, randomness, environment read, or mutation. Accepted-context materialization, retrieval, QA-profile injection, raw ACL changes, Context Packet compilation, and prompt integration remain deferred.
