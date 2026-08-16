import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AuditActorTypeSchema,
  ContextAuthoritySchema,
  ContextKindSchema,
  PromotedContextCandidateSchema,
  PromotedContextHumanConfirmationEvaluationSchema,
  PromotedContextHumanConfirmationEvidenceSchema,
  PromotedContextHumanConfirmationReasonSchema,
  PromotedContextRouteSchema,
  PromotedContextRouteTopologySchema,
  SubtaskDependencySchema,
  evaluatePromotedContextHumanConfirmationEvidence,
} from "../src/index.js";
import type {
  ContextKind,
  PromotedContextCandidate,
  PromotedContextRouteTopology,
  SubtaskDependency,
} from "../src/index.js";

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
    requiredGate: "HARDENED",
    reason: `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
  });

const topology = (
  dependencies: readonly SubtaskDependency[] = [],
): PromotedContextRouteTopology =>
  PromotedContextRouteTopologySchema.parse({
    projects: [{ id: "prj_one" }, { id: "prj_foreign" }],
    bigTasks: [
      { id: "bt_one", projectId: "prj_one" },
      { id: "bt_two", projectId: "prj_one" },
      { id: "bt_foreign", projectId: "prj_foreign" },
    ],
    subtasks: [
      { id: "st_a", bigTaskId: "bt_one" },
      { id: "st_b", bigTaskId: "bt_one" },
      { id: "st_c", bigTaskId: "bt_one" },
      { id: "st_other", bigTaskId: "bt_two" },
      { id: "st_foreign", bigTaskId: "bt_foreign" },
    ],
    dependencies,
  });

const parentRoute = (targetBigTaskId = "bt_one") =>
  PromotedContextRouteSchema.parse({
    sourceSubtaskId: "st_a",
    audienceKind: "PARENT_BIG_TASK",
    targetBigTaskId,
  });

const downstreamRoute = (sourceSubtaskId = "st_a", targetSubtaskId = "st_b") =>
  PromotedContextRouteSchema.parse({
    sourceSubtaskId,
    audienceKind: "DOWNSTREAM_SUBTASK",
    targetSubtaskId,
  });

const candidateInput = (overrides: Record<string, unknown> = {}) => ({
  route: parentRoute(),
  kind: "DECISION",
  title: "Keep the human path structurally explicit",
  body: "The envelope is applicable evidence but does not execute acceptance.",
  provenance: {
    sourceType: "MANUAL",
    sourceReference: "candidate:human-confirmation-contract",
    evidenceReferences: [],
  },
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): PromotedContextCandidate =>
  PromotedContextCandidateSchema.parse(candidateInput(overrides));

const evidenceInput = (overrides: Record<string, unknown> = {}) => ({
  evidenceType: "HUMAN_CONFIRMATION",
  sourceReference: "console-action:confirm-001",
  occurredAt: "2026-08-16T08:30:00+08:00",
  ...overrides,
});

const evaluate = (
  graph: PromotedContextRouteTopology = topology(),
  promotedCandidate: PromotedContextCandidate = candidate(),
  evidence: unknown = evidenceInput(),
) =>
  evaluatePromotedContextHumanConfirmationEvidence(
    graph,
    promotedCandidate,
    evidence,
  );

const deepFreeze = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
};

describe("S2D4 exact human-confirmation evidence schema", () => {
  it("exposes exactly the three approved fields and canonicalizes them", () => {
    expect(Object.keys(PromotedContextHumanConfirmationEvidenceSchema.shape)).toEqual([
      "evidenceType",
      "sourceReference",
      "occurredAt",
    ]);
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.parse({
        evidenceType: "HUMAN_CONFIRMATION",
        sourceReference: "  local-console:action/确认  ",
        occurredAt: "2026-08-16T08:30:00+08:00",
      }),
    ).toEqual({
      evidenceType: "HUMAN_CONFIRMATION",
      sourceReference: "local-console:action/确认",
      occurredAt: "2026-08-16T00:30:00.000Z",
    });
  });

  it.each(["evidenceType", "sourceReference", "occurredAt"])(
    "rejects a missing %s",
    (field) => {
      const input = evidenceInput();
      delete input[field as keyof typeof input];
      expect(PromotedContextHumanConfirmationEvidenceSchema.safeParse(input).success)
        .toBe(false);
    },
  );

  it.each([
    "CODEX_CONFIRMATION",
    "SYSTEM_CONFIRMATION",
    "MODEL_CONFIRMATION",
    "AUTO_CONFIRMATION",
    "REPO_CONFIRMATION",
    "DETERMINISTIC_EVIDENCE",
    "human_confirmation",
    " HUMAN_CONFIRMATION ",
  ])("rejects non-human-only evidenceType %s", (evidenceType) => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.safeParse(
        evidenceInput({ evidenceType }),
      ).success,
    ).toBe(false);
  });

  it.each([
    "actorType",
    "actorReference",
    "userId",
    "humanId",
    "confirmedBy",
    "approvedBy",
    "confirmed",
    "approved",
    "accepted",
    "verified",
    "trusted",
    "candidateId",
    "candidateHash",
    "candidateFingerprint",
    "summary",
    "body",
    "comment",
    "reason",
    "metadata",
    "payload",
    "attachments",
    "deterministicEvidence",
    "repoEvidence",
    "modelConfidence",
    "codexApproved",
  ])("rejects strict extra field %s", (field) => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.safeParse(
        evidenceInput({ [field]: "spoofed" }),
      ).success,
    ).toBe(false);
  });
});

describe("S2D4 sourceReference and occurredAt boundaries", () => {
  it.each([1, 2_048])("accepts a %i-character sourceReference", (length) => {
    const parsed = PromotedContextHumanConfirmationEvidenceSchema.parse(
      evidenceInput({ sourceReference: "界".repeat(length) }),
    );
    expect(parsed.sourceReference).toHaveLength(length);
  });

  it("rejects 2,049 characters without truncation", () => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.safeParse(
        evidenceInput({ sourceReference: "a".repeat(2_049) }),
      ).success,
    ).toBe(false);
  });

  it.each(["", " ", "\t\n"])("rejects blank reference %j", (sourceReference) => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.safeParse(
        evidenceInput({ sourceReference }),
      ).success,
    ).toBe(false);
  });

  it("trims only the reference edges and preserves Unicode content", () => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.parse(
        evidenceInput({ sourceReference: "\u2003確認：动作 一\u2003" }),
      ).sourceReference,
    ).toBe("確認：动作 一");
  });

  it.each([
    ["UTC Z", "2026-08-16T00:30:00Z", "2026-08-16T00:30:00.000Z"],
    [
      "positive offset",
      "2026-08-16T08:30:00+08:00",
      "2026-08-16T00:30:00.000Z",
    ],
    [
      "negative offset",
      "2026-08-15T20:00:00-04:30",
      "2026-08-16T00:30:00.000Z",
    ],
  ])("accepts and canonicalizes %s", (_label, occurredAt, expected) => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.parse(
        evidenceInput({ occurredAt }),
      ).occurredAt,
    ).toBe(expected);
  });

  it.each([
    "2026-08-16",
    "2026-08-16T00:30:00",
    "2026-13-16T00:30:00Z",
    "not-a-date",
    "",
    1_765_000_000,
    null,
  ])("rejects invalid occurredAt %j", (occurredAt) => {
    expect(
      PromotedContextHumanConfirmationEvidenceSchema.safeParse(
        evidenceInput({ occurredAt }),
      ).success,
    ).toBe(false);
  });

  it("accepts old and future timestamps without reading current time", () => {
    for (const occurredAt of [
      "0001-01-01T00:00:00Z",
      "9999-12-31T23:59:59Z",
    ]) {
      expect(
        PromotedContextHumanConfirmationEvidenceSchema.safeParse(
          evidenceInput({ occurredAt }),
        ).success,
      ).toBe(true);
    }
  });
});

describe("S2D4 S2D3 authority-path reuse", () => {
  it.each(ContextKindSchema.options)(
    "makes valid human evidence structurally applicable for %s",
    (kind: ContextKind) => {
      const result = evaluate(topology(), candidate({ kind }));
      expect(result).toEqual({
        structurallyApplicable: true,
        requirement:
          kind === "ENGINEERING_FACT"
            ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
            : "HUMAN_CONFIRMATION_REQUIRED",
        reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
        evidence: {
          evidenceType: "HUMAN_CONFIRMATION",
          sourceReference: "console-action:confirm-001",
          occurredAt: "2026-08-16T00:30:00.000Z",
        },
      });
    },
  );

  it("preserves deterministic-evidence-or-human for ENGINEERING_FACT", () => {
    const result = evaluate(topology(), candidate({ kind: "ENGINEERING_FACT" }));
    expect(result.structurallyApplicable).toBe(true);
    expect(result.structurallyApplicable && result.requirement).toBe(
      "DETERMINISTIC_EVIDENCE_OR_HUMAN",
    );
  });

  it("distinguishes invalid evidence for an otherwise eligible candidate", () => {
    expect(evaluate(topology(), candidate(), { ...evidenceInput(), approved: true }))
      .toEqual({
        structurallyApplicable: false,
        reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
      });
  });

  it.each([
    ["wrong parent", topology(), parentRoute("bt_two"), "NOT_SOURCE_PARENT_BIG_TASK"],
    ["sibling", topology(), downstreamRoute(), "NO_EXPLICIT_DEPENDENCY"],
    [
      "reverse",
      topology([dependency("st_b", "st_a")]),
      downstreamRoute(),
      "REVERSE_DIRECTION_NOT_ALLOWED",
    ],
    [
      "transitive",
      topology([dependency("st_a", "st_b"), dependency("st_b", "st_c")]),
      downstreamRoute("st_a", "st_c"),
      "NO_EXPLICIT_DEPENDENCY",
    ],
    [
      "foreign parent",
      topology(),
      parentRoute("bt_foreign"),
      "CROSS_PROJECT_NOT_ALLOWED",
    ],
    [
      "foreign downstream",
      topology(),
      downstreamRoute("st_a", "st_foreign"),
      "CROSS_PROJECT_NOT_ALLOWED",
    ],
  ] as const)("keeps a %s route non-applicable", (_label, graph, route, reason) => {
    expect(evaluate(graph, candidate({ route }))).toEqual({
      structurallyApplicable: false,
      reason,
    });
  });

  it("preserves invalid candidate, route, and topology reasons", () => {
    const malformedCandidate = {
      ...candidate(),
      kind: "FACT",
    } as unknown as PromotedContextCandidate;
    const invalidRoute = candidateInput({
      route: { ...parentRoute(), sourceSubtaskId: " st_a" },
    }) as PromotedContextCandidate;
    const invalidTopology = {
      ...topology(),
      subtasks: [{ id: "st_a", bigTaskId: "bt_missing" }],
    } as PromotedContextRouteTopology;

    expect(evaluate(topology(), malformedCandidate)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_CANDIDATE",
    });
    expect(evaluate(topology(), invalidRoute)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_ROUTE",
    });
    expect(evaluate(invalidTopology, candidate())).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("does not let malformed evidence bypass an ineligible route reason", () => {
    expect(evaluate(topology(), candidate({ route: downstreamRoute() }), null))
      .toEqual({
        structurallyApplicable: false,
        reason: "NO_EXPLICIT_DEPENDENCY",
      });
  });
});

describe("S2D4 opaque reference neutrality and canonical output", () => {
  it.each([
    "human-approved",
    "owner-confirmed",
    "Codex-confirmed",
    "system-approved",
    "trusted",
    "fake-human",
    "accepted",
    "PASS",
  ])("treats %s as opaque reference text", (sourceReference) => {
    const result = evaluate(
      topology(),
      candidate(),
      evidenceInput({ sourceReference }),
    );
    expect(result.structurallyApplicable).toBe(true);
    expect(
      result.structurallyApplicable && result.evidence.sourceReference,
    ).toBe(sourceReference);
  });

  it("returns a detached frozen canonical evidence snapshot", () => {
    const callerEvidence = evidenceInput({
      sourceReference: "  action:mutable-caller  ",
      occurredAt: "2026-08-16T08:30:00+08:00",
    });
    const result = evaluate(topology(), candidate(), callerEvidence);
    expect(result.structurallyApplicable).toBe(true);
    if (!result.structurallyApplicable) {
      return;
    }
    expect(result.evidence).not.toBe(callerEvidence);
    expect(result.evidence).toEqual({
      evidenceType: "HUMAN_CONFIRMATION",
      sourceReference: "action:mutable-caller",
      occurredAt: "2026-08-16T00:30:00.000Z",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);

    callerEvidence.sourceReference = "changed";
    callerEvidence.occurredAt = "2030-01-01T00:00:00Z";
    expect(result.evidence.sourceReference).toBe("action:mutable-caller");
    expect(result.evidence.occurredAt).toBe("2026-08-16T00:30:00.000Z");
  });

  it("rejects accessor-backed and throwing evidence without invoking accessors", () => {
    let reads = 0;
    const accessorEvidence = Object.defineProperties({}, {
      evidenceType: {
        enumerable: true,
        get() {
          reads += 1;
          return "HUMAN_CONFIRMATION";
        },
      },
      sourceReference: {
        enumerable: true,
        value: "action:accessor",
      },
      occurredAt: {
        enumerable: true,
        value: "2026-08-16T00:30:00Z",
      },
    });
    const throwingEvidence = new Proxy(evidenceInput(), {
      ownKeys() {
        throw new Error("hostile evidence");
      },
    });

    expect(evaluate(topology(), candidate(), accessorEvidence)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
    });
    expect(reads).toBe(0);
    expect(evaluate(topology(), candidate(), throwingEvidence)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
    });
  });
});

describe("S2D4 closed result and separation boundaries", () => {
  it("exposes a closed reason taxonomy and correlated result variants", () => {
    expect(PromotedContextHumanConfirmationReasonSchema.options).toEqual([
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
      "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
    ]);
    expect(
      PromotedContextHumanConfirmationEvaluationSchema.safeParse(
        evaluate(topology(), candidate()),
      ).success,
    ).toBe(true);
    expect(
      PromotedContextHumanConfirmationEvaluationSchema.safeParse({
        structurallyApplicable: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
        evidence: evidenceInput(),
      }).success,
    ).toBe(false);
  });

  it.each([
    "accepted",
    "approved",
    "trusted",
    "verified",
    "authoritySatisfied",
    "confirmationSatisfied",
  ])("rejects acceptance-semantic result field %s", (field) => {
    const applicable = evaluate(topology(), candidate());
    expect(applicable.structurallyApplicable).toBe(true);
    expect(
      PromotedContextHumanConfirmationEvaluationSchema.safeParse({
        ...applicable,
        [field]: true,
      }).success,
    ).toBe(false);
  });

  it("keeps AuditActorType and ContextAuthority outside the evidence contract", () => {
    expect(AuditActorTypeSchema.options).toEqual(["HUMAN", "CODEX", "SYSTEM"]);
    expect(ContextAuthoritySchema.options).toEqual([
      "HUMAN",
      "REPO_EVIDENCE",
      "CODEX_CANDIDATE",
      "SYSTEM",
    ]);
    for (const actorType of AuditActorTypeSchema.options) {
      expect(
        PromotedContextHumanConfirmationEvidenceSchema.safeParse(
          evidenceInput({ actorType }),
        ).success,
      ).toBe(false);
    }
  });

  it("is repeatable, frozen-input compatible, and mutation free", () => {
    const graph = topology([dependency("st_a", "st_b")]);
    const promotedCandidate = candidate({
      route: downstreamRoute(),
      kind: "ENGINEERING_FACT",
    });
    const evidence = evidenceInput();
    const before = JSON.stringify({ graph, promotedCandidate, evidence });
    deepFreeze(graph);
    deepFreeze(promotedCandidate);
    deepFreeze(evidence);

    const first = evaluate(graph, promotedCandidate, evidence);
    const second = evaluate(graph, promotedCandidate, evidence);
    expect(second).toEqual(first);
    expect(JSON.stringify({ graph, promotedCandidate, evidence })).toBe(before);
  });

  it("imports only pure domain contracts and no stateful infrastructure", () => {
    const source = readFileSync(
      new URL("../src/promoted-context-human-confirmation.ts", import.meta.url),
      "utf-8",
    );
    const importedModules = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importedModules).toEqual([
      "zod",
      "./promoted-context-acceptance.js",
      "./promoted-context-candidate.js",
      "./promoted-context-route.js",
    ]);
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
