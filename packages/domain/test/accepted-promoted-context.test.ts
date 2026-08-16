import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AcceptedPromotedContextSnapshotDataSchema,
  ContextKindSchema,
  ContextScopeSchema,
  PromotedContextCandidateSchema,
  PromotedContextRouteTopologySchema,
  SubtaskDependencySchema,
  evaluateContextScopeAccess,
  evaluatePromotedContextCandidate,
  evaluatePromotedContextHumanConfirmationEvidence,
  evaluateQaContextProfileCandidate,
} from "../src/index.js";
import type {
  AllowedContextSet,
  ContextKind,
  PromotedContextCandidate,
  PromotedContextRouteTopology,
  SubtaskDependency,
} from "../src/index.js";
import {
  TrustedHumanPromotedContextAcceptanceFailureReasonSchema,
  TrustedHumanPromotedContextAcceptanceResultSchema,
  acceptPromotedContextFromTrustedHumanAction,
} from "../src/accepted-promoted-context.js";

const dependency = (): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId: "st_a",
    downstreamSubtaskId: "st_b",
    dependencyType: "BLOCKING",
    requiredGate: "HARDENED",
    reason: "st_a explicitly informs st_b.",
  });

const topology = (
  dependencies: readonly SubtaskDependency[] = [dependency()],
): PromotedContextRouteTopology =>
  PromotedContextRouteTopologySchema.parse({
    projects: [{ id: "prj_one" }],
    bigTasks: [{ id: "bt_one", projectId: "prj_one" }],
    subtasks: [
      { id: "st_a", bigTaskId: "bt_one" },
      { id: "st_b", bigTaskId: "bt_one" },
    ],
    dependencies,
  });

const candidateInput = (overrides: Record<string, unknown> = {}) => ({
  route: {
    sourceSubtaskId: "st_a",
    audienceKind: "DOWNSTREAM_SUBTASK",
    targetSubtaskId: "st_b",
  },
  kind: "DECISION",
  title: "  Bind the accepted conclusion  ",
  body: "  Candidate and evidence form one immutable value.  ",
  provenance: {
    sourceType: "MANUAL",
    sourceReference: "  candidate:s2d5a  ",
    evidenceReferences: ["  evidence:one  ", "evidence:two"],
  },
  ...overrides,
});

const candidate = (
  overrides: Record<string, unknown> = {},
): PromotedContextCandidate =>
  PromotedContextCandidateSchema.parse(candidateInput(overrides));

const evidenceInput = (overrides: Record<string, unknown> = {}) => ({
  evidenceType: "HUMAN_CONFIRMATION",
  sourceReference: "  local-action:accept-001  ",
  occurredAt: "2026-08-16T08:30:00+08:00",
  ...overrides,
});

const accept = (
  graph: PromotedContextRouteTopology = topology(),
  promotedCandidate: PromotedContextCandidate = candidate(),
  evidence: unknown = evidenceInput(),
) =>
  acceptPromotedContextFromTrustedHumanAction(
    graph,
    promotedCandidate,
    evidence,
  );

const expectAccepted = (result: ReturnType<typeof accept>) => {
  expect(result.accepted).toBe(true);
  if (!result.accepted) {
    throw new Error(`Expected accepted result, received ${result.reason}.`);
  }
  return result.snapshot;
};

describe("S2D5a accepted Promoted Context snapshot DATA contract", () => {
  it("locks the exact strict shape and HUMAN_CONFIRMATION method", () => {
    expect(Object.keys(AcceptedPromotedContextSnapshotDataSchema.shape)).toEqual([
      "candidate",
      "acceptance",
    ]);
    expect(
      Object.keys(
        AcceptedPromotedContextSnapshotDataSchema.shape.acceptance.shape,
      ),
    ).toEqual(["method", "evidence"]);

    const snapshot = expectAccepted(accept());
    expect(Object.keys(snapshot)).toEqual(["candidate", "acceptance"]);
    expect(Object.keys(snapshot.acceptance)).toEqual(["method", "evidence"]);
    expect(snapshot.acceptance.method).toBe("HUMAN_CONFIRMATION");
    expect(Object.keys(snapshot.acceptance.evidence)).toEqual([
      "evidenceType",
      "sourceReference",
      "occurredAt",
    ]);
    expect(
      AcceptedPromotedContextSnapshotDataSchema.safeParse(snapshot).success,
    ).toBe(true);
    for (const method of [
      "AUTO",
      "SYSTEM",
      "CODEX",
      "MODEL",
      "REPO",
      "DETERMINISTIC_EVIDENCE",
    ]) {
      expect(
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          acceptance: { ...snapshot.acceptance, method },
        }).success,
      ).toBe(false);
    }
  });

  it.each(ContextKindSchema.options)(
    "reuses the canonical S2D2 candidate and canonical S2D4 evidence for %s",
    (kind: ContextKind) => {
      const graph = topology();
      const promotedCandidate = candidate({ kind });
      const callerEvidence = evidenceInput();
      const snapshot = expectAccepted(
        accept(graph, promotedCandidate, callerEvidence),
      );
      const candidateEvaluation = evaluatePromotedContextCandidate(
        graph,
        promotedCandidate,
      );
      const evidenceEvaluation =
        evaluatePromotedContextHumanConfirmationEvidence(
          graph,
          promotedCandidate,
          callerEvidence,
        );

      expect(candidateEvaluation.eligibleForPromotion).toBe(true);
      expect(evidenceEvaluation.structurallyApplicable).toBe(true);
      if (
        !candidateEvaluation.eligibleForPromotion ||
        !evidenceEvaluation.structurallyApplicable
      ) {
        return;
      }
      expect(snapshot.candidate).toEqual(candidateEvaluation.candidate);
      expect(snapshot.acceptance.evidence).toEqual(evidenceEvaluation.evidence);
      expect(snapshot.acceptance).toEqual({
        method: "HUMAN_CONFIRMATION",
        evidence: {
          evidenceType: "HUMAN_CONFIRMATION",
          sourceReference: "local-action:accept-001",
          occurredAt: "2026-08-16T00:30:00.000Z",
        },
      });
    },
  );

  it("rejects identity, timing, actor, trust, and approval scope creep", () => {
    const snapshot = expectAccepted(accept());
    const forbiddenFields = [
      "id",
      "accepted",
      "acceptanceId",
      "recordId",
      "eventId",
      "snapshotId",
      "candidateId",
      "candidateHash",
      "hash",
      "acceptedAt",
      "createdAt",
      "updatedAt",
      "transitionedAt",
      "actor",
      "user",
      "RBAC",
      "approved",
      "trusted",
      "verified",
      "authoritySatisfied",
      "confirmationSatisfied",
    ];
    const serialized = JSON.stringify(snapshot);
    for (const field of forbiddenFields) {
      expect(serialized).not.toContain(`"${field}"`);
      expect(
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          [field]: "forbidden",
        }).success,
      ).toBe(false);
    }
    for (const field of [
      "candidateId",
      "candidateHash",
      "candidateDigest",
      "candidateFingerprint",
      "contentHash",
      "sourceSubtaskSnapshotId",
    ]) {
      expect(
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          candidate: { ...snapshot.candidate, [field]: "forbidden" },
        }).success,
      ).toBe(false);
    }
    for (const field of [
      "requirement",
      "acceptedAt",
      "actorType",
      "acceptedBy",
      "approvedBy",
      "session",
      "signature",
      "deterministicEvidence",
    ]) {
      expect(
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          acceptance: { ...snapshot.acceptance, [field]: "forbidden" },
        }).success,
      ).toBe(false);
    }
  });

  it("treats schema parsing as shape validation rather than authenticity proof", () => {
    const handConstructed = {
      candidate: candidateInput(),
      acceptance: {
        method: "HUMAN_CONFIRMATION",
        evidence: evidenceInput(),
      },
    };
    const parsed = AcceptedPromotedContextSnapshotDataSchema.parse(handConstructed);
    expect(parsed.acceptance.method).toBe("HUMAN_CONFIRMATION");
    expect(parsed.candidate.title).toBe("Bind the accepted conclusion");
    expect(parsed.acceptance.evidence.occurredAt).toBe(
      "2026-08-16T00:30:00.000Z",
    );

    const source = readFileSync(
      new URL("../src/accepted-promoted-context.ts", import.meta.url),
      "utf-8",
    );
    for (const forbiddenApi of [
      "isTrustedAcceptedSnapshotFromSchema",
      "verifyAcceptedByParsing",
      "schemaAccepted",
      "trustedAccepted",
      "createTrustedCapability",
      "mintHumanCapability",
    ]) {
      expect(source).not.toContain(forbiddenApi);
    }
  });
});

describe("S2D5a internal trusted-human transition composition", () => {
  it("preserves closed S2D4 failures for stable invalid inputs", () => {
    const invalidCandidate = candidateInput({ title: " " });
    const invalidRoute = candidateInput({
      route: {
        sourceSubtaskId: " st_a ",
        audienceKind: "DOWNSTREAM_SUBTASK",
        targetSubtaskId: "st_b",
      },
    });
    const invalidTopology = {
      ...topology(),
      unexpected: true,
    };

    expect(
      accept(
        topology(),
        invalidCandidate as unknown as PromotedContextCandidate,
      ),
    ).toEqual({ accepted: false, reason: "INVALID_CANDIDATE" });
    expect(
      accept(
        topology(),
        invalidRoute as unknown as PromotedContextCandidate,
      ),
    ).toEqual({ accepted: false, reason: "INVALID_ROUTE" });
    expect(
      accept(
        invalidTopology as PromotedContextRouteTopology,
        candidate(),
      ),
    ).toEqual({ accepted: false, reason: "INVALID_TOPOLOGY" });
    expect(accept(topology(), candidate(), evidenceInput({ evidenceType: "MODEL" })))
      .toEqual({
        accepted: false,
        reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
      });
  });

  it("returns only closed, correlated, frozen internal results", () => {
    expect(TrustedHumanPromotedContextAcceptanceFailureReasonSchema.options)
      .toEqual([
        "INVALID_CANDIDATE",
        "SOURCE_SUBTASK_NOT_FOUND",
        "TARGET_BIG_TASK_NOT_FOUND",
        "TARGET_SUBTASK_NOT_FOUND",
        "NOT_SOURCE_PARENT_BIG_TASK",
        "NO_EXPLICIT_DEPENDENCY",
        "REVERSE_DIRECTION_NOT_ALLOWED",
        "CROSS_BIG_TASK_NOT_ALLOWED",
        "CROSS_PROJECT_NOT_ALLOWED",
        "INVALID_TOPOLOGY",
        "INVALID_ROUTE",
        "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
        "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
        "INCONSISTENT_UPSTREAM_EVALUATION",
      ]);
    const success = accept();
    const failure = accept(topology([]));
    expect(TrustedHumanPromotedContextAcceptanceResultSchema.safeParse(success).success)
      .toBe(true);
    expect(TrustedHumanPromotedContextAcceptanceResultSchema.safeParse(failure).success)
      .toBe(true);
    expect(failure).toEqual({ accepted: false, reason: "NO_EXPLICIT_DEPENDENCY" });
    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(
      TrustedHumanPromotedContextAcceptanceResultSchema.safeParse({
        accepted: true,
        snapshot: expectAccepted(success),
        reason: "NO_EXPLICIT_DEPENDENCY",
      }).success,
    ).toBe(false);
  });

  it("detaches and deeply freezes every nested snapshot structure", () => {
    const graph = topology();
    const callerCandidate = candidateInput() as unknown as PromotedContextCandidate;
    const callerEvidence = evidenceInput();
    const snapshot = expectAccepted(
      accept(graph, callerCandidate, callerEvidence),
    );
    const before = structuredClone(snapshot);

    (callerCandidate.route as { sourceSubtaskId: string }).sourceSubtaskId = "st_b";
    callerCandidate.provenance.evidenceReferences[0] = "changed";
    callerEvidence.sourceReference = "changed";
    (graph.projects[0] as unknown as { id: string }).id = "prj_changed";

    expect(snapshot).toEqual(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.candidate)).toBe(true);
    expect(Object.isFrozen(snapshot.candidate.route)).toBe(true);
    expect(Object.isFrozen(snapshot.candidate.provenance)).toBe(true);
    expect(
      Object.isFrozen(snapshot.candidate.provenance.evidenceReferences),
    ).toBe(true);
    expect(Object.isFrozen(snapshot.acceptance)).toBe(true);
    expect(Object.isFrozen(snapshot.acceptance.evidence)).toBe(true);
  });

  it("keeps OPEN_QUESTION unresolved and ENGINEERING_FACT on the human path only", () => {
    const openQuestion = expectAccepted(
      accept(topology(), candidate({ kind: "OPEN_QUESTION" })),
    );
    const engineeringFact = expectAccepted(
      accept(topology(), candidate({ kind: "ENGINEERING_FACT" })),
    );

    expect(openQuestion.candidate.kind).toBe("OPEN_QUESTION");
    expect(openQuestion).not.toHaveProperty("status");
    expect(openQuestion.candidate).not.toHaveProperty("status");
    expect(engineeringFact.acceptance.method).toBe("HUMAN_CONFIRMATION");
    expect(engineeringFact.acceptance).not.toHaveProperty("requirement");
    expect(engineeringFact.acceptance).not.toHaveProperty(
      "deterministicEvidence",
    );
  });
});

interface RelayCase {
  readonly label: string;
  readonly topology: PromotedContextRouteTopology;
  readonly candidate: PromotedContextCandidate;
  readonly evidence: unknown;
  readonly jointlyValidStates: readonly boolean[];
}

const makeCandidateTopologyRelay = (): RelayCase => {
  const candidateTarget = candidate() as unknown as Record<string, unknown>;
  const topologyTarget = topology([]) as PromotedContextRouteTopology & {
    dependencies: SubtaskDependency[];
  };
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1) => {
    candidateTarget.kind = state === 0 ? "DECISION" : "UNKNOWN";
    topologyTarget.dependencies = state === 0 ? [] : [dependency()];
    jointlyValidStates.push(
      candidateTarget.kind === "DECISION" &&
        topologyTarget.dependencies.length === 1,
    );
  };
  setState(0);
  return {
    label: "candidate/topology",
    candidate: new Proxy(candidateTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "provenance") {
          setState(1);
        }
        return descriptor;
      },
    }) as unknown as PromotedContextCandidate,
    topology: new Proxy(topologyTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "dependencies") {
          setState(0);
        }
        return descriptor;
      },
    }),
    evidence: evidenceInput(),
    jointlyValidStates,
  };
};

const makeCandidateEvidenceRelay = (): RelayCase => {
  const candidateTarget = candidate() as unknown as Record<string, unknown>;
  const evidenceTarget = evidenceInput() as Record<string, unknown>;
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1) => {
    candidateTarget.kind = state === 0 ? "DECISION" : "UNKNOWN";
    evidenceTarget.evidenceType = state === 0 ? "MODEL" : "HUMAN_CONFIRMATION";
    jointlyValidStates.push(
      candidateTarget.kind === "DECISION" &&
        evidenceTarget.evidenceType === "HUMAN_CONFIRMATION",
    );
  };
  setState(0);
  return {
    label: "candidate/evidence",
    candidate: new Proxy(candidateTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "provenance") {
          setState(1);
        }
        return descriptor;
      },
    }) as unknown as PromotedContextCandidate,
    topology: topology(),
    evidence: new Proxy(evidenceTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "occurredAt") {
          setState(0);
        }
        return descriptor;
      },
    }),
    jointlyValidStates,
  };
};

const makeTopologyEvidenceRelay = (): RelayCase => {
  const topologyTarget = topology() as PromotedContextRouteTopology & {
    dependencies: SubtaskDependency[];
  };
  const evidenceTarget = evidenceInput() as Record<string, unknown>;
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1) => {
    topologyTarget.dependencies = state === 0 ? [dependency()] : [];
    evidenceTarget.evidenceType = state === 0 ? "MODEL" : "HUMAN_CONFIRMATION";
    jointlyValidStates.push(
      topologyTarget.dependencies.length === 1 &&
        evidenceTarget.evidenceType === "HUMAN_CONFIRMATION",
    );
  };
  setState(0);
  return {
    label: "topology/evidence",
    candidate: candidate(),
    topology: new Proxy(topologyTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "dependencies") {
          setState(1);
        }
        return descriptor;
      },
    }),
    evidence: new Proxy(evidenceTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "occurredAt") {
          setState(0);
        }
        return descriptor;
      },
    }),
    jointlyValidStates,
  };
};

const makeThreeWayRelay = (): RelayCase => {
  const candidateTarget = candidate() as unknown as Record<string, unknown>;
  const topologyTarget = topology([]) as PromotedContextRouteTopology & {
    dependencies: SubtaskDependency[];
  };
  const evidenceTarget = evidenceInput({ evidenceType: "MODEL" }) as Record<
    string,
    unknown
  >;
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1 | 2) => {
    candidateTarget.kind = state === 0 ? "DECISION" : "UNKNOWN";
    topologyTarget.dependencies = state === 1 ? [dependency()] : [];
    evidenceTarget.evidenceType =
      state === 2 ? "HUMAN_CONFIRMATION" : "MODEL";
    jointlyValidStates.push(
      candidateTarget.kind === "DECISION" &&
        topologyTarget.dependencies.length === 1 &&
        evidenceTarget.evidenceType === "HUMAN_CONFIRMATION",
    );
  };
  setState(0);
  return {
    label: "three-way",
    candidate: new Proxy(candidateTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "provenance") {
          setState(1);
        }
        return descriptor;
      },
    }) as unknown as PromotedContextCandidate,
    topology: new Proxy(topologyTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "dependencies") {
          setState(2);
        }
        return descriptor;
      },
    }),
    evidence: new Proxy(evidenceTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "occurredAt") {
          setState(0);
        }
        return descriptor;
      },
    }),
    jointlyValidStates,
  };
};

describe("S2D5a joint acceptance-input snapshot safety", () => {
  it("rejects pairwise and three-way relays with zero false acceptances", () => {
    const relays = [
      makeCandidateTopologyRelay(),
      makeCandidateEvidenceRelay(),
      makeTopologyEvidenceRelay(),
      makeThreeWayRelay(),
    ];
    let falseAcceptedCount = 0;

    for (const relay of relays) {
      const result = accept(relay.topology, relay.candidate, relay.evidence);
      falseAcceptedCount += Number(result.accepted);
      expect(result, relay.label).toEqual({
        accepted: false,
        reason: "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
      });
      expect(relay.jointlyValidStates.length, relay.label).toBeGreaterThan(1);
      expect(relay.jointlyValidStates, relay.label).not.toContain(true);
    }
    expect(falseAcceptedCount).toBe(0);
  });
});

describe("S2D5a adjacent contract separation", () => {
  it("keeps S2A raw ACL and S2C1 Fresh QA exclusion unchanged", () => {
    const allowedContextSet = {
      target: {
        projectId: "prj_one",
        bigTaskId: "bt_one",
        subtaskId: "st_b",
      },
      allowedRawScopes: [
        { scopeType: "PROJECT", projectId: "prj_one" },
        {
          scopeType: "BIG_TASK",
          projectId: "prj_one",
          bigTaskId: "bt_one",
        },
        {
          scopeType: "SUBTASK",
          projectId: "prj_one",
          bigTaskId: "bt_one",
          subtaskId: "st_b",
        },
      ],
    } as unknown as AllowedContextSet;
    expect(
      evaluateContextScopeAccess(allowedContextSet, ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: "prj_one",
        bigTaskId: "bt_one",
        subtaskId: "st_a",
      })),
    ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", {
        candidateClass: "PROMOTED_CONTEXT",
        sourceReference: "accepted-snapshot:opaque-reference",
      }),
    ).toEqual({
      includedByProfile: false,
      reason: "EXCLUDED_PROMOTED_CONTEXT",
    });
  });

  it("imports only pure bounded domain contracts", () => {
    const source = readFileSync(
      new URL("../src/accepted-promoted-context.ts", import.meta.url),
      "utf-8",
    );
    for (const forbiddenRuntime of [
      /node:fs/,
      /node:net/,
      /node:http/,
      /storage\.js/,
      /sqlite/i,
      /drizzle/i,
      /process\.env/,
      /Date\.now/,
      /Math\.random/,
      /fetch\s*\(/,
      /AuditEventSchema/,
      /ContextItemSchema/,
    ]) {
      expect(source).not.toMatch(forbiddenRuntime);
    }
  });
});
