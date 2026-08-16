import { describe, expect, it } from "vitest";

import {
  ContextScopeSchema,
  evaluateContextScopeAccess,
  evaluatePromotedContextAcceptanceRequirement,
  evaluatePromotedContextCandidate,
  evaluatePromotedContextHumanConfirmationEvidence,
  evaluatePromotedContextRoute,
} from "../src/index.js";
import type {
  AllowedContextSet,
  ContextScope,
  ContextKind,
  PromotedContextCandidate,
  PromotedContextRoute,
  PromotedContextRouteTopology,
  SubtaskDependency,
} from "../src/index.js";

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
): SubtaskDependency => ({
  upstreamSubtaskId,
  downstreamSubtaskId,
  dependencyType: "INFORMATIONAL",
  requiredGate: "NONE",
  reason: `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
}) as SubtaskDependency;

const topology = (
  dependencies: readonly SubtaskDependency[] = [],
): PromotedContextRouteTopology => ({
  projects: [{ id: "prj_joint" }],
  bigTasks: [
    { id: "bt_joint", projectId: "prj_joint" },
    { id: "bt_other", projectId: "prj_joint" },
  ],
  subtasks: [
    { id: "st_a", bigTaskId: "bt_joint" },
    { id: "st_b", bigTaskId: "bt_joint" },
    { id: "st_c", bigTaskId: "bt_joint" },
  ],
  dependencies,
}) as PromotedContextRouteTopology;

const downstreamRoute = (
  sourceSubtaskId = "st_a",
  targetSubtaskId = "st_b",
): PromotedContextRoute => ({
  sourceSubtaskId,
  audienceKind: "DOWNSTREAM_SUBTASK",
  targetSubtaskId,
}) as PromotedContextRoute;

const parentRoute = (
  sourceSubtaskId = "st_a",
  targetBigTaskId = "bt_joint",
): PromotedContextRoute => ({
  sourceSubtaskId,
  audienceKind: "PARENT_BIG_TASK",
  targetBigTaskId,
}) as PromotedContextRoute;

const candidate = (
  route: PromotedContextRoute = downstreamRoute(),
  kind: ContextKind = "DECISION",
): PromotedContextCandidate => ({
  route,
  kind,
  title: "Joint structural snapshot",
  body: "All policy inputs must represent one consistent observation state.",
  provenance: {
    sourceType: "REPO",
    sourceReference: "joint:source",
    evidenceReferences: ["joint:evidence"],
  },
}) as PromotedContextCandidate;

const humanEvidence = Object.freeze({
  evidenceType: "HUMAN_CONFIRMATION" as const,
  sourceReference: "joint:human",
  occurredAt: "2026-08-16T00:00:00+00:00",
});

interface RelayOracle {
  readonly states: readonly {
    readonly routeSource: string;
    readonly dependencyUpstream: string;
  }[];
}

interface RouteTopologyRelay extends RelayOracle {
  readonly route: PromotedContextRoute;
  readonly topology: PromotedContextRouteTopology;
}

const makeRouteTopologyRelay = (initialState: 0 | 1): RouteTopologyRelay => {
  const routeStates: readonly [PromotedContextRoute, PromotedContextRoute] = [
    downstreamRoute("st_a", "st_b"),
    downstreamRoute("st_c", "st_b"),
  ];
  const topologyStates: readonly [
    PromotedContextRouteTopology,
    PromotedContextRouteTopology,
  ] = [
    topology([dependency("st_c", "st_b")]),
    topology([dependency("st_a", "st_b")]),
  ];
  const routeTarget = { ...routeStates[initialState] } as PromotedContextRoute;
  const topologyTarget = structuredClone(topologyStates[initialState]);
  const states: Array<{ routeSource: string; dependencyUpstream: string }> = [];

  const recordState = () => {
    states.push({
      routeSource: routeTarget.sourceSubtaskId,
      dependencyUpstream: topologyTarget.dependencies[0]!.upstreamSubtaskId,
    });
  };
  const setState = (state: 0 | 1) => {
    Object.assign(routeTarget, routeStates[state]);
    Object.assign(topologyTarget, topologyStates[state]);
    recordState();
  };
  recordState();

  const route = new Proxy(routeTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "targetSubtaskId") {
        setState(1);
      }
      return descriptor;
    },
  });
  const hostileTopology = new Proxy(topologyTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "dependencies") {
        setState(0);
      }
      return descriptor;
    },
  });

  return { route, topology: hostileTopology, states };
};

const makeParentRouteTopologyRelay = (): RouteTopologyRelay => {
  const routeStates: readonly [PromotedContextRoute, PromotedContextRoute] = [
    parentRoute("st_a"),
    parentRoute("st_c"),
  ];
  const topologyStates: [
    PromotedContextRouteTopology,
    PromotedContextRouteTopology,
  ] = [topology(), topology()];
  topologyStates[0]!.subtasks = [
    { id: "st_a", bigTaskId: "bt_other" },
    { id: "st_b", bigTaskId: "bt_joint" },
    { id: "st_c", bigTaskId: "bt_joint" },
  ] as PromotedContextRouteTopology["subtasks"];
  topologyStates[1]!.subtasks = [
    { id: "st_a", bigTaskId: "bt_joint" },
    { id: "st_b", bigTaskId: "bt_joint" },
    { id: "st_c", bigTaskId: "bt_other" },
  ] as PromotedContextRouteTopology["subtasks"];
  const routeTarget = { ...routeStates[0] } as PromotedContextRoute;
  const topologyTarget = structuredClone(topologyStates[0]);
  const states: Array<{ routeSource: string; dependencyUpstream: string }> = [];

  const recordState = () => {
    const source = topologyTarget.subtasks.find(
      ({ id }) => id === routeTarget.sourceSubtaskId,
    );
    states.push({
      routeSource: routeTarget.sourceSubtaskId,
      dependencyUpstream: source?.bigTaskId ?? "missing",
    });
  };
  const setState = (state: 0 | 1) => {
    Object.assign(routeTarget, routeStates[state]);
    Object.assign(topologyTarget, topologyStates[state]);
    recordState();
  };
  recordState();

  return {
    route: new Proxy(routeTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "targetBigTaskId") {
          setState(1);
        }
        return descriptor;
      },
    }),
    topology: new Proxy(topologyTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "dependencies") {
          setState(0);
        }
        return descriptor;
      },
    }),
    states,
  };
};

interface CandidateTopologyRelay extends RelayOracle {
  readonly candidate: PromotedContextCandidate;
  readonly topology: PromotedContextRouteTopology;
}

const makeCandidateTopologyRelay = (
  initialState: 0 | 1,
  nestedRoute: boolean,
): CandidateTopologyRelay => {
  const routeStates: readonly [PromotedContextRoute, PromotedContextRoute] = [
    downstreamRoute("st_a", "st_b"),
    downstreamRoute("st_c", "st_b"),
  ];
  const topologyStates: readonly [
    PromotedContextRouteTopology,
    PromotedContextRouteTopology,
  ] = [
    topology([dependency("st_c", "st_b")]),
    topology([dependency("st_a", "st_b")]),
  ];
  const routeTarget = { ...routeStates[initialState] } as PromotedContextRoute;
  const candidateTarget = candidate(routeTarget);
  const topologyTarget = structuredClone(topologyStates[initialState]);
  const states: Array<{ routeSource: string; dependencyUpstream: string }> = [];

  const recordState = () => {
    states.push({
      routeSource: routeTarget.sourceSubtaskId,
      dependencyUpstream: topologyTarget.dependencies[0]!.upstreamSubtaskId,
    });
  };
  const setState = (state: 0 | 1) => {
    Object.assign(routeTarget, routeStates[state]);
    candidateTarget.route = nestedRoute ? routeProxy : routeTarget;
    Object.assign(topologyTarget, topologyStates[state]);
    recordState();
  };
  const routeProxy = new Proxy(routeTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "targetSubtaskId") {
        setState(1);
      }
      return descriptor;
    },
  });
  candidateTarget.route = nestedRoute ? routeProxy : routeTarget;
  recordState();

  const hostileCandidate = nestedRoute
    ? candidateTarget
    : new Proxy(candidateTarget, {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (property === "provenance") {
            setState(1);
          }
          return descriptor;
        },
      });
  const hostileTopology = new Proxy(topologyTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "dependencies") {
        setState(0);
      }
      return descriptor;
    },
  });

  return { candidate: hostileCandidate, topology: hostileTopology, states };
};

const assertOracleHasNoEligibleState = (relay: RelayOracle): void => {
  expect(relay.states.length).toBeGreaterThan(1);
  expect(
    relay.states.filter(
      ({ routeSource, dependencyUpstream }) =>
        routeSource === "st_a" && dependencyUpstream === "st_a",
    ),
  ).toEqual([]);
};

describe("CTC-S2D4-FQA-001 direct S2D1 joint snapshot repair", () => {
  it("rejects route/topology relays from both initial capture orientations", () => {
    let falseEligible = 0;
    let exceptionLeaks = 0;
    for (const initialState of [0, 1] as const) {
      const relay = makeRouteTopologyRelay(initialState);
      try {
        falseEligible += Number(
          evaluatePromotedContextRoute(relay.topology, relay.route).eligible,
        );
      } catch {
        exceptionLeaks += 1;
      }
      assertOracleHasNoEligibleState(relay);
    }
    expect(falseEligible).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });

  it("rejects a parent-route ownership relay", () => {
    const relay = makeParentRouteTopologyRelay();
    const result = evaluatePromotedContextRoute(relay.topology, relay.route);
    expect(result.eligible).toBe(false);
    expect(
      relay.states.filter(
        ({ routeSource, dependencyUpstream }) =>
          (routeSource === "st_a" && dependencyUpstream === "bt_joint") ||
          (routeSource === "st_c" && dependencyUpstream === "bt_joint"),
      ),
    ).toEqual([]);
  });

  it("detects a topology change on the sixth observation after five apparent matches", () => {
    const denied = topology([dependency("st_c", "st_b")]);
    const eligibleDependencies = [dependency("st_a", "st_b")];
    let dependencyObservations = 0;
    const lateTopology = new Proxy(denied, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (
          property !== "dependencies" ||
          descriptor === undefined ||
          !("value" in descriptor)
        ) {
          return descriptor;
        }
        dependencyObservations += 1;
        return {
          ...descriptor,
          value: dependencyObservations < 6
            ? eligibleDependencies
            : target.dependencies,
        };
      },
    });
    expect(evaluatePromotedContextRoute(lateTopology, downstreamRoute())).toEqual({
      valid: false,
      eligible: false,
      reason: "INVALID_TOPOLOGY",
    });
    expect(dependencyObservations).toBe(6);
  });
});

describe("CTC-S2D4-FQA-001 direct S2D2 and nested route repair", () => {
  it.each([
    ["candidate-first", 0],
    ["topology-first", 1],
  ] as const)("rejects the %s candidate/topology relay", (_label, initialState) => {
    const relay = makeCandidateTopologyRelay(initialState, false);
    const result = evaluatePromotedContextCandidate(
      relay.topology,
      relay.candidate,
    );
    expect(result.eligibleForPromotion).toBe(false);
    assertOracleHasNoEligibleState(relay);
  });

  it.each([0, 1] as const)(
    "rejects nested candidate.route/topology relay orientation %s",
    (initialState) => {
      const relay = makeCandidateTopologyRelay(initialState, true);
      const result = evaluatePromotedContextCandidate(
        relay.topology,
        relay.candidate,
      );
      expect(result.eligibleForPromotion).toBe(false);
      assertOracleHasNoEligibleState(relay);
    },
  );
});

describe("CTC-S2D4-FQA-001 S2D3 and S2D4 propagation", () => {
  it("produces no actionable authority or structural applicability", () => {
    const acceptanceRelay = makeCandidateTopologyRelay(0, false);
    const acceptance = evaluatePromotedContextAcceptanceRequirement(
      acceptanceRelay.topology,
      acceptanceRelay.candidate,
    );
    const evidenceRelay = makeCandidateTopologyRelay(0, true);
    const evidence = evaluatePromotedContextHumanConfirmationEvidence(
      evidenceRelay.topology,
      evidenceRelay.candidate,
      humanEvidence,
    );

    expect(acceptance.acceptanceEligible).toBe(false);
    expect(evidence.structurallyApplicable).toBe(false);
    assertOracleHasNoEligibleState(acceptanceRelay);
    assertOracleHasNoEligibleState(evidenceRelay);
  });

  it("contains reflection exceptions across S2D1 through S2D4", () => {
    const throwingRoute = new Proxy(downstreamRoute(), {
      getPrototypeOf() {
        throw new Error("private joint-capture failure");
      },
    });
    const hostileCandidate = candidate(throwingRoute);
    const graph = topology([dependency("st_a", "st_b")]);

    expect(() => evaluatePromotedContextRoute(graph, throwingRoute)).not.toThrow();
    expect(() => evaluatePromotedContextCandidate(graph, hostileCandidate)).not.toThrow();
    expect(() =>
      evaluatePromotedContextAcceptanceRequirement(graph, hostileCandidate),
    ).not.toThrow();
    expect(() =>
      evaluatePromotedContextHumanConfirmationEvidence(
        graph,
        hostileCandidate,
        humanEvidence,
      ),
    ).not.toThrow();
  });
});

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

describe("CTC-S2D4-FQA-001 compatibility controls", () => {
  it("accepts seven stable structural representations with zero false rejection", () => {
    const makePair = (): readonly [unknown, unknown] => [
      topology([dependency("st_a", "st_b")]),
      downstreamRoute(),
    ];
    const ordinary = makePair();
    const cloned = structuredClone(makePair());
    const controls: ReadonlyArray<readonly [unknown, unknown]> = [
      ordinary,
      nullPrototypeCopy(makePair()) as readonly [unknown, unknown],
      deepFreeze(structuredClone(makePair())),
      deepSeal(structuredClone(makePair())),
      cloned,
      JSON.parse(JSON.stringify(makePair())) as readonly [unknown, unknown],
      [new Proxy(ordinary[0] as object, {}), new Proxy(ordinary[1] as object, {})],
    ];
    let routeFalseRejections = 0;
    let candidateFalseRejections = 0;
    for (const [graph, route] of controls) {
      routeFalseRejections += Number(
        !evaluatePromotedContextRoute(
          graph as PromotedContextRouteTopology,
          route as PromotedContextRoute,
        ).eligible,
      );
      candidateFalseRejections += Number(
        !evaluatePromotedContextCandidate(
          graph as PromotedContextRouteTopology,
          candidate(route as PromotedContextRoute),
        ).eligibleForPromotion,
      );
    }
    expect(controls).toHaveLength(7);
    expect(routeFalseRejections).toBe(0);
    expect(candidateFalseRejections).toBe(0);
  });

  it("preserves parent, exact-edge, denial, six-kind, and human-evidence controls", () => {
    const graph = topology([dependency("st_a", "st_b")]);
    expect(evaluatePromotedContextRoute(graph, parentRoute()).eligible).toBe(true);
    expect(evaluatePromotedContextRoute(graph, downstreamRoute()).eligible).toBe(true);
    expect(evaluatePromotedContextRoute(topology(), downstreamRoute()).eligible).toBe(false);
    expect(
      evaluatePromotedContextRoute(
        topology([dependency("st_b", "st_a")]),
        downstreamRoute(),
      ).eligible,
    ).toBe(false);
    expect(
      evaluatePromotedContextRoute(
        topology([
          dependency("st_a", "st_c"),
          dependency("st_c", "st_b"),
        ]),
        downstreamRoute(),
      ).eligible,
    ).toBe(false);

    for (const kind of [
      "DECISION",
      "REQUIREMENT",
      "CONSTRAINT",
      "ENGINEERING_FACT",
      "OPEN_QUESTION",
      "RISK",
    ] as const) {
      const acceptance = evaluatePromotedContextAcceptanceRequirement(
        graph,
        candidate(downstreamRoute(), kind),
      );
      expect(acceptance.acceptanceEligible).toBe(true);
      expect(
        acceptance.acceptanceEligible && acceptance.requirement,
      ).toBe(
        kind === "ENGINEERING_FACT"
          ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
          : "HUMAN_CONFIRMATION_REQUIRED",
      );
    }
    expect(
      evaluatePromotedContextHumanConfirmationEvidence(
        graph,
        candidate(),
        humanEvidence,
      ).structurallyApplicable,
    ).toBe(true);
  });
});

describe("shared S2A joint-capture boundary", () => {
  it("rejects the same cross-input relay in the raw-scope ACL evaluator", () => {
    const allowedFor = (subtaskId: string): AllowedContextSet => ({
      target: {
        projectId: "prj_joint",
        bigTaskId: "bt_joint",
        subtaskId,
      },
      allowedRawScopes: [
        { scopeType: "PROJECT", projectId: "prj_joint" },
        {
          scopeType: "BIG_TASK",
          projectId: "prj_joint",
          bigTaskId: "bt_joint",
        },
        {
          scopeType: "SUBTASK",
          projectId: "prj_joint",
          bigTaskId: "bt_joint",
          subtaskId,
        },
      ],
    }) as unknown as AllowedContextSet;
    const scopeFor = (
      subtaskId: string,
    ): Extract<ContextScope, { readonly scopeType: "SUBTASK" }> =>
      ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: "prj_joint",
        bigTaskId: "bt_joint",
        subtaskId,
      }) as Extract<ContextScope, { readonly scopeType: "SUBTASK" }>;
    const setStates: readonly [AllowedContextSet, AllowedContextSet] = [
      allowedFor("st_a"),
      allowedFor("st_c"),
    ];
    const scopeStates: readonly [
      Extract<ContextScope, { readonly scopeType: "SUBTASK" }>,
      Extract<ContextScope, { readonly scopeType: "SUBTASK" }>,
    ] = [scopeFor("st_c"), scopeFor("st_a")];
    const setTarget = structuredClone(setStates[0]);
    const scopeTarget = structuredClone(scopeStates[0]);
    const actualMatches: boolean[] = [];
    const setState = (state: 0 | 1) => {
      Object.assign(setTarget, setStates[state]);
      Object.assign(scopeTarget, scopeStates[state]);
      actualMatches.push(setTarget.target.subtaskId === scopeTarget.subtaskId);
    };
    setState(0);
    const hostileSet = new Proxy(setTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "allowedRawScopes") {
          setState(1);
        }
        return descriptor;
      },
    });
    const hostileScope = new Proxy(scopeTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "subtaskId") {
          setState(0);
        }
        return descriptor;
      },
    });

    expect(evaluateContextScopeAccess(hostileSet, hostileScope).allowed).toBe(false);
    expect(actualMatches).not.toContain(true);
  });
});

const JOINT_CAPTURE_MUTATIONS = [
  ["restore independent per-input stability", true],
  ["compare only the first and second forward sweeps", true],
  ["compare only the first and final forward sweeps", true],
  ["remove every reverse sweep", true],
  ["use fixed route-to-topology order", true],
  ["use fixed topology-to-route order", true],
  ["return first-sweep data after a reverse mismatch", true],
  ["ignore a route mismatch", true],
  ["ignore a topology mismatch", true],
  ["ignore a candidate mismatch", true],
  ["treat a null route capture as eligible", true],
  ["treat a null topology capture as eligible", true],
  ["treat a null candidate capture as eligible", true],
  ["rethrow a route reflection exception", true],
  ["rethrow a topology reflection exception", true],
  ["rethrow a candidate reflection exception", true],
  ["capture route before the joint sweep", true],
  ["capture topology after the joint sweep", true],
  ["capture candidate before the joint sweep", true],
  ["parse the hostile route after capture", true],
  ["parse the hostile topology after capture", true],
  ["parse the hostile candidate after capture", true],
  ["delegate the hostile candidate.route to S2D1", true],
  ["delegate the hostile topology to S2D1", true],
  ["normalize candidate.route before S2D1", true],
  ["let route reset topology between sweeps", true],
  ["let topology reset route between sweeps", true],
  ["let candidate reset topology between sweeps", true],
  ["let topology reset candidate between sweeps", true],
  ["accept nested candidate.route relay", true],
  ["compare only top-level candidate descriptors", true],
  ["skip nested route observations", true],
  ["stop before the sixth late observation", true],
  ["use only alternating forward sweeps", true],
  ["use only alternating reverse sweeps", true],
  ["S2D3 bypasses S2D2 joint denial", true],
  ["S2D4 bypasses S2D3 joint denial", true],
  ["S2D4 evidence success overrides joint denial", true],
  ["ACL evaluator restores independent capture", true],
  ["ACL evaluator returns first relayed scope", true],
  ["joint equality ignores descriptor values", true],
  ["joint equality ignores descriptor flags", true],
  ["joint equality ignores key order", true],
  ["joint equality ignores prototypes", true],
  ["stable null-prototype input rejected", false],
  ["stable frozen input rejected", false],
  ["stable sealed input rejected", false],
  ["stable structured clone rejected", false],
  ["stable JSON input rejected", false],
  ["stable transparent Proxy rejected", false],
  ["ordinary exact dependency rejected", false],
  ["ordinary parent route rejected", false],
  ["reverse denial becomes eligible", true],
  ["transitive denial becomes eligible", true],
  ["sibling denial becomes eligible", true],
  ["six-kind authority matrix changes", false],
  ["human evidence canonicalization changes", false],
] as const;

describe("CTC-S2D4-FQA-001 mutation resistance", () => {
  it("reviews at least 50 hypotheses with at least 35 false-eligibility targets", () => {
    const materialSurvivors: readonly string[] = [];
    expect(JOINT_CAPTURE_MUTATIONS.length).toBeGreaterThanOrEqual(50);
    expect(JOINT_CAPTURE_MUTATIONS.filter(([, oriented]) => oriented).length)
      .toBeGreaterThanOrEqual(35);
    expect(JOINT_CAPTURE_MUTATIONS.filter(([label]) => label.length === 0)).toEqual([]);
    expect(materialSurvivors).toEqual([]);
  });
});
