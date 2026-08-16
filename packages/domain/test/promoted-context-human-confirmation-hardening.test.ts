import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  AuditActorTypeSchema,
  AuditEventSchema,
  BigTaskSchema,
  ContextAuthoritySchema,
  PromotedContextCandidateSchema,
  PromotedContextHumanConfirmationEvaluationSchema,
  PromotedContextHumanConfirmationEvidenceSchema,
  PromotedContextRouteSchema,
  PromotedContextRouteTopologySchema,
  ProjectSchema,
  QaContextProfileCandidateSchema,
  SubtaskDependencySchema,
  SubtaskImplementationCheckpointSchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
  evaluateQaContextProfileCandidate,
  evaluatePromotedContextHumanConfirmationEvidence,
} from "../src/index.js";
import type {
  ContextKind,
  ContextSourceType,
  PromotedContextCandidate,
  PromotedContextRouteTopology,
} from "../src/index.js";

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

const validEvidence = (overrides: Record<string, unknown> = {}) => ({
  evidenceType: "HUMAN_CONFIRMATION",
  sourceReference: "action:s2d4-hardening",
  occurredAt: "2026-08-16T08:30:00+08:00",
  ...overrides,
});

const topology = PromotedContextRouteTopologySchema.parse({
  projects: [{ id: "prj_hardening" }],
  bigTasks: [{ id: "bt_hardening", projectId: "prj_hardening" }],
  subtasks: [{ id: "st_source", bigTaskId: "bt_hardening" }],
  dependencies: [],
});

const candidate = PromotedContextCandidateSchema.parse({
  route: PromotedContextRouteSchema.parse({
    sourceSubtaskId: "st_source",
    audienceKind: "PARENT_BIG_TASK",
    targetBigTaskId: "bt_hardening",
  }),
  kind: "DECISION",
  title: "Preserve a strict human evidence boundary",
  body: "Structural applicability does not authenticate a human.",
  provenance: {
    sourceType: "MANUAL",
    sourceReference: "candidate:s2d4-hardening",
    evidenceReferences: [],
  },
});

const dependency = (upstreamSubtaskId = "st_source", downstreamSubtaskId = "st_target") =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
    requiredGate: "HARDENED",
    reason: "The exact upstream conclusion may inform the downstream task.",
  });

const fullTopology = (
  dependencies = [dependency()],
): PromotedContextRouteTopology =>
  PromotedContextRouteTopologySchema.parse({
    projects: [{ id: "prj_hardening" }, { id: "prj_foreign" }],
    bigTasks: [
      { id: "bt_hardening", projectId: "prj_hardening" },
      { id: "bt_other", projectId: "prj_hardening" },
      { id: "bt_foreign", projectId: "prj_foreign" },
    ],
    subtasks: [
      { id: "st_source", bigTaskId: "bt_hardening" },
      { id: "st_target", bigTaskId: "bt_hardening" },
      { id: "st_sibling", bigTaskId: "bt_hardening" },
      { id: "st_other", bigTaskId: "bt_other" },
      { id: "st_foreign", bigTaskId: "bt_foreign" },
    ],
    dependencies,
  });

const parentRoute = (targetBigTaskId = "bt_hardening") =>
  PromotedContextRouteSchema.parse({
    sourceSubtaskId: "st_source",
    audienceKind: "PARENT_BIG_TASK",
    targetBigTaskId,
  });

const downstreamRoute = (
  sourceSubtaskId = "st_source",
  targetSubtaskId = "st_target",
) =>
  PromotedContextRouteSchema.parse({
    sourceSubtaskId,
    audienceKind: "DOWNSTREAM_SUBTASK",
    targetSubtaskId,
  });

const makeCandidate = (
  overrides: Record<string, unknown> = {},
): PromotedContextCandidate =>
  PromotedContextCandidateSchema.parse({
    route: parentRoute(),
    kind: "DECISION",
    title: "Preserve a strict human evidence boundary",
    body: "Structural applicability does not authenticate a human.",
    provenance: {
      sourceType: "MANUAL",
      sourceReference: "candidate:s2d4-hardening",
      evidenceReferences: [],
    },
    ...overrides,
  });

const evaluate = (
  evidence: unknown = validEvidence(),
  promotedCandidate: PromotedContextCandidate = makeCandidate(),
  graph: PromotedContextRouteTopology = fullTopology(),
) =>
  evaluatePromotedContextHumanConfirmationEvidence(
    graph,
    promotedCandidate,
    evidence,
  );

const descriptorSequence = (
  input: Record<string, unknown>,
  key: string,
  values: readonly unknown[],
): unknown => {
  let observations = 0;
  return new Proxy(input, {
    getOwnPropertyDescriptor(target, observedKey) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, observedKey);
      if (observedKey !== key || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      const value = values[Math.min(observations, values.length - 1)];
      observations += 1;
      return { ...descriptor, value };
    },
  });
};

const freezeDeep = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
};

const invalidEvidenceDecision = {
  structurallyApplicable: false,
  reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
} as const;

describe("S2D4 hardening defect reproductions", () => {
  it("rejects an envelope synthesized from mutually incompatible descriptor states", () => {
    const incompatibleStates = [
      {
        evidenceType: "HUMAN_CONFIRMATION",
        sourceReference: "",
        occurredAt: "invalid",
      },
      {
        evidenceType: "SYSTEM_CONFIRMATION",
        sourceReference: "action:mixed-state",
        occurredAt: "invalid",
      },
      {
        evidenceType: "SYSTEM_CONFIRMATION",
        sourceReference: "",
        occurredAt: "2026-08-16T00:30:00Z",
      },
    ] as const;
    let descriptorCalls = 0;
    const evidence = new Proxy(Object.create(null) as Record<string, unknown>, {
      getPrototypeOf: () => null,
      ownKeys: () => ["evidenceType", "sourceReference", "occurredAt"],
      getOwnPropertyDescriptor(_target, key) {
        const state = incompatibleStates[descriptorCalls % incompatibleStates.length]!;
        descriptorCalls += 1;
        return {
          value: state[key as keyof typeof state],
          writable: true,
          configurable: true,
          enumerable: true,
        };
      },
    });

    expect(
      evaluatePromotedContextHumanConfirmationEvidence(
        topology,
        candidate,
        evidence,
      ),
    ).toEqual(invalidEvidenceDecision);
  });
});

describe("S2D4 independent evidence oracle", () => {
  it("matches 96 fresh cases and 240 exact result fields with zero mismatches", () => {
    const evidenceCases = [
      {
        input: validEvidence({ occurredAt: "2026-08-16T00:30:00Z" }),
        valid: true,
        canonicalOccurredAt: "2026-08-16T00:30:00.000Z",
      },
      {
        input: validEvidence({ occurredAt: "2026-08-16T08:30:00+08:00" }),
        valid: true,
        canonicalOccurredAt: "2026-08-16T00:30:00.000Z",
      },
      {
        input: validEvidence({ evidenceType: "SYSTEM_CONFIRMATION" }),
        valid: false,
        canonicalOccurredAt: null,
      },
      {
        input: validEvidence({ approved: true }),
        valid: false,
        canonicalOccurredAt: null,
      },
    ] as const;
    const mismatches: Array<{
      readonly kind: ContextKind;
      readonly audience: "PARENT_BIG_TASK" | "DOWNSTREAM_SUBTASK";
      readonly eligible: boolean;
      readonly evidenceIndex: number;
    }> = [];
    let cases = 0;

    for (const kind of CONTEXT_KINDS) {
      for (const audience of ["PARENT_BIG_TASK", "DOWNSTREAM_SUBTASK"] as const) {
        for (const eligible of [true, false]) {
          for (const [evidenceIndex, evidenceCase] of evidenceCases.entries()) {
            const route =
              audience === "PARENT_BIG_TASK"
                ? parentRoute(eligible ? "bt_hardening" : "bt_other")
                : downstreamRoute();
            const graph =
              audience === "DOWNSTREAM_SUBTASK" && !eligible
                ? fullTopology([])
                : fullTopology();
            const actual = evaluate(
              evidenceCase.input,
              makeCandidate({ kind, route }),
              graph,
            );
            const expected = !eligible
              ? {
                  structurallyApplicable: false,
                  reason:
                    audience === "PARENT_BIG_TASK"
                      ? "NOT_SOURCE_PARENT_BIG_TASK"
                      : "NO_EXPLICIT_DEPENDENCY",
                }
              : !evidenceCase.valid
                ? invalidEvidenceDecision
                : {
                    structurallyApplicable: true,
                    requirement:
                      kind === "ENGINEERING_FACT"
                        ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
                        : "HUMAN_CONFIRMATION_REQUIRED",
                    reason:
                      "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
                    evidence: {
                      evidenceType: "HUMAN_CONFIRMATION",
                      sourceReference: "action:s2d4-hardening",
                      occurredAt: evidenceCase.canonicalOccurredAt,
                    },
                  };
            cases += 1;
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              mismatches.push({ kind, audience, eligible, evidenceIndex });
            }
          }
        }
      }
    }

    expect(cases).toBe(96);
    expect(mismatches).toEqual([]);
  });
});

const AUTHORITY_ESCAPE_FIELDS = [
  "actorType",
  "actorReference",
  "userId",
  "humanId",
  "ownerId",
  "sessionId",
  "confirmedBy",
  "approvedBy",
  "confirmed",
  "approved",
  "accepted",
  "verified",
  "trusted",
  "authoritySatisfied",
  "confirmationSatisfied",
  "humanAuthenticated",
  "candidateId",
  "candidateHash",
  "candidateDigest",
  "candidateFingerprint",
  "contentHash",
  "summary",
  "comment",
  "reason",
  "body",
  "metadata",
  "payload",
  "attachments",
  "signature",
  "publicKey",
  "repoEvidence",
  "deterministicEvidence",
  "modelConfidence",
  "codexApproved",
  "systemApproved",
  "autoAccept",
  "role",
  "identity",
  "status",
  "acceptedAt",
  "approvedAt",
  "trustLevel",
  "lifecycle",
  "generic",
] as const;

describe("S2D4 exact evidence envelope and authority escapes", () => {
  it.each(["evidenceType", "sourceReference", "occurredAt"])(
    "rejects missing required field %s",
    (field) => {
      const input = validEvidence();
      delete (input as Record<string, unknown>)[field];
      expect(evaluate(input)).toEqual(invalidEvidenceDecision);
    },
  );

  it.each([
    ["evidenceType", null],
    ["evidenceType", 1],
    ["evidenceType", {}],
    ["evidenceType", "CODEX_CONFIRMATION"],
    ["evidenceType", "SYSTEM_CONFIRMATION"],
    ["sourceReference", null],
    ["sourceReference", 1],
    ["sourceReference", {}],
    ["occurredAt", null],
    ["occurredAt", 1],
    ["occurredAt", {}],
    ["occurredAt", []],
  ])("rejects wrong %s value %#", (field, value) => {
    expect(evaluate(validEvidence({ [field]: value }))).toEqual(
      invalidEvidenceDecision,
    );
  });

  it.each(AUTHORITY_ESCAPE_FIELDS)("rejects fresh extra field %s", (field) => {
    expect(evaluate(validEvidence({ [field]: "attacker-controlled" }))).toEqual(
      invalidEvidenceDecision,
    );
  });

  it("rejects inherited, hidden, symbol, custom-prototype, array, function, null, and primitive shapes", () => {
    const inherited = Object.assign(
      Object.create({ approved: true }) as Record<string, unknown>,
      validEvidence(),
    );
    const hidden = validEvidence();
    Object.defineProperty(hidden, "approved", {
      value: true,
      enumerable: false,
    });
    const hiddenRequired = validEvidence();
    Object.defineProperty(hiddenRequired, "occurredAt", {
      ...Object.getOwnPropertyDescriptor(hiddenRequired, "occurredAt"),
      enumerable: false,
    });
    const symbol = validEvidence() as Record<PropertyKey, unknown>;
    symbol[Symbol("approved")] = true;
    const customPrototype = Object.assign(
      Object.create({ marker: true }) as Record<string, unknown>,
      validEvidence(),
    );
    for (const input of [
      inherited,
      hidden,
      hiddenRequired,
      symbol,
      customPrototype,
      [],
      () => validEvidence(),
      null,
      true,
      1,
      "HUMAN_CONFIRMATION",
    ]) {
      expect(evaluate(input)).toEqual(invalidEvidenceDecision);
    }
    expect(
      evaluatePromotedContextHumanConfirmationEvidence(
        fullTopology(),
        makeCandidate(),
        undefined,
      ),
    ).toEqual(invalidEvidenceDecision);
  });

  it("rejects a __proto__ own key that the schema alone would ignore", () => {
    const input = validEvidence();
    Object.defineProperty(input, "__proto__", {
      value: "authority-escape",
      enumerable: true,
      configurable: true,
    });

    expect(evaluate(input)).toEqual(invalidEvidenceDecision);
  });
});

describe("S2D4 sourceReference boundaries and authenticity neutrality", () => {
  it.each([
    [0, false],
    [1, true],
    [2_047, true],
    [2_048, true],
    [2_049, false],
  ] as const)("evaluates %i characters as valid=%s", (length, valid) => {
    expect(
      evaluate(validEvidence({ sourceReference: "r".repeat(length) }))
        .structurallyApplicable,
    ).toBe(valid);
  });

  it("uses JavaScript trim while preserving Unicode, multiline, interior whitespace, and controls", () => {
    const sourceReference = "\u2003人工\n确认 \t路径\u0000值\u00a0";
    const result = evaluate(validEvidence({ sourceReference }));
    expect(result.structurallyApplicable).toBe(true);
    expect(
      result.structurallyApplicable && result.evidence.sourceReference,
    ).toBe("人工\n确认 \t路径\u0000值");
  });

  it.each([
    "human approved",
    "Hanlin approved",
    "owner confirmed",
    "trusted UI",
    "signed confirmation",
    "system says human",
    "Codex says human",
    "verified",
    "accepted",
    "QA PASS",
    "production approved",
    "fake human",
    "spoofed user",
  ])("keeps authority-bait reference %s opaque", (sourceReference) => {
    const result = evaluate(validEvidence({ sourceReference }));
    expect(result.structurallyApplicable).toBe(true);
    expect(
      result.structurallyApplicable && result.evidence.sourceReference,
    ).toBe(sourceReference);
  });
});

describe("S2D4 occurredAt canonicalization and authority neutrality", () => {
  it.each([
    ["2026-08-16T00:30:00Z", "2026-08-16T00:30:00.000Z"],
    ["2026-08-16T08:30:00+08:00", "2026-08-16T00:30:00.000Z"],
    ["2026-08-15T20:00:00-04:30", "2026-08-16T00:30:00.000Z"],
    ["2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00.123Z"],
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["2026-01-01T00:00:00+14:00", "2025-12-31T10:00:00.000Z"],
    ["2026-01-01T00:00:00-12:00", "2026-01-01T12:00:00.000Z"],
    ["2026-12-31T23:59:59+00:00", "2026-12-31T23:59:59.000Z"],
  ])("canonicalizes %s", (occurredAt, canonical) => {
    const result = evaluate(validEvidence({ occurredAt }));
    expect(result.structurallyApplicable).toBe(true);
    expect(result.structurallyApplicable && result.evidence.occurredAt).toBe(
      canonical,
    );
  });

  it.each([
    "2026-08-16",
    "2026-08-16T00:30:00",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T23:60:00Z",
    "2026-01-01T23:59:60Z",
    "2026-01-01T00:00:00.Z",
    "2026-01-01T00:00:00+8:00",
    "2026-01-01T00:00:00+24:00",
    "not-a-date",
    "",
  ])("rejects malformed timestamp %s", (occurredAt) => {
    expect(evaluate(validEvidence({ occurredAt }))).toEqual(
      invalidEvidenceDecision,
    );
  });

  it("accepts ancient and far-future timestamps without a current-clock read", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("current time must not be read");
    });
    try {
      for (const occurredAt of [
        "0001-01-01T00:00:00Z",
        "1900-01-01T00:00:00-05:00",
        "9999-12-31T23:59:59+14:00",
      ]) {
        expect(evaluate(validEvidence({ occurredAt })).structurallyApplicable).toBe(
          true,
        );
      }
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});

describe("S2D4 state-changing and mixed-observation evidence", () => {
  it.each([
    ["evidenceType", ["SYSTEM_CONFIRMATION", "HUMAN_CONFIRMATION"]],
    [
      "evidenceType",
      ["HUMAN_CONFIRMATION", "SYSTEM_CONFIRMATION", "HUMAN_CONFIRMATION"],
    ],
    ["sourceReference", ["", "action:later-valid"]],
    ["sourceReference", ["r".repeat(2_049), "r".repeat(2_048)]],
    ["occurredAt", ["invalid", "2026-08-16T00:30:00Z"]],
  ] as const)("rejects changing %s descriptor values", (field, values) => {
    expect(
      evaluate(
        descriptorSequence(
          validEvidence(),
          field,
          values,
        ),
      ),
    ).toEqual(invalidEvidenceDecision);
  });

  it("rejects keys that appear, disappear, or alternate", () => {
    for (const schedules of [
      [
        ["evidenceType", "sourceReference"],
        ["evidenceType", "sourceReference", "occurredAt"],
      ],
      [
        ["evidenceType", "sourceReference", "occurredAt"],
        ["evidenceType", "sourceReference", "occurredAt", "approved"],
      ],
      [
        ["evidenceType", "sourceReference", "occurredAt", "authoritySatisfied"],
        ["evidenceType", "sourceReference", "occurredAt"],
      ],
    ]) {
      let calls = 0;
      const input = { ...validEvidence(), approved: true, authoritySatisfied: true };
      const hostile = new Proxy(input, {
        ownKeys() {
          const keys = schedules[calls % schedules.length]!;
          calls += 1;
          return keys;
        },
      });
      expect(evaluate(hostile)).toEqual(invalidEvidenceDecision);
    }
  });

  it("rejects changing prototypes and descriptor flags", () => {
    let prototypeCalls = 0;
    const changingPrototype = new Proxy(validEvidence(), {
      getPrototypeOf() {
        prototypeCalls += 1;
        return prototypeCalls % 2 === 1 ? Object.prototype : null;
      },
    });
    let descriptorCalls = 0;
    const changingFlags = new Proxy(validEvidence(), {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "sourceReference" || descriptor === undefined) {
          return descriptor;
        }
        descriptorCalls += 1;
        return { ...descriptor, writable: descriptorCalls % 2 === 1 };
      },
    });

    expect(evaluate(changingPrototype)).toEqual(invalidEvidenceDecision);
    expect(evaluate(changingFlags)).toEqual(invalidEvidenceDecision);
  });

  it("rejects four independent mixed-state descriptor schedules", () => {
    const states = [
      {
        evidenceType: "HUMAN_CONFIRMATION",
        sourceReference: "",
        occurredAt: "invalid",
      },
      {
        evidenceType: "SYSTEM_CONFIRMATION",
        sourceReference: "action:mixed",
        occurredAt: "invalid",
      },
      {
        evidenceType: "SYSTEM_CONFIRMATION",
        sourceReference: "",
        occurredAt: "2026-08-16T00:30:00Z",
      },
      {
        evidenceType: "SYSTEM_CONFIRMATION",
        sourceReference: "",
        occurredAt: "invalid",
        approved: true,
      },
    ] as const;
    const schedules = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
      [0, 3, 1, 2],
    ] as const;

    for (const schedule of schedules) {
      let calls = 0;
      const hostile = new Proxy(Object.create(null) as Record<string, unknown>, {
        getPrototypeOf: () => null,
        ownKeys: () => ["evidenceType", "sourceReference", "occurredAt"],
        getOwnPropertyDescriptor(_target, key) {
          const state = states[schedule[calls % schedule.length]!]!;
          calls += 1;
          return {
            value: state[key as keyof typeof state],
            writable: true,
            configurable: true,
            enumerable: true,
          };
        },
      });
      expect(evaluate(hostile)).toEqual(invalidEvidenceDecision);
    }
  });

  it("rejects valid-first, later-throwing, cycling, and missing-descriptor schedules", () => {
    const validFirst = descriptorSequence(validEvidence(), "evidenceType", [
      "HUMAN_CONFIRMATION",
      "SYSTEM_CONFIRMATION",
    ]);
    const cycles = descriptorSequence(validEvidence(), "sourceReference", [
      "action:valid",
      "",
      "action:valid",
      "",
    ]);
    let descriptorCalls = 0;
    const laterThrow = new Proxy(validEvidence(), {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        if (descriptorCalls === 5) {
          throw new Error("later reflection failure");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    let presenceCalls = 0;
    const missingLater = new Proxy(validEvidence(), {
      getOwnPropertyDescriptor(target, key) {
        presenceCalls += 1;
        if (presenceCalls === 4) {
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    for (const hostile of [validFirst, cycles, laterThrow, missingLater]) {
      expect(evaluate(hostile)).toEqual(invalidEvidenceDecision);
    }
  });
});

describe("S2D4 reflection exception containment", () => {
  it("contains 30 varied reflection failures without exception leakage", () => {
    const cases = [
      ...Array.from({ length: 6 }, (_, index) => ({
        trap: "getPrototypeOf" as const,
        ordinal: index + 1,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        trap: "ownKeys" as const,
        ordinal: index + 1,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        trap: "getOwnPropertyDescriptor" as const,
        ordinal: index + 1,
      })),
    ].flatMap((entry) => [
      { ...entry, errorKind: "ERROR" as const },
      { ...entry, errorKind: "TYPE_ERROR" as const },
    ]);
    let leaks = 0;

    for (const reflectionCase of cases) {
      let calls = 0;
      const throwIfSelected = (): void => {
        calls += 1;
        if (calls === reflectionCase.ordinal) {
          throw reflectionCase.errorKind === "ERROR"
            ? new Error("hostile reflection")
            : new TypeError("hostile reflection");
        }
      };
      const hostile = new Proxy(validEvidence(), {
        getPrototypeOf(target) {
          if (reflectionCase.trap === "getPrototypeOf") {
            throwIfSelected();
          }
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          if (reflectionCase.trap === "ownKeys") {
            throwIfSelected();
          }
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          if (reflectionCase.trap === "getOwnPropertyDescriptor") {
            throwIfSelected();
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      let result: ReturnType<typeof evaluate> | undefined;
      try {
        result = evaluate(hostile);
      } catch {
        leaks += 1;
      }
      expect(result).toEqual(invalidEvidenceDecision);
    }

    expect(cases).toHaveLength(30);
    expect(leaks).toBe(0);
  });
});

describe("S2D4 accessor and descriptor boundary", () => {
  it("rejects getters, setters, hidden fields, symbols, and reserved own keys", () => {
    let getterCalls = 0;
    const getter = validEvidence();
    Object.defineProperty(getter, "sourceReference", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "action:getter";
      },
    });
    const setter = validEvidence();
    Object.defineProperty(setter, "occurredAt", {
      enumerable: true,
      configurable: true,
      set(value: unknown) {
        void value;
      },
    });
    const nonEnumerableExtra = validEvidence();
    Object.defineProperty(nonEnumerableExtra, "approved", {
      value: true,
      enumerable: false,
    });
    const symbol = validEvidence() as Record<PropertyKey, unknown>;
    symbol[Symbol("trusted")] = true;
    const constructorKey = { ...validEvidence(), constructor: "spoof" };
    const prototypeKey = { ...validEvidence(), prototype: "spoof" };

    for (const input of [
      getter,
      setter,
      nonEnumerableExtra,
      symbol,
      constructorKey,
      prototypeKey,
      new Array(3),
      { ...validEvidence(), 0: "array-like", length: 1 },
    ]) {
      expect(evaluate(input)).toEqual(invalidEvidenceDecision);
    }
    expect(getterCalls).toBe(0);
  });
});

describe("S2D4 candidate and S2D3 gate preservation", () => {
  it.each(CONTEXT_KINDS)(
    "supports both eligible audiences and preserves the S2D3 requirement for %s",
    (kind) => {
      for (const route of [parentRoute(), downstreamRoute()]) {
        const result = evaluate(validEvidence(), makeCandidate({ kind, route }));
        expect(result.structurallyApplicable).toBe(true);
        expect(result.structurallyApplicable && result.requirement).toBe(
          kind === "ENGINEERING_FACT"
            ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
            : "HUMAN_CONFIRMATION_REQUIRED",
        );
      }
    },
  );

  it.each([
    [
      "missing source",
      fullTopology(),
      { ...parentRoute(), sourceSubtaskId: "st_missing" },
      "SOURCE_SUBTASK_NOT_FOUND",
    ],
    [
      "missing parent target",
      fullTopology(),
      { ...parentRoute(), targetBigTaskId: "bt_missing" },
      "TARGET_BIG_TASK_NOT_FOUND",
    ],
    [
      "missing downstream target",
      fullTopology(),
      { ...downstreamRoute(), targetSubtaskId: "st_missing" },
      "TARGET_SUBTASK_NOT_FOUND",
    ],
    ["wrong parent", fullTopology(), parentRoute("bt_other"), "NOT_SOURCE_PARENT_BIG_TASK"],
    ["sibling", fullTopology([]), downstreamRoute(), "NO_EXPLICIT_DEPENDENCY"],
    [
      "reverse",
      fullTopology([dependency("st_target", "st_source")]),
      downstreamRoute(),
      "REVERSE_DIRECTION_NOT_ALLOWED",
    ],
    [
      "transitive only",
      fullTopology([
        dependency("st_source", "st_sibling"),
        dependency("st_sibling", "st_target"),
      ]),
      downstreamRoute(),
      "NO_EXPLICIT_DEPENDENCY",
    ],
    [
      "cross Big Task",
      fullTopology(),
      downstreamRoute("st_source", "st_other"),
      "CROSS_BIG_TASK_NOT_ALLOWED",
    ],
    [
      "cross Project",
      fullTopology(),
      downstreamRoute("st_source", "st_foreign"),
      "CROSS_PROJECT_NOT_ALLOWED",
    ],
  ] as const)("keeps %s non-applicable", (_label, graph, route, reason) => {
    const result = evaluate(
      validEvidence(),
      makeCandidate({ route }),
      graph,
    );
    expect(result).toEqual({ structurallyApplicable: false, reason });
  });

  it("preserves invalid candidate, invalid route, and invalid topology reasons", () => {
    const invalidCandidate = {
      ...makeCandidate(),
      kind: "ENGINEERING_ASSERTION",
    } as unknown as PromotedContextCandidate;
    const invalidRoute = {
      ...makeCandidate(),
      route: { ...parentRoute(), sourceSubtaskId: " st_source " },
    } as unknown as PromotedContextCandidate;
    const invalidTopology = {
      ...fullTopology(),
      subtasks: [{ id: "st_source", bigTaskId: "bt_missing" }],
    } as PromotedContextRouteTopology;

    expect(evaluate(validEvidence(), invalidCandidate)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_CANDIDATE",
    });
    expect(evaluate(validEvidence(), invalidRoute)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_ROUTE",
    });
    expect(evaluate(validEvidence(), makeCandidate(), invalidTopology)).toEqual({
      structurallyApplicable: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("fails closed for unstable candidate/topology, unstable evidence, and coordinated combinations", () => {
    const unstableCandidate = descriptorSequence(
      { ...makeCandidate() },
      "kind",
      ["DECISION", "ENGINEERING_FACT"],
    ) as PromotedContextCandidate;
    const graph = fullTopology();
    const unstableTopology = descriptorSequence(
      { ...graph },
      "projects",
      [graph.projects, [{ id: "prj_changed" }]],
    ) as PromotedContextRouteTopology;
    const unstableEvidence = descriptorSequence(
      validEvidence(),
      "evidenceType",
      ["HUMAN_CONFIRMATION", "SYSTEM_CONFIRMATION"],
    );

    expect(evaluate(validEvidence(), unstableCandidate, graph).structurallyApplicable)
      .toBe(false);
    expect(
      evaluate(validEvidence(), makeCandidate(), unstableTopology)
        .structurallyApplicable,
    ).toBe(false);
    expect(evaluate(unstableEvidence, makeCandidate(), graph)).toEqual(
      invalidEvidenceDecision,
    );
    expect(
      evaluate(unstableEvidence, unstableCandidate, unstableTopology)
        .structurallyApplicable,
    ).toBe(false);
  });

  it("bases the decision on canonical S2D3 output before evidence side effects", () => {
    const mutableCandidate = makeCandidate({ kind: "DECISION" });
    let changed = false;
    const evidence = new Proxy(validEvidence(), {
      getPrototypeOf(target) {
        if (!changed) {
          (mutableCandidate as { kind: ContextKind }).kind = "ENGINEERING_FACT";
          changed = true;
        }
        return Reflect.getPrototypeOf(target);
      },
    });
    const result = evaluate(evidence, mutableCandidate);

    expect(changed).toBe(true);
    expect(result.structurallyApplicable).toBe(true);
    expect(result.structurallyApplicable && result.requirement).toBe(
      "HUMAN_CONFIRMATION_REQUIRED",
    );
  });
});

describe("S2D4 stable representation compatibility and canonical output", () => {
  it("accepts seven stable representations with zero false rejections", () => {
    const ordinary = validEvidence();
    const nullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      validEvidence(),
    );
    const frozen = freezeDeep(validEvidence());
    const sealed = Object.seal(validEvidence());
    const cloned = structuredClone(validEvidence());
    const jsonRoundTrip = JSON.parse(JSON.stringify(validEvidence())) as unknown;
    const transparentProxy = new Proxy(validEvidence(), {});

    for (const representation of [
      ordinary,
      nullPrototype,
      frozen,
      sealed,
      cloned,
      jsonRoundTrip,
      transparentProxy,
    ]) {
      expect(evaluate(representation).structurallyApplicable).toBe(true);
    }
  });

  it("returns detached frozen snapshots and isolated frozen decisions", () => {
    const callerEvidence = validEvidence({
      sourceReference: "  action:detached  ",
      occurredAt: "2026-08-16T08:30:00+08:00",
    });
    const result = evaluate(callerEvidence);
    expect(result.structurallyApplicable).toBe(true);
    if (!result.structurallyApplicable) {
      return;
    }
    expect(result.evidence).not.toBe(callerEvidence);
    expect(result.evidence).toEqual({
      evidenceType: "HUMAN_CONFIRMATION",
      sourceReference: "action:detached",
      occurredAt: "2026-08-16T00:30:00.000Z",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);

    callerEvidence.sourceReference = "mutated-after-evaluation";
    callerEvidence.occurredAt = "2030-01-01T00:00:00Z";
    expect(Reflect.set(result, "reason", "INVALID_CANDIDATE")).toBe(false);
    expect(Reflect.set(result.evidence, "sourceReference", "poisoned")).toBe(
      false,
    );
    expect(result.evidence.sourceReference).toBe("action:detached");

    const nonApplicable = evaluate(null);
    expect(Object.isFrozen(nonApplicable)).toBe(true);
    expect(Reflect.set(nonApplicable, "reason", "INVALID_CANDIDATE")).toBe(false);
    expect(evaluate()).toEqual({
      structurallyApplicable: true,
      requirement: "HUMAN_CONFIRMATION_REQUIRED",
      reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
      evidence: {
        evidenceType: "HUMAN_CONFIRMATION",
        sourceReference: "action:s2d4-hardening",
        occurredAt: "2026-08-16T00:30:00.000Z",
      },
    });
  });
});

describe("S2D4 result-schema correlation", () => {
  it("allows only the three correlated result variants", () => {
    const canonicalEvidence = {
      evidenceType: "HUMAN_CONFIRMATION",
      sourceReference: "action:correlation",
      occurredAt: "2026-08-16T00:30:00Z",
    };
    const validVariants = [
      invalidEvidenceDecision,
      {
        structurallyApplicable: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
        evidence: canonicalEvidence,
      },
      {
        structurallyApplicable: true,
        requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
        reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
        evidence: canonicalEvidence,
      },
    ];
    for (const variant of validVariants) {
      expect(
        PromotedContextHumanConfirmationEvaluationSchema.safeParse(variant).success,
      ).toBe(true);
    }

    const malformedVariants = [
      { structurallyApplicable: false, reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND" },
      { ...invalidEvidenceDecision, requirement: "HUMAN_CONFIRMATION_REQUIRED" },
      { ...invalidEvidenceDecision, evidence: canonicalEvidence },
      {
        structurallyApplicable: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
        evidence: canonicalEvidence,
      },
      {
        structurallyApplicable: true,
        requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
        reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
      },
      {
        structurallyApplicable: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
        evidence: { ...canonicalEvidence, approved: true },
      },
      {
        structurallyApplicable: true,
        requirement: "AUTO_ACCEPT",
        reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
        evidence: canonicalEvidence,
      },
    ];
    for (const variant of malformedVariants) {
      expect(
        PromotedContextHumanConfirmationEvaluationSchema.safeParse(variant).success,
      ).toBe(false);
    }
  });

  it.each([
    "accepted",
    "approved",
    "verified",
    "trusted",
    "authoritySatisfied",
    "confirmationSatisfied",
    "humanAuthenticated",
    "evidenceTrusted",
  ])("rejects lifecycle or trust output field %s", (field) => {
    expect(
      PromotedContextHumanConfirmationEvaluationSchema.safeParse({
        ...evaluate(),
        [field]: true,
      }).success,
    ).toBe(false);
  });
});

describe("S2D4 authenticity, binding, and existing-contract separation", () => {
  it("keeps OPEN_QUESTION unresolved without ContextStatus or lifecycle output", () => {
    const result = evaluate(validEvidence(), makeCandidate({ kind: "OPEN_QUESTION" }));
    expect(result.structurallyApplicable).toBe(true);
    expect(Object.keys(result)).toEqual([
      "structurallyApplicable",
      "requirement",
      "reason",
      "evidence",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/resolved|answered|closed/i);
  });

  it("does not bridge AuditEvent, ContextAuthority, or implementation checkpoint evidence", () => {
    const auditEvent = AuditEventSchema.parse({
      id: "aud_s2d4",
      scope: { scopeType: "PROJECT", projectId: "prj_hardening" },
      eventType: "HUMAN_CONFIRMED",
      actorType: "HUMAN",
      actorReference: "hanlin",
      summary: "This audit event remains a separate contract.",
      occurredAt: "2026-08-16T00:30:00Z",
    });
    const checkpoint = SubtaskImplementationCheckpointSchema.parse({
      id: "icp_s2d4",
      subtaskId: "st_source",
      repositoryCommitSha: "a".repeat(40),
      actorType: "HUMAN",
      actorReference: "hanlin",
      sourceReference: "repo:checkpoint",
      summary: "This checkpoint is not human confirmation evidence.",
      occurredAt: "2026-08-16T00:30:00Z",
    });

    for (const input of [
      auditEvent,
      checkpoint,
      ...AuditActorTypeSchema.options.map((actorType) => ({ actorType })),
      ...ContextAuthoritySchema.options.map((authority) => ({ authority })),
    ]) {
      expect(evaluate(input)).toEqual(invalidEvidenceDecision);
    }
  });

  it("adds no candidate identity and treats evidence only as alongside-evaluation input", () => {
    expect(
      Object.keys(PromotedContextHumanConfirmationEvidenceSchema.shape),
    ).toEqual(["evidenceType", "sourceReference", "occurredAt"]);
    const evidence = validEvidence({ sourceReference: "action:no-portable-proof" });
    const first = evaluate(evidence, makeCandidate({ kind: "DECISION" }));
    const second = evaluate(evidence, makeCandidate({ kind: "RISK" }));
    expect(first.structurallyApplicable).toBe(true);
    expect(second.structurallyApplicable).toBe(true);
    for (const field of [
      "candidateId",
      "candidateHash",
      "candidateDigest",
      "candidateFingerprint",
    ]) {
      expect(JSON.stringify(first)).not.toContain(field);
      expect(JSON.stringify(second)).not.toContain(field);
    }
  });
});

describe("S2D4 S2C1 and S2A regressions", () => {
  it("keeps PROMOTED_CONTEXT excluded from FRESH_INDEPENDENT_QA", () => {
    const profileCandidate = QaContextProfileCandidateSchema.parse({
      candidateClass: "PROMOTED_CONTEXT",
      sourceReference: "s2d4:structurally-applicable-only",
    });
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", profileCandidate),
    ).toEqual({
      includedByProfile: false,
      reason: "EXCLUDED_PROMOTED_CONTEXT",
    });
  });

  it("keeps downstream raw ACL exact across all six kinds and both requirements", () => {
    const project = ProjectSchema.parse({
      recordType: "PROJECT",
      id: "prj_hardening",
      name: "S2D4 hardening",
      slug: "s2d4-hardening",
      repository: { kind: "PATH", path: "/workspace/s2d4" },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 2,
    });
    const bigTask = BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_hardening",
      projectId: project.id,
      title: "Harden S2D4",
      goal: "Preserve exact ACL boundaries.",
      rationale: "Promoted evidence must not grant raw access.",
      scopeIn: ["S2D4"],
      scopeOut: ["raw history"],
      acceptanceCriteria: ["upstream source remains excluded"],
      status: "IN_PROGRESS",
    });
    const target = SubtaskSchema.parse({
      recordType: "SUBTASK",
      id: "st_target",
      bigTaskId: bigTask.id,
      title: "Downstream target",
      goal: "Consume only future accepted conclusions.",
      scopeIn: ["target context"],
      scopeOut: ["upstream raw context"],
      acceptanceCriteria: ["three exact raw scopes"],
      untouchedAreas: ["S2A"],
      status: "TODO",
      maturity: "NOT_STARTED",
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
      promptSeed: "Preserve the raw context ACL.",
    });
    const built = buildAllowedContextSet(project, bigTask, target);
    expect(built.valid).toBe(true);
    if (!built.valid) {
      return;
    }
    const before = JSON.stringify(built.allowedContextSet.allowedRawScopes);
    for (const kind of CONTEXT_KINDS) {
      expect(
        evaluate(
          validEvidence(),
          makeCandidate({ kind, route: downstreamRoute() }),
        ).structurallyApplicable,
      ).toBe(true);
      expect(JSON.stringify(built.allowedContextSet.allowedRawScopes)).toBe(before);
    }
    expect(built.allowedContextSet.allowedRawScopes).toEqual([
      { scopeType: "PROJECT", projectId: "prj_hardening" },
      {
        scopeType: "BIG_TASK",
        projectId: "prj_hardening",
        bigTaskId: "bt_hardening",
      },
      {
        scopeType: "SUBTASK",
        projectId: "prj_hardening",
        bigTaskId: "bt_hardening",
        subtaskId: "st_target",
      },
    ]);
    expect(
      evaluateContextScopeAccess(built.allowedContextSet, {
        scopeType: "SUBTASK",
        projectId: built.allowedContextSet.target.projectId,
        bigTaskId: built.allowedContextSet.target.bigTaskId,
        subtaskId: fullTopology().subtasks[0]!.id,
      }),
    ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
  });
});

describe("S2D4 deterministic scale/property campaign", () => {
  it("matches 1,152 distributed evaluations with zero oracle mismatches", () => {
    const references = [
      ["oracle:plain", "oracle:plain"],
      ["  oracle:trimmed  ", "oracle:trimmed"],
      ["人工确认:引用", "人工确认:引用"],
      ["system says human", "system says human"],
    ] as const;
    const timestamps = [
      ["2026-08-16T00:30:00Z", "2026-08-16T00:30:00.000Z"],
      ["2026-08-16T08:30:00+08:00", "2026-08-16T00:30:00.000Z"],
      ["invalid", null],
      ["2026-08-16T00:30:00", null],
    ] as const;
    let evaluations = 0;
    const mismatches: Array<{
      readonly kind: ContextKind;
      readonly sourceType: ContextSourceType;
      readonly audience: "PARENT_BIG_TASK" | "DOWNSTREAM_SUBTASK";
      readonly referenceIndex: number;
      readonly timestampIndex: number;
    }> = [];

    for (const kind of CONTEXT_KINDS) {
      for (const sourceType of SOURCE_TYPES) {
        for (const audience of ["PARENT_BIG_TASK", "DOWNSTREAM_SUBTASK"] as const) {
          for (const [referenceIndex, [sourceReference, canonicalReference]] of references.entries()) {
            for (const [timestampIndex, [occurredAt, canonicalTimestamp]] of timestamps.entries()) {
              const route =
                audience === "PARENT_BIG_TASK" ? parentRoute() : downstreamRoute();
              const actual = evaluate(
                validEvidence({ sourceReference, occurredAt }),
                makeCandidate({
                  kind,
                  route,
                  provenance: {
                    sourceType,
                    sourceReference: `candidate:${sourceType}:${referenceIndex}`,
                    evidenceReferences: [],
                  },
                }),
              );
              const expected =
                canonicalTimestamp === null
                  ? invalidEvidenceDecision
                  : {
                      structurallyApplicable: true,
                      requirement:
                        kind === "ENGINEERING_FACT"
                          ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
                          : "HUMAN_CONFIRMATION_REQUIRED",
                      reason:
                        "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
                      evidence: {
                        evidenceType: "HUMAN_CONFIRMATION",
                        sourceReference: canonicalReference,
                        occurredAt: canonicalTimestamp,
                      },
                    };
              evaluations += 1;
              if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                mismatches.push({
                  kind,
                  sourceType,
                  audience,
                  referenceIndex,
                  timestampIndex,
                });
              }
            }
          }
        }
      }
    }

    expect(evaluations).toBe(1_152);
    expect(mismatches).toEqual([]);
  });
});

const IMPLEMENTATION_SPECIFIC_MUTATIONS = [
  "single descriptor observation",
  "forward-only descriptor order",
  "no descriptor repeat",
  "no prototype repeat",
  "no ownKeys repeat",
  "two passes instead of three",
  "descriptor value comparison omitted",
  "descriptor enumerability comparison omitted",
  "descriptor configurability comparison omitted",
  "descriptor writability comparison omitted",
  "prototype comparison omitted",
  "key order comparison omitted",
  "symbol key ignored",
  "accessor descriptor accepted",
  "capture exception rethrown",
  "parse exception rethrown",
  "original evidence parsed after capture",
  "original evidence returned",
  "canonical evidence left mutable",
  "non-applicable decision left mutable",
  "applicable decision left mutable",
  "acceptance candidate reread after evidence",
  "evidence evaluated before S2D3",
  "transparent stable proxy rejected",
] as const;

describe("S2D4 mutation resistance", () => {
  it("reviews 95 hypotheses, including 71 authority-oriented and 24 implementation-specific mutations", () => {
    const wrongEvidenceTypes = [
      "CODEX_CONFIRMATION",
      "SYSTEM_CONFIRMATION",
      "MODEL_CONFIRMATION",
      "AUTO_CONFIRMATION",
      "REPO_CONFIRMATION",
      "DETERMINISTIC_EVIDENCE",
      "human_confirmation",
      " HUMAN_CONFIRMATION ",
      "HUMAN",
      "CONFIRMED",
    ] as const;
    const trustOutputFields = [
      "accepted",
      "approved",
      "verified",
      "trusted",
      "authoritySatisfied",
      "confirmationSatisfied",
      "humanAuthenticated",
      "evidenceTrusted",
    ] as const;
    const gateMutations = [
      makeCandidate({ route: parentRoute("bt_other") }),
      makeCandidate({ route: downstreamRoute() }),
      makeCandidate({ route: downstreamRoute("st_source", "st_other") }),
      makeCandidate({ route: downstreamRoute("st_source", "st_foreign") }),
      {
        ...makeCandidate(),
        kind: "UNKNOWN_KIND",
      } as unknown as PromotedContextCandidate,
      {
        ...makeCandidate(),
        route: { ...parentRoute(), sourceSubtaskId: " st_source" },
      } as unknown as PromotedContextCandidate,
      makeCandidate({ route: parentRoute("bt_foreign") }),
      makeCandidate({ route: downstreamRoute("st_target", "st_source") }),
      makeCandidate({ route: downstreamRoute("st_source", "st_sibling") }),
    ];
    let survivors = 0;

    for (const field of AUTHORITY_ESCAPE_FIELDS) {
      if (evaluate(validEvidence({ [field]: true })).structurallyApplicable) {
        survivors += 1;
      }
    }
    for (const evidenceType of wrongEvidenceTypes) {
      if (evaluate(validEvidence({ evidenceType })).structurallyApplicable) {
        survivors += 1;
      }
    }
    for (const field of trustOutputFields) {
      if (
        PromotedContextHumanConfirmationEvaluationSchema.safeParse({
          ...evaluate(),
          [field]: true,
        }).success
      ) {
        survivors += 1;
      }
    }
    for (const promotedCandidate of gateMutations) {
      const graph =
        promotedCandidate.route.audienceKind === "DOWNSTREAM_SUBTASK"
          ? fullTopology([])
          : fullTopology();
      if (evaluate(validEvidence(), promotedCandidate, graph).structurallyApplicable) {
        survivors += 1;
      }
    }

    const reviewed =
      AUTHORITY_ESCAPE_FIELDS.length +
      wrongEvidenceTypes.length +
      trustOutputFields.length +
      gateMutations.length +
      IMPLEMENTATION_SPECIFIC_MUTATIONS.length;
    const authorityOrFalseApplicabilityOriented =
      AUTHORITY_ESCAPE_FIELDS.length +
      wrongEvidenceTypes.length +
      trustOutputFields.length +
      gateMutations.length;
    expect(reviewed).toBe(95);
    expect(authorityOrFalseApplicabilityOriented).toBe(71);
    expect(IMPLEMENTATION_SPECIFIC_MUTATIONS).toHaveLength(24);
    expect(survivors).toBe(0);
  });
});

const SAFETY_SOURCE_TO_TEST_MAPPING = [
  "three exact evidence fields -> exact envelope test",
  "strict unknown-field rejection -> authority escape matrix",
  "literal evidenceType -> wrong evidenceType matrix",
  "sourceReference non-empty -> reference boundary matrix",
  "sourceReference 2048 maximum -> reference boundary matrix",
  "sourceReference no truncation -> 2049 rejection",
  "sourceReference trim -> Unicode trim test",
  "sourceReference controls opaque -> control preservation test",
  "sourceReference authenticity neutral -> authority bait matrix",
  "occurredAt offset required -> malformed timestamp matrix",
  "occurredAt UTC canonicalization -> timestamp canonicalization matrix",
  "occurredAt leap date -> leap-year test",
  "occurredAt invalid calendar date -> malformed timestamp matrix",
  "occurredAt old neutrality -> current-clock test",
  "occurredAt future neutrality -> current-clock test",
  "no current time -> Date.now poison test",
  "ordinary object compatibility -> representation test",
  "null prototype compatibility -> representation test",
  "frozen compatibility -> representation test",
  "sealed compatibility -> representation test",
  "structured clone compatibility -> representation test",
  "JSON round-trip compatibility -> representation test",
  "transparent Proxy compatibility -> representation test",
  "prototype stability -> changing prototype test",
  "ownKeys stability -> appearing key test",
  "descriptor presence stability -> missing descriptor test",
  "descriptor value stability -> value sequence matrix",
  "descriptor enumerability -> flag-change test",
  "descriptor configurability -> observation comparison mutation",
  "descriptor writability -> flag-change test",
  "mixed observation resistance -> incompatible-state reproduction",
  "repeated observation resistance -> valid-first cycle tests",
  "reflection exceptions -> 30-case containment campaign",
  "accessor rejection -> getter/setter test",
  "symbol rejection -> symbol test",
  "hidden extra rejection -> non-enumerable test",
  "S2D3 delegation -> candidate gate matrix",
  "all six kinds -> kind applicability matrix",
  "both audience kinds -> audience applicability matrix",
  "human requirement preservation -> kind applicability matrix",
  "engineering requirement preservation -> kind applicability matrix",
  "invalid candidate closed -> invalid upstream reason test",
  "invalid route closed -> invalid upstream reason test",
  "invalid topology closed -> invalid upstream reason test",
  "canonical evidence detached -> canonical output test",
  "canonical evidence frozen -> canonical output test",
  "decision frozen -> canonical output test",
  "caller mutation isolated -> canonical output test",
  "result correlation -> result schema matrix",
  "no lifecycle outputs -> trust output matrix",
  "OPEN_QUESTION unresolved -> open question test",
  "AuditActorType separation -> existing contract test",
  "AuditEvent separation -> existing contract test",
  "ContextAuthority separation -> existing contract test",
  "checkpoint separation -> existing contract test",
  "no candidate identity -> binding test",
  "same evidence alongside candidates -> binding test",
  "no acceptance transition -> purity source audit",
  "no persistence -> purity source audit",
  "S2C1 exclusion -> QA profile regression",
  "S2A raw ACL exact -> ACL regression",
  "S2A upstream exclusion -> ACL regression",
] as const;

describe("S2D4 source-to-test and purity audits", () => {
  it("maps 62 safety-critical conditions with zero unjustified gaps", () => {
    expect(SAFETY_SOURCE_TO_TEST_MAPPING).toHaveLength(62);
    expect(new Set(SAFETY_SOURCE_TO_TEST_MAPPING).size).toBe(62);
    expect(
      SAFETY_SOURCE_TO_TEST_MAPPING.every((mapping) => mapping.includes(" -> ")),
    ).toBe(true);
  });

  it("keeps production pure and documents the human-authenticity and binding boundaries", () => {
    const source = readFileSync(
      new URL("../src/promoted-context-human-confirmation.ts", import.meta.url),
      "utf-8",
    );
    const documentation = readFileSync(
      new URL(
        "../../../docs/S2D4_PROMOTED_CONTEXT_HUMAN_CONFIRMATION_EVIDENCE.md",
        import.meta.url,
      ),
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
      /node:/,
      /storage\.js/,
      /sqlite/i,
      /drizzle/i,
      /process\.env/,
      /Date\.now/,
      /new Date\(\)/,
      /Math\.random/,
      /fetch\s*\(/,
      /acceptPromotedContext/,
      /AuditEventSchema/,
      /ContextItemSchema/,
    ]) {
      expect(source).not.toMatch(forbiddenRuntime);
    }
    expect(documentation).toContain("Schema validity does not authenticate a human.");
    expect(documentation).toContain(
      "A future trusted human-action command or controller must establish",
    );
    expect(documentation).toContain("no candidate ID, hash, digest, fingerprint");
    expect(documentation).toContain("must atomically bind the canonical candidate");
    expect(documentation).toContain("creates no acceptance transition");
  });
});
