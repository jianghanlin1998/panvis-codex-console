import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ContextKindSchema,
  ContextSourceTypeSchema,
  ProjectSchema,
  PromotedContextCandidateProvenanceSchema,
  PromotedContextCandidateReasonSchema,
  PromotedContextCandidateSchema,
  PromotedContextRouteSchema,
  PromotedContextRouteTopologySchema,
  SubtaskDependencySchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
  evaluatePromotedContextCandidate,
  evaluateQaContextProfileCandidate,
} from "../src/index.js";
import type {
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
  kind: "ENGINEERING_FACT",
  title: "Route evaluation is deterministic",
  body: "The candidate delegates relationship eligibility to S2D1.",
  provenance: {
    sourceType: "REPO",
    sourceReference: "packages/domain/src/promoted-context-candidate.ts",
    evidenceReferences: ["packages/domain/test/promoted-context-candidate.test.ts"],
  },
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): PromotedContextCandidate =>
  PromotedContextCandidateSchema.parse(candidateInput(overrides));

describe("S2D2 strict candidate schema", () => {
  it("accepts exactly the five required candidate fields", () => {
    const parsed = PromotedContextCandidateSchema.parse(candidateInput());
    expect(Object.keys(parsed)).toEqual(["route", "kind", "title", "body", "provenance"]);
  });

  it.each(["route", "kind", "title", "body", "provenance"])(
    "requires %s",
    (requiredField) => {
      const input = candidateInput() as Record<string, unknown>;
      delete input[requiredField];
      expect(PromotedContextCandidateSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    "accepted",
    "approved",
    "status",
    "authority",
    "rawChat",
    "chatTranscript",
    "conversation",
    "chainOfThought",
    "reasoning",
    "analysis",
    "fullHandoff",
    "handoffBody",
    "rawDiff",
    "patch",
    "rawLog",
    "testLog",
    "commandLog",
    "terminalOutput",
    "payload",
    "metadata",
    "attachments",
    "raw",
    "details",
    "tokenCount",
  ])("rejects the extra candidate field %s", (field) => {
    expect(
      PromotedContextCandidateSchema.safeParse(candidateInput({ [field]: "excluded" }))
        .success,
    ).toBe(false);
  });

  it.each(["rawContent", "transcript", "reasoning", "attachment", "trusted", "accepted"])(
    "rejects the extra provenance field %s",
    (field) => {
      expect(
        PromotedContextCandidateSchema.safeParse(
          candidateInput({
            provenance: {
              ...candidateInput().provenance,
              [field]: "excluded",
            },
          }),
        ).success,
      ).toBe(false);
    },
  );

  it("rejects audience-mismatched route fields through the reused strict route schema", () => {
    const parentWithSubtask = candidateInput({
      route: { ...parentRoute(), targetSubtaskId: "st_b" },
    });
    const downstreamWithBigTask = candidateInput({
      route: { ...downstreamRoute(), targetBigTaskId: "bt_one" },
    });
    expect(PromotedContextCandidateSchema.safeParse(parentWithSubtask).success).toBe(false);
    expect(PromotedContextCandidateSchema.safeParse(downstreamWithBigTask).success).toBe(
      false,
    );
  });

  it("exposes no acceptance lifecycle reason or field", () => {
    expect(PromotedContextCandidateReasonSchema.safeParse("ACCEPTED").success).toBe(false);
    expect(PromotedContextCandidateReasonSchema.safeParse("APPROVED").success).toBe(false);
    expect(PromotedContextCandidateReasonSchema.safeParse("INVALID_CANDIDATE").success).toBe(
      true,
    );
  });
});

describe("S2D2 ContextKind reuse", () => {
  it.each(ContextKindSchema.options)("accepts the existing %s kind", (kind) => {
    const result = evaluatePromotedContextCandidate(topology(), candidate({ kind }));
    expect(result.valid).toBe(true);
    expect(result.eligibleForPromotion).toBe(true);
  });

  it.each(["ENGINEERING", "OPEN-QUESTION", "risk", "UNKNOWN"])(
    "rejects the unknown or near-miss %s kind",
    (kind) => {
      expect(PromotedContextCandidateSchema.safeParse(candidateInput({ kind })).success).toBe(
        false,
      );
    },
  );
});

describe("S2D2 content boundaries", () => {
  it.each([1, 256])("accepts a title of %i characters", (length) => {
    expect(
      PromotedContextCandidateSchema.safeParse(candidateInput({ title: "x".repeat(length) }))
        .success,
    ).toBe(true);
  });

  it.each(["", "   "])("rejects a blank title %#", (title) => {
    expect(PromotedContextCandidateSchema.safeParse(candidateInput({ title })).success).toBe(
      false,
    );
  });

  it("trims title without truncating or rewriting content", () => {
    expect(PromotedContextCandidateSchema.parse(candidateInput({ title: "  结论  " })).title)
      .toBe("结论");
    const overLimit = "x".repeat(257);
    expect(PromotedContextCandidateSchema.safeParse(candidateInput({ title: overLimit })).success)
      .toBe(false);
    expect(overLimit).toHaveLength(257);
  });

  it.each([1, 4_000])("accepts a body of %i characters", (length) => {
    expect(
      PromotedContextCandidateSchema.safeParse(candidateInput({ body: "x".repeat(length) }))
        .success,
    ).toBe(true);
  });

  it.each(["", "\n\t"])("rejects a blank body %#", (body) => {
    expect(PromotedContextCandidateSchema.safeParse(candidateInput({ body })).success).toBe(
      false,
    );
  });

  it("trims Unicode multiline conclusions and rejects 4,001 characters", () => {
    const body = "  第一行结论\n第二行结论  ";
    expect(PromotedContextCandidateSchema.parse(candidateInput({ body })).body).toBe(
      "第一行结论\n第二行结论",
    );
    const overLimit = "x".repeat(4_001);
    expect(PromotedContextCandidateSchema.safeParse(candidateInput({ body: overLimit })).success)
      .toBe(false);
    expect(overLimit).toHaveLength(4_001);
  });
});

describe("S2D2 compact reference-only provenance", () => {
  it.each(ContextSourceTypeSchema.options)("accepts the existing %s source type", (sourceType) => {
    expect(
      PromotedContextCandidateSchema.safeParse(
        candidateInput({
          provenance: { ...candidateInput().provenance, sourceType },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects unknown source types", () => {
    expect(
      PromotedContextCandidateSchema.safeParse(
        candidateInput({
          provenance: { ...candidateInput().provenance, sourceType: "MODEL_ASSERTION" },
        }),
      ).success,
    ).toBe(false);
  });

  it.each([1, 2_048])("accepts a source reference of %i characters", (length) => {
    expect(
      PromotedContextCandidateSchema.safeParse(
        candidateInput({
          provenance: {
            ...candidateInput().provenance,
            sourceReference: "x".repeat(length),
          },
        }),
      ).success,
    ).toBe(true);
  });

  it.each(["", "   ", "x".repeat(2_049)])("rejects invalid source reference %#", (value) => {
    expect(
      PromotedContextCandidateSchema.safeParse(
        candidateInput({
          provenance: { ...candidateInput().provenance, sourceReference: value },
        }),
      ).success,
    ).toBe(false);
  });

  it.each([0, 1, 8])("accepts %i evidence references", (length) => {
    expect(
      PromotedContextCandidateSchema.safeParse(
        candidateInput({
          provenance: {
            ...candidateInput().provenance,
            evidenceReferences: Array.from({ length }, (_, index) => `ref-${index}`),
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects nine, blank, or over-limit evidence references", () => {
    const provenance = candidateInput().provenance;
    expect(
      PromotedContextCandidateProvenanceSchema.safeParse({
        ...provenance,
        evidenceReferences: Array.from({ length: 9 }, (_, index) => `ref-${index}`),
      }).success,
    ).toBe(false);
    for (const reference of ["", "   ", "x".repeat(2_049)]) {
      expect(
        PromotedContextCandidateProvenanceSchema.safeParse({
          ...provenance,
          evidenceReferences: [reference],
        }).success,
      ).toBe(false);
    }
  });

  it("preserves evidence order, Unicode, maximum lengths, and duplicates", () => {
    const evidenceReferences = ["证据-一", "x".repeat(2_048), "证据-一"];
    const parsed = PromotedContextCandidateSchema.parse(
      candidateInput({
        provenance: {
          ...candidateInput().provenance,
          sourceReference: "  来源  ",
          evidenceReferences,
        },
      }),
    );
    expect(parsed.provenance.sourceReference).toBe("来源");
    expect(parsed.provenance.evidenceReferences).toEqual(evidenceReferences);
  });
});

describe("S2D2 route binding through S2D1", () => {
  it("allows the source's exact parent", () => {
    expect(evaluatePromotedContextCandidate(topology(), candidate())).toMatchObject({
      valid: true,
      eligibleForPromotion: true,
      reason: "ELIGIBLE_PARENT_BIG_TASK",
    });
  });

  it("allows only an exact downstream dependency", () => {
    const input = candidate({ route: downstreamRoute() });
    expect(
      evaluatePromotedContextCandidate(topology([dependency("st_a", "st_b")]), input),
    ).toMatchObject({
      valid: true,
      eligibleForPromotion: true,
      reason: "ELIGIBLE_EXPLICIT_DEPENDENCY",
    });
  });

  it.each([
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
    ["wrong parent", topology(), parentRoute("bt_two"), "NOT_SOURCE_PARENT_BIG_TASK"],
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
  ] as const)("denies a %s route with the exact S2D1 reason", (_label, graph, route, reason) => {
    expect(evaluatePromotedContextCandidate(graph, candidate({ route }))).toMatchObject({
      valid: true,
      eligibleForPromotion: false,
      reason,
    });
  });

  it("fails closed while keeping candidate validity distinct from malformed topology", () => {
    const malformed = {
      ...topology(),
      subtasks: [{ id: "st_a", bigTaskId: "bt_missing" }],
    } as PromotedContextRouteTopology;
    expect(evaluatePromotedContextCandidate(malformed, candidate())).toMatchObject({
      valid: true,
      eligibleForPromotion: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("fails closed for a malformed candidate", () => {
    expect(
      evaluatePromotedContextCandidate(topology(), {
        ...candidate(),
        kind: "FACT",
      } as unknown as PromotedContextCandidate),
    ).toEqual({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
  });
});

describe("S2D2 determinism and structural behavior", () => {
  it("returns identical results for ordinary, frozen, sealed, JSON, and structured copies", () => {
    const graph = topology([dependency("st_a", "st_b")]);
    const ordinary = candidate({ route: downstreamRoute() });
    const frozen = structuredClone(ordinary);
    Object.freeze(frozen.provenance.evidenceReferences);
    Object.freeze(frozen.provenance);
    Object.freeze(frozen.route);
    Object.freeze(frozen);
    const sealed = structuredClone(ordinary);
    Object.seal(sealed.provenance.evidenceReferences);
    Object.seal(sealed.provenance);
    Object.seal(sealed.route);
    Object.seal(sealed);
    const expected = evaluatePromotedContextCandidate(graph, ordinary);

    for (const copy of [
      ordinary,
      frozen,
      sealed,
      JSON.parse(JSON.stringify(ordinary)) as PromotedContextCandidate,
      structuredClone(ordinary),
    ]) {
      expect(evaluatePromotedContextCandidate(graph, copy)).toEqual(expected);
    }
  });

  it("is repeatedly deterministic and does not mutate candidate, route, topology, or arrays", () => {
    const graph = topology([dependency("st_a", "st_b")]);
    const input = candidate({
      route: downstreamRoute(),
      provenance: {
        ...candidateInput().provenance,
        evidenceReferences: ["second", "first", "second"],
      },
    });
    const before = JSON.stringify({ graph, input });
    const first = evaluatePromotedContextCandidate(graph, input);
    const second = evaluatePromotedContextCandidate(graph, input);

    expect(second).toEqual(first);
    expect(JSON.stringify({ graph, input })).toBe(before);
    expect(first.valid && first.candidate.provenance.evidenceReferences).toEqual([
      "second",
      "first",
      "second",
    ]);
    expect(first.valid && Object.isFrozen(first.candidate.provenance.evidenceReferences))
      .toBe(true);
  });

  it("rejects accessor-backed candidates without invoking the accessor", () => {
    let getterCalls = 0;
    const input = candidateInput() as Record<string, unknown>;
    delete input.body;
    Object.defineProperty(input, "body", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must not be read";
      },
    });

    expect(
      evaluatePromotedContextCandidate(topology(), input as PromotedContextCandidate),
    ).toEqual({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
    expect(getterCalls).toBe(0);
  });
});

describe("S2D2 preserves S2A and S2C1 boundaries", () => {
  it("does not widen a downstream target's AllowedContextSet", () => {
    const project = ProjectSchema.parse({
      recordType: "PROJECT",
      id: "prj_one",
      name: "Project One",
      slug: "project-one",
      repository: { kind: "PATH", path: "/workspace/project-one" },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 1,
    });
    const bigTask = BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_one",
      projectId: project.id,
      title: "Big Task One",
      goal: "Keep raw context isolated.",
      rationale: "Conclusion routing is a separate boundary.",
      scopeIn: ["Candidate evaluation"],
      scopeOut: ["Raw context widening"],
      acceptanceCriteria: ["Raw scopes remain exact."],
      status: "IN_PROGRESS",
    });
    const subtask = (id: "st_a" | "st_b") =>
      SubtaskSchema.parse({
        recordType: "SUBTASK",
        id,
        bigTaskId: bigTask.id,
        title: `Subtask ${id}`,
        goal: "Evaluate one bounded contract.",
        scopeIn: ["Deterministic evidence"],
        scopeOut: ["Raw history"],
        acceptanceCriteria: ["Fail closed."],
        untouchedAreas: ["S2A"],
        status: "TODO",
        maturity: "NOT_STARTED",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
        promptSeed: "Use only allowed context.",
      });
    const source = subtask("st_a");
    const target = subtask("st_b");
    const graph = PromotedContextRouteTopologySchema.parse({
      projects: [{ id: project.id }],
      bigTasks: [{ id: bigTask.id, projectId: project.id }],
      subtasks: [
        { id: source.id, bigTaskId: source.bigTaskId },
        { id: target.id, bigTaskId: target.bigTaskId },
      ],
      dependencies: [dependency(source.id, target.id)],
    });
    expect(
      evaluatePromotedContextCandidate(
        graph,
        candidate({ route: downstreamRoute(source.id, target.id) }),
      ).eligibleForPromotion,
    ).toBe(true);
    const allowed = buildAllowedContextSet(project, bigTask, target);
    expect(allowed.valid).toBe(true);
    if (!allowed.valid) {
      return;
    }
    expect(
      evaluateContextScopeAccess(allowed.allowedContextSet, {
        scopeType: "SUBTASK",
        projectId: project.id,
        bigTaskId: bigTask.id,
        subtaskId: source.id,
      }),
    ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
  });

  it("keeps generic PROMOTED_CONTEXT excluded from Fresh Independent QA", () => {
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", {
        candidateClass: "PROMOTED_CONTEXT",
        sourceReference: "candidate:opaque-reference",
      }),
    ).toEqual({
      includedByProfile: false,
      reason: "EXCLUDED_PROMOTED_CONTEXT",
    });
  });
});
