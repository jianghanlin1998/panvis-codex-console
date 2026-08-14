import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ProjectSchema,
  PromotedContextRouteAudienceKindSchema,
  PromotedContextRouteReasonSchema,
  PromotedContextRouteSchema,
  PromotedContextRouteTopologySchema,
  SubtaskDependencySchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
  evaluatePromotedContextRoute,
} from "../src/index.js";
import type {
  DependencyRequiredGate,
  DependencyType,
  PromotedContextRoute,
  PromotedContextRouteTopology,
  SubtaskDependency,
} from "../src/index.js";

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: DependencyType = "BLOCKING",
  requiredGate: DependencyRequiredGate =
    dependencyType === "BLOCKING" ? "HARDENED" : "NONE",
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType,
    requiredGate,
    reason: `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
  });

const topology = (
  dependencies: readonly SubtaskDependency[] = [],
): PromotedContextRouteTopology =>
  PromotedContextRouteTopologySchema.parse({
    projects: [{ id: "prj_one" }, { id: "prj_two" }],
    bigTasks: [
      { id: "bt_one", projectId: "prj_one" },
      { id: "bt_two", projectId: "prj_one" },
      { id: "bt_foreign", projectId: "prj_two" },
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

const parentRoute = (targetBigTaskId = "bt_one"): PromotedContextRoute =>
  PromotedContextRouteSchema.parse({
    sourceSubtaskId: "st_a",
    audienceKind: "PARENT_BIG_TASK",
    targetBigTaskId,
  });

const downstreamRoute = (
  sourceSubtaskId = "st_a",
  targetSubtaskId = "st_b",
): PromotedContextRoute =>
  PromotedContextRouteSchema.parse({
    sourceSubtaskId,
    audienceKind: "DOWNSTREAM_SUBTASK",
    targetSubtaskId,
  });

describe("S2D1 closed public route contract", () => {
  it("supports exactly the two approved audience kinds and stable reasons", () => {
    expect(PromotedContextRouteAudienceKindSchema.options).toEqual([
      "PARENT_BIG_TASK",
      "DOWNSTREAM_SUBTASK",
    ]);
    expect(PromotedContextRouteReasonSchema.options).toEqual([
      "ELIGIBLE_PARENT_BIG_TASK",
      "ELIGIBLE_EXPLICIT_DEPENDENCY",
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
    ]);
  });

  it.each(["PROJECT", "TASK", "GLOBAL", "BROADCAST"])(
    "rejects the unapproved %s audience",
    (audienceKind) => {
      expect(
        PromotedContextRouteSchema.safeParse({
          sourceSubtaskId: "st_a",
          audienceKind,
          targetSubtaskId: "st_b",
        }).success,
      ).toBe(false);
    },
  );

  it.each(["body", "title", "rawTranscript", "handoff", "accepted", "storageId"])(
    "rejects content or lifecycle field %s",
    (field) => {
      expect(
        PromotedContextRouteSchema.safeParse({
          ...parentRoute(),
          [field]: "not route evidence",
        }).success,
      ).toBe(false);
    },
  );

  it("fails closed for a malformed route without exposing parser details", () => {
    expect(
      evaluatePromotedContextRoute(topology(), {
        ...parentRoute(),
        sourceSubtaskId: " st_a",
      } as PromotedContextRoute),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
  });
});

describe("S2D1 parent Big Task route", () => {
  it("allows the source Subtask's exact parent even with a sibling present", () => {
    expect(evaluatePromotedContextRoute(topology(), parentRoute())).toEqual({
      valid: true,
      eligible: true,
      reason: "ELIGIBLE_PARENT_BIG_TASK",
    });
  });

  it("denies another Big Task in the same Project", () => {
    expect(evaluatePromotedContextRoute(topology(), parentRoute("bt_two"))).toEqual({
      valid: true,
      eligible: false,
      reason: "NOT_SOURCE_PARENT_BIG_TASK",
    });
  });

  it("denies a Big Task in another Project", () => {
    expect(evaluatePromotedContextRoute(topology(), parentRoute("bt_foreign"))).toEqual({
      valid: true,
      eligible: false,
      reason: "CROSS_PROJECT_NOT_ALLOWED",
    });
  });

  it("distinguishes a missing target", () => {
    expect(evaluatePromotedContextRoute(topology(), parentRoute("bt_missing"))).toEqual({
      valid: false,
      eligible: false,
      reason: "TARGET_BIG_TASK_NOT_FOUND",
    });
  });
});

describe("S2D1 exact explicit dependency route", () => {
  it.each([
    ["BLOCKING", "HARDENED"],
    ["BLOCKING", "ACCEPTED"],
    ["INFORMATIONAL", "NONE"],
  ] as const)("allows an exact %s + %s A to B edge", (dependencyType, requiredGate) => {
    const result = evaluatePromotedContextRoute(
      topology([dependency("st_a", "st_b", dependencyType, requiredGate)]),
      downstreamRoute(),
    );

    expect(result).toEqual({
      valid: true,
      eligible: true,
      reason: "ELIGIBLE_EXPLICIT_DEPENDENCY",
    });
  });

  it("denies siblings without an exact dependency", () => {
    expect(evaluatePromotedContextRoute(topology(), downstreamRoute())).toEqual({
      valid: true,
      eligible: false,
      reason: "NO_EXPLICIT_DEPENDENCY",
    });
  });

  it("denies reverse-only propagation", () => {
    expect(
      evaluatePromotedContextRoute(
        topology([dependency("st_b", "st_a")]),
        downstreamRoute(),
      ),
    ).toEqual({
      valid: true,
      eligible: false,
      reason: "REVERSE_DIRECTION_NOT_ALLOWED",
    });
  });

  it("uses the exact edge despite unrelated edges", () => {
    expect(
      evaluatePromotedContextRoute(
        topology([
          dependency("st_b", "st_c", "INFORMATIONAL", "NONE"),
          dependency("st_a", "st_b", "BLOCKING", "HARDENED"),
        ]),
        downstreamRoute(),
      ).eligible,
    ).toBe(true);
  });

  it("denies cross-Big-Task and cross-Project targets without bypassing dependencies", () => {
    expect(evaluatePromotedContextRoute(topology(), downstreamRoute("st_a", "st_other")))
      .toEqual({ valid: true, eligible: false, reason: "CROSS_BIG_TASK_NOT_ALLOWED" });
    expect(evaluatePromotedContextRoute(topology(), downstreamRoute("st_a", "st_foreign")))
      .toEqual({ valid: true, eligible: false, reason: "CROSS_PROJECT_NOT_ALLOWED" });
  });
});

describe("S2D1 no transitive propagation", () => {
  it("does not infer A to C from A to B and B to C", () => {
    const graph = topology([
      dependency("st_a", "st_b"),
      dependency("st_b", "st_c"),
    ]);

    expect(evaluatePromotedContextRoute(graph, downstreamRoute("st_a", "st_c")))
      .toEqual({ valid: true, eligible: false, reason: "NO_EXPLICIT_DEPENDENCY" });
  });

  it("allows A to C only after an exact A to C edge exists", () => {
    const graph = topology([
      dependency("st_a", "st_b"),
      dependency("st_b", "st_c"),
      dependency("st_a", "st_c", "INFORMATIONAL", "NONE"),
    ]);

    expect(evaluatePromotedContextRoute(graph, downstreamRoute("st_a", "st_c")))
      .toEqual({ valid: true, eligible: true, reason: "ELIGIBLE_EXPLICIT_DEPENDENCY" });
  });
});

describe("S2D1 fail-closed topology and endpoint validation", () => {
  const invalidTopology = (
    mutate: (input: Record<string, unknown>) => void,
  ): PromotedContextRouteTopology => {
    const input = structuredClone(topology()) as unknown as Record<string, unknown>;
    mutate(input);
    return input as unknown as PromotedContextRouteTopology;
  };

  it("distinguishes missing source and target Subtasks", () => {
    expect(evaluatePromotedContextRoute(topology(), downstreamRoute("st_missing", "st_b")))
      .toEqual({ valid: false, eligible: false, reason: "SOURCE_SUBTASK_NOT_FOUND" });
    expect(evaluatePromotedContextRoute(topology(), downstreamRoute("st_a", "st_missing")))
      .toEqual({ valid: false, eligible: false, reason: "TARGET_SUBTASK_NOT_FOUND" });
  });

  it.each([
    ["duplicate dependency", [dependency("st_a", "st_b"), dependency("st_a", "st_b")]],
    ["missing endpoint", [dependency("st_missing", "st_b")]],
    ["self dependency", [dependency("st_a", "st_a")]],
    ["cross-Big-Task dependency", [dependency("st_a", "st_other")]],
    ["blocking cycle", [dependency("st_a", "st_b"), dependency("st_b", "st_a")]],
  ] as const)("rejects an invalid graph with %s", (_label, dependencies) => {
    const input = invalidTopology((value) => {
      value.dependencies = dependencies;
    });
    expect(evaluatePromotedContextRoute(input, downstreamRoute())).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("rejects duplicate task IDs and malformed ownership", () => {
    const duplicate = invalidTopology((value) => {
      value.subtasks = [
        ...(value.subtasks as unknown[]),
        { id: "st_a", bigTaskId: "bt_one" },
      ];
    });
    const malformedOwnership = invalidTopology((value) => {
      value.subtasks = (value.subtasks as Array<Record<string, unknown>>).map((subtask) =>
        subtask.id === "st_a" ? { ...subtask, bigTaskId: "bt_missing" } : subtask,
      );
    });

    expect(evaluatePromotedContextRoute(duplicate, parentRoute()).reason).toBe(
      "INVALID_TOPOLOGY",
    );
    expect(evaluatePromotedContextRoute(malformedOwnership, parentRoute())).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("rejects noncanonical and extra topology evidence", () => {
    const padded = invalidTopology((value) => {
      (value.projects as Array<Record<string, unknown>>)[0]!.id = " prj_one";
    });
    const extra = invalidTopology((value) => {
      (value.bigTasks as Array<Record<string, unknown>>)[0]!.hidden = true;
    });

    expect(evaluatePromotedContextRoute(padded, parentRoute()).reason).toBe("INVALID_TOPOLOGY");
    expect(evaluatePromotedContextRoute(extra, parentRoute()).reason).toBe("INVALID_TOPOLOGY");
  });
});

describe("S2D1 determinism, structural copies, and no mutation", () => {
  it("returns the same frozen result for repeated, copied, and reordered evidence", () => {
    const base = topology([
      dependency("st_b", "st_c", "INFORMATIONAL", "NONE"),
      dependency("st_a", "st_b", "BLOCKING", "ACCEPTED"),
    ]);
    const route = downstreamRoute();
    const expected = evaluatePromotedContextRoute(base, route);
    const reordered = {
      projects: [...base.projects].reverse(),
      bigTasks: [...base.bigTasks].reverse(),
      subtasks: [...base.subtasks].reverse(),
      dependencies: [...base.dependencies].reverse(),
    };

    expect(evaluatePromotedContextRoute(base, route)).toEqual(expected);
    expect(evaluatePromotedContextRoute(structuredClone(base), structuredClone(route)))
      .toEqual(expected);
    expect(evaluatePromotedContextRoute(JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(route))))
      .toEqual(expected);
    expect(evaluatePromotedContextRoute(reordered, route)).toEqual(expected);
    expect(Object.isFrozen(expected)).toBe(true);
  });

  it("does not mutate topology, dependencies, or route", () => {
    const input = topology([dependency("st_a", "st_b")]);
    const route = downstreamRoute();
    const before = JSON.stringify({ input, route });

    evaluatePromotedContextRoute(input, route);

    expect(JSON.stringify({ input, route })).toBe(before);
  });
});

describe("S2D1 raw-context non-expansion regression", () => {
  it("keeps A raw scope outside B's S2A AllowedContextSet when A to B is eligible", () => {
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
      goal: "Keep context isolated.",
      rationale: "Conclusions and raw context require separate boundaries.",
      scopeIn: ["Route eligibility"],
      scopeOut: ["Raw context widening"],
      acceptanceCriteria: ["Raw scopes remain exact."],
      status: "IN_PROGRESS",
    });
    const fullSubtask = (id: "st_a" | "st_b") =>
      SubtaskSchema.parse({
        recordType: "SUBTASK",
        id,
        bigTaskId: bigTask.id,
        title: `Subtask ${id}`,
        goal: "Evaluate the bounded contract.",
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
    const source = fullSubtask("st_a");
    const target = fullSubtask("st_b");
    const routeTopology = PromotedContextRouteTopologySchema.parse({
      projects: [{ id: project.id }],
      bigTasks: [{ id: bigTask.id, projectId: project.id }],
      subtasks: [
        { id: source.id, bigTaskId: source.bigTaskId },
        { id: target.id, bigTaskId: target.bigTaskId },
      ],
      dependencies: [dependency(source.id, target.id)],
    });

    expect(evaluatePromotedContextRoute(routeTopology, downstreamRoute()).eligible).toBe(true);
    const allowed = buildAllowedContextSet(project, bigTask, target);
    expect(allowed.valid).toBe(true);
    if (!allowed.valid) {
      return;
    }
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
    expect(
      evaluateContextScopeAccess(allowed.allowedContextSet, {
        scopeType: "SUBTASK",
        projectId: project.id,
        bigTaskId: bigTask.id,
        subtaskId: source.id,
      }),
    ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
  });
});
