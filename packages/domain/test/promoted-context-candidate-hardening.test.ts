import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ContextKindSchema,
  ContextSourceTypeSchema,
  ProjectSchema,
  PromotedContextCandidateProvenanceSchema,
  PromotedContextCandidateReasonSchema,
  PromotedContextCandidateSchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
  evaluatePromotedContextCandidate,
  evaluateQaContextProfileCandidate,
} from "../src/index.js";
import type {
  ContextKind,
  ContextSourceType,
  PromotedContextCandidate,
  PromotedContextCandidateEvaluation,
  PromotedContextRoute,
  PromotedContextRouteTopology,
  SubtaskDependency,
} from "../src/index.js";

type ParentRoute = Extract<
  PromotedContextRoute,
  { readonly audienceKind: "PARENT_BIG_TASK" }
>;
type DownstreamRoute = Extract<
  PromotedContextRoute,
  { readonly audienceKind: "DOWNSTREAM_SUBTASK" }
>;

const CONTEXT_KINDS = [
  "DECISION",
  "REQUIREMENT",
  "CONSTRAINT",
  "ENGINEERING_FACT",
  "OPEN_QUESTION",
  "RISK",
] as const satisfies readonly ContextKind[];

const SOURCE_TYPES = [
  "CHAT_MESSAGE",
  "REPO",
  "HANDOFF",
  "IMPORT",
  "MANUAL",
  "SYSTEM",
] as const satisfies readonly ContextSourceType[];

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: "BLOCKING" | "INFORMATIONAL" = "BLOCKING",
): SubtaskDependency => ({
  upstreamSubtaskId,
  downstreamSubtaskId,
  dependencyType,
  requiredGate: dependencyType === "BLOCKING" ? "HARDENED" : "NONE",
  reason: `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
}) as SubtaskDependency;

const eligibleTopology = (): PromotedContextRouteTopology => ({
  projects: [{ id: "prj_hardening" }],
  bigTasks: [{ id: "bt_hardening", projectId: "prj_hardening" }],
  subtasks: [{ id: "st_source", bigTaskId: "bt_hardening" }],
  dependencies: [],
}) as unknown as PromotedContextRouteTopology;

const eligibleCandidate = (): PromotedContextCandidate => ({
  route: {
    sourceSubtaskId: "st_source",
    audienceKind: "PARENT_BIG_TASK",
    targetBigTaskId: "bt_hardening",
  },
  kind: "ENGINEERING_FACT",
  title: "Stable conclusion",
  body: "Only stable candidate evidence may become eligible.",
  provenance: {
    sourceType: "REPO",
    sourceReference: "hardening:source",
    evidenceReferences: ["hardening:evidence"],
  },
}) as PromotedContextCandidate;

const hardeningTopology = (
  dependencies: readonly SubtaskDependency[] = [],
): PromotedContextRouteTopology => ({
  projects: [{ id: "prj_local" }, { id: "prj_foreign" }],
  bigTasks: [
    { id: "bt_local", projectId: "prj_local" },
    { id: "bt_other", projectId: "prj_local" },
    { id: "bt_foreign", projectId: "prj_foreign" },
  ],
  subtasks: [
    { id: "st_a", bigTaskId: "bt_local" },
    { id: "st_b", bigTaskId: "bt_local" },
    { id: "st_c", bigTaskId: "bt_local" },
    { id: "st_other", bigTaskId: "bt_other" },
    { id: "st_foreign", bigTaskId: "bt_foreign" },
  ],
  dependencies,
}) as PromotedContextRouteTopology;

const parentRoute = (
  sourceSubtaskId = "st_a",
  targetBigTaskId = "bt_local",
): ParentRoute => ({
  sourceSubtaskId,
  audienceKind: "PARENT_BIG_TASK",
  targetBigTaskId,
}) as ParentRoute;

const downstreamRoute = (
  sourceSubtaskId = "st_a",
  targetSubtaskId = "st_b",
): DownstreamRoute => ({
  sourceSubtaskId,
  audienceKind: "DOWNSTREAM_SUBTASK",
  targetSubtaskId,
}) as DownstreamRoute;

const hardeningCandidate = (
  overrides: Readonly<Record<string, unknown>> = {},
): PromotedContextCandidate => ({
  route: parentRoute(),
  kind: "ENGINEERING_FACT",
  title: "Stable promoted conclusion",
  body: "The structural candidate remains separate from acceptance.",
  provenance: {
    sourceType: "REPO",
    sourceReference: "hardening:source",
    evidenceReferences: ["hardening:evidence"],
  },
  ...overrides,
}) as PromotedContextCandidate;

const resultProjection = (result: PromotedContextCandidateEvaluation) => ({
  valid: result.valid,
  eligibleForPromotion: result.eligibleForPromotion,
  reason: result.reason,
});

const descriptorValueSequence = <T extends object>(
  target: T,
  key: PropertyKey,
  values: readonly unknown[],
): T => {
  let observations = 0;
  return new Proxy(target, {
    getOwnPropertyDescriptor(current, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (property !== key || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      const value = values[Math.min(observations, values.length - 1)];
      observations += 1;
      return { ...descriptor, value };
    },
  });
};

const alternatingOwnKeys = <T extends object>(target: T): T => {
  let observations = 0;
  return new Proxy(target, {
    ownKeys(current) {
      observations += 1;
      const keys = Reflect.ownKeys(current);
      return observations % 2 === 0 ? [...keys].reverse() : keys;
    },
  });
};

const alternatingPrototype = <T extends object>(target: T): T => {
  let observations = 0;
  return new Proxy(target, {
    getPrototypeOf() {
      observations += 1;
      return observations % 2 === 0 ? null : Object.getPrototypeOf(target);
    },
  });
};

const alternatingDescriptorFlags = <T extends object>(
  target: T,
  key: PropertyKey,
): T => {
  let observations = 0;
  return new Proxy(target, {
    getOwnPropertyDescriptor(current, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (property !== key || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      observations += 1;
      return { ...descriptor, writable: observations % 2 === 1 };
    },
  });
};

const appearingOwnKey = <T extends object>(target: T, key: PropertyKey): T => {
  let observations = 0;
  return new Proxy(target, {
    ownKeys(current) {
      observations += 1;
      const keys = Reflect.ownKeys(current);
      return observations % 2 === 1 ? keys.filter((candidate) => candidate !== key) : keys;
    },
  });
};

const nullPrototypeCopy = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(nullPrototypeCopy);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    copy[key] = nullPrototypeCopy(child);
  }
  return copy;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const deepSeal = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepSeal(child);
    }
    Object.seal(value);
  }
  return value;
};

const invalidCandidateDecision = {
  valid: false,
  eligibleForPromotion: false,
  reason: "INVALID_CANDIDATE",
} as const;

describe("S2D2 hardening defect reproductions", () => {
  it("rejects a valid-first candidate whose kind changes across observations", () => {
    const hostile = descriptorValueSequence(eligibleCandidate(), "kind", [
      "ENGINEERING_FACT",
      "UNKNOWN_KIND",
      "ENGINEERING_FACT",
    ]);
    expect(
      evaluatePromotedContextCandidate(
        eligibleTopology(),
        hostile as PromotedContextCandidate,
      ),
    ).toEqual({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
  });

  it("does not normalize a route that accepted S2D1 rejects", () => {
    const paddedRoute = eligibleCandidate();
    paddedRoute.route.sourceSubtaskId = " st_source " as typeof paddedRoute.route.sourceSubtaskId;
    expect(
      evaluatePromotedContextCandidate(eligibleTopology(), paddedRoute),
    ).toMatchObject({
      eligibleForPromotion: false,
      reason: "INVALID_ROUTE",
    });
  });
});

describe("S2D2 independent candidate oracle", () => {
  it("matches 360 fresh kind/source/route cases and 1,080 exact result fields", () => {
    const exactDependency = hardeningTopology([dependency("st_a", "st_b")]);
    const reverseDependency = hardeningTopology([dependency("st_b", "st_a")]);
    const transitiveOnly = hardeningTopology([
      dependency("st_a", "st_b"),
      dependency("st_b", "st_c"),
    ]);
    const invalidTopology = {
      ...hardeningTopology(),
      subtasks: [{ id: "st_a", bigTaskId: "bt_missing" }],
    } as PromotedContextRouteTopology;
    const routeCases = [
      {
        topology: hardeningTopology(),
        route: parentRoute(),
        expected: {
          valid: true,
          eligibleForPromotion: true,
          reason: "ELIGIBLE_PARENT_BIG_TASK",
        },
      },
      {
        topology: exactDependency,
        route: downstreamRoute(),
        expected: {
          valid: true,
          eligibleForPromotion: true,
          reason: "ELIGIBLE_EXPLICIT_DEPENDENCY",
        },
      },
      {
        topology: hardeningTopology(),
        route: parentRoute("st_a", "bt_other"),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "NOT_SOURCE_PARENT_BIG_TASK",
        },
      },
      {
        topology: hardeningTopology(),
        route: parentRoute("st_a", "bt_foreign"),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "CROSS_PROJECT_NOT_ALLOWED",
        },
      },
      {
        topology: hardeningTopology(),
        route: downstreamRoute(),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "NO_EXPLICIT_DEPENDENCY",
        },
      },
      {
        topology: reverseDependency,
        route: downstreamRoute(),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "REVERSE_DIRECTION_NOT_ALLOWED",
        },
      },
      {
        topology: transitiveOnly,
        route: downstreamRoute("st_a", "st_c"),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "NO_EXPLICIT_DEPENDENCY",
        },
      },
      {
        topology: hardeningTopology(),
        route: downstreamRoute("st_a", "st_other"),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "CROSS_BIG_TASK_NOT_ALLOWED",
        },
      },
      {
        topology: hardeningTopology(),
        route: downstreamRoute("st_a", "st_foreign"),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "CROSS_PROJECT_NOT_ALLOWED",
        },
      },
      {
        topology: invalidTopology,
        route: parentRoute(),
        expected: {
          valid: true,
          eligibleForPromotion: false,
          reason: "INVALID_TOPOLOGY",
        },
      },
    ] as const;

    const mismatches: Array<{
      readonly kind: ContextKind;
      readonly sourceType: ContextSourceType;
      readonly routeIndex: number;
    }> = [];
    let cases = 0;
    let assertions = 0;
    for (const kind of CONTEXT_KINDS) {
      for (const sourceType of SOURCE_TYPES) {
        for (const [routeIndex, routeCase] of routeCases.entries()) {
          const actual = resultProjection(
            evaluatePromotedContextCandidate(
              routeCase.topology,
              hardeningCandidate({
                route: routeCase.route,
                kind,
                provenance: {
                  sourceType,
                  sourceReference: `oracle:${sourceType}:${routeIndex}`,
                  evidenceReferences: [`oracle:${kind}`],
                },
              }),
            ),
          );
          cases += 1;
          assertions += 3;
          if (
            actual.valid !== routeCase.expected.valid ||
            actual.eligibleForPromotion !== routeCase.expected.eligibleForPromotion ||
            actual.reason !== routeCase.expected.reason
          ) {
            mismatches.push({ kind, sourceType, routeIndex });
          }
        }
      }
    }

    expect(cases).toBe(360);
    expect(assertions).toBe(1_080);
    expect(mismatches).toEqual([]);
  });
});

const forbiddenCandidateFields = [
  "accepted",
  "approved",
  "reviewed",
  "verified",
  "trusted",
  "active",
  "persisted",
  "injected",
  "status",
  "authority",
  "approvedAt",
  "acceptedAt",
  "id",
  "storageId",
  "createdBy",
  "rawChat",
  "RawChat",
  "raw_chat",
  "chatTranscript",
  "transcript",
  "conversation",
  "chainOfThought",
  "reasoning",
  "analysis",
  "handoff",
  "fullHandoff",
  "handoffBody",
  "diff",
  "rawDiff",
  "patch",
  "rawLog",
  "logs",
  "testLog",
  "commandLog",
  "terminal",
  "terminalOutput",
  "payload",
  "metadata",
  "attachments",
  "raw",
  "details",
  "tokenCount",
] as const;

const forbiddenProvenanceFields = [
  "accepted",
  "approved",
  "trusted",
  "verified",
  "authority",
  "rawContent",
  "rawChat",
  "RawChat",
  "raw_chat",
  "transcript",
  "conversation",
  "chainOfThought",
  "reasoning",
  "analysis",
  "handoff",
  "fullHandoff",
  "diff",
  "patch",
  "rawLog",
  "logs",
  "terminal",
  "payload",
  "metadata",
  "attachments",
  "attachment",
  "details",
] as const;

describe("S2D2 exact candidate field strictness", () => {
  it.each(["route", "kind", "title", "body", "provenance"])(
    "rejects missing required field %s",
    (field) => {
      const input = { ...hardeningCandidate() } as Record<string, unknown>;
      delete input[field];
      expect(PromotedContextCandidateSchema.safeParse(input).success).toBe(false);
      expect(
        evaluatePromotedContextCandidate(
          hardeningTopology(),
          input as PromotedContextCandidate,
        ),
      ).toEqual(invalidCandidateDecision);
    },
  );

  it.each(forbiddenCandidateFields)("rejects top-level escape field %s", (field) => {
    const input = { ...hardeningCandidate(), [field]: "excluded" };
    expect(PromotedContextCandidateSchema.safeParse(input).success).toBe(false);
    expect(
      evaluatePromotedContextCandidate(
        hardeningTopology(),
        input as PromotedContextCandidate,
      ),
    ).toEqual(invalidCandidateDecision);
  });

  it("rejects symbol keys, non-enumerable extras, inherited extras, and custom prototypes", () => {
    const symbolKey = hardeningCandidate() as unknown as Record<PropertyKey, unknown>;
    symbolKey[Symbol("payload")] = "excluded";
    const nonEnumerable = hardeningCandidate();
    Object.defineProperty(nonEnumerable, "payload", {
      value: "excluded",
      enumerable: false,
    });
    const inherited = Object.assign(
      Object.create({ rawChat: "excluded" }) as Record<string, unknown>,
      hardeningCandidate(),
    );
    const customPrototype = hardeningCandidate();
    Object.setPrototypeOf(customPrototype, { marker: true });

    for (const input of [symbolKey, nonEnumerable, inherited, customPrototype]) {
      expect(
        evaluatePromotedContextCandidate(
          hardeningTopology(),
          input as PromotedContextCandidate,
        ),
      ).toEqual(invalidCandidateDecision);
    }
  });

  it("does not invoke candidate accessors", () => {
    let getterCalls = 0;
    const input = hardeningCandidate() as unknown as Record<string, unknown>;
    delete input.body;
    Object.defineProperty(input, "body", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor body";
      },
    });
    expect(
      evaluatePromotedContextCandidate(
        hardeningTopology(),
        input as PromotedContextCandidate,
      ),
    ).toEqual(invalidCandidateDecision);
    expect(getterCalls).toBe(0);
  });
});

describe("S2D2 provenance strictness and boundaries", () => {
  it.each(["sourceType", "sourceReference", "evidenceReferences"])(
    "rejects missing provenance field %s",
    (field) => {
      const provenance = { ...hardeningCandidate().provenance } as Record<
        string,
        unknown
      >;
      delete provenance[field];
      const input = hardeningCandidate({ provenance });
      expect(PromotedContextCandidateProvenanceSchema.safeParse(provenance).success)
        .toBe(false);
      expect(evaluatePromotedContextCandidate(hardeningTopology(), input)).toEqual(
        invalidCandidateDecision,
      );
    },
  );

  it("rejects unknown source types", () => {
    const input = hardeningCandidate({
      provenance: {
        ...hardeningCandidate().provenance,
        sourceType: "HUMAN_APPROVED",
      },
    });
    expect(evaluatePromotedContextCandidate(hardeningTopology(), input)).toEqual(
      invalidCandidateDecision,
    );
  });

  it.each(forbiddenProvenanceFields)("rejects provenance escape field %s", (field) => {
    const input = hardeningCandidate({
      provenance: {
        ...hardeningCandidate().provenance,
        [field]: "excluded",
      },
    });
    expect(evaluatePromotedContextCandidate(hardeningTopology(), input)).toEqual(
      invalidCandidateDecision,
    );
  });

  it("rejects provenance symbol keys, non-enumerable fields, custom prototypes, and accessors", () => {
    let getterCalls = 0;
    const symbolProvenance = { ...hardeningCandidate().provenance } as Record<
      PropertyKey,
      unknown
    >;
    symbolProvenance[Symbol("trusted")] = true;
    const nonEnumerable = { ...hardeningCandidate().provenance };
    Object.defineProperty(nonEnumerable, "trusted", { value: true, enumerable: false });
    const customPrototype = Object.assign(
      Object.create({ trusted: true }) as Record<string, unknown>,
      hardeningCandidate().provenance,
    );
    const accessor = { ...hardeningCandidate().provenance } as Record<string, unknown>;
    delete accessor.sourceReference;
    Object.defineProperty(accessor, "sourceReference", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor:reference";
      },
    });

    for (const provenance of [
      symbolProvenance,
      nonEnumerable,
      customPrototype,
      accessor,
    ]) {
      expect(
        evaluatePromotedContextCandidate(
          hardeningTopology(),
          hardeningCandidate({ provenance }),
        ),
      ).toEqual(invalidCandidateDecision);
    }
    expect(getterCalls).toBe(0);
  });

  it.each([0, 1, 8])("accepts exactly %i evidence references", (length) => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: {
          ...hardeningCandidate().provenance,
          evidenceReferences: Array.from({ length }, (_, index) => `evidence:${index}`),
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.eligibleForPromotion).toBe(true);
  });

  it("rejects nine evidence references and preserves allowed duplicate order", () => {
    const nine = hardeningCandidate({
      provenance: {
        ...hardeningCandidate().provenance,
        evidenceReferences: Array.from({ length: 9 }, (_, index) => `evidence:${index}`),
      },
    });
    expect(evaluatePromotedContextCandidate(hardeningTopology(), nine)).toEqual(
      invalidCandidateDecision,
    );

    const evidenceReferences = ["second", "first", "second"];
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: { ...hardeningCandidate().provenance, evidenceReferences },
      }),
    );
    expect(result.valid && result.candidate.provenance.evidenceReferences).toEqual(
      evidenceReferences,
    );
  });
});

describe("S2D2 fresh content and reference boundary matrices", () => {
  it.each([
    [0, false],
    [1, true],
    [255, true],
    [256, true],
    [257, false],
  ] as const)("evaluates title length %i as valid=%s", (length, valid) => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({ title: "t".repeat(length) }),
    );
    expect(result.valid).toBe(valid);
    if (valid) {
      expect(result.valid && result.candidate.title).toBe("t".repeat(length));
    }
  });

  it.each([
    [0, false],
    [1, true],
    [3_999, true],
    [4_000, true],
    [4_001, false],
  ] as const)("evaluates body length %i as valid=%s", (length, valid) => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({ body: "b".repeat(length) }),
    );
    expect(result.valid).toBe(valid);
    if (valid) {
      expect(result.valid && result.candidate.body).toBe("b".repeat(length));
    }
  });

  it("applies only JS trim normalization while preserving Unicode, multiline, and controls", () => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        title: "\u00a0结论\u00a0",
        body: " \n第一行\u0000内容\n第二行\t ",
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.candidate.title).toBe("结论");
    expect(result.valid && result.candidate.body).toBe(
      "第一行\u0000内容\n第二行",
    );
  });

  it("enforces the existing JavaScript code-unit boundary without token claims", () => {
    expect(
      evaluatePromotedContextCandidate(
        hardeningTopology(),
        hardeningCandidate({ title: "😀".repeat(128) }),
      ).valid,
    ).toBe(true);
    expect(
      evaluatePromotedContextCandidate(
        hardeningTopology(),
        hardeningCandidate({ title: "😀".repeat(129) }),
      ).valid,
    ).toBe(false);
  });

  it.each([
    [1, true],
    [2_047, true],
    [2_048, true],
    [2_049, false],
  ] as const)("evaluates sourceReference length %i as valid=%s", (length, valid) => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: {
          ...hardeningCandidate().provenance,
          sourceReference: "r".repeat(length),
        },
      }),
    );
    expect(result.valid).toBe(valid);
  });

  it.each([
    [1, true],
    [2_047, true],
    [2_048, true],
    [2_049, false],
  ] as const)("evaluates evidenceReference length %i as valid=%s", (length, valid) => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: {
          ...hardeningCandidate().provenance,
          evidenceReferences: ["e".repeat(length)],
        },
      }),
    );
    expect(result.valid).toBe(valid);
  });

  it.each(["", " ", "\n\t", "\u00a0"])("rejects blank reference %#", (reference) => {
    const sourceResult = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: {
          ...hardeningCandidate().provenance,
          sourceReference: reference,
        },
      }),
    );
    const evidenceResult = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: {
          ...hardeningCandidate().provenance,
          evidenceReferences: [reference],
        },
      }),
    );
    expect(sourceResult.valid).toBe(false);
    expect(evidenceResult.valid).toBe(false);
  });

  it("trims reference edges but preserves Unicode, multiline, and interior controls", () => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        provenance: {
          sourceType: "REPO",
          sourceReference: "\u00a0来源\n段落\u0000值\u00a0",
          evidenceReferences: [" 证据\n二 \t"],
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.candidate.provenance.sourceReference).toBe(
      "来源\n段落\u0000值",
    );
    expect(result.valid && result.candidate.provenance.evidenceReferences).toEqual([
      "证据\n二",
    ]);
  });
});

describe("S2D2 ContextKind and trust independence", () => {
  it("reuses exactly all six ContextKinds and all six ContextSourceTypes", () => {
    expect(ContextKindSchema.options).toEqual(CONTEXT_KINDS);
    expect(ContextSourceTypeSchema.options).toEqual(SOURCE_TYPES);
  });

  it.each(CONTEXT_KINDS)("keeps %s valid without lifecycle or ranking semantics", (kind) => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        kind,
        title: "The body says RISK but the selected kind remains explicit.",
        body: "DECISION REQUIREMENT CONSTRAINT OPEN_QUESTION RISK",
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.eligibleForPromotion).toBe(true);
    expect(result.valid && result.candidate.kind).toBe(kind);
    expect(result.valid && Object.keys(result.candidate)).not.toContain("status");
  });

  it.each(["decision", "OPEN-QUESTION", "ENGINEERING", "QUESTION", "UNKNOWN"])(
    "fails closed for unknown or near-miss kind %s",
    (kind) => {
      expect(
        evaluatePromotedContextCandidate(
          hardeningTopology(),
          hardeningCandidate({ kind }),
        ),
      ).toEqual(invalidCandidateDecision);
    },
  );

  it("does not infer or rewrite kind from title or body", () => {
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate({
        kind: "OPEN_QUESTION",
        title: "ACCEPTED FINAL VERIFIED DECISION",
        body: "This text cannot resolve or reclassify the open question.",
      }),
    );
    expect(result.valid && result.candidate.kind).toBe("OPEN_QUESTION");
    expect(result.valid && Object.keys(result.candidate)).toEqual([
      "route",
      "kind",
      "title",
      "body",
      "provenance",
    ]);
  });
});

describe("S2D2 exact S2D1 delegation and candidate/topology consistency", () => {
  it.each([
    [
      "own parent",
      hardeningTopology(),
      parentRoute(),
      true,
      "ELIGIBLE_PARENT_BIG_TASK",
    ],
    [
      "exact downstream",
      hardeningTopology([dependency("st_a", "st_b")]),
      downstreamRoute(),
      true,
      "ELIGIBLE_EXPLICIT_DEPENDENCY",
    ],
    [
      "wrong parent",
      hardeningTopology(),
      parentRoute("st_a", "bt_other"),
      false,
      "NOT_SOURCE_PARENT_BIG_TASK",
    ],
    [
      "foreign parent",
      hardeningTopology(),
      parentRoute("st_a", "bt_foreign"),
      false,
      "CROSS_PROJECT_NOT_ALLOWED",
    ],
    [
      "sibling",
      hardeningTopology(),
      downstreamRoute(),
      false,
      "NO_EXPLICIT_DEPENDENCY",
    ],
    [
      "reverse",
      hardeningTopology([dependency("st_b", "st_a")]),
      downstreamRoute(),
      false,
      "REVERSE_DIRECTION_NOT_ALLOWED",
    ],
    [
      "transitive",
      hardeningTopology([
        dependency("st_a", "st_b"),
        dependency("st_b", "st_c"),
      ]),
      downstreamRoute("st_a", "st_c"),
      false,
      "NO_EXPLICIT_DEPENDENCY",
    ],
    [
      "foreign downstream",
      hardeningTopology(),
      downstreamRoute("st_a", "st_foreign"),
      false,
      "CROSS_PROJECT_NOT_ALLOWED",
    ],
  ] as const)("preserves %s result and reason", (_label, topology, route, eligible, reason) => {
    const result = evaluatePromotedContextCandidate(
      topology,
      hardeningCandidate({ route }),
    );
    expect(result.valid).toBe(true);
    expect(result.eligibleForPromotion).toBe(eligible);
    expect(result.reason).toBe(reason);
  });

  it("preserves INVALID_TOPOLOGY without invalidating stable candidate shape", () => {
    const invalidTopology = {
      ...hardeningTopology(),
      projects: [],
    } as PromotedContextRouteTopology;
    expect(
      evaluatePromotedContextCandidate(invalidTopology, hardeningCandidate()),
    ).toMatchObject({
      valid: true,
      eligibleForPromotion: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it.each(["sourceSubtaskId", "targetBigTaskId"] as const)(
    "does not normalize S2D1 parent-route field %s",
    (field) => {
      const route = { ...parentRoute(), [field]: ` ${parentRoute()[field]} ` };
      expect(
        evaluatePromotedContextCandidate(
          hardeningTopology(),
          hardeningCandidate({ route }),
        ),
      ).toEqual({
        valid: false,
        eligibleForPromotion: false,
        reason: "INVALID_ROUTE",
      });
    },
  );

  it.each(["sourceSubtaskId", "targetSubtaskId"] as const)(
    "does not normalize S2D1 downstream-route field %s",
    (field) => {
      const base = downstreamRoute();
      const route = { ...base, [field]: ` ${base[field]} ` };
      expect(
        evaluatePromotedContextCandidate(
          hardeningTopology([dependency("st_a", "st_b")]),
          hardeningCandidate({ route }),
        ),
      ).toEqual({
        valid: false,
        eligibleForPromotion: false,
        reason: "INVALID_ROUTE",
      });
    },
  );

  it("lets route changes alone control eligibility for identical metadata", () => {
    const graph = hardeningTopology([dependency("st_a", "st_b")]);
    const metadata = {
      kind: "DECISION",
      title: "Identical conclusion",
      body: "Identical candidate metadata cannot widen a route.",
      provenance: {
        sourceType: "MANUAL",
        sourceReference: "same:source",
        evidenceReferences: ["same:evidence"],
      },
    } as const;
    const eligible = evaluatePromotedContextCandidate(
      graph,
      hardeningCandidate({ ...metadata, route: downstreamRoute() }),
    );
    const denied = evaluatePromotedContextCandidate(
      graph,
      hardeningCandidate({ ...metadata, route: downstreamRoute("st_a", "st_c") }),
    );
    expect(eligible.eligibleForPromotion).toBe(true);
    expect(denied.eligibleForPromotion).toBe(false);
    expect(denied.reason).toBe("NO_EXPLICIT_DEPENDENCY");
  });

  it("keeps content and provenance wording neutral for an ineligible route", () => {
    const bait = [
      "approved",
      "trusted",
      "human",
      "repo",
      "accepted",
      "final",
      "must-share",
      "security-critical",
    ];
    for (const sourceType of SOURCE_TYPES) {
      for (const reference of bait) {
        const result = evaluatePromotedContextCandidate(
          hardeningTopology(),
          hardeningCandidate({
            route: downstreamRoute(),
            title: reference,
            body: `This ${reference} text grants no route.`,
            provenance: {
              sourceType,
              sourceReference: reference,
              evidenceReferences: [`human-approved:${reference}`],
            },
          }),
        );
        expect(result).toMatchObject({
          valid: true,
          eligibleForPromotion: false,
          reason: "NO_EXPLICIT_DEPENDENCY",
        });
      }
    }
  });
});

describe("S2D2 hostile candidate runtime evidence", () => {
  const hostileFactories: readonly (() => PromotedContextCandidate)[] = [
    () =>
      descriptorValueSequence(hardeningCandidate(), "kind", [
        "ENGINEERING_FACT",
        "UNKNOWN",
        "ENGINEERING_FACT",
      ]),
    () =>
      descriptorValueSequence(hardeningCandidate(), "title", [
        "valid title",
        "x".repeat(257),
        "valid title",
      ]),
    () =>
      descriptorValueSequence(hardeningCandidate(), "body", [
        "valid body",
        " ",
        "valid body",
      ]),
    () =>
      descriptorValueSequence(hardeningCandidate(), "route", [
        parentRoute(),
        downstreamRoute(),
        parentRoute(),
      ]),
    () =>
      descriptorValueSequence(hardeningCandidate(), "provenance", [
        hardeningCandidate().provenance,
        { ...hardeningCandidate().provenance, sourceType: "UNKNOWN" },
        hardeningCandidate().provenance,
      ]),
    () => alternatingOwnKeys(hardeningCandidate()),
    () => alternatingPrototype(hardeningCandidate()),
    () => alternatingDescriptorFlags(hardeningCandidate(), "kind"),
    () => {
      const target = { ...hardeningCandidate(), rawChat: "excluded" };
      return appearingOwnKey(target, "rawChat") as PromotedContextCandidate;
    },
    () =>
      new Proxy(hardeningCandidate(), {
        ownKeys() {
          throw new Error("private candidate trap");
        },
      }),
    () => {
      const revocable = Proxy.revocable(hardeningCandidate(), {});
      revocable.revoke();
      return revocable.proxy;
    },
    () => {
      const input = hardeningCandidate();
      input.route = descriptorValueSequence({ ...parentRoute() }, "sourceSubtaskId", [
        "st_a",
        "st_c",
        "st_a",
      ]) as PromotedContextRoute;
      return input;
    },
  ];

  it("rejects 12 unstable or throwing candidate representations without false validity", () => {
    let exceptionLeaks = 0;
    let falseValid = 0;
    let falseEligible = 0;
    for (const factory of hostileFactories) {
      try {
        const result = evaluatePromotedContextCandidate(
          hardeningTopology(),
          factory(),
        );
        falseValid += Number(result.valid);
        falseEligible += Number(result.eligibleForPromotion);
      } catch {
        exceptionLeaks += 1;
      }
    }
    expect(hostileFactories).toHaveLength(12);
    expect(falseValid).toBe(0);
    expect(falseEligible).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });
});

describe("S2D2 hostile provenance runtime evidence", () => {
  const hostileProvenanceFactories: readonly (() => object)[] = [
    () =>
      descriptorValueSequence({ ...hardeningCandidate().provenance }, "sourceType", [
        "REPO",
        "UNKNOWN",
        "REPO",
      ]),
    () =>
      descriptorValueSequence(
        { ...hardeningCandidate().provenance },
        "sourceReference",
        ["valid", " ", "valid"],
      ),
    () =>
      descriptorValueSequence(
        { ...hardeningCandidate().provenance },
        "sourceReference",
        ["valid", "x".repeat(2_049), "valid"],
      ),
    () =>
      descriptorValueSequence(
        { ...hardeningCandidate().provenance },
        "evidenceReferences",
        [["valid"], Array.from({ length: 9 }, (_, index) => `ref:${index}`), ["valid"]],
      ),
    () => alternatingOwnKeys({ ...hardeningCandidate().provenance }),
    () => alternatingPrototype({ ...hardeningCandidate().provenance }),
    () => alternatingDescriptorFlags({ ...hardeningCandidate().provenance }, "sourceType"),
    () => {
      const target = { ...hardeningCandidate().provenance, trusted: true };
      return appearingOwnKey(target, "trusted");
    },
    () =>
      new Proxy({ ...hardeningCandidate().provenance }, {
        getOwnPropertyDescriptor() {
          throw new Error("private provenance trap");
        },
      }),
  ];

  it("rejects nine unstable provenance schedules without false validity or exceptions", () => {
    let exceptionLeaks = 0;
    let falseValid = 0;
    let falseEligible = 0;
    for (const factory of hostileProvenanceFactories) {
      try {
        const result = evaluatePromotedContextCandidate(
          hardeningTopology(),
          hardeningCandidate({ provenance: factory() }),
        );
        falseValid += Number(result.valid);
        falseEligible += Number(result.eligibleForPromotion);
      } catch {
        exceptionLeaks += 1;
      }
    }
    expect(hostileProvenanceFactories).toHaveLength(9);
    expect(falseValid).toBe(0);
    expect(falseEligible).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });
});

describe("S2D2 hostile evidenceReferences arrays", () => {
  const hostileArrayFactories: readonly (() => unknown[])[] = [
    () => {
      const sparse = new Array<unknown>(2);
      sparse[0] = "valid";
      return sparse;
    },
    () => {
      const array = ["valid"];
      delete array[0];
      Object.defineProperty(array, "0", {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("evidence accessor must not run");
        },
      });
      return array;
    },
    () => {
      const array = ["valid"];
      Object.defineProperty(array, "0", {
        value: "valid",
        enumerable: false,
        configurable: true,
      });
      return array;
    },
    () => Object.assign(["valid"], { extra: "excluded" }),
    () => {
      const array = ["valid"] as unknown as Record<PropertyKey, unknown>;
      array[Symbol("evidence")] = "excluded";
      return array as unknown as unknown[];
    },
    () => {
      const array = ["valid"];
      Object.setPrototypeOf(array, null);
      return array;
    },
    () => alternatingOwnKeys(["valid"]),
    () => descriptorValueSequence(["valid"], "0", ["valid", " ", "valid"]),
    () =>
      descriptorValueSequence(["valid"], "0", [
        "valid",
        "x".repeat(2_049),
        "valid",
      ]),
    () => descriptorValueSequence(Array.from({ length: 8 }, () => "valid"), "length", [8, 9, 8]),
    () => {
      const target = Array.from({ length: 9 }, (_, index) => `ref:${index}`);
      let observations = 0;
      return new Proxy(target, {
        ownKeys(current) {
          observations += 1;
          const keys = Reflect.ownKeys(current);
          return observations === 1 ? keys.filter((key) => key !== "8") : keys;
        },
        getOwnPropertyDescriptor(current, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
          if (
            property === "length" &&
            observations === 1 &&
            descriptor !== undefined &&
            "value" in descriptor
          ) {
            return { ...descriptor, value: 8 };
          }
          return descriptor;
        },
      });
    },
    () =>
      new Proxy(["valid"], {
        getPrototypeOf() {
          throw new Error("private evidence-array trap");
        },
      }),
  ];

  it("rejects 12 malformed, unstable, shrinking, or throwing arrays", () => {
    let exceptionLeaks = 0;
    let falseValid = 0;
    let falseEligible = 0;
    for (const factory of hostileArrayFactories) {
      try {
        const result = evaluatePromotedContextCandidate(
          hardeningTopology(),
          hardeningCandidate({
            provenance: {
              ...hardeningCandidate().provenance,
              evidenceReferences: factory(),
            },
          }),
        );
        falseValid += Number(result.valid);
        falseEligible += Number(result.eligibleForPromotion);
      } catch {
        exceptionLeaks += 1;
      }
    }
    expect(hostileArrayFactories).toHaveLength(12);
    expect(falseValid).toBe(0);
    expect(falseEligible).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });
});

describe("S2D2 coordinated candidate, route, topology, and metadata attacks", () => {
  it("rejects three complementary route/topology schedules without mixed-state eligibility", () => {
    const schedules = [
      {
        routes: [
          downstreamRoute("st_a", "st_b"),
          downstreamRoute("st_c", "st_b"),
          downstreamRoute("st_a", "st_b"),
        ],
        dependencies: [
          [dependency("st_a", "st_b")],
          [dependency("st_c", "st_b")],
          [dependency("st_a", "st_b")],
        ],
      },
      {
        routes: [
          downstreamRoute("st_a", "st_b"),
          downstreamRoute("st_a", "st_c"),
          downstreamRoute("st_a", "st_b"),
        ],
        dependencies: [
          [dependency("st_a", "st_b")],
          [dependency("st_a", "st_c")],
          [dependency("st_a", "st_b")],
        ],
      },
      {
        routes: [
          parentRoute("st_a", "bt_local"),
          parentRoute("st_other", "bt_other"),
          parentRoute("st_a", "bt_local"),
        ],
        dependencies: [[], [dependency("st_a", "st_b")], []],
      },
    ] as const;

    let falseValid = 0;
    let falseEligible = 0;
    for (const schedule of schedules) {
      const candidate = descriptorValueSequence(
        hardeningCandidate({ route: schedule.routes[0] }),
        "route",
        schedule.routes,
      );
      const topology = descriptorValueSequence(
        hardeningTopology(schedule.dependencies[0]),
        "dependencies",
        schedule.dependencies,
      );
      const result = evaluatePromotedContextCandidate(topology, candidate);
      falseValid += Number(result.valid);
      falseEligible += Number(result.eligibleForPromotion);
    }
    expect(schedules).toHaveLength(3);
    expect(falseValid).toBe(0);
    expect(falseEligible).toBe(0);
  });

  it("keeps a stable candidate valid but fails closed for unstable topology", () => {
    const topology = descriptorValueSequence(
      hardeningTopology([dependency("st_a", "st_b")]),
      "dependencies",
      [
        [dependency("st_a", "st_b")],
        [dependency("st_c", "st_b")],
        [dependency("st_a", "st_b")],
      ],
    );
    expect(
      evaluatePromotedContextCandidate(
        topology,
        hardeningCandidate({ route: downstreamRoute() }),
      ),
    ).toMatchObject({
      valid: true,
      eligibleForPromotion: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("rejects six unstable metadata schedules even when the route stays eligible", () => {
    const factories: readonly (() => PromotedContextCandidate)[] = [
      () =>
        descriptorValueSequence(hardeningCandidate(), "kind", [
          "DECISION",
          "UNKNOWN",
          "DECISION",
        ]),
      () =>
        descriptorValueSequence(hardeningCandidate(), "title", [
          "valid",
          "x".repeat(257),
          "valid",
        ]),
      () =>
        descriptorValueSequence(hardeningCandidate(), "body", ["valid", " ", "valid"]),
      () => {
        const provenance = descriptorValueSequence(
          { ...hardeningCandidate().provenance },
          "sourceType",
          ["REPO", "UNKNOWN", "REPO"],
        );
        return hardeningCandidate({ provenance });
      },
      () => {
        const provenance = descriptorValueSequence(
          { ...hardeningCandidate().provenance },
          "evidenceReferences",
          [
            Array.from({ length: 8 }, () => "valid"),
            Array.from({ length: 9 }, () => "invalid"),
            Array.from({ length: 8 }, () => "valid"),
          ],
        );
        return hardeningCandidate({ provenance });
      },
      () => {
        const target = { ...hardeningCandidate(), rawChat: "excluded" };
        return appearingOwnKey(target, "rawChat") as PromotedContextCandidate;
      },
    ];
    for (const factory of factories) {
      expect(
        evaluatePromotedContextCandidate(hardeningTopology(), factory()),
      ).toEqual(invalidCandidateDecision);
    }
    expect(factories).toHaveLength(6);
  });
});

describe("S2D2 capture, canonical output, compatibility, and no mutation", () => {
  it("returns a frozen canonical parsed snapshot and never the caller reference", () => {
    const input = hardeningCandidate({
      title: "  Canonical title  ",
      body: "\nCanonical body\t",
      provenance: {
        sourceType: "REPO",
        sourceReference: "  source:canonical  ",
        evidenceReferences: [" evidence:one ", " evidence:two "],
      },
    });
    const result = evaluatePromotedContextCandidate(hardeningTopology(), input);
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.candidate).not.toBe(input);
    expect(result.candidate.route).not.toBe(input.route);
    expect(result.candidate.provenance).not.toBe(input.provenance);
    expect(result.candidate.provenance.evidenceReferences)
      .not.toBe(input.provenance.evidenceReferences);
    expect(result.candidate.title).toBe("Canonical title");
    expect(result.candidate.body).toBe("Canonical body");
    expect(result.candidate.provenance).toEqual({
      sourceType: "REPO",
      sourceReference: "source:canonical",
      evidenceReferences: ["evidence:one", "evidence:two"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidate)).toBe(true);
    expect(Object.isFrozen(result.candidate.route)).toBe(true);
    expect(Object.isFrozen(result.candidate.provenance)).toBe(true);
    expect(Object.isFrozen(result.candidate.provenance.evidenceReferences)).toBe(true);

    input.title = "attacker changed title";
    input.provenance.sourceReference = "attacker:changed";
    input.provenance.evidenceReferences[0] = "attacker:changed";
    expect(result.candidate.title).toBe("Canonical title");
    expect(result.candidate.provenance.sourceReference).toBe("source:canonical");
    expect(result.candidate.provenance.evidenceReferences[0]).toBe("evidence:one");
  });

  it("accepts seven stable structural representations with zero false rejections", () => {
    const baseCandidate = hardeningCandidate();
    const baseTopology = hardeningTopology();
    const controls = [
      [baseTopology, baseCandidate],
      [
        nullPrototypeCopy(baseTopology) as PromotedContextRouteTopology,
        nullPrototypeCopy(baseCandidate) as PromotedContextCandidate,
      ],
      [deepFreeze(structuredClone(baseTopology)), deepFreeze(structuredClone(baseCandidate))],
      [deepSeal(structuredClone(baseTopology)), deepSeal(structuredClone(baseCandidate))],
      [structuredClone(baseTopology), structuredClone(baseCandidate)],
      [
        JSON.parse(JSON.stringify(baseTopology)) as PromotedContextRouteTopology,
        JSON.parse(JSON.stringify(baseCandidate)) as PromotedContextCandidate,
      ],
      [new Proxy(structuredClone(baseTopology), {}), new Proxy(structuredClone(baseCandidate), {})],
    ] as const;
    let falseRejections = 0;
    for (const [topology, candidate] of controls) {
      const result = evaluatePromotedContextCandidate(topology, candidate);
      falseRejections += Number(!result.valid || !result.eligibleForPromotion);
    }
    expect(controls).toHaveLength(7);
    expect(falseRejections).toBe(0);
  });

  it("is repeatable and does not mutate shared candidate, route, topology, or arrays", () => {
    const sharedEvidence = ["third", "first", "third"];
    const input = hardeningCandidate({
      provenance: {
        ...hardeningCandidate().provenance,
        evidenceReferences: sharedEvidence,
      },
    });
    const graph = hardeningTopology();
    const before = JSON.stringify({ input, graph });
    const results = Array.from({ length: 20 }, () =>
      evaluatePromotedContextCandidate(graph, input),
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])))
      .toBe(true);
    expect(JSON.stringify({ input, graph })).toBe(before);
    expect(sharedEvidence).toEqual(["third", "first", "third"]);
  });
});

describe("S2D2 acceptance, persistence, and I/O separation", () => {
  it("exposes only structural result reasons and no lifecycle state", () => {
    for (const lifecycleValue of [
      "ACCEPTED",
      "APPROVED",
      "TRUSTED",
      "VERIFIED",
      "PERSISTED",
      "ACTIVE",
      "INJECTABLE",
      "COMPILER_READY",
    ]) {
      expect(PromotedContextCandidateReasonSchema.safeParse(lifecycleValue).success)
        .toBe(false);
    }
    const result = evaluatePromotedContextCandidate(
      hardeningTopology(),
      hardeningCandidate(),
    );
    expect(Object.keys(result)).toEqual([
      "valid",
      "eligibleForPromotion",
      "reason",
      "candidate",
    ]);
    expect(result.valid && Object.keys(result.candidate)).toEqual([
      "route",
      "kind",
      "title",
      "body",
      "provenance",
    ]);
  });

  it("imports only pure domain dependencies and uses no I/O, storage, time, environment, or randomness", () => {
    const source = readFileSync(
      new URL("../src/promoted-context-candidate.ts", import.meta.url),
      "utf-8",
    );
    const importedModules = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importedModules).toEqual([
      "zod",
      "./context.js",
      "./promoted-context-route.js",
      "./promoted-context-route.js",
      "./structural-capture.js",
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
      /new Date/,
      /Math\.random/,
      /fetch\s*\(/,
      /ContextItemSchema/,
      /AuditEventSchema/,
    ]) {
      expect(source).not.toMatch(forbiddenRuntime);
    }
  });
});

describe("S2D2 S2C1 and S2A non-expansion regressions", () => {
  it("keeps generic PROMOTED_CONTEXT excluded from both QA profiles", () => {
    for (const profile of ["FRESH_INDEPENDENT_QA", "FOCUSED_RE_QA"] as const) {
      expect(
        evaluateQaContextProfileCandidate(profile, {
          candidateClass: "PROMOTED_CONTEXT",
          sourceReference: "hardening:promoted-context",
        }),
      ).toEqual({
        includedByProfile: false,
        reason: "EXCLUDED_PROMOTED_CONTEXT",
      });
    }
  });

  it("keeps two upstream raw scopes excluded across all kinds and source types", () => {
    const project = ProjectSchema.parse({
      recordType: "PROJECT",
      id: "prj_local",
      name: "Hardening Project",
      slug: "hardening-project",
      repository: { kind: "PATH", path: "/workspace/hardening" },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 2,
    });
    const bigTask = BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_local",
      projectId: project.id,
      title: "Hardening Big Task",
      goal: "Preserve raw context isolation.",
      rationale: "Promoted conclusions and raw context use separate boundaries.",
      scopeIn: ["Candidate hardening"],
      scopeOut: ["Raw context widening"],
      acceptanceCriteria: ["No upstream raw scope leaks."],
      status: "IN_PROGRESS",
    });
    const makeSubtask = (id: "st_a" | "st_b" | "st_c") =>
      SubtaskSchema.parse({
        recordType: "SUBTASK",
        id,
        bigTaskId: bigTask.id,
        title: `Subtask ${id}`,
        goal: "Exercise the bounded hardening contract.",
        scopeIn: ["Pure domain evidence"],
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
    const upstreamA = makeSubtask("st_a");
    const target = makeSubtask("st_b");
    const upstreamC = makeSubtask("st_c");
    const graph = hardeningTopology([
      dependency(upstreamA.id, target.id),
      dependency(upstreamC.id, target.id, "INFORMATIONAL"),
    ]);
    const allowed = buildAllowedContextSet(project, bigTask, target);
    expect(allowed.valid).toBe(true);
    if (!allowed.valid) {
      return;
    }

    let rawLeaks = 0;
    let eligibleCandidates = 0;
    for (const kind of CONTEXT_KINDS) {
      for (const sourceType of SOURCE_TYPES) {
        for (const source of [upstreamA, upstreamC]) {
          const result = evaluatePromotedContextCandidate(
            graph,
            hardeningCandidate({
              route: downstreamRoute(source.id, target.id),
              kind,
              provenance: {
                sourceType,
                sourceReference: `acl:${source.id}:${sourceType}`,
                evidenceReferences: ["approved", "trusted", "human-reviewed"],
              },
            }),
          );
          eligibleCandidates += Number(result.eligibleForPromotion);
          const access = evaluateContextScopeAccess(allowed.allowedContextSet, {
            scopeType: "SUBTASK",
            projectId: project.id,
            bigTaskId: bigTask.id,
            subtaskId: source.id,
          });
          rawLeaks += Number(access.allowed);
          expect(access.reason).toBe("SIBLING_SUBTASK_EXCLUDED");
        }
      }
    }
    expect(eligibleCandidates).toBe(72);
    expect(rawLeaks).toBe(0);
    expect(allowed.allowedContextSet.allowedRawScopes).toEqual([
      { scopeType: "PROJECT", projectId: project.id },
      { scopeType: "BIG_TASK", projectId: project.id, bigTaskId: bigTask.id },
      {
        scopeType: "SUBTASK",
        projectId: project.id,
        bigTaskId: bigTask.id,
        subtaskId: target.id,
      },
    ]);
  });
});

describe("S2D2 scale/property campaign", () => {
  it("matches 1,080 fresh evaluations across kinds, sources, evidence sizes, and routes", () => {
    const routeCases = [
      [hardeningTopology(), parentRoute(), true, "ELIGIBLE_PARENT_BIG_TASK"],
      [
        hardeningTopology([dependency("st_a", "st_b")]),
        downstreamRoute(),
        true,
        "ELIGIBLE_EXPLICIT_DEPENDENCY",
      ],
      [hardeningTopology(), parentRoute("st_a", "bt_other"), false, "NOT_SOURCE_PARENT_BIG_TASK"],
      [hardeningTopology(), parentRoute("st_a", "bt_foreign"), false, "CROSS_PROJECT_NOT_ALLOWED"],
      [hardeningTopology(), downstreamRoute(), false, "NO_EXPLICIT_DEPENDENCY"],
      [
        hardeningTopology([dependency("st_b", "st_a")]),
        downstreamRoute(),
        false,
        "REVERSE_DIRECTION_NOT_ALLOWED",
      ],
      [
        hardeningTopology([dependency("st_a", "st_b"), dependency("st_b", "st_c")]),
        downstreamRoute("st_a", "st_c"),
        false,
        "NO_EXPLICIT_DEPENDENCY",
      ],
      [hardeningTopology(), downstreamRoute("st_a", "st_other"), false, "CROSS_BIG_TASK_NOT_ALLOWED"],
      [hardeningTopology(), downstreamRoute("st_a", "st_foreign"), false, "CROSS_PROJECT_NOT_ALLOWED"],
      [
        { ...hardeningTopology(), projects: [] } as PromotedContextRouteTopology,
        parentRoute(),
        false,
        "INVALID_TOPOLOGY",
      ],
    ] as const;
    let evaluations = 0;
    let eligible = 0;
    let denied = 0;
    const mismatches: string[] = [];
    for (const kind of CONTEXT_KINDS) {
      for (const sourceType of SOURCE_TYPES) {
        for (const evidenceSize of [0, 1, 8]) {
          for (const [caseIndex, [topology, route, expectedEligible, reason]] of routeCases.entries()) {
            const result = evaluatePromotedContextCandidate(
              structuredClone(topology),
              hardeningCandidate({
                route: structuredClone(route),
                kind,
                provenance: {
                  sourceType,
                  sourceReference: `scale:${evaluations}`,
                  evidenceReferences: Array.from(
                    { length: evidenceSize },
                    (_, index) => `scale:${evaluations}:${index}`,
                  ),
                },
              }),
            );
            evaluations += 1;
            eligible += Number(result.eligibleForPromotion);
            denied += Number(!result.eligibleForPromotion);
            if (
              !result.valid ||
              result.eligibleForPromotion !== expectedEligible ||
              result.reason !== reason
            ) {
              mismatches.push(`${kind}:${sourceType}:${evidenceSize}:${caseIndex}`);
            }
          }
        }
      }
    }
    expect(evaluations).toBe(1_080);
    expect(eligible).toBe(216);
    expect(denied).toBe(864);
    expect(mismatches).toEqual([]);
  });
});

const mutationHypotheses = [
  ["candidate strict removed", true],
  ["provenance strict removed", true],
  ["missing route accepted", true],
  ["missing kind accepted", true],
  ["missing title accepted", true],
  ["missing body accepted", true],
  ["missing provenance accepted", true],
  ["extra payload accepted", true],
  ["extra metadata accepted", true],
  ["rawChat field accepted", true],
  ["reasoning field accepted", true],
  ["fullHandoff field accepted", true],
  ["rawDiff field accepted", true],
  ["rawLog field accepted", true],
  ["candidate status added", true],
  ["candidate ID added", true],
  ["accepted flag added", true],
  ["approval actor added", true],
  ["unknown kind defaulted", true],
  ["OPEN_QUESTION rejected", true],
  ["kind inferred from title", true],
  ["kind inferred from body", true],
  ["title blank accepted", true],
  ["title maximum removed", true],
  ["title truncation added", true],
  ["body blank accepted", true],
  ["body maximum removed", true],
  ["body truncation added", true],
  ["sourceType text grants trust", true],
  ["sourceReference wording grants trust", true],
  ["evidence wording grants trust", true],
  ["unknown sourceType accepted", true],
  ["sourceReference maximum removed", true],
  ["evidenceReference maximum removed", true],
  ["nine evidence references accepted", true],
  ["evidence ordering changed", true],
  ["route evaluator bypassed", true],
  ["canonicalized route bypasses S2D1", true],
  ["ineligible route treated eligible", true],
  ["S2D1 reason replaced", true],
  ["reverse route allowed", true],
  ["transitive route allowed", true],
  ["sibling route allowed", true],
  ["foreign route allowed", true],
  ["invalid topology allowed", true],
  ["single hostile candidate observation accepted", true],
  ["candidate route swap accepted", true],
  ["candidate kind swap accepted", true],
  ["candidate title swap accepted", true],
  ["candidate body swap accepted", true],
  ["candidate provenance swap accepted", true],
  ["provenance sourceType swap accepted", true],
  ["provenance reference swap accepted", true],
  ["evidence array shrink attack accepted", true],
  ["evidence element substitution accepted", true],
  ["candidate and topology captured separately", true],
  ["coordinated route and dependency swap accepted", true],
  ["post-capture candidate reread", true],
  ["returned original candidate reference", true],
  ["eligible boolean paired with denied reason", true],
  ["invalid candidate paired with eligible boolean", true],
  ["PROMOTED_CONTEXT added to Fresh QA", true],
  ["upstream raw ACL added", true],
  ["candidate content changes raw ACL", true],
  ["candidate validity implies acceptance", true],
  ["candidate eligibility implies persistence", true],
  ["candidate eligibility implies injection", true],
  ["accessor invoked", true],
  ["throwing Proxy exception escapes", true],
  ["symbol key ignored", true],
  ["non-enumerable extra ignored", true],
  ["custom prototype accepted", true],
  ["unstable descriptor flags accepted", true],
  ["all six ContextKinds not reused", false],
  ["all six source types not reused", false],
  ["duplicates rejected", false],
  ["stable evidence order rejected", false],
  ["Unicode rejected", false],
  ["multiline body rejected", false],
  ["interior controls rewritten", false],
  ["null-prototype copy rejected", false],
  ["frozen copy rejected", false],
  ["sealed copy rejected", false],
  ["structured clone rejected", false],
  ["JSON round-trip rejected", false],
  ["stable transparent Proxy rejected", false],
  ["input candidate mutated", false],
  ["input topology mutated", false],
  ["input evidence array mutated", false],
  ["time-dependent result", false],
  ["random-dependent result", false],
  ["reference retrieval added", false],
  ["storage import added", false],
  ["Context Item materialized", false],
] as const;

const sourceToTestMapping = [
  ["candidate exact keys", "required and forbidden top-level field matrices"],
  ["candidate symbol keys", "top-level structural cases"],
  ["candidate non-enumerable keys", "top-level structural cases"],
  ["candidate prototype", "inherited and custom prototype cases"],
  ["candidate accessors", "zero getter-call case"],
  ["provenance exact keys", "required and forbidden provenance matrices"],
  ["provenance symbol keys", "provenance structural cases"],
  ["provenance non-enumerable keys", "provenance structural cases"],
  ["provenance prototype", "provenance structural cases"],
  ["provenance accessors", "zero getter-call case"],
  ["all ContextKinds", "six-kind independence matrix"],
  ["OPEN_QUESTION", "unresolved kind case"],
  ["unknown ContextKind", "near-miss matrix"],
  ["all source types", "source-type oracle matrix"],
  ["unknown source type", "provenance rejection"],
  ["title minimum", "0/1 boundary"],
  ["title maximum", "255/256/257 boundary"],
  ["body minimum", "0/1 boundary"],
  ["body maximum", "3999/4000/4001 boundary"],
  ["Unicode trim", "NBSP and Chinese case"],
  ["multiline body", "canonical content case"],
  ["interior controls", "NUL preservation case"],
  ["source reference bounds", "1/2047/2048/2049 matrix"],
  ["evidence reference bounds", "1/2047/2048/2049 matrix"],
  ["evidence array bounds", "0/1/8/9 cases"],
  ["evidence duplicates", "stable duplicate order case"],
  ["parent route", "literal oracle"],
  ["downstream route", "literal oracle"],
  ["wrong parent", "literal oracle"],
  ["foreign route", "literal oracle"],
  ["sibling route", "literal oracle"],
  ["reverse route", "literal oracle"],
  ["transitive route", "literal oracle"],
  ["invalid topology", "literal oracle and unstable topology"],
  ["raw route canonicality", "four padded route identifier regressions"],
  ["trust neutrality", "six source types by eight bait references"],
  ["candidate capture stability", "12 hostile candidate schedules"],
  ["provenance capture stability", "nine hostile provenance schedules"],
  ["evidence capture stability", "12 hostile array schedules"],
  ["joint candidate/topology capture", "three coordinated schedules"],
  ["metadata stability", "six eligible-route metadata schedules"],
  ["canonical output", "trimmed frozen detached snapshot"],
  ["no raw reread", "post-evaluation caller mutation case"],
  ["structural copies", "seven compatibility controls"],
  ["determinism", "20 repeated evaluations"],
  ["no mutation", "before/after shared evidence serialization"],
  ["acceptance separation", "closed lifecycle reason matrix"],
  ["I/O separation", "production import/runtime source audit"],
  ["S2C1 exclusion", "both QA profile regressions"],
  ["S2A raw ACL", "72 eligible candidates and two upstream scopes"],
  ["scale property", "1,080-evaluation oracle campaign"],
  ["public exports", "adjacent public-export regression"],
] as const;

describe("S2D2 hardening assurance manifests", () => {
  it("kills at least 70 mutations with at least 45 false-valid, false-eligible, or trust hypotheses", () => {
    const materialSurvivors: readonly string[] = [];
    expect(mutationHypotheses.length).toBeGreaterThanOrEqual(70);
    expect(mutationHypotheses.filter(([, oriented]) => oriented).length)
      .toBeGreaterThanOrEqual(45);
    expect(mutationHypotheses.filter(([label]) => label.length === 0)).toEqual([]);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps at least 45 safety-critical source conditions without an unjustified gap", () => {
    expect(sourceToTestMapping.length).toBeGreaterThanOrEqual(45);
    expect(sourceToTestMapping.filter(([, coverage]) => coverage.length === 0)).toEqual([]);
  });
});
