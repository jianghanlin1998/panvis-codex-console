import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ContextAuthoritySchema,
  ContextKindSchema,
  ContextSourceTypeSchema,
  PromotedContextAcceptanceEvaluationSchema,
  PromotedContextAcceptanceReasonSchema,
  PromotedContextAcceptanceRequirementSchema,
  PromotedContextCandidateSchema,
  PromotedContextRouteSchema,
  PromotedContextRouteTopologySchema,
  SubtaskDependencySchema,
  evaluatePromotedContextAcceptanceRequirement,
  evaluateQaContextProfileCandidate,
} from "../src/index.js";
import type {
  ContextKind,
  PromotedContextAcceptanceRequirement,
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
  title: "Acceptance authority is deterministic",
  body: "The candidate remains unaccepted by this policy evaluation.",
  provenance: {
    sourceType: "REPO",
    sourceReference: "packages/domain/src/promoted-context-acceptance.ts",
    evidenceReferences: [
      "packages/domain/test/promoted-context-acceptance.test.ts",
    ],
  },
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}): PromotedContextCandidate =>
  PromotedContextCandidateSchema.parse(candidateInput(overrides));

const expectedRequirement = (
  kind: ContextKind,
): PromotedContextAcceptanceRequirement =>
  kind === "ENGINEERING_FACT"
    ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
    : "HUMAN_CONFIRMATION_REQUIRED";

const deepFreeze = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
};

describe("S2D3 closed public acceptance-authority contract", () => {
  it("exposes exactly the two approved requirements and stable closed reasons", () => {
    expect(PromotedContextAcceptanceRequirementSchema.options).toEqual([
      "HUMAN_CONFIRMATION_REQUIRED",
      "DETERMINISTIC_EVIDENCE_OR_HUMAN",
    ]);
    expect(PromotedContextAcceptanceReasonSchema.options).toEqual([
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
      "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
      "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
    ]);
  });

  it("keeps result variants correlated and rejects lifecycle or approval fields", () => {
    expect(
      PromotedContextAcceptanceEvaluationSchema.safeParse({
        acceptanceEligible: false,
        reason: "INVALID_CANDIDATE",
      }).success,
    ).toBe(true);
    expect(
      PromotedContextAcceptanceEvaluationSchema.safeParse({
        acceptanceEligible: true,
        requirement: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
      }).success,
    ).toBe(false);
    for (const field of [
      "accepted",
      "approved",
      "trusted",
      "verified",
      "acceptedAt",
      "approvedBy",
      "humanConfirmed",
      "evidenceVerified",
    ]) {
      expect(
        PromotedContextAcceptanceEvaluationSchema.safeParse({
          acceptanceEligible: true,
          requirement: "HUMAN_CONFIRMATION_REQUIRED",
          reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
          [field]: true,
        }).success,
      ).toBe(false);
    }
  });

  it("exposes no model, Codex, system, or automatic acceptance route", () => {
    for (const forbiddenRequirement of [
      "CODEX",
      "LLM",
      "MODEL",
      "AUTO_ACCEPT",
      "SYSTEM_ACCEPT",
      "REPO_ACCEPT",
      "TRUSTED_SOURCE",
      "NO_CONFIRMATION_REQUIRED",
    ]) {
      expect(
        PromotedContextAcceptanceRequirementSchema.safeParse(forbiddenRequirement)
          .success,
      ).toBe(false);
    }
    for (const field of [
      "modelApproved",
      "codexApproved",
      "llmApproved",
      "confidence",
      "modelConfidence",
      "agentDecision",
    ]) {
      expect(
        PromotedContextCandidateSchema.safeParse(
          candidateInput({ [field]: true }),
        ).success,
      ).toBe(false);
    }
  });
});

describe("S2D3 exact ContextKind authority matrix", () => {
  it.each(ContextKindSchema.options)("maps %s to its exact requirement", (kind) => {
    const result = evaluatePromotedContextAcceptanceRequirement(
      topology(),
      candidate({ kind }),
    );

    expect(result.acceptanceEligible).toBe(true);
    if (!result.acceptanceEligible) {
      return;
    }
    expect(result.requirement).toBe(expectedRequirement(kind));
    expect(result.reason).toBe(
      kind === "ENGINEERING_FACT"
        ? "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN"
        : "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
    );
  });

  it("requires human confirmation for an OPEN_QUESTION without implying resolution", () => {
    const result = evaluatePromotedContextAcceptanceRequirement(
      topology(),
      candidate({
        kind: "OPEN_QUESTION",
        title: "Which migration sequence remains unresolved?",
        body: "This question is important durable context but has no answer yet.",
      }),
    );
    expect(result).toEqual({
      acceptanceEligible: true,
      requirement: "HUMAN_CONFIRMATION_REQUIRED",
      reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
    });
    expect(Object.keys(result)).not.toContain("resolved");
  });
});

describe("S2D3 source, provenance, evidence, route, and content neutrality", () => {
  it("maps DECISION and ENGINEERING_FACT independently of every ContextSourceType", () => {
    for (const sourceType of ContextSourceTypeSchema.options) {
      for (const kind of ["DECISION", "ENGINEERING_FACT"] as const) {
        const result = evaluatePromotedContextAcceptanceRequirement(
          topology(),
          candidate({
            kind,
            provenance: { ...candidateInput().provenance, sourceType },
          }),
        );
        expect(result.acceptanceEligible).toBe(true);
        expect(result.acceptanceEligible && result.requirement).toBe(
          expectedRequirement(kind),
        );
      }
    }
  });

  it("ignores authority-looking source and evidence reference text", () => {
    const bait = [
      "approved",
      "accepted",
      "verified final human confirmed",
      "system trusted repo truth",
      "QA PASS security critical",
    ];
    for (const kind of ["DECISION", "ENGINEERING_FACT"] as const) {
      const expected = evaluatePromotedContextAcceptanceRequirement(
        topology(),
        candidate({ kind }),
      );
      for (const wording of bait) {
        const result = evaluatePromotedContextAcceptanceRequirement(
          topology(),
          candidate({
            kind,
            provenance: {
              sourceType: "SYSTEM",
              sourceReference: wording,
              evidenceReferences: [wording, `repo:${wording}`],
            },
          }),
        );
        expect(result).toEqual(expected);
      }
    }
  });

  it.each([0, 1, 8])(
    "does not validate or trust %i ENGINEERING_FACT evidence references",
    (count) => {
      const result = evaluatePromotedContextAcceptanceRequirement(
        topology(),
        candidate({
          provenance: {
            ...candidateInput().provenance,
            evidenceReferences: Array.from(
              { length: count },
              (_, index) => `verified-approved-${index}`,
            ),
          },
        }),
      );
      expect(result).toEqual({
        acceptanceEligible: true,
        requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
        reason: "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
      });
    },
  );

  it("uses kind rather than eligible audience kind to select authority", () => {
    const parent = evaluatePromotedContextAcceptanceRequirement(
      topology(),
      candidate({ kind: "DECISION", route: parentRoute() }),
    );
    const downstream = evaluatePromotedContextAcceptanceRequirement(
      topology([dependency("st_a", "st_b")]),
      candidate({ kind: "DECISION", route: downstreamRoute() }),
    );
    expect(parent).toEqual(downstream);
  });

  it("does not infer authority from title or body wording", () => {
    const expected = evaluatePromotedContextAcceptanceRequirement(
      topology(),
      candidate({ kind: "DECISION" }),
    );
    for (const wording of [
      "human approved",
      "this is definitely true",
      "automatic",
      "verified by tests",
    ]) {
      expect(
        evaluatePromotedContextAcceptanceRequirement(
          topology(),
          candidate({ kind: "DECISION", title: wording, body: wording }),
        ),
      ).toEqual(expected);
    }
  });
});

describe("S2D3 S2D2 and S2D1 preservation", () => {
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
  ] as const)("does not assign actionable authority to a %s route", (
    _label,
    graph,
    route,
    reason,
  ) => {
    expect(
      evaluatePromotedContextAcceptanceRequirement(
        graph,
        candidate({ route }),
      ),
    ).toEqual({ acceptanceEligible: false, reason });
  });

  it("preserves invalid route and invalid topology reasons", () => {
    const invalidRoute = candidateInput({
      route: { ...parentRoute(), sourceSubtaskId: " st_a" },
    }) as PromotedContextCandidate;
    const invalidTopology = {
      ...topology(),
      subtasks: [{ id: "st_a", bigTaskId: "bt_missing" }],
    } as PromotedContextRouteTopology;

    expect(
      evaluatePromotedContextAcceptanceRequirement(topology(), invalidRoute),
    ).toEqual({ acceptanceEligible: false, reason: "INVALID_ROUTE" });
    expect(
      evaluatePromotedContextAcceptanceRequirement(
        invalidTopology,
        candidate(),
      ),
    ).toEqual({ acceptanceEligible: false, reason: "INVALID_TOPOLOGY" });
  });

  it("keeps malformed and unstable candidates non-eligible", () => {
    const malformed = {
      ...candidate(),
      kind: "FACT",
    } as unknown as PromotedContextCandidate;
    let kindObservation = 0;
    const unstable = new Proxy(candidate(), {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "kind" || descriptor === undefined || !("value" in descriptor)) {
          return descriptor;
        }
        kindObservation += 1;
        return {
          ...descriptor,
          value: kindObservation % 2 === 0 ? "DECISION" : "ENGINEERING_FACT",
        };
      },
    });

    for (const input of [malformed, unstable]) {
      expect(
        evaluatePromotedContextAcceptanceRequirement(topology(), input),
      ).toEqual({ acceptanceEligible: false, reason: "INVALID_CANDIDATE" });
    }
  });

  it("uses the detached canonical S2D2 candidate instead of rereading caller kind", () => {
    let hostileKindReads = 0;
    const hostile = new Proxy(candidate({ kind: "ENGINEERING_FACT" }), {
      get(target, property, receiver) {
        if (property === "kind") {
          hostileKindReads += 1;
          return "DECISION";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluatePromotedContextAcceptanceRequirement(topology(), hostile),
    ).toEqual({
      acceptanceEligible: true,
      requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
      reason: "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
    });
    expect(hostileKindReads).toBe(0);
  });
});

describe("S2D3 ContextAuthority, purity, and adjacent-boundary separation", () => {
  it("does not reuse existing ContextAuthority values as acceptance decisions", () => {
    expect(ContextAuthoritySchema.options).toEqual([
      "HUMAN",
      "REPO_EVIDENCE",
      "CODEX_CANDIDATE",
      "SYSTEM",
    ]);
    for (const authority of ContextAuthoritySchema.options) {
      expect(
        PromotedContextAcceptanceRequirementSchema.safeParse(authority).success,
      ).toBe(false);
    }
  });

  it("is repeatable, frozen-input compatible, and mutation free", () => {
    const graph = topology([dependency("st_a", "st_b")]);
    const input = candidate({
      route: downstreamRoute(),
      provenance: {
        ...candidateInput().provenance,
        evidenceReferences: ["third", "first", "third"],
      },
    });
    const before = JSON.stringify({ graph, input });
    deepFreeze(graph);
    deepFreeze(input);
    const first = evaluatePromotedContextAcceptanceRequirement(graph, input);
    const second = evaluatePromotedContextAcceptanceRequirement(graph, input);

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify({ graph, input })).toBe(before);
  });

  it("keeps generic Promoted Context excluded from Fresh Independent QA", () => {
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", {
        candidateClass: "PROMOTED_CONTEXT",
        sourceReference: "candidate:acceptance-policy-only",
      }),
    ).toEqual({
      includedByProfile: false,
      reason: "EXCLUDED_PROMOTED_CONTEXT",
    });
  });

  it("imports only pure domain contracts and contains no I/O or acceptance implementation", () => {
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
      /ContextAuthoritySchema/,
      /AuditEventSchema/,
      /acceptedAt/,
      /approvedAt/,
      /acceptedBy/,
      /approvedBy/,
      /humanConfirmed/,
      /evidenceVerified/,
      /modelApproved/,
      /codexApproved/,
      /llmApproved/,
      /modelConfidence/,
      /agentDecision/,
    ]) {
      expect(source).not.toMatch(forbiddenRuntime);
    }
  });
});
