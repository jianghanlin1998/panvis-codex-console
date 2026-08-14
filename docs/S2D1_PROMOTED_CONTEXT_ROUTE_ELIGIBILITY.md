# S2D1 Promoted Context route eligibility

S2D1 defines one pure deterministic policy boundary for deciding whether a requested route may later carry a promoted conclusion from a source Subtask. It implements the structural rule **discussion stays isolated; conclusions may be explicitly shared**. It does not define promoted content or grant any context access by itself.

`evaluatePromotedContextRoute(topology, route)` accepts minimal canonical Project, Big Task, Subtask ownership views plus existing explicit `SubtaskDependency` records. It returns `valid`, `eligible`, and a closed stable reason. Malformed routes, duplicate task identifiers, broken ownership, malformed dependency records, duplicate or missing dependency endpoints, self-dependencies, cross-Big-Task dependencies, and invalid blocking cycles fail closed. The evaluator performs no I/O, writes, time reads, randomness, input mutation, storage access, or Audit Event creation.

Evaluation first captures route and topology evidence together as a stable descriptor-backed structural representation. Accessors are not invoked, security-relevant fields are not reread from the caller after capture, and changing or throwing runtime objects, records, and arrays fail closed. Stable ordinary, null-prototype, frozen, sealed, cloned, JSON-round-tripped, and transparent Proxy representations remain compatible.

Exactly two audience kinds exist:

- `PARENT_BIG_TASK`: a source Subtask may route only to its own parent Big Task. No dependency is required. Another Big Task in the same Project and every Big Task in another Project are denied.
- `DOWNSTREAM_SUBTASK`: a source A may route to target B only when the topology contains the exact explicit dependency edge whose `upstreamSubtaskId` is A and `downstreamSubtaskId` is B. `BLOCKING + HARDENED`, `BLOCKING + ACCEPTED`, and `INFORMATIONAL + NONE` all qualify structurally.

Direction is exact. An A to B dependency does not permit B to A. A to B plus B to C does not permit A to C; an explicit A to C edge is required. Sibling ownership alone grants no route. Existing dependency validation remains authoritative, so the route cannot bypass same-Big-Task and same-Project boundaries.

Required gates and Subtask maturity belong to dependency readiness, not route eligibility. The evaluator does not inspect maturity, readiness, or required-gate satisfaction. Eligibility means only that the relationship may later be offered a promoted conclusion; it is not content validity, provenance validation, acceptance, readiness satisfaction, raw-context access, or Context Packet inclusion.

Promotion eligibility does not call or modify `buildAllowedContextSet`. A downstream target's raw ACL remains exactly its Project, parent Big Task, and own Subtask scopes. Upstream and sibling raw chats, histories, reasoning, Handoffs, and Context Items remain inaccessible through this contract.

Promoted Context body and identifiers, provenance, acceptance or approval, persistence, supersession, retrieval, token budgeting, compiler or Context Packet integration, and all raw-history transfer remain deferred.
