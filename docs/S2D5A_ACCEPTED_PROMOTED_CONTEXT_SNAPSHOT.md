# S2D5a accepted Promoted Context snapshot

S2D5a defines the immutable data shape of a Promoted Context conclusion accepted through the human-confirmation path and one pure internal transition core that composes the accepted S2D1-S2D4 contracts. It does not expose an operational acceptance command.

`AcceptedPromotedContextSnapshotDataSchema` is the deliberate package-root DATA contract. Its exact strict shape is:

```text
{
  candidate: PromotedContextCandidate,
  acceptance: {
    method: "HUMAN_CONFIRMATION",
    evidence: PromotedContextHumanConfirmationEvidence
  }
}
```

The candidate is exactly the canonical detached S2D2 candidate, containing only `route`, `kind`, `title`, `body`, and `provenance`. The evidence is exactly the canonical detached S2D4 evidence, containing only `evidenceType`, `sourceReference`, and `occurredAt`. Candidate and evidence are atomically bound in one deeply frozen snapshot value. The snapshot does not repeat the S2D3 requirement because that requirement remains policy-derived; it records only the human method actually used.

`acceptPromotedContextFromTrustedHumanAction(topology, candidate, evidence)` is internal to the domain source module and intentionally absent from the package-root API. Its name states its precondition: the caller must already be inside a trusted local human-action boundary. The function does not authenticate a human or establish that boundary. It jointly captures detached candidate, nested route, topology, and evidence input state; delegates human evidence applicability to S2D4; obtains the canonical candidate from S2D2 using the same detached evidence; fails closed on joint-capture or unexpected upstream disagreement; and returns a closed frozen accepted-or-failure result. The future trusted human-action controller owns the only deliberate operational entrypoint.

The public DATA schema validates serialized shape only. A caller can construct JSON that passes `AcceptedPromotedContextSnapshotDataSchema.parse(...)`; this does not prove that trusted human acceptance happened. No parser-based trust or authenticity API exists. A future durable layer must create trusted accepted state only through its approved transition and write path, never by treating arbitrary snapshot-shaped JSON as acceptance authority.

S2D5a adds no candidate or accepted-record ID, hash, digest, fingerprint, `acceptedAt`, system transition timestamp, actor, user, role, RBAC, session, signature, capability, deterministic-evidence claim, persistence, migration, storage API, Audit Event, Context Item materialization, retrieval, Context Packet/compiler integration, idempotency key, deduplication, one-shot consumption, or anti-replay behavior. Repeated stable calls may return structurally equivalent data because the slice has no durable identity or storage.

An accepted `OPEN_QUESTION` remains unresolved; acceptance means only that the unresolved question is durable promoted context. An `ENGINEERING_FACT` accepted through this path records only `HUMAN_CONFIRMATION`; it does not imply that deterministic repository evidence existed or was validated.

The function performs no filesystem, network, Git, database, current-time, environment, randomness, persistence, or mutation effect. S2A raw ACL, S2B retrieval and ACTIVE selection, and S2C1 Fresh Independent QA exclusion of generic `PROMOTED_CONTEXT` remain unchanged.
