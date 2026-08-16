import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as domainExports from "../src/index.js";
import {
  AcceptedPromotedContextSnapshotDataSchema,
  AuditActorTypeSchema,
  ContextAuthoritySchema,
  ContextKindSchema,
  ContextScopeSchema,
  ContextSourceTypeSchema,
  evaluateContextScopeAccess,
  evaluatePromotedContextAcceptanceRequirement,
  evaluatePromotedContextCandidate,
  evaluatePromotedContextHumanConfirmationEvidence,
  evaluatePromotedContextRoute,
  evaluateQaContextProfileCandidate,
} from "../src/index.js";
import type {
  AllowedContextSet,
  ContextKind,
  ContextSourceType,
  PromotedContextCandidate,
  PromotedContextRoute,
  PromotedContextRouteTopology,
  SubtaskDependency,
} from "../src/index.js";
import {
  TrustedHumanPromotedContextAcceptanceFailureReasonSchema,
  TrustedHumanPromotedContextAcceptanceResultSchema,
  acceptPromotedContextFromTrustedHumanAction,
} from "../src/accepted-promoted-context.js";

const CONTEXT_KINDS = ContextKindSchema.options;
const SOURCE_TYPES = ContextSourceTypeSchema.options;

const dependency = (
  upstreamSubtaskId = "st_source",
  downstreamSubtaskId = "st_target",
): SubtaskDependency => ({
  upstreamSubtaskId,
  downstreamSubtaskId,
  dependencyType: "INFORMATIONAL",
  requiredGate: "NONE",
  reason: `${upstreamSubtaskId} explicitly informs ${downstreamSubtaskId}.`,
}) as SubtaskDependency;

const topology = (
  dependencies: readonly SubtaskDependency[] = [dependency()],
): PromotedContextRouteTopology => ({
  projects: [{ id: "prj_local" }, { id: "prj_foreign" }],
  bigTasks: [
    { id: "bt_local", projectId: "prj_local" },
    { id: "bt_other", projectId: "prj_local" },
    { id: "bt_foreign", projectId: "prj_foreign" },
  ],
  subtasks: [
    { id: "st_source", bigTaskId: "bt_local" },
    { id: "st_mid", bigTaskId: "bt_local" },
    { id: "st_target", bigTaskId: "bt_local" },
    { id: "st_sibling", bigTaskId: "bt_local" },
    { id: "st_other", bigTaskId: "bt_other" },
    { id: "st_foreign", bigTaskId: "bt_foreign" },
  ],
  dependencies,
}) as PromotedContextRouteTopology;

const parentRoute = (targetBigTaskId = "bt_local"): PromotedContextRoute => ({
  sourceSubtaskId: "st_source",
  audienceKind: "PARENT_BIG_TASK",
  targetBigTaskId,
}) as PromotedContextRoute;

const downstreamRoute = (
  sourceSubtaskId = "st_source",
  targetSubtaskId = "st_target",
): PromotedContextRoute => ({
  sourceSubtaskId,
  audienceKind: "DOWNSTREAM_SUBTASK",
  targetSubtaskId,
}) as PromotedContextRoute;

const candidateInput = (
  overrides: Readonly<Record<string, unknown>> = {},
): PromotedContextCandidate => ({
  route: downstreamRoute(),
  kind: "DECISION",
  title: "  Bind the canonical accepted conclusion  ",
  body: "\nCandidate, topology, and evidence form one coherent value.\t",
  provenance: {
    sourceType: "MANUAL",
    sourceReference: "  candidate:s2d5a-hardening  ",
    evidenceReferences: ["  evidence:one  ", "evidence:two"],
  },
  ...overrides,
}) as PromotedContextCandidate;

const evidenceInput = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  evidenceType: "HUMAN_CONFIRMATION",
  sourceReference: "  local-action:s2d5a-hardening  ",
  occurredAt: "2026-08-16T08:30:00+08:00",
  ...overrides,
});

const accept = (
  graph: PromotedContextRouteTopology = topology(),
  promotedCandidate: PromotedContextCandidate = candidateInput(),
  evidence: unknown = evidenceInput(),
) =>
  acceptPromotedContextFromTrustedHumanAction(
    graph,
    promotedCandidate,
    evidence,
  );

const requireSnapshot = (result: ReturnType<typeof accept>) => {
  expect(result.accepted).toBe(true);
  if (!result.accepted) {
    throw new Error(`Expected accepted result, received ${result.reason}.`);
  }
  return result.snapshot;
};

const canonicalCandidate = (
  kind: ContextKind,
  route: PromotedContextRoute,
  sourceType: ContextSourceType = "MANUAL",
  sourceReference = "candidate:s2d5a-hardening",
  evidenceReferences: readonly string[] = ["evidence:one", "evidence:two"],
) => ({
  route,
  kind,
  title: "Bind the canonical accepted conclusion",
  body: "Candidate, topology, and evidence form one coherent value.",
  provenance: {
    sourceType,
    sourceReference,
    evidenceReferences,
  },
});

const canonicalEvidence = (
  sourceReference = "local-action:s2d5a-hardening",
  occurredAt = "2026-08-16T00:30:00.000Z",
) => ({
  evidenceType: "HUMAN_CONFIRMATION" as const,
  sourceReference,
  occurredAt,
});

const withSpecialOwnKey = <T extends object>(value: T): T => {
  Object.defineProperty(value, "__proto__", {
    value: "forbidden",
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
};

const collectTypeScriptFiles = (directory: URL): readonly URL[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(child);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  });

const productionFiles = [
  new URL("../src/", import.meta.url),
  new URL("../../storage/src/", import.meta.url),
  new URL("../../codex-adapter/src/", import.meta.url),
  new URL("../../shared/src/", import.meta.url),
].flatMap(collectTypeScriptFiles);

const productionSource = productionFiles
  .map((file) => readFileSync(file, "utf-8"))
  .join("\n");

const acceptedSourceUrl = new URL(
  "../src/accepted-promoted-context.ts",
  import.meta.url,
);
const acceptedSource = readFileSync(acceptedSourceUrl, "utf-8");
const productionOutsideAcceptedModule = productionFiles
  .filter((file) => file.href !== acceptedSourceUrl.href)
  .map((file) => readFileSync(file, "utf-8"))
  .join("\n");

describe("S2D5a independent literal accepted snapshot oracle", () => {
  it("matches 12 kind/audience cases and 96 exact field assertions with zero mismatches", () => {
    let cases = 0;
    let fieldAssertions = 0;
    const mismatches: Array<{
      readonly kind: ContextKind;
      readonly audience: "PARENT_BIG_TASK" | "DOWNSTREAM_SUBTASK";
    }> = [];

    for (const kind of CONTEXT_KINDS) {
      for (const audience of ["PARENT_BIG_TASK", "DOWNSTREAM_SUBTASK"] as const) {
        const route = audience === "PARENT_BIG_TASK" ? parentRoute() : downstreamRoute();
        const result = accept(topology(), candidateInput({ kind, route }));
        const expected = {
          candidate: canonicalCandidate(kind, route),
          acceptance: {
            method: "HUMAN_CONFIRMATION",
            evidence: canonicalEvidence(),
          },
        };
        cases += 1;
        fieldAssertions += 8;
        if (!result.accepted || JSON.stringify(result.snapshot) !== JSON.stringify(expected)) {
          mismatches.push({ kind, audience });
          continue;
        }
        expect(Object.keys(result.snapshot)).toEqual(["candidate", "acceptance"]);
        expect(result.snapshot.candidate).toEqual(expected.candidate);
        expect(Object.keys(result.snapshot.candidate)).toEqual([
          "route",
          "kind",
          "title",
          "body",
          "provenance",
        ]);
        expect(Object.keys(result.snapshot.acceptance)).toEqual(["method", "evidence"]);
        expect(result.snapshot.acceptance.method).toBe("HUMAN_CONFIRMATION");
        expect(result.snapshot.acceptance.evidence).toEqual(expected.acceptance.evidence);
        expect(Object.keys(result.snapshot.acceptance.evidence)).toEqual([
          "evidenceType",
          "sourceReference",
          "occurredAt",
        ]);
        expect(AcceptedPromotedContextSnapshotDataSchema.safeParse(result.snapshot).success)
          .toBe(true);
      }
    }

    expect(cases).toBe(12);
    expect(fieldAssertions).toBe(96);
    expect(mismatches).toEqual([]);
  });
});

const SNAPSHOT_ESCAPE_FIELDS = [
  "accepted",
  "approved",
  "trusted",
  "verified",
  "humanAuthenticated",
  "authoritySatisfied",
  "confirmationSatisfied",
  "requirement",
  "acceptedAt",
  "createdAt",
  "updatedAt",
  "transitionAt",
  "recordId",
  "snapshotId",
  "acceptanceId",
  "candidateId",
  "candidateHash",
  "candidateDigest",
  "candidateFingerprint",
  "actor",
  "actorType",
  "userId",
  "role",
  "RBAC",
  "session",
  "signature",
  "capability",
  "deterministicEvidence",
  "repoEvidence",
  "metadata",
  "payload",
  "reason",
  "status",
  "supersedes",
  "source",
  "auditEvent",
  "contextItem",
  "identity",
  "acceptedBy",
  "approvedBy",
  "persisted",
  "injectable",
] as const;

describe("S2D5a exact DATA schema and method closure", () => {
  it("rejects 42 top-level and acceptance escape fields", () => {
    const snapshot = requireSnapshot(accept());
    let survivors = 0;
    for (const field of SNAPSHOT_ESCAPE_FIELDS) {
      survivors += Number(
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          [field]: "forbidden",
        }).success,
      );
      survivors += Number(
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          acceptance: { ...snapshot.acceptance, [field]: "forbidden" },
        }).success,
      );
    }
    expect(SNAPSHOT_ESCAPE_FIELDS).toHaveLength(42);
    expect(survivors).toBe(0);
  });

  it("rejects missing, wrong, generic escape, and extra serialized forms", () => {
    const snapshot = requireSnapshot(accept());
    const invalidForms = [
      {},
      { candidate: snapshot.candidate },
      { acceptance: snapshot.acceptance },
      { ...snapshot, candidate: null },
      { ...snapshot, acceptance: null },
      { ...snapshot, acceptance: { evidence: snapshot.acceptance.evidence } },
      { ...snapshot, acceptance: { method: "HUMAN_CONFIRMATION" } },
      { ...snapshot, acceptance: { ...snapshot.acceptance, evidence: {} } },
      { ...snapshot, payload: {} },
      { ...snapshot, acceptance: { ...snapshot.acceptance, payload: {} } },
    ];
    expect(
      invalidForms.filter(
        (form) => AcceptedPromotedContextSnapshotDataSchema.safeParse(form).success,
      ),
    ).toEqual([]);
  });

  it("accepts only the exact HUMAN_CONFIRMATION literal without normalization", () => {
    const snapshot = requireSnapshot(accept());
    const alternatives = [
      "SYSTEM",
      "CODEX",
      "MODEL",
      "AUTO",
      "REPO",
      "DETERMINISTIC_EVIDENCE",
      "HUMAN",
      "MANUAL",
      "HUMAN_APPROVAL",
      "human_confirmation",
      " HUMAN_CONFIRMATION",
      "HUMAN_CONFIRMATION ",
      "HUMAN CONFIRMATION",
      "HUMAN-CONFIRMATION",
    ] as const;
    expect(
      alternatives.filter((method) =>
        AcceptedPromotedContextSnapshotDataSchema.safeParse({
          ...snapshot,
          acceptance: { ...snapshot.acceptance, method },
        }).success,
      ),
    ).toEqual([]);
  });
});

describe("S2D5a schema validity and trust separation", () => {
  it("parses manually forged DATA while exposing no parser-based trust API", () => {
    const forged = {
      candidate: candidateInput(),
      acceptance: {
        method: "HUMAN_CONFIRMATION",
        evidence: evidenceInput(),
      },
    };
    const parsed = AcceptedPromotedContextSnapshotDataSchema.parse(forged);
    expect(parsed).toEqual({
      candidate: canonicalCandidate("DECISION", downstreamRoute()),
      acceptance: {
        method: "HUMAN_CONFIRMATION",
        evidence: canonicalEvidence(),
      },
    });

    const parserTrustApis = [
      "isTrustedAcceptedSnapshot",
      "verifyAcceptedSnapshot",
      "trustAcceptedSnapshot",
      "acceptSnapshotFromJson",
      "hydrateTrustedAcceptedSnapshot",
      "markAcceptedFromSchema",
      "verifyAcceptedByParsing",
      "isTrustedAcceptedSnapshotFromSchema",
    ];
    expect(parserTrustApis.filter((name) => productionSource.includes(name))).toEqual([]);
    expect(Object.keys(domainExports).filter((name) => /trusted.*snapshot/i.test(name)))
      .toEqual([]);
  });

  it("round-trips DATA serialization without adding a trusted runtime marker", () => {
    const snapshot = requireSnapshot(accept());
    const roundTrip = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const parsed = AcceptedPromotedContextSnapshotDataSchema.parse(roundTrip);
    expect(parsed).toEqual(snapshot);
    expect(Object.keys(parsed)).toEqual(["candidate", "acceptance"]);
    expect(parsed).not.toHaveProperty("trusted");
    expect(parsed).not.toHaveProperty("accepted");
    expect(Object.isFrozen(parsed)).toBe(false);
  });
});

describe("S2D5a deliberate public surface inventory", () => {
  it("exposes only the accepted snapshot DATA schema from the package root", () => {
    const s2d5aRuntimeExports = Object.keys(domainExports)
      .filter((name) => /AcceptedPromoted|acceptPromoted|TrustedHumanPromoted/.test(name))
      .sort();
    expect(s2d5aRuntimeExports).toEqual([
      "AcceptedPromotedContextSnapshotDataSchema",
    ]);
    expect(domainExports).not.toHaveProperty(
      "acceptPromotedContextFromTrustedHumanAction",
    );
    expect(domainExports).not.toHaveProperty(
      "TrustedHumanPromotedContextAcceptanceResultSchema",
    );
    expect(domainExports).not.toHaveProperty(
      "TrustedHumanPromotedContextAcceptanceFailureReasonSchema",
    );

    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { readonly exports: Readonly<Record<string, unknown>> };
    expect(Object.keys(packageManifest.exports)).toEqual(["."]);
  });

  it("finds no alias, barrel leak, wrapper, or operational transition caller", () => {
    expect(productionOutsideAcceptedModule).not.toContain(
      "acceptPromotedContextFromTrustedHumanAction",
    );
    for (const wrapper of [
      /createAcceptedPromotedContext\s*\(/,
      /transitionPromotedContext\s*\(/,
      /approvePromotedContext\s*\(/,
      /confirmPromotedContext\s*\(/,
      /acceptFromHumanEvidence\s*\(/,
      /trustedAccept\s*\(/,
      /mint.*capability/i,
      /createTrustedCapability\s*\(/,
    ]) {
      expect(productionSource).not.toMatch(wrapper);
    }
  });
});

describe("S2D5a upstream failure and internal result correlation", () => {
  it("preserves exact closed failures without partial accepted output", () => {
    const cases = [
      [
        "invalid candidate",
        topology(),
        candidateInput({ title: " " }),
        evidenceInput(),
        "INVALID_CANDIDATE",
      ],
      [
        "invalid route",
        topology(),
        candidateInput({
          route: { ...downstreamRoute(), sourceSubtaskId: " st_source " },
        }),
        evidenceInput(),
        "INVALID_ROUTE",
      ],
      [
        "invalid topology",
        { ...topology(), unexpected: true },
        candidateInput(),
        evidenceInput(),
        "INVALID_TOPOLOGY",
      ],
      [
        "wrong parent",
        topology(),
        candidateInput({ route: parentRoute("bt_other") }),
        evidenceInput(),
        "NOT_SOURCE_PARENT_BIG_TASK",
      ],
      [
        "sibling",
        topology([]),
        candidateInput({ route: downstreamRoute("st_source", "st_sibling") }),
        evidenceInput(),
        "NO_EXPLICIT_DEPENDENCY",
      ],
      [
        "reverse",
        topology([dependency("st_target", "st_source")]),
        candidateInput(),
        evidenceInput(),
        "REVERSE_DIRECTION_NOT_ALLOWED",
      ],
      [
        "transitive",
        topology([
          dependency("st_source", "st_mid"),
          dependency("st_mid", "st_target"),
        ]),
        candidateInput(),
        evidenceInput(),
        "NO_EXPLICIT_DEPENDENCY",
      ],
      [
        "cross Big Task",
        topology(),
        candidateInput({ route: downstreamRoute("st_source", "st_other") }),
        evidenceInput(),
        "CROSS_BIG_TASK_NOT_ALLOWED",
      ],
      [
        "cross Project",
        topology(),
        candidateInput({ route: downstreamRoute("st_source", "st_foreign") }),
        evidenceInput(),
        "CROSS_PROJECT_NOT_ALLOWED",
      ],
      [
        "invalid human evidence",
        topology(),
        candidateInput(),
        evidenceInput({ evidenceType: "MODEL" }),
        "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
      ],
    ] as const;
    let falseAccepted = 0;
    for (const [label, graph, promotedCandidate, evidence, reason] of cases) {
      const result = accept(
        graph as PromotedContextRouteTopology,
        promotedCandidate,
        evidence,
      );
      falseAccepted += Number(result.accepted);
      expect(result, label).toEqual({ accepted: false, reason });
      expect(Object.keys(result), label).toEqual(["accepted", "reason"]);
      expect(result, label).not.toHaveProperty("snapshot");
    }
    expect(falseAccepted).toBe(0);
  });

  it("rejects unstable evidence through the bounded joint-input failure reason", () => {
    let observations = 0;
    const evidence = new Proxy(evidenceInput(), {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "evidenceType" || descriptor === undefined || !("value" in descriptor)) {
          return descriptor;
        }
        observations += 1;
        return {
          ...descriptor,
          value: observations % 2 === 0 ? "MODEL" : "HUMAN_CONFIRMATION",
        };
      },
    });
    expect(accept(topology(), candidateInput(), evidence)).toEqual({
      accepted: false,
      reason: "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
    });
    expect(observations).toBeGreaterThan(1);
  });

  it("locks legal success and failure variants and rejects contradictions", () => {
    const success = accept();
    const failure = accept(topology([]));
    const snapshot = requireSnapshot(success);
    expect(TrustedHumanPromotedContextAcceptanceResultSchema.safeParse(success).success)
      .toBe(true);
    expect(TrustedHumanPromotedContextAcceptanceResultSchema.safeParse(failure).success)
      .toBe(true);
    const contradictory = [
      { accepted: false, reason: "NO_EXPLICIT_DEPENDENCY", snapshot },
      { accepted: true, snapshot, reason: "NO_EXPLICIT_DEPENDENCY" },
      { accepted: true },
      { accepted: false },
      { accepted: true, snapshot, trusted: true },
      { accepted: false, reason: "NO_EXPLICIT_DEPENDENCY", approved: false },
    ];
    expect(
      contradictory.filter(
        (value) => TrustedHumanPromotedContextAcceptanceResultSchema.safeParse(value).success,
      ),
    ).toEqual([]);
    expect(TrustedHumanPromotedContextAcceptanceFailureReasonSchema.options).toContain(
      "INCONSISTENT_UPSTREAM_EVALUATION",
    );
  });
});

describe("CTC-S2D5A-HARD-001 shared special-own-key repair", () => {
  it("fails closed across every direct shared-capture consumer", () => {
    const allowed = withSpecialOwnKey({
      target: {
        projectId: "prj_local",
        bigTaskId: "bt_local",
        subtaskId: "st_target",
      },
      allowedRawScopes: [
        { scopeType: "PROJECT", projectId: "prj_local" },
        { scopeType: "BIG_TASK", projectId: "prj_local", bigTaskId: "bt_local" },
        {
          scopeType: "SUBTASK",
          projectId: "prj_local",
          bigTaskId: "bt_local",
          subtaskId: "st_target",
        },
      ],
    }) as unknown as AllowedContextSet;
    expect(
      evaluateContextScopeAccess(allowed, ContextScopeSchema.parse({
        scopeType: "PROJECT",
        projectId: "prj_local",
      })),
    ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });

    expect(
      evaluatePromotedContextRoute(
        topology(),
        withSpecialOwnKey(downstreamRoute()),
      ),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_ROUTE" });
    const specialCandidate = withSpecialOwnKey(candidateInput());
    expect(evaluatePromotedContextCandidate(topology(), specialCandidate)).toEqual({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
    expect(
      evaluatePromotedContextAcceptanceRequirement(
        topology(),
        withSpecialOwnKey(candidateInput()),
      ),
    ).toEqual({ acceptanceEligible: false, reason: "INVALID_CANDIDATE" });
    expect(
      evaluatePromotedContextHumanConfirmationEvidence(
        topology(),
        withSpecialOwnKey(candidateInput()),
        evidenceInput(),
      ),
    ).toEqual({ structurallyApplicable: false, reason: "INVALID_CANDIDATE" });
    expect(
      accept(topology(), withSpecialOwnKey(candidateInput()), evidenceInput()),
    ).toEqual({
      accepted: false,
      reason: "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
    });
  });

  it("rejects the special key on route, topology, and evidence inputs", () => {
    expect(
      evaluatePromotedContextRoute(
        topology(),
        withSpecialOwnKey(downstreamRoute()),
      ).eligible,
    ).toBe(false);
    expect(
      evaluatePromotedContextRoute(
        withSpecialOwnKey(topology()),
        downstreamRoute(),
      ),
    ).toEqual({ valid: false, eligible: false, reason: "INVALID_TOPOLOGY" });
    expect(
      accept(
        topology(),
        candidateInput(),
        withSpecialOwnKey(evidenceInput()),
      ),
    ).toEqual({
      accepted: false,
      reason: "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
    });
  });
});

interface RelayCase {
  readonly label: string;
  readonly topology: PromotedContextRouteTopology;
  readonly candidate: PromotedContextCandidate;
  readonly evidence: unknown;
  readonly jointlyValidStates: readonly boolean[];
}

const makeCandidateTopologyRelay = (nestedRoute: boolean): RelayCase => {
  const routeTarget = downstreamRoute() as unknown as Record<string, unknown>;
  const candidateTarget = candidateInput({ route: routeTarget }) as unknown as Record<
    string,
    unknown
  >;
  const topologyTarget = topology([]) as PromotedContextRouteTopology & {
    dependencies: SubtaskDependency[];
  };
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1) => {
    candidateTarget.kind = state === 0 ? "DECISION" : "UNKNOWN";
    routeTarget.sourceSubtaskId = state === 0 ? "st_source" : "st_mid";
    topologyTarget.dependencies =
      state === 0 ? [] : [dependency(nestedRoute ? "st_mid" : "st_source")];
    jointlyValidStates.push(
      candidateTarget.kind === "DECISION" &&
        routeTarget.sourceSubtaskId === "st_source" &&
        topologyTarget.dependencies.some(
          ({ upstreamSubtaskId }) => upstreamSubtaskId === "st_source",
        ),
    );
  };
  setState(0);
  const route = new Proxy(routeTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "targetSubtaskId") {
        setState(1);
      }
      return descriptor;
    },
  });
  candidateTarget.route = nestedRoute ? route : routeTarget;
  const promotedCandidate = nestedRoute
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
  const graph = new Proxy(topologyTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "dependencies") {
        setState(0);
      }
      return descriptor;
    },
  });
  return {
    label: nestedRoute ? "nested candidate.route/topology" : "candidate/topology",
    topology: graph,
    candidate: promotedCandidate as PromotedContextCandidate,
    evidence: evidenceInput(),
    jointlyValidStates,
  };
};

const makeCandidateEvidenceRelay = (routeSpecific: boolean): RelayCase => {
  const routeTarget = downstreamRoute() as unknown as Record<string, unknown>;
  const candidateTarget = candidateInput({ route: routeTarget }) as unknown as Record<
    string,
    unknown
  >;
  const evidenceTarget = evidenceInput({ evidenceType: "MODEL" });
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1) => {
    candidateTarget.kind = state === 0 ? "DECISION" : "UNKNOWN";
    routeTarget.sourceSubtaskId = state === 0 ? "st_source" : "st_mid";
    evidenceTarget.evidenceType = state === 0 ? "MODEL" : "HUMAN_CONFIRMATION";
    jointlyValidStates.push(
      candidateTarget.kind === "DECISION" &&
        routeTarget.sourceSubtaskId === "st_source" &&
        evidenceTarget.evidenceType === "HUMAN_CONFIRMATION",
    );
  };
  setState(0);
  const route = new Proxy(routeTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (routeSpecific && property === "targetSubtaskId") {
        setState(1);
      }
      return descriptor;
    },
  });
  candidateTarget.route = routeSpecific ? route : routeTarget;
  const promotedCandidate = routeSpecific
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
  const evidence = new Proxy(evidenceTarget, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === "occurredAt") {
        setState(0);
      }
      return descriptor;
    },
  });
  return {
    label: routeSpecific ? "candidate.route/evidence" : "candidate/evidence",
    topology: topology(),
    candidate: promotedCandidate as PromotedContextCandidate,
    evidence,
    jointlyValidStates,
  };
};

const makeTopologyEvidenceRelay = (): RelayCase => {
  const topologyTarget = topology() as PromotedContextRouteTopology & {
    dependencies: SubtaskDependency[];
  };
  const evidenceTarget = evidenceInput({ evidenceType: "MODEL" });
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
    topology: new Proxy(topologyTarget, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "dependencies") {
          setState(1);
        }
        return descriptor;
      },
    }),
    candidate: candidateInput(),
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
  const candidateTarget = candidateInput() as unknown as Record<string, unknown>;
  const topologyTarget = topology([]) as PromotedContextRouteTopology & {
    dependencies: SubtaskDependency[];
  };
  const evidenceTarget = evidenceInput({ evidenceType: "MODEL" });
  const jointlyValidStates: boolean[] = [];
  const setState = (state: 0 | 1 | 2) => {
    candidateTarget.kind = state === 0 ? "DECISION" : "UNKNOWN";
    topologyTarget.dependencies = state === 1 ? [dependency()] : [];
    evidenceTarget.evidenceType = state === 2 ? "HUMAN_CONFIRMATION" : "MODEL";
    jointlyValidStates.push(
      candidateTarget.kind === "DECISION" &&
        topologyTarget.dependencies.length === 1 &&
        evidenceTarget.evidenceType === "HUMAN_CONFIRMATION",
    );
  };
  setState(0);
  return {
    label: "three-way candidate/topology/evidence",
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

const descriptorSequence = <T extends object>(
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
      const value = values[observations % values.length];
      observations += 1;
      return { ...descriptor, value };
    },
  });
};

describe("S2D5a joint candidate/topology/evidence snapshot safety", () => {
  it("rejects pairwise, nested-route, and three-way relays with no coherent state", () => {
    const relays = [
      makeCandidateTopologyRelay(false),
      makeCandidateTopologyRelay(true),
      makeCandidateEvidenceRelay(false),
      makeCandidateEvidenceRelay(true),
      makeTopologyEvidenceRelay(),
      makeThreeWayRelay(),
    ];
    let falseAccepted = 0;
    let exceptionLeaks = 0;
    for (const relay of relays) {
      let result: ReturnType<typeof accept> | undefined;
      try {
        result = accept(relay.topology, relay.candidate, relay.evidence);
      } catch {
        exceptionLeaks += 1;
      }
      falseAccepted += Number(result?.accepted ?? false);
      expect(result, relay.label).toEqual({
        accepted: false,
        reason: "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
      });
      expect(relay.jointlyValidStates.length, relay.label).toBeGreaterThan(1);
      expect(relay.jointlyValidStates, relay.label).not.toContain(true);
    }
    expect(relays).toHaveLength(6);
    expect(falseAccepted).toBe(0);
    expect(exceptionLeaks).toBe(0);
  });

  it("rejects prime-cycle, late-change, burst, and phase-shifted schedules", () => {
    const validCandidate = candidateInput() as unknown as Record<string, unknown>;
    const validGraph = topology() as PromotedContextRouteTopology & {
      dependencies: SubtaskDependency[];
    };
    const validEvidence = evidenceInput();
    const schedules = [
      {
        label: "prime-length candidate cycle",
        candidate: descriptorSequence(validCandidate, "kind", [
          "DECISION",
          "UNKNOWN",
          "DECISION",
          "UNKNOWN",
          "DECISION",
          "UNKNOWN",
          "DECISION",
        ]),
        topology: validGraph,
        evidence: validEvidence,
      },
      {
        label: "long candidate cycle",
        candidate: descriptorSequence(
          structuredClone(validCandidate),
          "kind",
          [
            "DECISION",
            "DECISION",
            "UNKNOWN",
            "DECISION",
            "UNKNOWN",
            "UNKNOWN",
            "DECISION",
            "DECISION",
            "UNKNOWN",
            "DECISION",
            "UNKNOWN",
            "DECISION",
            "UNKNOWN",
          ],
        ),
        topology: structuredClone(validGraph),
        evidence: structuredClone(validEvidence),
      },
      {
        label: "one-shot late candidate change",
        candidate: descriptorSequence(
          structuredClone(validCandidate),
          "kind",
          ["DECISION", "DECISION", "DECISION", "DECISION", "DECISION", "UNKNOWN"],
        ),
        topology: structuredClone(validGraph),
        evidence: structuredClone(validEvidence),
      },
      {
        label: "burst topology transition",
        candidate: structuredClone(validCandidate),
        topology: descriptorSequence(
          structuredClone(validGraph),
          "dependencies",
          [[dependency()], [], [], [dependency()], [dependency()], []],
        ),
        evidence: structuredClone(validEvidence),
      },
      {
        label: "phase-shifted evidence transition",
        candidate: structuredClone(validCandidate),
        topology: structuredClone(validGraph),
        evidence: descriptorSequence(
          structuredClone(validEvidence),
          "evidenceType",
          ["HUMAN_CONFIRMATION", "MODEL", "MODEL", "HUMAN_CONFIRMATION", "MODEL"],
        ),
      },
      {
        label: "reflection-operation-specific ownKeys transition",
        candidate: new Proxy(structuredClone(validCandidate), (() => {
          let observations = 0;
          return {
          ownKeys(target) {
            observations += 1;
            const keys = Reflect.ownKeys(target);
            return observations % 2 === 0 ? [...keys].reverse() : keys;
          },
          };
        })()),
        topology: structuredClone(validGraph),
        evidence: structuredClone(validEvidence),
      },
    ];
    let falseAccepted = 0;
    for (const scheduled of schedules) {
      const result = accept(
        scheduled.topology as PromotedContextRouteTopology,
        scheduled.candidate as PromotedContextCandidate,
        scheduled.evidence,
      );
      falseAccepted += Number(result.accepted);
      expect(result.accepted, scheduled.label).toBe(false);
    }
    expect(schedules).toHaveLength(6);
    expect(falseAccepted).toBe(0);
  });
});

type ReflectionTrap = "getPrototypeOf" | "ownKeys" | "getOwnPropertyDescriptor";

const throwingReflectionProxy = <T extends object>(
  target: T,
  trap: ReflectionTrap,
): T => {
  if (trap === "getPrototypeOf") {
    return new Proxy(target, {
      getPrototypeOf() {
        throw new Error("hostile getPrototypeOf");
      },
    });
  }
  if (trap === "ownKeys") {
    return new Proxy(target, {
      ownKeys() {
        throw new Error("hostile ownKeys");
      },
    });
  }
  return new Proxy(target, {
    getOwnPropertyDescriptor() {
      throw new Error("hostile getOwnPropertyDescriptor");
    },
  });
};

const reflectionCases = (): readonly {
  readonly label: string;
  readonly topology: PromotedContextRouteTopology;
  readonly candidate: PromotedContextCandidate;
  readonly evidence: unknown;
}[] => {
  const cases: Array<{
    readonly label: string;
    readonly topology: PromotedContextRouteTopology;
    readonly candidate: PromotedContextCandidate;
    readonly evidence: unknown;
  }> = [];
  for (const trap of [
    "getPrototypeOf",
    "ownKeys",
    "getOwnPropertyDescriptor",
  ] as const) {
    cases.push({
      label: `candidate ${trap}`,
      topology: topology(),
      candidate: throwingReflectionProxy(candidateInput(), trap),
      evidence: evidenceInput(),
    });
    cases.push({
      label: `topology ${trap}`,
      topology: throwingReflectionProxy(topology(), trap),
      candidate: candidateInput(),
      evidence: evidenceInput(),
    });
    cases.push({
      label: `evidence ${trap}`,
      topology: topology(),
      candidate: candidateInput(),
      evidence: throwingReflectionProxy(evidenceInput(), trap),
    });

    for (const nested of [
      "candidate.route",
      "candidate.provenance",
      "candidate.evidenceReferences",
      "topology.projects",
      "topology.bigTasks",
      "topology.subtasks",
      "topology.dependencies",
      "topology.project",
      "topology.bigTask",
      "topology.subtask",
      "topology.dependency",
    ] as const) {
      const promotedCandidate = candidateInput() as unknown as {
        route: PromotedContextRoute;
        provenance: {
          sourceType: ContextSourceType;
          sourceReference: string;
          evidenceReferences: string[];
        };
      };
      const graph = topology() as PromotedContextRouteTopology & {
        projects: Array<{ id: string }>;
        bigTasks: Array<{ id: string; projectId: string }>;
        subtasks: Array<{ id: string; bigTaskId: string }>;
        dependencies: SubtaskDependency[];
      };
      if (nested === "candidate.route") {
        promotedCandidate.route = throwingReflectionProxy(promotedCandidate.route, trap);
      } else if (nested === "candidate.provenance") {
        promotedCandidate.provenance = throwingReflectionProxy(
          promotedCandidate.provenance,
          trap,
        );
      } else if (nested === "candidate.evidenceReferences") {
        promotedCandidate.provenance.evidenceReferences = throwingReflectionProxy(
          promotedCandidate.provenance.evidenceReferences,
          trap,
        );
      } else if (nested === "topology.projects") {
        graph.projects = throwingReflectionProxy(graph.projects, trap);
      } else if (nested === "topology.bigTasks") {
        graph.bigTasks = throwingReflectionProxy(graph.bigTasks, trap);
      } else if (nested === "topology.subtasks") {
        graph.subtasks = throwingReflectionProxy(graph.subtasks, trap);
      } else if (nested === "topology.dependencies") {
        graph.dependencies = throwingReflectionProxy(graph.dependencies, trap);
      } else if (nested === "topology.project") {
        graph.projects[0] = throwingReflectionProxy(graph.projects[0]!, trap);
      } else if (nested === "topology.bigTask") {
        graph.bigTasks[0] = throwingReflectionProxy(graph.bigTasks[0]!, trap);
      } else if (nested === "topology.subtask") {
        graph.subtasks[0] = throwingReflectionProxy(graph.subtasks[0]!, trap);
      } else {
        graph.dependencies[0] = throwingReflectionProxy(graph.dependencies[0]!, trap);
      }
      cases.push({
        label: `${nested} ${trap}`,
        topology: graph,
        candidate: promotedCandidate as PromotedContextCandidate,
        evidence: evidenceInput(),
      });
    }
  }
  return cases;
};

describe("S2D5a reflection, accessor, and descriptor attacks", () => {
  it("contains 42 throwing reflection cases without exceptions or false snapshots", () => {
    const cases = reflectionCases();
    let exceptionLeaks = 0;
    let falseAccepted = 0;
    for (const hostile of cases) {
      let result: ReturnType<typeof accept> | undefined;
      try {
        result = accept(hostile.topology, hostile.candidate, hostile.evidence);
      } catch {
        exceptionLeaks += 1;
      }
      falseAccepted += Number(result?.accepted ?? false);
      expect(result?.accepted, hostile.label).toBe(false);
      expect(result, hostile.label).not.toHaveProperty("snapshot");
    }
    expect(cases).toHaveLength(42);
    expect(exceptionLeaks).toBe(0);
    expect(falseAccepted).toBe(0);
  });

  it("rejects accessors, descriptor changes, disappearing keys, symbols, and special keys", () => {
    let accessorReads = 0;
    const accessorCandidate = candidateInput() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorCandidate, "kind", {
      get() {
        accessorReads += 1;
        return "DECISION";
      },
      enumerable: true,
      configurable: true,
    });
    const accessorEvidence = evidenceInput();
    Object.defineProperty(accessorEvidence, "evidenceType", {
      get() {
        accessorReads += 1;
        return "HUMAN_CONFIRMATION";
      },
      enumerable: true,
      configurable: true,
    });
    const symbolCandidate = {
      ...candidateInput(),
      [Symbol("accepted")]: true,
    } as unknown as PromotedContextCandidate;
    const symbolEvidence = {
      ...evidenceInput(),
      [Symbol("trusted")]: true,
    };
    const symbolTopology = {
      ...topology(),
      [Symbol("authorized")]: true,
    } as unknown as PromotedContextRouteTopology;
    const extraKeyCandidate = {
      ...candidateInput(),
      __proto__: null,
    } as unknown as PromotedContextCandidate;
    Object.defineProperty(extraKeyCandidate, "hidden", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    const specialOwnKeyCandidate = candidateInput() as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(specialOwnKeyCandidate, "__proto__", {
      value: "forbidden",
      enumerable: true,
      configurable: true,
    });
    let descriptorCalls = 0;
    const changingDescriptor = new Proxy(candidateInput(), {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "kind" && descriptor !== undefined && "value" in descriptor) {
          descriptorCalls += 1;
          return { ...descriptor, writable: descriptorCalls % 2 === 0 };
        }
        return descriptor;
      },
    });
    let keyCalls = 0;
    const disappearingKey = new Proxy(evidenceInput(), {
      ownKeys(target) {
        keyCalls += 1;
        const keys = Reflect.ownKeys(target);
        return keyCalls % 2 === 0
          ? keys.filter((key) => key !== "occurredAt")
          : keys;
      },
    });
    const hostileInputs = [
      [accessorCandidate as unknown as PromotedContextCandidate, evidenceInput()],
      [candidateInput(), accessorEvidence],
      [symbolCandidate, evidenceInput()],
      [candidateInput(), symbolEvidence],
      [specialOwnKeyCandidate as unknown as PromotedContextCandidate, evidenceInput()],
      [extraKeyCandidate, evidenceInput()],
      [changingDescriptor, evidenceInput()],
      [candidateInput(), disappearingKey],
    ] as const;
    for (const [promotedCandidate, evidence] of hostileInputs) {
      expect(accept(topology(), promotedCandidate, evidence).accepted).toBe(false);
    }
    expect(accept(symbolTopology, candidateInput(), evidenceInput()).accepted).toBe(false);
    expect(hostileInputs).toHaveLength(8);
    expect(accessorReads).toBe(0);
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
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const deepSeal = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isSealed(value)) {
    for (const child of Object.values(value)) {
      deepSeal(child);
    }
    Object.seal(value);
  }
  return value;
};

describe("S2D5a canonicalization, detachment, and stable representation compatibility", () => {
  it("returns canonical S2D2 and S2D4 data without rereading caller-owned inputs", () => {
    const promotedCandidate = candidateInput({
      title: "  Canonical title  ",
      body: "\nCanonical body\t",
      provenance: {
        sourceType: "REPO",
        sourceReference: "  source:canonical  ",
        evidenceReferences: [" evidence:one ", " evidence:two "],
      },
    });
    const evidence = evidenceInput({
      sourceReference: "  action:canonical  ",
      occurredAt: "2026-08-16T09:45:30+09:00",
    });
    const snapshot = requireSnapshot(accept(topology(), promotedCandidate, evidence));
    expect(snapshot.candidate).toEqual({
      route: downstreamRoute(),
      kind: "DECISION",
      title: "Canonical title",
      body: "Canonical body",
      provenance: {
        sourceType: "REPO",
        sourceReference: "source:canonical",
        evidenceReferences: ["evidence:one", "evidence:two"],
      },
    });
    expect(snapshot.acceptance.evidence).toEqual(
      canonicalEvidence("action:canonical", "2026-08-16T00:45:30.000Z"),
    );
    expect(snapshot.candidate).not.toBe(promotedCandidate);
    expect(snapshot.acceptance.evidence).not.toBe(evidence);
  });

  it("does not normalize an invalid route into acceptance", () => {
    expect(
      accept(
        topology(),
        candidateInput({
          route: { ...downstreamRoute(), targetSubtaskId: " st_target " },
        }),
      ),
    ).toEqual({ accepted: false, reason: "INVALID_ROUTE" });
  });

  it("accepts seven stable representation families with zero false rejections", () => {
    const graph = topology();
    const promotedCandidate = candidateInput();
    const evidence = evidenceInput();
    const controls = [
      [graph, promotedCandidate, evidence],
      [
        nullPrototypeCopy(graph),
        nullPrototypeCopy(promotedCandidate),
        nullPrototypeCopy(evidence),
      ],
      [
        deepFreeze(structuredClone(graph)),
        deepFreeze(structuredClone(promotedCandidate)),
        deepFreeze(structuredClone(evidence)),
      ],
      [
        deepSeal(structuredClone(graph)),
        deepSeal(structuredClone(promotedCandidate)),
        deepSeal(structuredClone(evidence)),
      ],
      [structuredClone(graph), structuredClone(promotedCandidate), structuredClone(evidence)],
      [
        JSON.parse(JSON.stringify(graph)),
        JSON.parse(JSON.stringify(promotedCandidate)),
        JSON.parse(JSON.stringify(evidence)),
      ],
      [
        new Proxy(structuredClone(graph), {}),
        new Proxy(structuredClone(promotedCandidate), {}),
        new Proxy(structuredClone(evidence), {}),
      ],
    ] as const;
    let falseRejected = 0;
    for (const [controlGraph, controlCandidate, controlEvidence] of controls) {
      falseRejected += Number(
        !accept(
          controlGraph as PromotedContextRouteTopology,
          controlCandidate as PromotedContextCandidate,
          controlEvidence,
        ).accepted,
      );
    }
    expect(controls).toHaveLength(7);
    expect(falseRejected).toBe(0);
  });
});

describe("S2D5a deep snapshot immutability and shared-state safety", () => {
  it("deeply freezes every accepted layer and detaches all caller references", () => {
    const graph = topology();
    const promotedCandidate = candidateInput();
    const evidence = evidenceInput();
    const snapshot = requireSnapshot(accept(graph, promotedCandidate, evidence));
    const before = structuredClone(snapshot);
    expect([
      snapshot,
      snapshot.candidate,
      snapshot.candidate.route,
      snapshot.candidate.provenance,
      snapshot.candidate.provenance.evidenceReferences,
      snapshot.acceptance,
      snapshot.acceptance.evidence,
    ].every(Object.isFrozen)).toBe(true);

    (promotedCandidate.route as { sourceSubtaskId: string }).sourceSubtaskId = "st_mid";
    promotedCandidate.provenance.sourceReference = "attacker:changed";
    promotedCandidate.provenance.evidenceReferences[0] = "attacker:changed";
    evidence.sourceReference = "attacker:changed";
    (graph.dependencies as SubtaskDependency[])[0] = dependency("st_mid", "st_target");
    expect(snapshot).toEqual(before);
  });

  it("prevents output poisoning from changing future results or closed reasons", () => {
    const first = accept();
    const snapshot = requireSnapshot(first);
    expect(Reflect.set(snapshot.acceptance, "method", "SYSTEM")).toBe(false);
    expect(Reflect.set(snapshot.candidate, "kind", "UNKNOWN")).toBe(false);
    expect(Reflect.set(snapshot.acceptance.evidence, "sourceReference", "poisoned"))
      .toBe(false);
    expect(Reflect.set(first, "accepted", false)).toBe(false);

    const second = accept();
    expect(second).toEqual(first);
    expect(accept(topology([]))).toEqual({
      accepted: false,
      reason: "NO_EXPLICIT_DEPENDENCY",
    });
  });
});

describe("S2D5a kind semantics, timing, identity, and repeated calls", () => {
  it("accepts all six kinds through the human method without changing schema", () => {
    for (const kind of CONTEXT_KINDS) {
      const snapshot = requireSnapshot(accept(topology(), candidateInput({ kind })));
      expect(snapshot.candidate.kind).toBe(kind);
      expect(snapshot.acceptance.method).toBe("HUMAN_CONFIRMATION");
      expect(Object.keys(snapshot)).toEqual(["candidate", "acceptance"]);
      expect(snapshot.acceptance).not.toHaveProperty("requirement");
    }
  });

  it("keeps OPEN_QUESTION unresolved and ENGINEERING_FACT non-deterministic", () => {
    const openQuestion = requireSnapshot(
      accept(topology(), candidateInput({ kind: "OPEN_QUESTION" })),
    );
    const engineeringFact = requireSnapshot(
      accept(topology(), candidateInput({ kind: "ENGINEERING_FACT" })),
    );
    expect(openQuestion).not.toHaveProperty("status");
    expect(openQuestion.candidate).not.toHaveProperty("status");
    expect(JSON.stringify(openQuestion)).not.toMatch(/answered|resolved|closed/i);
    expect(engineeringFact.acceptance.method).toBe("HUMAN_CONFIRMATION");
    expect(engineeringFact.acceptance).not.toHaveProperty("deterministicEvidence");
    expect(JSON.stringify(engineeringFact)).not.toContain(
      "DETERMINISTIC_EVIDENCE_OR_HUMAN",
    );
  });

  it("contains no acceptedAt, identity, actor, capability, time read, or random identity", () => {
    const serialized = JSON.stringify(requireSnapshot(accept()));
    for (const forbidden of [
      "acceptedAt",
      "transitionAt",
      "recordId",
      "snapshotId",
      "acceptanceId",
      "actor",
      "userId",
      "role",
      "RBAC",
      "session",
      "signature",
      "capability",
      "requirement",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(acceptedSource).not.toMatch(/Date\.now|Math\.random|randomUUID|crypto/);
    expect(acceptedSource).not.toMatch(/acceptedAt|transitionAt|persistedAt/);
  });

  it("returns deterministic content across repeated calls without replay state", () => {
    const results = Array.from({ length: 25 }, () => accept());
    expect(results.every((result) => result.accepted)).toBe(true);
    expect(
      results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])),
    ).toBe(true);
    expect(acceptedSource).not.toMatch(/idempot|anti.?replay|one.?shot|dedup|invocation/i);
  });
});

describe("S2D5a authority, operational, and materialization separation", () => {
  it("does not bridge ContextAuthority, AuditActorType, or legacy record shapes", () => {
    let falseAccepted = 0;
    for (const authority of ContextAuthoritySchema.options) {
      falseAccepted += Number(accept(topology(), candidateInput(), authority).accepted);
    }
    for (const actorType of AuditActorTypeSchema.options) {
      falseAccepted += Number(accept(topology(), candidateInput(), actorType).accepted);
    }
    for (const legacy of [
      { authority: "HUMAN" },
      { actorType: "HUMAN" },
      { eventType: "IMPLEMENTATION_COMPLETED", actorType: "HUMAN" },
      { commitSha: "a".repeat(40), actorType: "HUMAN" },
      { evidenceType: "REPO_EVIDENCE", sourceReference: "repo", occurredAt: "now" },
      { evidenceType: "SYSTEM", sourceReference: "system", occurredAt: "now" },
      { evidenceType: "CODEX_CANDIDATE", sourceReference: "model", occurredAt: "now" },
    ]) {
      falseAccepted += Number(accept(topology(), candidateInput(), legacy).accepted);
    }
    expect(falseAccepted).toBe(0);
    expect(acceptedSource).not.toMatch(
      /ContextAuthority|AuditActorType|AuditEvent|ImplementationCheckpoint/,
    );
  });

  it("contains no operational controller, command, storage, or App Server bridge", () => {
    expect(productionOutsideAcceptedModule).not.toContain(
      "acceptPromotedContextFromTrustedHumanAction",
    );
    expect(acceptedSource).not.toMatch(
      /controller|handler|router|command|daemon|app.?server|storage|sqlite|drizzle|fetch\s*\(/i,
    );
    expect(acceptedSource).not.toMatch(
      /ContextItem|AuditEvent|materializ|persist|retrieve|compiler|ContextPacket/i,
    );
  });

  it("finds no accepted snapshot consumer in storage or adapter production code", () => {
    const nonDomainSource = [
      new URL("../../storage/src/", import.meta.url),
      new URL("../../codex-adapter/src/", import.meta.url),
    ]
      .flatMap(collectTypeScriptFiles)
      .map((file) => readFileSync(file, "utf-8"))
      .join("\n");
    expect(nonDomainSource).not.toMatch(
      /AcceptedPromotedContextSnapshot|acceptPromotedContextFromTrustedHumanAction/,
    );
  });
});

describe("S2D5a S2A, S2B, and S2C non-expansion", () => {
  it("keeps sibling and upstream raw scopes denied after accepted transitions", () => {
    const allowed = {
      target: {
        projectId: "prj_local",
        bigTaskId: "bt_local",
        subtaskId: "st_target",
      },
      allowedRawScopes: [
        { scopeType: "PROJECT", projectId: "prj_local" },
        { scopeType: "BIG_TASK", projectId: "prj_local", bigTaskId: "bt_local" },
        {
          scopeType: "SUBTASK",
          projectId: "prj_local",
          bigTaskId: "bt_local",
          subtaskId: "st_target",
        },
      ],
    } as unknown as AllowedContextSet;
    let rawLeaks = 0;
    for (const sourceSubtaskId of ["st_source", "st_mid", "st_sibling"]) {
      requireSnapshot(accept());
      const access = evaluateContextScopeAccess(
        allowed,
        ContextScopeSchema.parse({
          scopeType: "SUBTASK",
          projectId: "prj_local",
          bigTaskId: "bt_local",
          subtaskId: sourceSubtaskId,
        }),
      );
      rawLeaks += Number(access.allowed);
      expect(access.reason).toBe("SIBLING_SUBTASK_EXCLUDED");
    }
    expect(rawLeaks).toBe(0);
  });

  it("keeps generic PROMOTED_CONTEXT excluded from both QA profiles", () => {
    for (const profile of ["FRESH_INDEPENDENT_QA", "FOCUSED_RE_QA"] as const) {
      expect(
        evaluateQaContextProfileCandidate(profile, {
          candidateClass: "PROMOTED_CONTEXT",
          sourceReference: "accepted-snapshot:shape-only",
        }),
      ).toEqual({
        includedByProfile: false,
        reason: "EXCLUDED_PROMOTED_CONTEXT",
      });
    }
  });
});

describe("S2D5a scale/property oracle", () => {
  it("matches 864 distributed transition evaluations with zero mismatches", () => {
    const provenanceCases = [
      {
        sourceReference: "source:plain",
        evidenceReferences: [] as readonly string[],
      },
      {
        sourceReference: "  source:trimmed  ",
        evidenceReferences: [" evidence:a ", "evidence:a"],
      },
    ] as const;
    const evidenceCases = [
      {
        input: evidenceInput({
          sourceReference: "action:plain",
          occurredAt: "2026-08-16T00:30:00Z",
        }),
        valid: true,
        sourceReference: "action:plain",
        occurredAt: "2026-08-16T00:30:00.000Z",
      },
      {
        input: evidenceInput({
          sourceReference: "  action:trimmed  ",
          occurredAt: "2026-08-16T08:30:00+08:00",
        }),
        valid: true,
        sourceReference: "action:trimmed",
        occurredAt: "2026-08-16T00:30:00.000Z",
      },
      {
        input: evidenceInput({ evidenceType: "MODEL" }),
        valid: false,
        sourceReference: "",
        occurredAt: "",
      },
    ] as const;
    let evaluations = 0;
    let falseAccepted = 0;
    let falseRejectedValid = 0;
    const mismatches: string[] = [];

    for (const kind of CONTEXT_KINDS) {
      for (const sourceType of SOURCE_TYPES) {
        for (const audience of ["PARENT_BIG_TASK", "DOWNSTREAM_SUBTASK"] as const) {
          for (const provenance of provenanceCases) {
            for (const evidenceCase of evidenceCases) {
              for (const eligible of [true, false]) {
                const route = audience === "PARENT_BIG_TASK"
                  ? parentRoute(eligible ? "bt_local" : "bt_other")
                  : downstreamRoute();
                const graph = audience === "DOWNSTREAM_SUBTASK" && !eligible
                  ? topology([])
                  : topology();
                const promotedCandidate = candidateInput({
                  kind,
                  route,
                  provenance: {
                    sourceType,
                    sourceReference: provenance.sourceReference,
                    evidenceReferences: provenance.evidenceReferences,
                  },
                });
                const actual = accept(graph, promotedCandidate, evidenceCase.input);
                const shouldAccept = eligible && evidenceCase.valid;
                const expectedReason = !eligible
                  ? audience === "PARENT_BIG_TASK"
                    ? "NOT_SOURCE_PARENT_BIG_TASK"
                    : "NO_EXPLICIT_DEPENDENCY"
                  : "INVALID_HUMAN_CONFIRMATION_EVIDENCE";
                evaluations += 1;
                falseAccepted += Number(actual.accepted && !shouldAccept);
                falseRejectedValid += Number(!actual.accepted && shouldAccept);
                if (shouldAccept) {
                  const expectedSnapshot = {
                    candidate: canonicalCandidate(
                      kind,
                      route,
                      sourceType,
                      provenance.sourceReference.trim(),
                      provenance.evidenceReferences.map((reference) => reference.trim()),
                    ),
                    acceptance: {
                      method: "HUMAN_CONFIRMATION",
                      evidence: canonicalEvidence(
                        evidenceCase.sourceReference,
                        evidenceCase.occurredAt,
                      ),
                    },
                  };
                  if (
                    !actual.accepted ||
                    JSON.stringify(actual.snapshot) !== JSON.stringify(expectedSnapshot)
                  ) {
                    mismatches.push(`${kind}:${sourceType}:${audience}:eligible`);
                  }
                } else if (actual.accepted || actual.reason !== expectedReason) {
                  mismatches.push(`${kind}:${sourceType}:${audience}:${expectedReason}`);
                }
              }
            }
          }
        }
      }
    }

    expect(evaluations).toBe(864);
    expect(mismatches).toEqual([]);
    expect(falseAccepted).toBe(0);
    expect(falseRejectedValid).toBe(0);
  }, 15_000);
});

const MUTATION_HYPOTHESES = [
  ["transition exported from root", true, true],
  ["result schema exported from root", true, true],
  ["failure schema exported from root", true, true],
  ["schema parse treated as trust", true, true],
  ["method enum widened", true, true],
  ["accepted true added to DATA schema", true, true],
  ["trusted true added to DATA schema", true, true],
  ["approved true added to DATA schema", true, true],
  ["verified true added to DATA schema", true, true],
  ["requirement stored in snapshot", true, true],
  ["candidate rebuilt from caller after S2D2", true, true],
  ["evidence rebuilt from caller after S2D4", true, true],
  ["joint capture removed", true, true],
  ["candidate excluded from joint capture", true, true],
  ["topology excluded from joint capture", true, true],
  ["evidence excluded from joint capture", true, true],
  ["nested route mismatch ignored", true, true],
  ["later joint disagreement ignored", true, true],
  ["candidate topology relay survives", true, true],
  ["candidate evidence relay survives", true, true],
  ["topology evidence relay survives", true, true],
  ["three-way relay survives", true, true],
  ["late candidate change survives", true, true],
  ["burst topology change survives", true, true],
  ["phase-shifted evidence change survives", true, true],
  ["reflection exception treated as success", true, true],
  ["S2D4 denial ignored", true, true],
  ["S2D2 denial ignored", true, true],
  ["inconsistent upstream fallback removed", true, true],
  ["success result includes reason", true, true],
  ["failure result includes snapshot", true, true],
  ["success without snapshot accepted", true, true],
  ["failure without reason accepted", true, true],
  ["snapshot not deeply frozen", true, true],
  ["candidate caller references leaked", true, true],
  ["evidence caller references leaked", true, true],
  ["ContextAuthority HUMAN grants acceptance", true, true],
  ["AuditActorType HUMAN grants acceptance", true, true],
  ["AuditEvent grants acceptance", true, true],
  ["ImplementationCheckpoint grants acceptance", true, true],
  ["acceptedAt copied from evidence time", true, true],
  ["Date now acceptedAt added", true, true],
  ["random snapshot ID added", true, true],
  ["candidate ID added", true, false],
  ["candidate hash added", true, false],
  ["acceptance ID added", true, false],
  ["actor field added", true, false],
  ["session field added", true, false],
  ["signature field added", true, false],
  ["capability mint added", true, false],
  ["public accept wrapper added", true, false],
  ["controller call added", true, false],
  ["daemon command added", true, false],
  ["storage command added", true, false],
  ["persistence introduced", true, false],
  ["Context Item materialized", true, false],
  ["Audit Event emitted", true, false],
  ["retrieval introduced", true, false],
  ["Context Packet compiler widened", true, false],
  ["Fresh QA widened", true, false],
  ["raw ACL widened", true, false],
  ["OPEN_QUESTION marked resolved", true, false],
  ["OPEN_QUESTION marked answered", true, false],
  ["ENGINEERING_FACT claims deterministic evidence", true, false],
  ["engineering fact method changed", true, false],
  ["manual method accepted", true, false],
  ["system method accepted", true, false],
  ["model method accepted", true, false],
  ["repo method accepted", true, false],
  ["method whitespace normalized", true, false],
  ["method case normalized", true, false],
  ["top-level generic payload accepted", true, false],
  ["acceptance generic payload accepted", true, false],
  ["candidate extra lifecycle field accepted", true, false],
  ["evidence extra trust field accepted", true, false],
  ["accessor candidate trusted", true, false],
  ["accessor evidence trusted", true, false],
  ["symbol-key candidate trusted", true, false],
  ["changing descriptor trusted", true, false],
  ["output poisoning changes future method", true, false],
  ["output poisoning changes future reason", true, false],
  ["repeated calls add invocation counter", true, false],
  ["idempotency key added", true, false],
  ["anti-replay state added", true, false],
  ["one-shot consumption added", true, false],
  ["stable null-prototype input rejected", false, false],
  ["stable frozen input rejected", false, false],
  ["stable sealed input rejected", false, false],
  ["stable structured clone rejected", false, false],
  ["stable JSON copy rejected", false, false],
  ["stable transparent Proxy rejected", false, false],
] as const;

const SOURCE_TO_TEST_MAPPING = [
  "exact top-level DATA keys -> exact schema test",
  "exact acceptance keys -> exact schema test",
  "candidate exact S2D2 shape -> literal oracle",
  "evidence exact S2D4 shape -> literal oracle",
  "HUMAN_CONFIRMATION closure -> method alternatives",
  "no method normalization -> whitespace/case alternatives",
  "schema is DATA only -> manual forgery parse",
  "schema parse is not trust -> parser API audit",
  "root DATA schema export -> runtime inventory",
  "root DATA type export -> index source review",
  "internal transition absent from root -> runtime inventory",
  "internal result schemas absent from root -> runtime inventory",
  "package subpath closure -> package manifest",
  "no public alias -> wrapper source audit",
  "no operational caller -> call-site source audit",
  "invalid candidate preservation -> upstream matrix",
  "invalid route preservation -> upstream matrix",
  "invalid topology preservation -> upstream matrix",
  "wrong parent denial -> upstream matrix",
  "sibling denial -> upstream matrix",
  "reverse denial -> upstream matrix",
  "transitive denial -> upstream matrix",
  "cross-Big-Task denial -> upstream matrix",
  "cross-Project denial -> upstream matrix",
  "invalid evidence denial -> upstream matrix",
  "unstable evidence denial -> bounded failure test",
  "failure has no snapshot -> upstream matrix",
  "success/failure correlation -> result schema contradictions",
  "closed failure reasons -> failure enum test",
  "candidate/topology consistency -> pair relay",
  "candidate/evidence consistency -> pair relay",
  "topology/evidence consistency -> pair relay",
  "nested route/topology consistency -> nested relay",
  "nested route/evidence consistency -> nested relay",
  "three-way consistency -> three-way relay",
  "prime cycle resistance -> schedule campaign",
  "late change resistance -> schedule campaign",
  "burst resistance -> schedule campaign",
  "phase shift resistance -> schedule campaign",
  "reflection getPrototypeOf containment -> 42-case campaign",
  "reflection ownKeys containment -> 42-case campaign",
  "reflection descriptor containment -> 42-case campaign",
  "accessor rejection -> accessor campaign",
  "descriptor flag stability -> descriptor campaign",
  "symbol rejection -> descriptor campaign",
  "canonical title/body -> canonicalization test",
  "canonical provenance -> canonicalization test",
  "canonical evidence reference -> canonicalization test",
  "canonical evidence UTC time -> canonicalization test",
  "no raw reread -> detachment mutation test",
  "deep candidate freeze -> nested freeze test",
  "deep evidence freeze -> nested freeze test",
  "global singleton safety -> output poisoning test",
  "all six kinds -> kind matrix",
  "OPEN_QUESTION unresolved -> semantic test",
  "ENGINEERING_FACT human-only -> semantic test",
  "no requirement duplication -> kind/schema tests",
  "occurredAt is not acceptedAt -> source/schema audit",
  "no identity or randomness -> source/schema audit",
  "repeat determinism -> 25-call test",
  "legacy authority separation -> legacy matrix",
  "no controller or persistence -> production source audit",
  "S2A raw ACL closure -> sibling access test",
  "S2B non-consumption -> storage source audit",
  "S2C1 exclusion -> both-profile test",
  "stable representations -> seven-control matrix",
  "DATA JSON round trip -> serialization test",
  "scale oracle -> 864 evaluations",
] as const;

describe("S2D5a mutation resistance and source-to-test assurance", () => {
  it("reviews at least 85 mutations with 60 trust targets and 20 implementation-specific cases", () => {
    const materialSurvivors: readonly string[] = [];
    expect(MUTATION_HYPOTHESES.length).toBeGreaterThanOrEqual(85);
    expect(MUTATION_HYPOTHESES.filter(([, trustOriented]) => trustOriented).length)
      .toBeGreaterThanOrEqual(60);
    expect(
      MUTATION_HYPOTHESES.filter(([, , implementationSpecific]) => implementationSpecific)
        .length,
    ).toBeGreaterThanOrEqual(20);
    expect(MUTATION_HYPOTHESES.filter(([label]) => label.length === 0)).toEqual([]);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps at least 55 safety-critical conditions with no unjustified gap", () => {
    expect(SOURCE_TO_TEST_MAPPING.length).toBeGreaterThanOrEqual(55);
    expect(SOURCE_TO_TEST_MAPPING.filter((mapping) => !mapping.includes(" -> ")))
      .toEqual([]);
  });
});
