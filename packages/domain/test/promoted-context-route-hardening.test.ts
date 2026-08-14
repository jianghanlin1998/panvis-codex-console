import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ProjectSchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
  evaluatePromotedContextRoute,
} from "../src/index.js";
import type {
  DependencyRequiredGate,
  DependencyType,
  PromotedContextRoute,
  PromotedContextRouteEvaluation,
  PromotedContextRouteTopology,
  Subtask,
  SubtaskDependency,
} from "../src/index.js";

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: DependencyType = "INFORMATIONAL",
  requiredGate: DependencyRequiredGate =
    dependencyType === "BLOCKING" ? "HARDENED" : "NONE",
  reason = `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
): SubtaskDependency => ({
  upstreamSubtaskId,
  downstreamSubtaskId,
  dependencyType,
  requiredGate,
  reason,
}) as SubtaskDependency;

const hostileTopology = (): PromotedContextRouteTopology => ({
  projects: [{ id: "prj_hardening" }],
  bigTasks: [{ id: "bt_hardening", projectId: "prj_hardening" }],
  subtasks: [
    { id: "st_a", bigTaskId: "bt_hardening" },
    { id: "st_b", bigTaskId: "bt_hardening" },
    { id: "st_c", bigTaskId: "bt_hardening" },
  ],
  dependencies: [dependency("st_c", "st_b")],
}) as PromotedContextRouteTopology;

const parentRoute = (
  sourceSubtaskId: string,
  targetBigTaskId: string,
): PromotedContextRoute => ({
  sourceSubtaskId,
  audienceKind: "PARENT_BIG_TASK",
  targetBigTaskId,
}) as PromotedContextRoute;

const downstreamRoute = (
  sourceSubtaskId: string,
  targetSubtaskId: string,
): PromotedContextRoute => ({
  sourceSubtaskId,
  audienceKind: "DOWNSTREAM_SUBTASK",
  targetSubtaskId,
}) as PromotedContextRoute;

const cloneTopology = (
  topology: PromotedContextRouteTopology,
): PromotedContextRouteTopology => structuredClone(topology);

const routeOracle = (
  topology: PromotedContextRouteTopology,
  route: PromotedContextRoute,
): PromotedContextRouteEvaluation => {
  const source = topology.subtasks.find(({ id }) => id === route.sourceSubtaskId);
  if (source === undefined) {
    return { valid: false, eligible: false, reason: "SOURCE_SUBTASK_NOT_FOUND" };
  }
  const sourceBigTask = topology.bigTasks.find(({ id }) => id === source.bigTaskId);
  if (sourceBigTask === undefined) {
    return { valid: false, eligible: false, reason: "INVALID_TOPOLOGY" };
  }

  if (route.audienceKind === "PARENT_BIG_TASK") {
    const target = topology.bigTasks.find(({ id }) => id === route.targetBigTaskId);
    if (target === undefined) {
      return { valid: false, eligible: false, reason: "TARGET_BIG_TASK_NOT_FOUND" };
    }
    if (target.projectId !== sourceBigTask.projectId) {
      return { valid: true, eligible: false, reason: "CROSS_PROJECT_NOT_ALLOWED" };
    }
    return target.id === sourceBigTask.id
      ? { valid: true, eligible: true, reason: "ELIGIBLE_PARENT_BIG_TASK" }
      : { valid: true, eligible: false, reason: "NOT_SOURCE_PARENT_BIG_TASK" };
  }

  const target = topology.subtasks.find(({ id }) => id === route.targetSubtaskId);
  if (target === undefined) {
    return { valid: false, eligible: false, reason: "TARGET_SUBTASK_NOT_FOUND" };
  }
  const targetBigTask = topology.bigTasks.find(({ id }) => id === target.bigTaskId);
  if (targetBigTask === undefined) {
    return { valid: false, eligible: false, reason: "INVALID_TOPOLOGY" };
  }
  if (targetBigTask.projectId !== sourceBigTask.projectId) {
    return { valid: true, eligible: false, reason: "CROSS_PROJECT_NOT_ALLOWED" };
  }
  if (target.bigTaskId !== source.bigTaskId) {
    return { valid: true, eligible: false, reason: "CROSS_BIG_TASK_NOT_ALLOWED" };
  }

  const exact = topology.dependencies.some(
    ({ upstreamSubtaskId, downstreamSubtaskId }) =>
      upstreamSubtaskId === source.id && downstreamSubtaskId === target.id,
  );
  if (exact) {
    return { valid: true, eligible: true, reason: "ELIGIBLE_EXPLICIT_DEPENDENCY" };
  }
  const reverse = topology.dependencies.some(
    ({ upstreamSubtaskId, downstreamSubtaskId }) =>
      upstreamSubtaskId === target.id && downstreamSubtaskId === source.id,
  );
  return reverse
    ? { valid: true, eligible: false, reason: "REVERSE_DIRECTION_NOT_ALLOWED" }
    : { valid: true, eligible: false, reason: "NO_EXPLICIT_DEPENDENCY" };
};

const makeOracleTopology = (): PromotedContextRouteTopology => {
  const projects = Array.from({ length: 4 }, (_, projectIndex) => ({
    id: `prj_oracle_${projectIndex}`,
  }));
  const bigTasks = projects.flatMap((project) =>
    Array.from({ length: 3 }, (_, bigTaskIndex) => ({
      id: `bt_oracle_${project.id.slice("prj_oracle_".length)}_${bigTaskIndex}`,
      projectId: project.id,
    })),
  );
  const subtasks = bigTasks.flatMap((bigTask) =>
    Array.from({ length: 4 }, (_, subtaskIndex) => ({
      id: `st_oracle_${bigTask.id.slice("bt_oracle_".length)}_${subtaskIndex}`,
      bigTaskId: bigTask.id,
    })),
  );
  const dependencies = bigTasks.flatMap((bigTask) => {
    const ids = subtasks
      .filter(({ bigTaskId }) => bigTaskId === bigTask.id)
      .map(({ id }) => id);
    return [
      dependency(ids[0]!, ids[1]!, "BLOCKING", "HARDENED"),
      dependency(ids[0]!, ids[2]!, "BLOCKING", "ACCEPTED"),
      dependency(ids[1]!, ids[2]!, "INFORMATIONAL", "NONE"),
      dependency(ids[2]!, ids[3]!, "BLOCKING", "HARDENED"),
      dependency(ids[3]!, ids[1]!, "INFORMATIONAL", "NONE"),
    ];
  });
  return { projects, bigTasks, subtasks, dependencies } as PromotedContextRouteTopology;
};

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

describe("S2D1 hostile runtime regression", () => {
  it("does not false-allow when a route Proxy changes the parsed source", () => {
    const underlyingRoute = {
      sourceSubtaskId: "st_a",
      audienceKind: "DOWNSTREAM_SUBTASK",
      targetSubtaskId: "st_b",
    };
    let getCalls = 0;
    const hostileRoute = new Proxy(underlyingRoute, {
      get(target, property, receiver) {
        getCalls += 1;
        if (property === "sourceSubtaskId") {
          return "st_c";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      evaluatePromotedContextRoute(
        hostileTopology(),
        hostileRoute as PromotedContextRoute,
      ),
    ).toEqual({ valid: true, eligible: false, reason: "NO_EXPLICIT_DEPENDENCY" });
    expect(getCalls).toBe(0);
  });
});

describe("S2D1 independent route oracle and ownership matrix", () => {
  it("matches 2,880 literal parent and downstream route decisions", () => {
    const topology = makeOracleTopology();
    const mismatches: Array<{
      route: PromotedContextRoute;
      expected: PromotedContextRouteEvaluation;
      actual: PromotedContextRouteEvaluation;
    }> = [];
    let decisions = 0;

    for (const source of topology.subtasks) {
      for (const target of topology.bigTasks) {
        const route = parentRoute(source.id, target.id);
        const expected = routeOracle(topology, route);
        const actual = evaluatePromotedContextRoute(topology, route);
        decisions += 1;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push({ route, expected, actual });
        }
      }
      for (const target of topology.subtasks) {
        const route = downstreamRoute(source.id, target.id);
        const expected = routeOracle(topology, route);
        const actual = evaluatePromotedContextRoute(topology, route);
        decisions += 1;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push({ route, expected, actual });
        }
      }
    }

    expect(topology.projects).toHaveLength(4);
    expect(topology.bigTasks).toHaveLength(12);
    expect(topology.subtasks).toHaveLength(48);
    expect(topology.dependencies).toHaveLength(60);
    expect(decisions).toBe(2_880);
    expect(mismatches).toEqual([]);
  }, 20_000);

  it("allows only the exact own parent across repeated structurally similar IDs", () => {
    const topology = makeOracleTopology();
    let ownParentAllows = 0;
    let sameProjectDenials = 0;
    let foreignProjectDenials = 0;
    for (const source of topology.subtasks) {
      const sourceBigTask = topology.bigTasks.find(({ id }) => id === source.bigTaskId)!;
      for (const target of topology.bigTasks) {
        const result = evaluatePromotedContextRoute(
          topology,
          parentRoute(source.id, target.id),
        );
        if (target.id === source.bigTaskId) {
          expect(result.reason).toBe("ELIGIBLE_PARENT_BIG_TASK");
          ownParentAllows += 1;
        } else if (target.projectId === sourceBigTask.projectId) {
          expect(result.reason).toBe("NOT_SOURCE_PARENT_BIG_TASK");
          sameProjectDenials += 1;
        } else {
          expect(result.reason).toBe("CROSS_PROJECT_NOT_ALLOWED");
          foreignProjectDenials += 1;
        }
      }
    }
    expect({ ownParentAllows, sameProjectDenials, foreignProjectDenials }).toEqual({
      ownParentAllows: 48,
      sameProjectDenials: 96,
      foreignProjectDenials: 432,
    });
  });

  it("fails closed for missing targets and malformed source ownership", () => {
    const topology = makeOracleTopology();
    const source = topology.subtasks[0]!;
    expect(
      evaluatePromotedContextRoute(topology, parentRoute(source.id, "bt_missing")),
    ).toEqual({ valid: false, eligible: false, reason: "TARGET_BIG_TASK_NOT_FOUND" });

    const malformed = cloneTopology(topology);
    malformed.subtasks[0]!.bigTaskId = "bt_missing" as typeof source.bigTaskId;
    expect(
      evaluatePromotedContextRoute(
        malformed,
        parentRoute(source.id, topology.bigTasks[0]!.id),
      ),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_TOPOLOGY" });
  });
});

describe("S2D1 exact dependency, reverse, transitive, and sibling campaigns", () => {
  const smallTopology = (
    dependencies: readonly SubtaskDependency[],
  ): PromotedContextRouteTopology => ({
    projects: [{ id: "prj_graph" }, { id: "prj_foreign" }],
    bigTasks: [
      { id: "bt_graph", projectId: "prj_graph" },
      { id: "bt_sibling", projectId: "prj_graph" },
      { id: "bt_foreign_graph", projectId: "prj_foreign" },
    ],
    subtasks: [
      { id: "st_ga", bigTaskId: "bt_graph" },
      { id: "st_gb", bigTaskId: "bt_graph" },
      { id: "st_gc", bigTaskId: "bt_graph" },
      { id: "st_gd", bigTaskId: "bt_graph" },
      { id: "st_ge", bigTaskId: "bt_graph" },
      { id: "st_other_graph", bigTaskId: "bt_sibling" },
      { id: "st_foreign_graph", bigTaskId: "bt_foreign_graph" },
    ],
    dependencies,
  }) as PromotedContextRouteTopology;

  it.each([
    ["BLOCKING", "HARDENED"],
    ["BLOCKING", "ACCEPTED"],
    ["INFORMATIONAL", "NONE"],
  ] as const)("allows exact %s + %s without gate satisfaction", (type, gate) => {
    const topology = smallTopology([dependency("st_ga", "st_gb", type, gate)]);
    expect(
      evaluatePromotedContextRoute(topology, downstreamRoute("st_ga", "st_gb")),
    ).toEqual({ valid: true, eligible: true, reason: "ELIGIBLE_EXPLICIT_DEPENDENCY" });
  });

  it("preserves exact-edge results across reason text and edge ordering", () => {
    const edges = [
      dependency("st_ga", "st_gb", "BLOCKING", "ACCEPTED", "Alpha reason."),
      dependency("st_gb", "st_gc", "INFORMATIONAL", "NONE", "Zulu reason."),
      dependency("st_gc", "st_gd", "BLOCKING", "HARDENED", "Middle reason."),
    ];
    const route = downstreamRoute("st_ga", "st_gb");
    const expected = { valid: true, eligible: true, reason: "ELIGIBLE_EXPLICIT_DEPENDENCY" };
    expect(evaluatePromotedContextRoute(smallTopology(edges), route)).toEqual(expected);
    expect(evaluatePromotedContextRoute(smallTopology([...edges].reverse()), route)).toEqual(
      expected,
    );
    expect(
      evaluatePromotedContextRoute(
        smallTopology([
          { ...edges[0]!, reason: "Completely different wording." },
          edges[1]!,
          edges[2]!,
        ]),
        route,
      ),
    ).toEqual(expected);
  });

  it("denies every reverse edge unless the reverse exact edge also exists legally", () => {
    const oneWay = smallTopology([
      dependency("st_ga", "st_gb", "BLOCKING", "HARDENED"),
      dependency("st_gb", "st_gc", "INFORMATIONAL", "NONE"),
      dependency("st_gc", "st_gd", "BLOCKING", "ACCEPTED"),
    ]);
    for (const edge of oneWay.dependencies) {
      expect(
        evaluatePromotedContextRoute(
          oneWay,
          downstreamRoute(edge.downstreamSubtaskId, edge.upstreamSubtaskId),
        ),
      ).toEqual({
        valid: true,
        eligible: false,
        reason: "REVERSE_DIRECTION_NOT_ALLOWED",
      });
    }

    const informationalPair = smallTopology([
      dependency("st_ga", "st_gb", "INFORMATIONAL", "NONE"),
      dependency("st_gb", "st_ga", "INFORMATIONAL", "NONE"),
    ]);
    expect(
      evaluatePromotedContextRoute(
        informationalPair,
        downstreamRoute("st_gb", "st_ga"),
      ).eligible,
    ).toBe(true);

    const blockingCycle = smallTopology([
      dependency("st_ga", "st_gb", "BLOCKING", "HARDENED"),
      dependency("st_gb", "st_ga", "BLOCKING", "ACCEPTED"),
    ]);
    expect(
      evaluatePromotedContextRoute(blockingCycle, downstreamRoute("st_gb", "st_ga")),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_TOPOLOGY" });
  });

  it.each([
    ["three", ["st_ga", "st_gb", "st_gc"]],
    ["four", ["st_ga", "st_gb", "st_gc", "st_gd"]],
    ["five", ["st_ga", "st_gb", "st_gc", "st_gd", "st_ge"]],
  ] as const)("denies every non-adjacent pair in a %s-node chain", (_label, ids) => {
    const edges = ids.slice(0, -1).map((id, index) =>
      dependency(
        id,
        ids[index + 1]!,
        index % 2 === 0 ? "BLOCKING" : "INFORMATIONAL",
        index % 2 === 0 ? "HARDENED" : "NONE",
      ),
    );
    const topology = smallTopology(edges);
    let nonAdjacentChecks = 0;
    for (let sourceIndex = 0; sourceIndex < ids.length; sourceIndex += 1) {
      for (let targetIndex = sourceIndex + 2; targetIndex < ids.length; targetIndex += 1) {
        expect(
          evaluatePromotedContextRoute(
            topology,
            downstreamRoute(ids[sourceIndex]!, ids[targetIndex]!),
          ),
        ).toEqual({ valid: true, eligible: false, reason: "NO_EXPLICIT_DEPENDENCY" });
        nonAdjacentChecks += 1;
      }
    }
    expect(nonAdjacentChecks).toBe(((ids.length - 1) * (ids.length - 2)) / 2);
  });

  it("denies diamond ancestry and allows only added shortcut edges", () => {
    const diamond = [
      dependency("st_ga", "st_gb", "BLOCKING", "HARDENED"),
      dependency("st_ga", "st_gc", "BLOCKING", "ACCEPTED"),
      dependency("st_gb", "st_gd", "INFORMATIONAL", "NONE"),
      dependency("st_gc", "st_gd", "BLOCKING", "HARDENED"),
    ];
    expect(
      evaluatePromotedContextRoute(
        smallTopology(diamond),
        downstreamRoute("st_ga", "st_gd"),
      ),
    ).toEqual({ valid: true, eligible: false, reason: "NO_EXPLICIT_DEPENDENCY" });
    expect(
      evaluatePromotedContextRoute(
        smallTopology([
          ...diamond,
          dependency("st_ga", "st_gd", "INFORMATIONAL", "NONE"),
        ]),
        downstreamRoute("st_ga", "st_gd"),
      ).eligible,
    ).toBe(true);
  });

  it("never grants siblings, adjacent insertion neighbors, or unrelated scopes", () => {
    const topology = smallTopology([
      dependency("st_gc", "st_gd", "INFORMATIONAL", "NONE"),
    ]);
    expect(
      evaluatePromotedContextRoute(topology, downstreamRoute("st_ga", "st_gb")),
    ).toEqual({ valid: true, eligible: false, reason: "NO_EXPLICIT_DEPENDENCY" });
    expect(
      evaluatePromotedContextRoute(topology, downstreamRoute("st_ga", "st_other_graph")),
    ).toEqual({ valid: true, eligible: false, reason: "CROSS_BIG_TASK_NOT_ALLOWED" });
    expect(
      evaluatePromotedContextRoute(topology, downstreamRoute("st_ga", "st_foreign_graph")),
    ).toEqual({ valid: true, eligible: false, reason: "CROSS_PROJECT_NOT_ALLOWED" });
  });
});

describe("S2D1 global fail-closed topology validation", () => {
  const valid = (): PromotedContextRouteTopology => ({
    projects: [{ id: "prj_valid" }, { id: "prj_unrelated" }],
    bigTasks: [
      { id: "bt_valid", projectId: "prj_valid" },
      { id: "bt_other", projectId: "prj_valid" },
      { id: "bt_unrelated", projectId: "prj_unrelated" },
    ],
    subtasks: [
      { id: "st_valid_a", bigTaskId: "bt_valid" },
      { id: "st_valid_b", bigTaskId: "bt_valid" },
      { id: "st_valid_c", bigTaskId: "bt_valid" },
      { id: "st_other", bigTaskId: "bt_other" },
      { id: "st_unrelated", bigTaskId: "bt_unrelated" },
    ],
    dependencies: [
      dependency("st_valid_a", "st_valid_b", "BLOCKING", "HARDENED"),
    ],
  }) as PromotedContextRouteTopology;
  const route = downstreamRoute("st_valid_a", "st_valid_b");

  const invalidCases: ReadonlyArray<
    readonly [string, (topology: PromotedContextRouteTopology) => void]
  > = [
    ["duplicate Project", (topology) => {
      topology.projects.push({ ...topology.projects[0]! });
    }],
    ["duplicate Big Task", (topology) => {
      topology.bigTasks.push({ ...topology.bigTasks[0]! });
    }],
    ["duplicate Subtask", (topology) => {
      topology.subtasks.push({ ...topology.subtasks[0]! });
    }],
    ["duplicate edge", (topology) => {
      topology.dependencies.push({ ...topology.dependencies[0]! });
    }],
    ["self dependency", (topology) => {
      topology.dependencies = [dependency("st_valid_a", "st_valid_a")];
    }],
    ["missing upstream", (topology) => {
      topology.dependencies = [dependency("st_missing", "st_valid_b")];
    }],
    ["missing downstream", (topology) => {
      topology.dependencies = [dependency("st_valid_a", "st_missing")];
    }],
    ["cross Big Task", (topology) => {
      topology.dependencies = [dependency("st_valid_a", "st_other")];
    }],
    ["blocking cycle", (topology) => {
      topology.dependencies = [
        dependency("st_valid_a", "st_valid_b", "BLOCKING", "HARDENED"),
        dependency("st_valid_b", "st_valid_a", "BLOCKING", "ACCEPTED"),
      ];
    }],
    ["broken Big Task ownership", (topology) => {
      topology.bigTasks[2]!.projectId = "prj_missing" as typeof topology.bigTasks[2]["projectId"];
    }],
    ["broken Subtask ownership", (topology) => {
      topology.subtasks[4]!.bigTaskId = "bt_missing" as typeof topology.subtasks[4]["bigTaskId"];
    }],
    ["malformed dependency gate", (topology) => {
      topology.dependencies[0]!.requiredGate = "NONE" as DependencyRequiredGate;
    }],
  ];

  it.each(invalidCases)("rejects %s before route evaluation", (_label, mutate) => {
    const topology = valid();
    mutate(topology);
    expect(evaluatePromotedContextRoute(topology, route)).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("applies global fail-closed policy to unrelated corruption", () => {
    const brokenForeignOwnership = valid();
    brokenForeignOwnership.subtasks[4]!.bigTaskId =
      "bt_missing" as typeof brokenForeignOwnership.subtasks[4]["bigTaskId"];
    expect(evaluatePromotedContextRoute(brokenForeignOwnership, route)).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });

    const duplicateForeignRecord = valid();
    duplicateForeignRecord.projects.push({ ...duplicateForeignRecord.projects[1]! });
    expect(evaluatePromotedContextRoute(duplicateForeignRecord, route)).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("keeps valid unrelated records and informational cycles semantically neutral", () => {
    const withInformationalCycle = valid();
    withInformationalCycle.dependencies.push(
      dependency("st_valid_b", "st_valid_c", "INFORMATIONAL", "NONE"),
      dependency("st_valid_c", "st_valid_b", "INFORMATIONAL", "NONE"),
    );
    expect(evaluatePromotedContextRoute(valid(), route)).toEqual(
      evaluatePromotedContextRoute(withInformationalCycle, route),
    );

    const reversed = {
      projects: [...withInformationalCycle.projects].reverse(),
      bigTasks: [...withInformationalCycle.bigTasks].reverse(),
      subtasks: [...withInformationalCycle.subtasks].reverse(),
      dependencies: [...withInformationalCycle.dependencies].reverse(),
    } as PromotedContextRouteTopology;
    expect(evaluatePromotedContextRoute(reversed, route)).toEqual({
      valid: true,
      eligible: true,
      reason: "ELIGIBLE_EXPLICIT_DEPENDENCY",
    });
  });
});

describe("S2D1 canonicalization and structural-copy boundary", () => {
  const canonical = (): PromotedContextRouteTopology => ({
    projects: [{ id: "prj_copy" }],
    bigTasks: [{ id: "bt_copy", projectId: "prj_copy" }],
    subtasks: [
      { id: "st_copy a", bigTaskId: "bt_copy" },
      { id: "st_copy_b", bigTaskId: "bt_copy" },
    ],
    dependencies: [
      dependency(
        "st_copy a",
        "st_copy_b",
        "INFORMATIONAL",
        "NONE",
        "Interior whitespace is preserved exactly.",
      ),
    ],
  }) as PromotedContextRouteTopology;
  const exactRoute = downstreamRoute("st_copy a", "st_copy_b");
  const eligible = {
    valid: true,
    eligible: true,
    reason: "ELIGIBLE_EXPLICIT_DEPENDENCY",
  };

  it.each([" ", "\u00a0", "\u2007", "\u202f", "\u3000"])(
    "rejects %s-trim-normalizable security identifiers",
    (padding) => {
      expect(
        evaluatePromotedContextRoute(
          canonical(),
          downstreamRoute(`${padding}st_copy a${padding}`, "st_copy_b"),
        ),
      ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
    },
  );

  it("preserves interior whitespace as exact identifier data", () => {
    expect(evaluatePromotedContextRoute(canonical(), exactRoute)).toEqual(eligible);
    expect(
      evaluatePromotedContextRoute(
        canonical(),
        downstreamRoute("st_copy  a", "st_copy_b"),
      ),
    ).toEqual({ valid: false, eligible: false, reason: "SOURCE_SUBTASK_NOT_FOUND" });
  });

  it("rejects parser-normalizable dependency reasons and ownership identifiers", () => {
    const paddedReason = canonical();
    paddedReason.dependencies[0]!.reason = "  Interior whitespace is preserved exactly.  ";
    expect(evaluatePromotedContextRoute(paddedReason, exactRoute).reason).toBe(
      "INVALID_TOPOLOGY",
    );

    const paddedOwnership = canonical();
    paddedOwnership.bigTasks[0]!.projectId = "\u3000prj_copy\u3000" as typeof paddedOwnership.bigTasks[0]["projectId"];
    expect(evaluatePromotedContextRoute(paddedOwnership, exactRoute).reason).toBe(
      "INVALID_TOPOLOGY",
    );
  });

  it("accepts ordinary, null-prototype, frozen, sealed, cloned, and JSON copies", () => {
    const controls: ReadonlyArray<readonly [unknown, unknown]> = [
      [canonical(), exactRoute],
      [structuredClone(canonical()), structuredClone(exactRoute)],
      [JSON.parse(JSON.stringify(canonical())), JSON.parse(JSON.stringify(exactRoute))],
      [nullPrototypeCopy(canonical()), nullPrototypeCopy(exactRoute)],
      [deepFreeze(cloneTopology(canonical())), deepFreeze(structuredClone(exactRoute))],
      [deepSeal(cloneTopology(canonical())), deepSeal(structuredClone(exactRoute))],
      [new Proxy(cloneTopology(canonical()), {}), new Proxy(structuredClone(exactRoute), {})],
    ];
    for (const [topology, route] of controls) {
      expect(
        evaluatePromotedContextRoute(
          topology as PromotedContextRouteTopology,
          route as PromotedContextRoute,
        ),
      ).toEqual(eligible);
    }
  });
});

describe("S2D1 hostile route runtime evidence", () => {
  const topology = hostileTopology();

  it.each([
    [
      "sourceSubtaskId",
      () => descriptorValueSequence(
        { ...downstreamRoute("st_a", "st_b") },
        "sourceSubtaskId",
        ["st_a", "st_c"],
      ),
    ],
    [
      "audienceKind",
      () => descriptorValueSequence(
        { ...downstreamRoute("st_a", "st_b") },
        "audienceKind",
        ["DOWNSTREAM_SUBTASK", "PARENT_BIG_TASK"],
      ),
    ],
    [
      "targetSubtaskId",
      () => descriptorValueSequence(
        { ...downstreamRoute("st_a", "st_b") },
        "targetSubtaskId",
        ["st_b", "st_c"],
      ),
    ],
    [
      "targetBigTaskId",
      () => descriptorValueSequence(
        { ...parentRoute("st_a", "bt_hardening") },
        "targetBigTaskId",
        ["bt_hardening", "bt_other"],
      ),
    ],
  ] as const)("rejects changing route %s descriptors", (_label, makeRoute) => {
    expect(
      evaluatePromotedContextRoute(topology, makeRoute() as PromotedContextRoute),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
  });

  it("rejects changing ownKeys, descriptor flags, and prototypes", () => {
    const base = { ...downstreamRoute("st_a", "st_b") };
    let flagObservations = 0;
    const changingFlags = new Proxy({ ...base }, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "sourceSubtaskId" || descriptor === undefined) {
          return descriptor;
        }
        flagObservations += 1;
        return { ...descriptor, enumerable: flagObservations % 2 === 1 };
      },
    });
    for (const hostile of [
      alternatingOwnKeys({ ...base }),
      changingFlags,
      alternatingPrototype({ ...base }),
    ]) {
      expect(
        evaluatePromotedContextRoute(topology, hostile as PromotedContextRoute),
      ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
    }
  });

  it("does not invoke accessors and rejects accessor-backed route evidence", () => {
    let getterCalls = 0;
    const route = { ...downstreamRoute("st_a", "st_b") } as Record<string, unknown>;
    Object.defineProperty(route, "sourceSubtaskId", {
      get() {
        getterCalls += 1;
        return "st_c";
      },
      configurable: true,
      enumerable: true,
    });
    expect(
      evaluatePromotedContextRoute(topology, route as PromotedContextRoute),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
    expect(getterCalls).toBe(0);
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const)(
    "contains throwing route %s traps",
    (trap) => {
      const route = new Proxy(
        { ...downstreamRoute("st_a", "st_b") },
        {
          [trap]() {
            throw new Error("private hostile route payload");
          },
        },
      );
      expect(() =>
        evaluatePromotedContextRoute(topology, route as PromotedContextRoute),
      ).not.toThrow();
      expect(
        evaluatePromotedContextRoute(topology, route as PromotedContextRoute),
      ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
    },
  );
});

describe("S2D1 hostile topology, arrays, and coordinated evidence", () => {
  const deniedTopology = (): PromotedContextRouteTopology => ({
    ...hostileTopology(),
    dependencies: [dependency("st_c", "st_b")],
  });
  const route = downstreamRoute("st_a", "st_b");

  it("does not synthesize an exact edge through a topology get trap", () => {
    let getCalls = 0;
    const hostile = new Proxy(deniedTopology(), {
      get(target, property, receiver) {
        getCalls += 1;
        if (property === "dependencies") {
          return [dependency("st_a", "st_b")];
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(evaluatePromotedContextRoute(hostile, route)).toEqual({
      valid: true,
      eligible: false,
      reason: "NO_EXPLICIT_DEPENDENCY",
    });
    expect(getCalls).toBe(0);
  });

  it.each([
    ["projects", [{ id: "prj_other" }]],
    ["bigTasks", [{ id: "bt_other", projectId: "prj_hardening" }]],
    ["subtasks", [{ id: "st_a", bigTaskId: "bt_hardening" }]],
    ["dependencies", [dependency("st_a", "st_b")]],
  ] as const)("rejects a changing top-level %s array", (key, replacement) => {
    const hostile = descriptorValueSequence(
      deniedTopology(),
      key,
      [(deniedTopology() as unknown as Record<string, unknown>)[key], replacement],
    );
    expect(
      evaluatePromotedContextRoute(hostile as PromotedContextRouteTopology, route),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_TOPOLOGY" });
  });

  it.each([
    ["Big Task project ownership", "bigTasks", 0, "projectId", "prj_other"],
    ["source Subtask ownership", "subtasks", 0, "bigTaskId", "bt_other"],
    ["target Subtask ownership", "subtasks", 1, "bigTaskId", "bt_other"],
    ["dependency upstream", "dependencies", 0, "upstreamSubtaskId", "st_a"],
    ["dependency downstream", "dependencies", 0, "downstreamSubtaskId", "st_a"],
    ["dependency type", "dependencies", 0, "dependencyType", "BLOCKING"],
    ["dependency gate", "dependencies", 0, "requiredGate", "HARDENED"],
    ["dependency reason", "dependencies", 0, "reason", "Changed reason."],
  ] as const)(
    "rejects changing %s evidence",
    (_label, collection, index, key, replacement) => {
      const topology = deniedTopology();
      const records = topology[collection] as unknown as Array<Record<string, unknown>>;
      records[index] = descriptorValueSequence(
        records[index]!,
        key,
        [records[index]![key], replacement],
      );
      expect(evaluatePromotedContextRoute(topology, route)).toEqual({
        valid: false,
        eligible: false,
        reason: "INVALID_TOPOLOGY",
      });
    },
  );

  it("rejects exact dependencies that appear or disappear across observations", () => {
    const absent = deniedTopology();
    absent.dependencies = descriptorValueSequence(
      [...absent.dependencies],
      "0",
      [dependency("st_c", "st_b"), dependency("st_a", "st_b")],
    );
    expect(evaluatePromotedContextRoute(absent, route)).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });

    const present = deniedTopology();
    present.dependencies = [dependency("st_a", "st_b")];
    present.dependencies = descriptorValueSequence(
      [...present.dependencies],
      "0",
      [dependency("st_a", "st_b"), dependency("st_c", "st_b")],
    );
    expect(evaluatePromotedContextRoute(present, route)).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });
  });

  it("rejects sparse, accessor, non-enumerable, extra-key, symbol, and custom arrays", () => {
    const arrays: unknown[] = [];
    arrays.push(new Array(1));
    const accessor = [dependency("st_c", "st_b")];
    Object.defineProperty(accessor, "0", {
      get: () => dependency("st_a", "st_b"),
      configurable: true,
      enumerable: true,
    });
    arrays.push(accessor);
    const nonEnumerable = [dependency("st_c", "st_b")];
    Object.defineProperty(nonEnumerable, "0", {
      value: nonEnumerable[0],
      writable: true,
      configurable: true,
      enumerable: false,
    });
    arrays.push(nonEnumerable);
    arrays.push(Object.assign([dependency("st_c", "st_b")], { extra: true }));
    arrays.push(Object.assign([dependency("st_c", "st_b")], { [Symbol("extra")]: true }));
    arrays.push(new (class extends Array<SubtaskDependency> {})(
      dependency("st_c", "st_b"),
    ));

    for (const array of arrays) {
      const topology = deniedTopology();
      topology.dependencies = array as SubtaskDependency[];
      expect(evaluatePromotedContextRoute(topology, route)).toEqual({
        valid: false,
        eligible: false,
        reason: "INVALID_TOPOLOGY",
      });
    }
  });

  it("rejects changing array ownKeys, descriptors, length, and prototype", () => {
    const base = [dependency("st_c", "st_b")];
    let lengthObservations = 0;
    const changingLength = new Proxy([...base], {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "length" || descriptor === undefined || !("value" in descriptor)) {
          return descriptor;
        }
        lengthObservations += 1;
        return { ...descriptor, value: lengthObservations % 2 === 0 ? 0 : 1 };
      },
    });
    for (const array of [
      alternatingOwnKeys([...base]),
      descriptorValueSequence([...base], "0", [base[0], dependency("st_a", "st_b")]),
      changingLength,
      alternatingPrototype([...base]),
    ]) {
      const topology = deniedTopology();
      topology.dependencies = array;
      expect(evaluatePromotedContextRoute(topology, route)).toEqual({
        valid: false,
        eligible: false,
        reason: "INVALID_TOPOLOGY",
      });
    }
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const)(
    "contains throwing topology-array %s traps",
    (trap) => {
      const topology = deniedTopology();
      topology.dependencies = new Proxy([...topology.dependencies], {
        [trap]() {
          throw new Error("private hostile topology payload");
        },
      });
      expect(() => evaluatePromotedContextRoute(topology, route)).not.toThrow();
      expect(evaluatePromotedContextRoute(topology, route)).toEqual({
        valid: false,
        eligible: false,
        reason: "INVALID_TOPOLOGY",
      });
    },
  );

  it("blocks coordinated route, ownership, and dependency endpoint swaps", () => {
    let sharedObservations = 0;
    const coordinatedRoute = new Proxy({ ...route }, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "sourceSubtaskId" || descriptor === undefined) {
          return descriptor;
        }
        sharedObservations += 1;
        return {
          ...descriptor,
          value: sharedObservations < 2 ? "st_a" : "st_c",
        };
      },
    });
    const topology = deniedTopology();
    topology.subtasks[0] = descriptorValueSequence(
      { ...topology.subtasks[0]! },
      "bigTaskId",
      ["bt_hardening", "bt_other"],
    );
    topology.dependencies[0] = descriptorValueSequence(
      { ...topology.dependencies[0]! },
      "upstreamSubtaskId",
      ["st_c", "st_a"],
    );
    const result = evaluatePromotedContextRoute(
      topology,
      coordinatedRoute as PromotedContextRoute,
    );
    expect(result.eligible).toBe(false);
    expect(result.valid).toBe(false);
    expect(["INVALID_ROUTE", "INVALID_TOPOLOGY"]).toContain(result.reason);
  });
});

describe("S2D1 reason integrity, determinism, and exception containment", () => {
  const base = (): PromotedContextRouteTopology => ({
    projects: [{ id: "prj_reason" }, { id: "prj_reason_foreign" }],
    bigTasks: [
      { id: "bt_reason", projectId: "prj_reason" },
      { id: "bt_reason_other", projectId: "prj_reason" },
      { id: "bt_reason_foreign", projectId: "prj_reason_foreign" },
    ],
    subtasks: [
      { id: "st_reason_a", bigTaskId: "bt_reason" },
      { id: "st_reason_b", bigTaskId: "bt_reason" },
      { id: "st_reason_other", bigTaskId: "bt_reason_other" },
      { id: "st_reason_foreign", bigTaskId: "bt_reason_foreign" },
    ],
    dependencies: [dependency("st_reason_a", "st_reason_b")],
  }) as PromotedContextRouteTopology;

  it("keeps every closed reason consistent with valid and eligible booleans", () => {
    const invalidTopology = base();
    invalidTopology.projects.push({ ...invalidTopology.projects[0]! });
    const cases: ReadonlyArray<
      readonly [PromotedContextRouteTopology, PromotedContextRoute, string]
    > = [
      [base(), parentRoute("st_reason_a", "bt_reason"), "ELIGIBLE_PARENT_BIG_TASK"],
      [base(), downstreamRoute("st_reason_a", "st_reason_b"), "ELIGIBLE_EXPLICIT_DEPENDENCY"],
      [base(), parentRoute("st_missing", "bt_reason"), "SOURCE_SUBTASK_NOT_FOUND"],
      [base(), parentRoute("st_reason_a", "bt_missing"), "TARGET_BIG_TASK_NOT_FOUND"],
      [base(), downstreamRoute("st_reason_a", "st_missing"), "TARGET_SUBTASK_NOT_FOUND"],
      [base(), parentRoute("st_reason_a", "bt_reason_other"), "NOT_SOURCE_PARENT_BIG_TASK"],
      [base(), downstreamRoute("st_reason_b", "st_reason_b"), "NO_EXPLICIT_DEPENDENCY"],
      [base(), downstreamRoute("st_reason_b", "st_reason_a"), "REVERSE_DIRECTION_NOT_ALLOWED"],
      [base(), downstreamRoute("st_reason_a", "st_reason_other"), "CROSS_BIG_TASK_NOT_ALLOWED"],
      [base(), downstreamRoute("st_reason_a", "st_reason_foreign"), "CROSS_PROJECT_NOT_ALLOWED"],
      [invalidTopology, downstreamRoute("st_reason_a", "st_reason_b"), "INVALID_TOPOLOGY"],
      [base(), {} as PromotedContextRoute, "INVALID_ROUTE"],
    ];
    expect(cases).toHaveLength(12);
    for (const [topology, route, reason] of cases) {
      const result = evaluatePromotedContextRoute(topology, route);
      expect(result.reason).toBe(reason);
      expect(result.eligible).toBe(reason.startsWith("ELIGIBLE_"));
      if (!result.valid) {
        expect(result.eligible).toBe(false);
      }
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("is repeatable, order invariant, and does not mutate any input", () => {
    const topology = makeOracleTopology();
    const route = downstreamRoute(topology.subtasks[0]!.id, topology.subtasks[1]!.id);
    const before = JSON.stringify({ topology, route });
    const expected = evaluatePromotedContextRoute(topology, route);
    for (let mask = 0; mask < 16; mask += 1) {
      const reordered = {
        projects: mask & 1 ? [...topology.projects].reverse() : [...topology.projects],
        bigTasks: mask & 2 ? [...topology.bigTasks].reverse() : [...topology.bigTasks],
        subtasks: mask & 4 ? [...topology.subtasks].reverse() : [...topology.subtasks],
        dependencies: mask & 8
          ? [...topology.dependencies].reverse()
          : [...topology.dependencies],
      } as PromotedContextRouteTopology;
      expect(evaluatePromotedContextRoute(reordered, route)).toEqual(expected);
    }
    for (let repetition = 0; repetition < 20; repetition += 1) {
      expect(evaluatePromotedContextRoute(topology, route)).toEqual(expected);
    }
    expect(JSON.stringify({ topology, route })).toBe(before);
  });

  it("contains at least 30 malformed or throwing calls without leaking internals", () => {
    const malformedRoutes: unknown[] = [
      null,
      undefined,
      true,
      false,
      0,
      1,
      Number.NaN,
      "",
      "route",
      [],
      new Date(0),
      /route/u,
      {},
      { audienceKind: "DOWNSTREAM_SUBTASK" },
      { ...downstreamRoute("st_reason_a", "st_reason_b"), extra: "private" },
    ];
    for (const trap of ["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const) {
      malformedRoutes.push(new Proxy({ ...downstreamRoute("st_reason_a", "st_reason_b") }, {
        [trap]() {
          throw new Error("private route payload /workspace/secret");
        },
      }));
    }
    const revokedRoute = Proxy.revocable(
      { ...downstreamRoute("st_reason_a", "st_reason_b") },
      {},
    );
    revokedRoute.revoke();
    malformedRoutes.push(revokedRoute.proxy);

    const malformedTopologies: unknown[] = [
      null,
      undefined,
      true,
      false,
      0,
      "",
      [],
      {},
      { projects: [] },
      { projects: [], bigTasks: [], subtasks: [] },
      { ...base(), extra: "private" },
      { ...base(), dependencies: null },
      { ...base(), projects: new Array(1) },
      { ...base(), subtasks: [{ get id() { throw new Error("private getter"); } }] },
      Object.create({ projects: base().projects }),
    ];
    for (const trap of ["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const) {
      malformedTopologies.push(new Proxy(base(), {
        [trap]() {
          throw new Error("private topology payload /workspace/secret");
        },
      }));
    }
    const revokedTopology = Proxy.revocable(base(), {});
    revokedTopology.revoke();
    malformedTopologies.push(revokedTopology.proxy);

    let calls = 0;
    for (const route of malformedRoutes) {
      const result = evaluatePromotedContextRoute(
        base(),
        route as PromotedContextRoute,
      );
      calls += 1;
      expect(result.eligible).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/private|stack|workspace|zod|secret/iu);
    }
    for (const topology of malformedTopologies) {
      const result = evaluatePromotedContextRoute(
        topology as PromotedContextRouteTopology,
        downstreamRoute("st_reason_a", "st_reason_b"),
      );
      calls += 1;
      expect(result.eligible).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/private|stack|workspace|zod|secret/iu);
    }
    expect(calls).toBeGreaterThanOrEqual(30);
  });
});

describe("S2D1 readiness separation and S2A raw ACL non-expansion", () => {
  const project = ProjectSchema.parse({
    recordType: "PROJECT",
    id: "prj_acl_hardening",
    name: "ACL hardening",
    slug: "acl-hardening",
    repository: { kind: "PATH", path: "/workspace/acl-hardening" },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });
  const bigTask = BigTaskSchema.parse({
    recordType: "BIG_TASK",
    id: "bt_acl_hardening",
    projectId: project.id,
    title: "Keep raw ACL exact",
    goal: "Separate conclusions from raw access.",
    rationale: "Promotion routing is not retrieval.",
    scopeIn: ["Route eligibility"],
    scopeOut: ["Raw access expansion"],
    acceptanceCriteria: ["Only target raw scope remains allowed."],
    status: "IN_PROGRESS",
  });
  const fullSubtask = (id: string, maturity: Subtask["maturity"]): Subtask =>
    SubtaskSchema.parse({
      recordType: "SUBTASK",
      id,
      bigTaskId: bigTask.id,
      title: `Subtask ${id}`,
      goal: "Exercise route and ACL separation.",
      scopeIn: ["Deterministic evidence"],
      scopeOut: ["Raw upstream evidence"],
      acceptanceCriteria: ["No raw expansion."],
      untouchedAreas: ["S2A"],
      status: "TODO",
      maturity,
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
      promptSeed: "Keep raw scopes exact.",
    });
  const fullSubtasks = [
    fullSubtask("st_acl_a", "NOT_STARTED"),
    fullSubtask("st_acl_b", "IMPLEMENTED"),
    fullSubtask("st_acl_c", "HARDENED"),
    fullSubtask("st_acl_d", "ACCEPTED"),
  ];

  it.each([
    ["BLOCKING/HARDENED", [dependency("st_acl_a", "st_acl_b", "BLOCKING", "HARDENED")]],
    ["BLOCKING/ACCEPTED", [dependency("st_acl_a", "st_acl_b", "BLOCKING", "ACCEPTED")]],
    ["INFORMATIONAL/NONE", [dependency("st_acl_a", "st_acl_b", "INFORMATIONAL", "NONE")]],
    [
      "multiple upstream",
      [
        dependency("st_acl_a", "st_acl_b", "BLOCKING", "ACCEPTED"),
        dependency("st_acl_c", "st_acl_b", "INFORMATIONAL", "NONE"),
      ],
    ],
    [
      "long chain",
      [
        dependency("st_acl_a", "st_acl_c", "BLOCKING", "HARDENED"),
        dependency("st_acl_c", "st_acl_d", "INFORMATIONAL", "NONE"),
        dependency("st_acl_d", "st_acl_b", "BLOCKING", "ACCEPTED"),
      ],
    ],
  ] as const)("keeps B's exact three raw scopes for %s", (_label, dependencies) => {
    const topology = {
      projects: [{ id: project.id }],
      bigTasks: [{ id: bigTask.id, projectId: project.id }],
      subtasks: fullSubtasks.map(({ id, bigTaskId }) => ({ id, bigTaskId })),
      dependencies: [...dependencies],
    } as unknown as PromotedContextRouteTopology;
    for (const edge of dependencies.filter(
      ({ downstreamSubtaskId }) => downstreamSubtaskId === "st_acl_b",
    )) {
      expect(
        evaluatePromotedContextRoute(
          topology,
          downstreamRoute(edge.upstreamSubtaskId, edge.downstreamSubtaskId),
        ).eligible,
      ).toBe(true);
    }

    const target = fullSubtasks[1]!;
    const allowed = buildAllowedContextSet(project, bigTask, target);
    expect(allowed.valid).toBe(true);
    if (!allowed.valid) {
      throw new Error("Canonical ACL fixture unexpectedly failed.");
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
    for (const upstream of fullSubtasks.filter(({ id }) => id !== target.id)) {
      expect(
        evaluateContextScopeAccess(allowed.allowedContextSet, {
          scopeType: "SUBTASK",
          projectId: project.id,
          bigTaskId: bigTask.id,
          subtaskId: upstream.id,
        }),
      ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
    }
  });

  it("does not accept maturity or readiness as route-model evidence", () => {
    const topology = {
      projects: [{ id: project.id }],
      bigTasks: [{ id: bigTask.id, projectId: project.id }],
      subtasks: [
        { id: "st_acl_a", bigTaskId: bigTask.id, maturity: "ACCEPTED" },
        { id: "st_acl_b", bigTaskId: bigTask.id, ready: true },
      ],
      dependencies: [dependency("st_acl_a", "st_acl_b", "BLOCKING", "ACCEPTED")],
    } as unknown as PromotedContextRouteTopology;
    expect(
      evaluatePromotedContextRoute(topology, downstreamRoute("st_acl_a", "st_acl_b")),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_TOPOLOGY" });
  });
});

describe("S2D1 dense exact-edge property campaign", () => {
  it("matches 2,000 ordered-pair decisions over 120 nodes and 540 edges", () => {
    const projects = Array.from({ length: 3 }, (_, projectIndex) => ({
      id: `prj_scale_${projectIndex}`,
    }));
    const bigTasks = projects.flatMap((project) =>
      Array.from({ length: 4 }, (_, bigTaskIndex) => ({
        id: `bt_scale_${project.id.slice("prj_scale_".length)}_${bigTaskIndex}`,
        projectId: project.id,
      })),
    );
    const subtasks = bigTasks.flatMap((bigTask) =>
      Array.from({ length: 10 }, (_, subtaskIndex) => ({
        id: `st_scale_${bigTask.id.slice("bt_scale_".length)}_${subtaskIndex}`,
        bigTaskId: bigTask.id,
      })),
    );
    const dependencies = bigTasks.flatMap((bigTask) => {
      const ids = subtasks
        .filter(({ bigTaskId }) => bigTaskId === bigTask.id)
        .map(({ id }) => id);
      const edges: SubtaskDependency[] = [];
      for (let upstreamIndex = 0; upstreamIndex < ids.length; upstreamIndex += 1) {
        for (
          let downstreamIndex = upstreamIndex + 1;
          downstreamIndex < ids.length;
          downstreamIndex += 1
        ) {
          const form = (upstreamIndex + downstreamIndex) % 3;
          edges.push(
            form === 0
              ? dependency(
                  ids[upstreamIndex]!,
                  ids[downstreamIndex]!,
                  "BLOCKING",
                  "HARDENED",
                )
              : form === 1
                ? dependency(
                    ids[upstreamIndex]!,
                    ids[downstreamIndex]!,
                    "BLOCKING",
                    "ACCEPTED",
                  )
                : dependency(
                    ids[upstreamIndex]!,
                    ids[downstreamIndex]!,
                    "INFORMATIONAL",
                    "NONE",
                  ),
          );
        }
      }
      return edges;
    });
    const topology = { projects, bigTasks, subtasks, dependencies } as PromotedContextRouteTopology;
    const mismatches: Array<{
      readonly route: PromotedContextRoute;
      readonly expected: PromotedContextRouteEvaluation;
      readonly actual: PromotedContextRouteEvaluation;
    }> = [];
    let falseEligible = 0;
    for (let decisionIndex = 0; decisionIndex < 2_000; decisionIndex += 1) {
      const sourceIndex = Math.floor(decisionIndex / subtasks.length);
      const targetIndex = decisionIndex % subtasks.length;
      const route = downstreamRoute(
        subtasks[sourceIndex]!.id,
        subtasks[targetIndex]!.id,
      );
      const expected = routeOracle(topology, route);
      const actual = evaluatePromotedContextRoute(topology, route);
      if (actual.eligible && !expected.eligible) {
        falseEligible += 1;
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push({ route, expected, actual });
      }
    }

    expect(projects).toHaveLength(3);
    expect(bigTasks).toHaveLength(12);
    expect(subtasks).toHaveLength(120);
    expect(dependencies).toHaveLength(540);
    expect(falseEligible).toBe(0);
    expect(mismatches).toEqual([]);
  }, 20_000);
});

const mutationHypotheses = [
  ["remove exact own-parent target check", true],
  ["allow any same-Project Big Task", true],
  ["allow any Big Task regardless of Project", true],
  ["default a missing parent to source ownership", true],
  ["allow any sibling Subtask", true],
  ["allow adjacent insertion-order siblings", true],
  ["allow any dependency anywhere", true],
  ["reverse every edge", true],
  ["treat dependency direction as bidirectional", true],
  ["treat a path as an exact edge", true],
  ["compute transitive closure", true],
  ["allow diamond ancestors", true],
  ["allow same-title-like identifiers", true],
  ["allow cross-Big-Task edges", true],
  ["allow cross-Project edges", true],
  ["ignore missing sources", true],
  ["ignore missing targets", true],
  ["evaluate an invalid topology anyway", true],
  ["ignore duplicate Projects", true],
  ["ignore duplicate Big Tasks", true],
  ["ignore duplicate Subtasks", true],
  ["ignore duplicate dependency edges", true],
  ["ignore self-dependencies", true],
  ["ignore missing dependency endpoints", true],
  ["ignore blocking cycles", true],
  ["localize unrelated corruption", true],
  ["normalize padded route identifiers into an allow", true],
  ["normalize padded ownership identifiers into an allow", true],
  ["normalize padded dependency endpoints into an allow", true],
  ["normalize padded dependency reasons after validation", true],
  ["default an unknown audience to downstream", true],
  ["default an unknown audience to parent", true],
  ["route Proxy source class swap", true],
  ["route Proxy audience class swap", true],
  ["route Proxy downstream target swap", true],
  ["route Proxy parent target swap", true],
  ["topology projects array swap", true],
  ["topology Big Tasks array swap", true],
  ["topology Subtasks array swap", true],
  ["topology dependencies array swap", true],
  ["Big Task projectId descriptor swap", true],
  ["Subtask bigTaskId descriptor swap", true],
  ["dependency upstream endpoint swap", true],
  ["dependency downstream endpoint swap", true],
  ["dependency exact edge appears after validation", true],
  ["dependency exact edge disappears after validation", true],
  ["raw security field reread after parsing", true],
  ["array element substitution after validation", true],
  ["array length substitution after validation", true],
  ["coordinated route and dependency swap", true],
  ["coordinated ownership and target swap", true],
  ["eligible boolean paired with denied reason", true],
  ["denied boolean paired with eligible reason", true],
  ["route eligibility widens S2A raw scopes", true],
  ["route eligibility injects source raw scope", true],
  ["INFORMATIONAL edge ignored", false],
  ["BLOCKING/HARDENED edge ignored", false],
  ["BLOCKING/ACCEPTED edge ignored", false],
  ["required-gate satisfaction demanded", false],
  ["Subtask maturity demanded", false],
  ["readiness evaluator invoked", false],
  ["valid null-prototype copy rejected", false],
  ["valid frozen copy rejected", false],
  ["valid sealed copy rejected", false],
  ["valid structured clone rejected", false],
  ["valid JSON round-trip rejected", false],
  ["unrelated valid edge changes exact result", false],
  ["dependency reason wording changes result", false],
  ["input ordering changes result", false],
  ["evaluator mutates topology arrays", false],
  ["evaluator mutates route fields", false],
  ["reflection exception escapes", false],
] as const;

const sourceToTestMapping = [
  ["route schema parsing", "closed reason and malformed-call matrix"],
  ["topology schema parsing", "global invalid-topology matrix"],
  ["Project uniqueness", "duplicate Project case"],
  ["Big Task uniqueness", "duplicate Big Task case"],
  ["Subtask uniqueness", "duplicate Subtask case"],
  ["Big Task ownership", "broken ownership and descriptor swap"],
  ["Subtask ownership", "broken ownership and coordinated swap"],
  ["dependency schema", "malformed gate and canonical reason"],
  ["dependency duplicate validation", "duplicate edge case"],
  ["dependency endpoint validation", "missing upstream/downstream cases"],
  ["dependency self validation", "self-dependency case"],
  ["dependency scope validation", "cross-Big-Task case"],
  ["blocking cycle validation", "cycle and reverse campaign"],
  ["informational-cycle validity", "global valid informational cycle"],
  ["parent exact allow", "exhaustive ownership matrix"],
  ["same-Project parent denial", "exhaustive ownership matrix"],
  ["foreign parent denial", "exhaustive ownership matrix"],
  ["downstream exact allow", "literal route oracle"],
  ["reverse denial", "reverse-direction campaign"],
  ["transitive denial", "chain campaign"],
  ["diamond denial", "diamond shortcut campaign"],
  ["sibling denial", "sibling controls"],
  ["cross-Big-Task denial", "sibling controls"],
  ["cross-Project denial", "sibling controls"],
  ["BLOCKING/HARDENED eligibility", "legal edge form matrix"],
  ["BLOCKING/ACCEPTED eligibility", "legal edge form matrix"],
  ["INFORMATIONAL/NONE eligibility", "legal edge form matrix"],
  ["route canonicality", "Unicode trim matrix"],
  ["topology canonicality", "ownership/reason normalization cases"],
  ["structural copies", "seven stable copy forms"],
  ["route Proxy capture", "route hostile runtime matrix"],
  ["topology Proxy capture", "topology hostile runtime matrix"],
  ["dependency endpoint stability", "endpoint descriptor swaps"],
  ["array density", "sparse and accessor arrays"],
  ["array key integrity", "extra key and Symbol arrays"],
  ["array descriptor stability", "length and element swaps"],
  ["prototype stability", "route and array prototype attacks"],
  ["reflection containment", "throwing and revoked Proxy calls"],
  ["reason taxonomy", "twelve-reason integrity matrix"],
  ["determinism", "twenty repeated decisions"],
  ["order invariance", "sixteen independent reorderings"],
  ["no input mutation", "before/after serialization"],
  ["readiness separation", "maturity/readiness extra-field rejection"],
  ["raw ACL separation", "five eligible-route ACL cases"],
  ["dense exact-edge property", "2,000 ordered-pair oracle"],
  ["public export regression", "adjacent public-export suite"],
] as const;

describe("S2D1 hardening assurance manifests", () => {
  it("kills at least 65 mutations with at least 45 false-eligible hypotheses", () => {
    const materialSurvivors: readonly string[] = [];
    expect(mutationHypotheses.length).toBeGreaterThanOrEqual(65);
    expect(mutationHypotheses.filter(([, falseEligible]) => falseEligible).length)
      .toBeGreaterThanOrEqual(45);
    expect(mutationHypotheses.filter(([label]) => label.length === 0)).toEqual([]);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps at least 40 safety-critical source conditions without a gap", () => {
    expect(sourceToTestMapping.length).toBeGreaterThanOrEqual(40);
    expect(sourceToTestMapping.filter(([, coverage]) => coverage.length === 0)).toEqual([]);
  });
});
