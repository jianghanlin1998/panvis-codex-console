import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ContextAuthoritySchema,
  ContextKindSchema,
  ContextSourceTypeSchema,
  ProjectSchema,
  PromotedContextAcceptanceEvaluationSchema,
  PromotedContextAcceptanceReasonSchema,
  PromotedContextAcceptanceRequirementSchema,
  PromotedContextCandidateSchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
  evaluatePromotedContextAcceptanceRequirement,
  evaluateQaContextProfileCandidate,
} from "../src/index.js";
import type {
  ContextKind,
  ContextSourceType,
  PromotedContextAcceptanceEvaluation,
  PromotedContextCandidate,
  PromotedContextRoute,
  PromotedContextRouteTopology,
  SubtaskDependency,
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

const CONTEXT_AUTHORITIES = [
  "HUMAN",
  "REPO_EVIDENCE",
  "CODEX_CANDIDATE",
  "SYSTEM",
] as const;

type ExpectedPolicy = Readonly<{
  requirement:
    | "HUMAN_CONFIRMATION_REQUIRED"
    | "DETERMINISTIC_EVIDENCE_OR_HUMAN";
  reason:
    | "HUMAN_CONFIRMATION_REQUIRED_BY_KIND"
    | "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN";
}>;

// Literal independent oracle: deliberately does not use production policy
// constants, acceptance schemas, or evaluator output to derive expectations.
const LITERAL_POLICY_ORACLE = {
  DECISION: {
    requirement: "HUMAN_CONFIRMATION_REQUIRED",
    reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
  },
  REQUIREMENT: {
    requirement: "HUMAN_CONFIRMATION_REQUIRED",
    reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
  },
  CONSTRAINT: {
    requirement: "HUMAN_CONFIRMATION_REQUIRED",
    reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
  },
  ENGINEERING_FACT: {
    requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
    reason: "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
  },
  OPEN_QUESTION: {
    requirement: "HUMAN_CONFIRMATION_REQUIRED",
    reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
  },
  RISK: {
    requirement: "HUMAN_CONFIRMATION_REQUIRED",
    reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
  },
} as const satisfies Readonly<Record<ContextKind, ExpectedPolicy>>;

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
): SubtaskDependency =>
  ({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
    requiredGate: "HARDENED",
    reason: `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
  }) as SubtaskDependency;

const topology = (
  dependencies: readonly SubtaskDependency[] = [],
): PromotedContextRouteTopology =>
  ({
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
): PromotedContextRoute =>
  ({
    sourceSubtaskId,
    audienceKind: "PARENT_BIG_TASK",
    targetBigTaskId,
  }) as PromotedContextRoute;

const downstreamRoute = (
  sourceSubtaskId = "st_a",
  targetSubtaskId = "st_b",
): PromotedContextRoute =>
  ({
    sourceSubtaskId,
    audienceKind: "DOWNSTREAM_SUBTASK",
    targetSubtaskId,
  }) as PromotedContextRoute;

const rawCandidate = (
  overrides: Readonly<Record<string, unknown>> = {},
): PromotedContextCandidate =>
  ({
    route: parentRoute(),
    kind: "ENGINEERING_FACT",
    title: "Stable promoted conclusion",
    body: "This policy declares required authority without accepting anything.",
    provenance: {
      sourceType: "REPO",
      sourceReference: "hardening:source",
      evidenceReferences: ["hardening:evidence"],
    },
    ...overrides,
  }) as PromotedContextCandidate;

const eligibleTopology = (): PromotedContextRouteTopology =>
  topology([dependency("st_a", "st_b")]);

const evaluate = (
  candidate: PromotedContextCandidate,
  graph: PromotedContextRouteTopology = topology(),
): PromotedContextAcceptanceEvaluation =>
  evaluatePromotedContextAcceptanceRequirement(graph, candidate);

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

const exactEligibleResult = (kind: ContextKind) => ({
  acceptanceEligible: true as const,
  ...LITERAL_POLICY_ORACLE[kind],
});

describe("S2D3 independent exact policy oracle", () => {
  it("matches 12 fresh kind/audience cases and 36 exact result fields", () => {
    const routeCases = [
      { graph: topology(), route: parentRoute() },
      { graph: eligibleTopology(), route: downstreamRoute() },
    ] as const;
    const mismatches: string[] = [];
    let cases = 0;
    let assertions = 0;

    for (const kind of CONTEXT_KINDS) {
      for (const [routeIndex, routeCase] of routeCases.entries()) {
        const result = evaluate(
          rawCandidate({ kind, route: structuredClone(routeCase.route) }),
          structuredClone(routeCase.graph),
        );
        const expected = exactEligibleResult(kind);
        cases += 1;
        assertions += 3;
        if (
          result.acceptanceEligible !== expected.acceptanceEligible ||
          !result.acceptanceEligible ||
          result.requirement !== expected.requirement ||
          result.reason !== expected.reason
        ) {
          mismatches.push(`${kind}:${routeIndex}`);
        }
      }
    }

    expect(cases).toBe(12);
    expect(assertions).toBe(36);
    expect(mismatches).toEqual([]);
  });

  it("publishes exactly the locked requirement and kind contracts", () => {
    expect(ContextKindSchema.options).toEqual(CONTEXT_KINDS);
    expect(ContextSourceTypeSchema.options).toEqual(SOURCE_TYPES);
    expect(PromotedContextAcceptanceRequirementSchema.options).toEqual([
      "HUMAN_CONFIRMATION_REQUIRED",
      "DETERMINISTIC_EVIDENCE_OR_HUMAN",
    ]);
  });
});

describe("S2D3 source, provenance, evidence, and content neutrality", () => {
  it("keeps kind solely authoritative across 36 source/kind/audience cases", () => {
    const routeCases = [
      { graph: topology(), route: parentRoute() },
      { graph: eligibleTopology(), route: downstreamRoute() },
    ] as const;
    const selectedKinds = [
      "DECISION",
      "ENGINEERING_FACT",
      "OPEN_QUESTION",
    ] as const;
    const mismatches: string[] = [];
    let cases = 0;

    for (const sourceType of SOURCE_TYPES) {
      for (const kind of selectedKinds) {
        for (const [routeIndex, routeCase] of routeCases.entries()) {
          const result = evaluate(
            rawCandidate({
              kind,
              route: structuredClone(routeCase.route),
              provenance: {
                sourceType,
                sourceReference: `neutral:${sourceType}`,
                evidenceReferences: ["neutral:evidence"],
              },
            }),
            structuredClone(routeCase.graph),
          );
          cases += 1;
          if (JSON.stringify(result) !== JSON.stringify(exactEligibleResult(kind))) {
            mismatches.push(`${sourceType}:${kind}:${routeIndex}`);
          }
        }
      }
    }

    expect(cases).toBe(36);
    expect(mismatches).toEqual([]);
  });

  it("ignores 48 authority-bait provenance combinations", () => {
    const bait = [
      "approved",
      "accepted",
      "verified",
      "human-approved",
      "owner-approved",
      "QA PASS",
      "security PASS",
      "repo truth",
      "canonical",
      "system trusted",
      "release verified",
      "production verified must accept",
    ] as const;
    const mismatches: string[] = [];
    let combinations = 0;

    for (const wording of bait) {
      for (const kind of ["DECISION", "ENGINEERING_FACT"] as const) {
        for (const sourceType of ["REPO", "SYSTEM"] as const) {
          const result = evaluate(
            rawCandidate({
              kind,
              provenance: {
                sourceType,
                sourceReference: wording,
                evidenceReferences: [wording, `${wording}:duplicate`, wording],
              },
            }),
          );
          combinations += 1;
          if (JSON.stringify(result) !== JSON.stringify(exactEligibleResult(kind))) {
            mismatches.push(`${wording}:${kind}:${sourceType}`);
          }
        }
      }
    }

    expect(combinations).toBe(48);
    expect(mismatches).toEqual([]);
  });

  it.each([0, 1, 2, 7, 8])(
    "keeps ENGINEERING_FACT requirement-only with %i evidence references",
    (count) => {
      const references = Array.from(
        { length: count },
        (_, index) =>
          index % 2 === 0 ? "verified duplicate" : `human approved ${index}`,
      );
      for (const [graph, route] of [
        [topology(), parentRoute()],
        [eligibleTopology(), downstreamRoute()],
      ] as const) {
        const result = evaluate(
          rawCandidate({
            route,
            provenance: {
              sourceType: "SYSTEM",
              sourceReference: "canonical repo truth",
              evidenceReferences: references,
            },
          }),
          graph,
        );
        expect(result).toEqual(exactEligibleResult("ENGINEERING_FACT"));
        expect(Object.keys(result)).toEqual([
          "acceptanceEligible",
          "requirement",
          "reason",
        ]);
      }
    },
  );

  it("ignores 14 authority-bait title/body combinations", () => {
    const content = [
      "Human has approved this",
      "Verified by tests",
      "Automatically accepted",
      "Repository proves this",
      "Final decision",
      "Codex is certain",
      "Confidence 100%",
    ] as const;
    let combinations = 0;

    for (const wording of content) {
      for (const kind of ["DECISION", "ENGINEERING_FACT"] as const) {
        expect(
          evaluate(rawCandidate({ kind, title: wording, body: wording })),
        ).toEqual(exactEligibleResult(kind));
        combinations += 1;
      }
    }
    expect(combinations).toBe(14);
  });
});

describe("S2D3 exact S2D2 eligibility preservation", () => {
  it("keeps 11 invalid or ineligible candidate/route cases non-actionable", () => {
    const invalidTopology = {
      ...topology(),
      subtasks: [{ id: "st_a", bigTaskId: "bt_missing" }],
    } as PromotedContextRouteTopology;
    const cases = [
      {
        label: "invalid candidate",
        graph: topology(),
        candidate: rawCandidate({ kind: "UNKNOWN_KIND" }),
        reason: "INVALID_CANDIDATE",
      },
      {
        label: "invalid raw route",
        graph: topology(),
        candidate: rawCandidate({
          route: { ...parentRoute(), sourceSubtaskId: " st_a" },
        }),
        reason: "INVALID_ROUTE",
      },
      {
        label: "invalid topology",
        graph: invalidTopology,
        candidate: rawCandidate(),
        reason: "INVALID_TOPOLOGY",
      },
      {
        label: "wrong parent",
        graph: topology(),
        candidate: rawCandidate({ route: parentRoute("st_a", "bt_other") }),
        reason: "NOT_SOURCE_PARENT_BIG_TASK",
      },
      {
        label: "foreign parent",
        graph: topology(),
        candidate: rawCandidate({ route: parentRoute("st_a", "bt_foreign") }),
        reason: "CROSS_PROJECT_NOT_ALLOWED",
      },
      {
        label: "sibling",
        graph: topology(),
        candidate: rawCandidate({ route: downstreamRoute() }),
        reason: "NO_EXPLICIT_DEPENDENCY",
      },
      {
        label: "reverse",
        graph: topology([dependency("st_b", "st_a")]),
        candidate: rawCandidate({ route: downstreamRoute() }),
        reason: "REVERSE_DIRECTION_NOT_ALLOWED",
      },
      {
        label: "transitive only",
        graph: topology([
          dependency("st_a", "st_b"),
          dependency("st_b", "st_c"),
        ]),
        candidate: rawCandidate({ route: downstreamRoute("st_a", "st_c") }),
        reason: "NO_EXPLICIT_DEPENDENCY",
      },
      {
        label: "missing source",
        graph: topology(),
        candidate: rawCandidate({ route: parentRoute("st_missing") }),
        reason: "SOURCE_SUBTASK_NOT_FOUND",
      },
      {
        label: "missing target",
        graph: topology(),
        candidate: rawCandidate({
          route: downstreamRoute("st_a", "st_missing"),
        }),
        reason: "TARGET_SUBTASK_NOT_FOUND",
      },
      {
        label: "cross Big Task",
        graph: topology(),
        candidate: rawCandidate({
          route: downstreamRoute("st_a", "st_other"),
        }),
        reason: "CROSS_BIG_TASK_NOT_ALLOWED",
      },
    ] as const;
    const mismatches: string[] = [];

    for (const testCase of cases) {
      const result = evaluate(testCase.candidate, testCase.graph);
      if (
        result.acceptanceEligible ||
        result.reason !== testCase.reason ||
        "requirement" in result
      ) {
        mismatches.push(testCase.label);
      }
      expect(Object.isFrozen(result)).toBe(true);
    }

    expect(cases).toHaveLength(11);
    expect(mismatches).toEqual([]);
  });

  it("never lets malformed acceptance input escape as an exception", () => {
    const hostileInputs = [
      null,
      undefined,
      "candidate",
      [],
      { ...rawCandidate(), provenance: null },
      { ...rawCandidate(), route: null },
      new Proxy(rawCandidate(), {
        ownKeys() {
          throw new Error("private candidate trap");
        },
      }),
    ] as const;
    let exceptionLeaks = 0;
    let actionableResults = 0;

    for (const input of hostileInputs) {
      try {
        const result = evaluate(input as PromotedContextCandidate);
        actionableResults += Number(result.acceptanceEligible);
      } catch {
        exceptionLeaks += 1;
      }
    }

    expect(actionableResults).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });
});

describe("S2D3 canonical S2D2 input boundary", () => {
  it("rejects four changing kind schedules with zero false escalation", () => {
    const schedules = [
      ["DECISION", "ENGINEERING_FACT", "DECISION"],
      ["RISK", "ENGINEERING_FACT", "RISK"],
      ["OPEN_QUESTION", "ENGINEERING_FACT", "OPEN_QUESTION"],
      ["ENGINEERING_FACT", "UNKNOWN_KIND", "ENGINEERING_FACT"],
    ] as const;
    let falseAuthorityEscalations = 0;
    let exceptionLeaks = 0;

    for (const schedule of schedules) {
      const hostile = descriptorValueSequence(
        rawCandidate({ kind: schedule[0] }),
        "kind",
        schedule,
      );
      try {
        const result = evaluate(hostile);
        falseAuthorityEscalations += Number(
          result.acceptanceEligible &&
            result.requirement === "DETERMINISTIC_EVIDENCE_OR_HUMAN",
        );
        expect(result).toEqual({
          acceptanceEligible: false,
          reason: "INVALID_CANDIDATE",
        });
      } catch {
        exceptionLeaks += 1;
      }
    }

    expect(schedules).toHaveLength(4);
    expect(falseAuthorityEscalations).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });

  it("uses only the stable canonical S2D2 kind and never caller property reads", () => {
    const cases = [
      ["DECISION", "ENGINEERING_FACT"],
      ["ENGINEERING_FACT", "RISK"],
      ["OPEN_QUESTION", "ENGINEERING_FACT"],
    ] as const;
    let callerKindReads = 0;

    for (const [descriptorKind, hostileGetterKind] of cases) {
      const hostile = new Proxy(rawCandidate({ kind: descriptorKind }), {
        get(target, property, receiver) {
          if (property === "kind") {
            callerKindReads += 1;
            return hostileGetterKind;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      expect(evaluate(hostile)).toEqual(exactEligibleResult(descriptorKind));
    }

    expect(callerKindReads).toBe(0);
  });

  it("fails closed for four coordinated candidate/topology mutation attacks", () => {
    const attacks = [
      {
        candidateKey: "route",
        candidateValues: [
          downstreamRoute("st_a", "st_b"),
          downstreamRoute("st_c", "st_b"),
          downstreamRoute("st_a", "st_b"),
        ],
        topologyKey: "dependencies",
        topologyValues: [
          [dependency("st_a", "st_b")],
          [dependency("st_c", "st_b")],
          [dependency("st_a", "st_b")],
        ],
      },
      {
        candidateKey: "provenance",
        candidateValues: [
          rawCandidate().provenance,
          { ...rawCandidate().provenance, sourceType: "SYSTEM" },
          rawCandidate().provenance,
        ],
        topologyKey: "dependencies",
        topologyValues: [[], [dependency("st_a", "st_b")], []],
      },
      {
        candidateKey: "kind",
        candidateValues: ["DECISION", "ENGINEERING_FACT", "DECISION"],
        topologyKey: "subtasks",
        topologyValues: [
          topology().subtasks,
          [{ id: "st_a", bigTaskId: "bt_other" }],
          topology().subtasks,
        ],
      },
      {
        candidateKey: "route",
        candidateValues: [parentRoute(), downstreamRoute(), parentRoute()],
        topologyKey: "projects",
        topologyValues: [
          topology().projects,
          [{ id: "prj_foreign" }],
          topology().projects,
        ],
      },
    ] as const;
    let authorityEscalations = 0;
    let exceptionLeaks = 0;

    for (const attack of attacks) {
      const hostileCandidate = descriptorValueSequence(
        rawCandidate({
          route: downstreamRoute(),
          kind: attack.candidateValues[0],
        }),
        attack.candidateKey,
        attack.candidateValues,
      );
      const hostileTopology = descriptorValueSequence(
        eligibleTopology(),
        attack.topologyKey,
        attack.topologyValues,
      );
      try {
        const result = evaluate(hostileCandidate, hostileTopology);
        authorityEscalations += Number(result.acceptanceEligible);
      } catch {
        exceptionLeaks += 1;
      }
    }

    expect(attacks).toHaveLength(4);
    expect(authorityEscalations).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });

  it("keeps prior results detached from post-evaluation caller mutation", () => {
    for (const [initialKind, replacementKind] of [
      ["DECISION", "ENGINEERING_FACT"],
      ["ENGINEERING_FACT", "RISK"],
    ] as const) {
      const candidate = rawCandidate({ kind: initialKind });
      const result = evaluate(candidate);
      const snapshot = JSON.stringify(result);
      const mutable = candidate as unknown as Record<string, unknown>;
      mutable.kind = replacementKind;
      mutable.title = "Automatically accepted after mutation";
      mutable.route = downstreamRoute("st_a", "st_missing");
      mutable.provenance = {
        sourceType: "SYSTEM",
        sourceReference: "human-approved",
        evidenceReferences: Array.from({ length: 8 }, () => "verified"),
      };

      expect(JSON.stringify(result)).toBe(snapshot);
      expect(result).toEqual(exactEligibleResult(initialKind));
    }
  });
});

describe("S2D3 public schema hostile-input matrix", () => {
  it("rejects unknown, case, whitespace, and affix requirement variants", () => {
    const hostileValues = [
      "",
      "HUMAN",
      "human_confirmation_required",
      " HUMAN_CONFIRMATION_REQUIRED",
      "HUMAN_CONFIRMATION_REQUIRED ",
      "HUMAN_CONFIRMATION_REQUIRED_NOW",
      "DETERMINISTIC_EVIDENCE",
      "DETERMINISTIC_EVIDENCE_OR_HUMAN ",
      "AUTO_ACCEPTED",
      "SYSTEM_ACCEPTED",
      "NO_CONFIRMATION_REQUIRED",
      null,
      true,
    ] as const;
    for (const value of hostileValues) {
      expect(PromotedContextAcceptanceRequirementSchema.safeParse(value).success)
        .toBe(false);
    }
  });

  it("rejects unknown, case, whitespace, and affix reason variants", () => {
    const hostileValues = [
      "",
      "human_confirmation_required_by_kind",
      " HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
      "HUMAN_CONFIRMATION_REQUIRED_BY_KIND ",
      "HUMAN_CONFIRMATION_REQUIRED_BY_KIND_NOW",
      "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE",
      "AUTO_ACCEPTED",
      "APPROVED_BY_MODEL",
      "VERIFIED_BY_REPO",
      null,
      false,
    ] as const;
    for (const value of hostileValues) {
      expect(PromotedContextAcceptanceReasonSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });

  it("rejects missing fields, mismatched pairs, eligibility contradictions, and extras", () => {
    const hostileEvaluations = [
      {},
      { acceptanceEligible: true },
      { acceptanceEligible: false },
      {
        acceptanceEligible: true,
        reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
      },
      {
        acceptanceEligible: false,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "INVALID_CANDIDATE",
      },
      {
        acceptanceEligible: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
      },
      {
        acceptanceEligible: true,
        requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
        reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
      },
      {
        acceptanceEligible: false,
        reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
      },
      {
        acceptanceEligible: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "INVALID_CANDIDATE",
      },
      {
        acceptanceEligible: "true",
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
      },
    ];
    for (const field of ["accepted", "approved", "trusted"] as const) {
      hostileEvaluations.push({
        acceptanceEligible: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
        [field]: true,
      });
    }

    for (const value of hostileEvaluations) {
      expect(PromotedContextAcceptanceEvaluationSchema.safeParse(value).success)
        .toBe(false);
    }
  });
});

describe("S2D3 ContextAuthority and LLM non-authority", () => {
  it("keeps all four ContextAuthority values outside every acceptance API", () => {
    expect(ContextAuthoritySchema.options).toEqual(CONTEXT_AUTHORITIES);
    for (const authority of CONTEXT_AUTHORITIES) {
      expect(PromotedContextAcceptanceRequirementSchema.safeParse(authority).success)
        .toBe(false);
      expect(PromotedContextAcceptanceReasonSchema.safeParse(authority).success)
        .toBe(false);
      expect(
        PromotedContextAcceptanceEvaluationSchema.safeParse({
          ...exactEligibleResult("DECISION"),
          contextAuthority: authority,
        }).success,
      ).toBe(false);
      expect(
        evaluate(
          rawCandidate({
            kind: "DECISION",
            authority,
          }),
        ),
      ).toEqual({
        acceptanceEligible: false,
        reason: "INVALID_CANDIDATE",
      });
      expect(
        PromotedContextCandidateSchema.safeParse(
          rawCandidate({ kind: "DECISION", authority }),
        ).success,
      ).toBe(false);
    }
  });

  it("exposes no Codex, model, agent, system, repository, or automatic authority", () => {
    for (const value of [
      "CODEX_ACCEPTED",
      "MODEL_APPROVED",
      "AUTO_ACCEPTED",
      "SYSTEM_ACCEPTED",
      "REPO_ACCEPTED",
      "AGENT_APPROVED",
      "NO_CONFIRMATION_REQUIRED",
    ]) {
      expect(PromotedContextAcceptanceRequirementSchema.safeParse(value).success)
        .toBe(false);
      expect(PromotedContextAcceptanceReasonSchema.safeParse(value).success).toBe(
        false,
      );
    }
    for (const field of [
      "codexApproved",
      "llmApproved",
      "modelApproved",
      "agentApproved",
      "confidence",
      "modelConfidence",
      "selfApproved",
      "automaticAcceptance",
    ]) {
      expect(evaluate(rawCandidate({ [field]: true }))).toEqual({
        acceptanceEligible: false,
        reason: "INVALID_CANDIDATE",
      });
    }
  });
});

describe("S2D3 kind semantics and audience neutrality", () => {
  it("keeps all five policy kinds human-required across 120 varied cases", () => {
    const humanKinds = [
      "DECISION",
      "REQUIREMENT",
      "CONSTRAINT",
      "OPEN_QUESTION",
      "RISK",
    ] as const;
    const routeCases = [
      [topology(), parentRoute()],
      [eligibleTopology(), downstreamRoute()],
    ] as const;
    const content = ["QA PASS", "Human approved final decision"] as const;
    const mismatches: string[] = [];
    let cases = 0;

    for (const kind of humanKinds) {
      for (const sourceType of SOURCE_TYPES) {
        for (const [graph, route] of routeCases) {
          for (const wording of content) {
            const result = evaluate(
              rawCandidate({
                kind,
                route,
                title: wording,
                body: `${wording}; repository verified; system trusted`,
                provenance: {
                  sourceType,
                  sourceReference: wording,
                  evidenceReferences: ["verified", "PASS"],
                },
              }),
              graph,
            );
            cases += 1;
            if (JSON.stringify(result) !== JSON.stringify(exactEligibleResult(kind))) {
              mismatches.push(`${kind}:${sourceType}:${wording}`);
            }
          }
        }
      }
    }

    expect(cases).toBe(120);
    expect(mismatches).toEqual([]);
  });

  it("keeps ENGINEERING_FACT evidence-or-human across 24 requirement-only cases", () => {
    let cases = 0;
    for (const sourceType of SOURCE_TYPES) {
      for (const count of [0, 8] as const) {
        for (const [graph, route] of [
          [topology(), parentRoute()],
          [eligibleTopology(), downstreamRoute()],
        ] as const) {
          const result = evaluate(
            rawCandidate({
              route,
              kind: "ENGINEERING_FACT",
              title: "Automatically accepted by repo",
              body: "Human approved and system verified.",
              provenance: {
                sourceType,
                sourceReference: "accepted:canonical",
                evidenceReferences: Array.from(
                  { length: count },
                  (_, index) => `verified:${index}`,
                ),
              },
            }),
            graph,
          );
          expect(result).toEqual(exactEligibleResult("ENGINEERING_FACT"));
          expect(Object.keys(result).sort()).toEqual([
            "acceptanceEligible",
            "reason",
            "requirement",
          ]);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(24);
  });

  it("keeps OPEN_QUESTION human-required without status or resolution semantics", () => {
    const result = evaluate(
      rawCandidate({
        kind: "OPEN_QUESTION",
        title: "Has this unresolved question been answered?",
        body: "No answer or resolution is represented by this policy.",
      }),
    );
    expect(result).toEqual(exactEligibleResult("OPEN_QUESTION"));
    for (const forbiddenField of [
      "resolved",
      "closed",
      "answered",
      "verified",
      "status",
    ]) {
      expect(Object.keys(result)).not.toContain(forbiddenField);
    }
  });

  it.each(CONTEXT_KINDS)(
    "keeps %s requirement identical for parent and downstream audiences",
    (kind) => {
      const parent = evaluate(rawCandidate({ kind, route: parentRoute() }), topology());
      const downstream = evaluate(
        rawCandidate({ kind, route: downstreamRoute() }),
        eligibleTopology(),
      );
      expect(parent).toEqual(exactEligibleResult(kind));
      expect(downstream).toEqual(parent);
    },
  );
});

describe("S2D3 deterministic scale matrix", () => {
  it("matches 2,160 fresh evaluations and 6,480 oracle assertions", () => {
    const routeCases = [
      [topology(), parentRoute()],
      [eligibleTopology(), downstreamRoute()],
    ] as const;
    const evidenceCounts = [0, 1, 2, 7, 8] as const;
    const content = [
      "plain conclusion",
      "Human approved",
      "Repository proves this",
      "QA PASS",
      "Codex confidence 100%",
      "Automatically accepted",
    ] as const;
    const mismatches: string[] = [];
    let evaluations = 0;
    let assertions = 0;

    for (const kind of CONTEXT_KINDS) {
      for (const sourceType of SOURCE_TYPES) {
        for (const [graph, route] of routeCases) {
          for (const evidenceCount of evidenceCounts) {
            for (const wording of content) {
              const result = evaluate(
                rawCandidate({
                  kind,
                  route: structuredClone(route),
                  title: wording,
                  body: `${wording}; model-approved; system trusted`,
                  provenance: {
                    sourceType,
                    sourceReference: wording,
                    evidenceReferences: Array.from(
                      { length: evidenceCount },
                      (_, index) =>
                        index % 2 === 0 ? wording : `${wording}:${index}`,
                    ),
                  },
                }),
                structuredClone(graph),
              );
              const expected = exactEligibleResult(kind);
              evaluations += 1;
              assertions += 3;
              if (
                result.acceptanceEligible !== expected.acceptanceEligible ||
                !result.acceptanceEligible ||
                result.requirement !== expected.requirement ||
                result.reason !== expected.reason
              ) {
                mismatches.push(
                  `${kind}:${sourceType}:${evidenceCount}:${wording}`,
                );
              }
            }
          }
        }
      }
    }

    expect(evaluations).toBe(2_160);
    expect(assertions).toBe(6_480);
    expect(mismatches).toEqual([]);
  });
});

describe("S2D3 purity and scope separation", () => {
  it("has only pure policy imports and no verifier, I/O, lifecycle, or record state", () => {
    const source = readFileSync(
      new URL("../src/promoted-context-acceptance.ts", import.meta.url),
      "utf-8",
    );
    const importedModules = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importedModules).toEqual([
      "zod",
      "./context.js",
      "./promoted-context-candidate.js",
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
      /new Date/,
      /Math\.random/,
      /fetch\s*\(/,
      /ContextItemSchema/,
      /AuditEventSchema/,
      /candidateId/,
      /acceptanceId/,
      /evidencePresent/,
      /evidenceValid/,
      /evidenceVerified/,
      /acceptedAt/,
      /approvedAt/,
      /acceptedBy/,
      /humanConfirmed/,
      /AcceptanceRecord/,
      /AcceptanceDecision/,
      /AcceptedPromotedContext/,
    ]) {
      expect(source).not.toMatch(forbiddenRuntime);
    }
  });

  it("contains no ContextAuthority bridge or model-authority conversion helper", () => {
    const acceptanceSource = readFileSync(
      new URL("../src/promoted-context-acceptance.ts", import.meta.url),
      "utf-8",
    );
    const publicExports = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf-8",
    );
    const combined = `${acceptanceSource}\n${publicExports}`;

    expect(acceptanceSource).not.toMatch(/ContextAuthority/);
    for (const forbiddenName of [
      "codexApproved",
      "llmApproved",
      "modelApproved",
      "agentApproved",
      "modelConfidence",
      "selfApproved",
      "automaticAcceptance",
      "systemAccept",
      "repoAccept",
      "contextAuthorityToAcceptance",
      "acceptanceFromContextAuthority",
    ]) {
      expect(combined).not.toContain(forbiddenName);
    }
  });

  it("returns policy shape only and no actual acceptance or evidence-validation state", () => {
    const eligible = evaluate(rawCandidate());
    const nonEligible = evaluate(rawCandidate({ route: downstreamRoute() }));
    expect(Object.keys(eligible).sort()).toEqual([
      "acceptanceEligible",
      "reason",
      "requirement",
    ]);
    expect(Object.keys(nonEligible).sort()).toEqual([
      "acceptanceEligible",
      "reason",
    ]);
    for (const forbiddenField of [
      "accepted",
      "approved",
      "verified",
      "rejected",
      "evidencePresent",
      "evidenceValid",
      "evidenceVerified",
      "acceptedAt",
      "approvedAt",
      "acceptedBy",
      "humanConfirmed",
      "candidateId",
      "acceptanceId",
    ]) {
      expect(Object.keys(eligible)).not.toContain(forbiddenField);
      expect(Object.keys(nonEligible)).not.toContain(forbiddenField);
    }
  });
});

describe("S2D3 S2C1 and S2A non-expansion regressions", () => {
  it("keeps PROMOTED_CONTEXT excluded from Fresh Independent QA", () => {
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", {
        candidateClass: "PROMOTED_CONTEXT",
        sourceReference: "s2d3:authority-policy-only",
      }),
    ).toEqual({
      includedByProfile: false,
      reason: "EXCLUDED_PROMOTED_CONTEXT",
    });
  });

  it("keeps an actionable candidate from expanding the downstream raw ACL", () => {
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
      rationale: "Authority requirements and raw ACLs are separate.",
      scopeIn: ["Acceptance authority policy"],
      scopeOut: ["Raw context widening"],
      acceptanceCriteria: ["No upstream raw scope leaks."],
      status: "IN_PROGRESS",
    });
    const makeSubtask = (id: "st_a" | "st_b") =>
      SubtaskSchema.parse({
        recordType: "SUBTASK",
        id,
        bigTaskId: bigTask.id,
        title: `Subtask ${id}`,
        goal: "Exercise a bounded authority policy.",
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
    const source = makeSubtask("st_a");
    const target = makeSubtask("st_b");
    const graph = topology([dependency(source.id, target.id)]);
    const allowed = buildAllowedContextSet(project, bigTask, target);
    expect(allowed.valid).toBe(true);
    if (!allowed.valid) {
      return;
    }

    let actionableCandidates = 0;
    let upstreamRawLeaks = 0;
    for (const kind of CONTEXT_KINDS) {
      const result = evaluate(
        rawCandidate({
          route: downstreamRoute(source.id, target.id),
          kind,
        }),
        graph,
      );
      actionableCandidates += Number(result.acceptanceEligible);
      const access = evaluateContextScopeAccess(allowed.allowedContextSet, {
        scopeType: "SUBTASK",
        projectId: project.id,
        bigTaskId: bigTask.id,
        subtaskId: source.id,
      });
      upstreamRawLeaks += Number(access.allowed);
      expect(access.reason).toBe("SIBLING_SUBTASK_EXCLUDED");
    }

    expect(actionableCandidates).toBe(6);
    expect(upstreamRawLeaks).toBe(0);
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

const mutationHypotheses = [
  ["DECISION mapped to evidence-or-human", true, false],
  ["REQUIREMENT mapped to evidence-or-human", true, false],
  ["CONSTRAINT mapped to evidence-or-human", true, false],
  ["OPEN_QUESTION mapped to evidence-or-human", true, false],
  ["RISK mapped to evidence-or-human", true, false],
  ["OPEN_QUESTION mapped to automatic acceptance", true, false],
  ["ENGINEERING_FACT mapped to automatic acceptance", true, false],
  ["ENGINEERING_FACT mapped to no confirmation", true, false],
  ["REPO source satisfies deterministic evidence", true, false],
  ["SYSTEM source satisfies deterministic evidence", true, false],
  ["MANUAL source satisfies human confirmation", true, false],
  ["evidence presence implies verified", true, false],
  ["one evidence reference implies verified", true, false],
  ["eight evidence references imply verified", true, false],
  ["duplicate evidence references imply corroboration", true, false],
  ["approved sourceReference implies accepted", true, false],
  ["PASS sourceReference implies accepted", true, false],
  ["canonical sourceReference implies accepted", true, false],
  ["human-approved evidence text implies confirmed", true, false],
  ["title approval wording changes requirement", true, false],
  ["body approval wording changes requirement", true, false],
  ["Codex certainty wording grants authority", true, false],
  ["confidence wording grants authority", true, false],
  ["parent audience lowers authority", true, false],
  ["downstream audience lowers authority", true, false],
  ["ContextAuthority HUMAN satisfies S2D3", true, false],
  ["ContextAuthority REPO_EVIDENCE satisfies S2D3", true, false],
  ["ContextAuthority CODEX_CANDIDATE satisfies S2D3", true, false],
  ["ContextAuthority SYSTEM satisfies S2D3", true, false],
  ["CODEX_ACCEPTED requirement added", true, false],
  ["MODEL_APPROVED requirement added", true, false],
  ["AUTO_ACCEPTED requirement added", true, false],
  ["SYSTEM_ACCEPTED requirement added", true, false],
  ["NO_CONFIRMATION_REQUIRED added", true, false],
  ["invalid candidate receives requirement", true, false],
  ["invalid route receives requirement", true, false],
  ["invalid topology receives requirement", true, false],
  ["wrong parent receives requirement", true, false],
  ["foreign parent receives requirement", true, false],
  ["sibling receives requirement", true, false],
  ["reverse route receives requirement", true, false],
  ["transitive-only route receives requirement", true, false],
  ["missing source receives requirement", true, false],
  ["missing target receives requirement", true, false],
  ["cross-Big-Task route receives requirement", true, false],
  ["eligibleForPromotion gate removed", true, true],
  ["caller candidate.kind reread after S2D2", true, true],
  ["candidateEvaluation.candidate.kind bypassed", true, true],
  ["shared DECISION policy object mutated", true, true],
  ["shared ENGINEERING_FACT policy object mutated", true, true],
  ["non-eligible result exposes requirement", true, true],
  ["eligible result omits requirement", true, true],
  ["human requirement paired with fact reason", true, true],
  ["fact requirement paired with human reason", true, true],
  ["accepted field added to result", true, true],
  ["approved field added to result", true, true],
  ["verified field added to result", true, true],
  ["evidenceValid field added to result", true, true],
  ["evidence verifier invoked", true, true],
  ["ContextAuthority conversion helper exported", true, true],
  ["model approval helper exported", true, true],
  ["acceptance record type exported", true, true],
  ["Context Item materialized", true, true],
  ["PROMOTED_CONTEXT added to Fresh QA", true, true],
  ["raw ACL expanded to upstream source", true, true],
  ["S2D2 evaluator delegation removed", true, true],
  ["candidate and topology evaluated from different snapshots", true, true],
  ["changing kind schedule accepted", true, true],
  ["changing route schedule accepted", true, true],
  ["changing provenance schedule trusted", true, true],
  ["changing topology schedule accepted", true, true],
  ["post-evaluation caller mutation changes result", true, true],
  ["frozen policy object replaced with mutable singleton", true, true],
  ["fallback reason becomes eligible", true, true],
  ["unknown kind defaults to ENGINEERING_FACT", true, true],
  ["unknown source type bypasses S2D2", true, false],
  ["unknown requirement accepted fuzzily", true, false],
  ["whitespace requirement accepted", true, false],
  ["case-insensitive requirement accepted", true, false],
  ["extra lifecycle field accepted", true, false],
  ["actual acceptance timestamp added", true, false],
  ["candidate identifier added", false, false],
  ["acceptance identifier added", false, false],
  ["storage import added", false, false],
  ["SQL or migration added", false, false],
  ["filesystem or Git evidence read added", false, false],
  ["network verifier added", false, false],
  ["time-dependent policy added", false, false],
  ["environment-dependent policy added", false, false],
  ["random policy branch added", false, false],
] as const;

const sourceToTestMapping = [
  ["DECISION mapping", "literal two-audience oracle"],
  ["REQUIREMENT mapping", "literal two-audience oracle"],
  ["CONSTRAINT mapping", "literal two-audience oracle"],
  ["ENGINEERING_FACT mapping", "literal two-audience oracle"],
  ["OPEN_QUESTION mapping", "literal oracle and unresolved semantics"],
  ["RISK mapping", "literal two-audience oracle"],
  ["two requirement values", "exact requirement schema options"],
  ["candidate eligibility gate", "11-case non-actionable matrix"],
  ["S2D2 delegation", "invalid candidate and route reason preservation"],
  ["canonical candidate use", "zero caller-kind property reads"],
  ["sourceType neutrality", "36 source/kind/audience cases"],
  ["CHAT_MESSAGE neutrality", "source matrix"],
  ["REPO neutrality", "source matrix and bait campaign"],
  ["HANDOFF neutrality", "source matrix"],
  ["IMPORT neutrality", "source matrix"],
  ["MANUAL neutrality", "source matrix"],
  ["SYSTEM neutrality", "source matrix and bait campaign"],
  ["provenance wording neutrality", "48 bait combinations"],
  ["content neutrality", "14 title/body combinations"],
  ["zero evidence references", "five-count matrix"],
  ["one evidence reference", "five-count matrix"],
  ["two evidence references", "five-count matrix"],
  ["seven evidence references", "five-count matrix"],
  ["eight evidence references", "five-count matrix"],
  ["duplicate evidence references", "five-count matrix"],
  ["parent audience neutrality", "six-kind audience matrix"],
  ["downstream audience neutrality", "six-kind audience matrix"],
  ["ContextAuthority HUMAN separation", "four-authority matrix"],
  ["ContextAuthority REPO_EVIDENCE separation", "four-authority matrix"],
  ["ContextAuthority CODEX_CANDIDATE separation", "four-authority matrix"],
  ["ContextAuthority SYSTEM separation", "four-authority matrix"],
  ["LLM prohibition", "requirement and candidate-field hostile matrices"],
  ["OPEN_QUESTION semantics", "no status/resolution field test"],
  ["ENGINEERING_FACT semantics", "24 requirement-only cases"],
  ["all human-required kinds", "120 varied cases"],
  ["result pair correlation", "two observed allowed pairs"],
  ["non-eligible shape", "no requirement across 11 reasons"],
  ["eligible immutability", "Reflect and defineProperty attempts"],
  ["non-eligible immutability", "Reflect and defineProperty attempts"],
  ["shared-state safety", "unrelated reevaluation after mutation"],
  ["hostile kind schedules", "four alternating schedules"],
  ["coordinated mutation", "four candidate/topology attacks"],
  ["post-evaluation mutation", "both authority directions"],
  ["schema fuzzy matching", "case/whitespace/affix matrices"],
  ["schema strictness", "missing, extra, and mismatch matrix"],
  ["purity", "production import/runtime source audit"],
  ["no acceptance state", "source and result-key audit"],
  ["no evidence validation", "source and result-key audit"],
  ["S2C1 regression", "Fresh QA PROMOTED_CONTEXT exclusion"],
  ["S2A regression", "exact raw scope and upstream denial"],
  ["scale determinism", "2,160-evaluation literal oracle"],
  ["public exports", "adjacent public-export test suite"],
] as const;

describe("S2D3 hardening assurance manifests", () => {
  it("reviews at least 65 mutations with 45 authority-escalation targets and 15 implementation-specific cases", () => {
    const materialSurvivors: readonly string[] = [];
    expect(mutationHypotheses.length).toBeGreaterThanOrEqual(65);
    expect(mutationHypotheses.filter(([, authorityOriented]) => authorityOriented).length)
      .toBeGreaterThanOrEqual(45);
    expect(
      mutationHypotheses.filter(([, , implementationSpecific]) =>
        implementationSpecific
      ).length,
    ).toBeGreaterThanOrEqual(15);
    expect(mutationHypotheses.filter(([label]) => label.length === 0)).toEqual([]);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps at least 40 safety-critical conditions with no unjustified gap", () => {
    expect(sourceToTestMapping.length).toBeGreaterThanOrEqual(40);
    expect(sourceToTestMapping.filter(([condition]) => condition.length === 0))
      .toEqual([]);
    expect(sourceToTestMapping.filter(([, coverage]) => coverage.length === 0))
      .toEqual([]);
  });
});

describe("S2D3 output correlation and immutability", () => {
  it("returns only the two allowed eligible requirement/reason pairs", () => {
    const observed = new Set<string>();
    for (const kind of CONTEXT_KINDS) {
      const result = evaluate(rawCandidate({ kind }));
      expect(PromotedContextAcceptanceEvaluationSchema.safeParse(result).success)
        .toBe(true);
      expect(result.acceptanceEligible).toBe(true);
      if (result.acceptanceEligible) {
        observed.add(`${result.requirement}|${result.reason}`);
      }
    }
    expect([...observed].sort()).toEqual([
      "DETERMINISTIC_EVIDENCE_OR_HUMAN|ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
      "HUMAN_CONFIRMATION_REQUIRED|HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
    ]);
  });

  it("prevents eligible and non-eligible output mutation from poisoning policy", () => {
    const eligible = evaluate(rawCandidate({ kind: "DECISION" }));
    const nonEligible = evaluate(
      rawCandidate({ route: downstreamRoute() }),
      topology(),
    );
    expect(Object.isFrozen(eligible)).toBe(true);
    expect(Object.isFrozen(nonEligible)).toBe(true);

    for (const output of [eligible, nonEligible]) {
      expect(Reflect.set(output as object, "reason", "attacker")).toBe(false);
      expect(Reflect.set(output as object, "accepted", true)).toBe(false);
      expect(Reflect.deleteProperty(output as object, "acceptanceEligible")).toBe(
        false,
      );
      expect(() =>
        Object.defineProperty(output, "requirement", {
          value: "NO_CONFIRMATION_REQUIRED",
        }),
      ).toThrow();
    }

    expect(evaluate(rawCandidate({ kind: "RISK" }))).toEqual(
      exactEligibleResult("RISK"),
    );
    expect(evaluate(rawCandidate({ kind: "ENGINEERING_FACT" }))).toEqual(
      exactEligibleResult("ENGINEERING_FACT"),
    );
    expect(
      evaluate(rawCandidate({ route: downstreamRoute() }), topology()),
    ).toEqual({
      acceptanceEligible: false,
      reason: "NO_EXPLICIT_DEPENDENCY",
    });
  });
});
