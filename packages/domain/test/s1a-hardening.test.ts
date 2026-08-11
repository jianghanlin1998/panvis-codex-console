import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  SubtaskCreateInputSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  SubtaskSchema,
  evaluateSubtaskDependencyReadiness,
  validateSubtaskDependencies,
  validateSubtaskMaturityTransition,
} from "../src/index.js";
import type {
  DependencyReadinessBlocker,
  DependencyReadinessSubtask,
  DependencyRequiredGate,
  SubtaskDependency,
  SubtaskMaturity,
} from "../src/index.js";

const MATURITIES = ["NOT_STARTED", "IMPLEMENTED", "HARDENED", "ACCEPTED"] as const;
const STATUSES = ["TODO", "IN_PROGRESS", "QA_DEBUG", "DONE", "DROPPED", "ARCHIVED"] as const;

const taskId = (value: string) => SubtaskIdSchema.parse(value);
const bigTaskId = (value = "bt_hardening") => BigTaskIdSchema.parse(value);

const subtask = (
  id: string,
  maturity: SubtaskMaturity = "NOT_STARTED",
  owner = "bt_hardening",
): DependencyReadinessSubtask => ({ id: taskId(id), bigTaskId: bigTaskId(owner), maturity });

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: "BLOCKING" | "INFORMATIONAL" = "BLOCKING",
  requiredGate: DependencyRequiredGate = dependencyType === "BLOCKING" ? "HARDENED" : "NONE",
  reason = `${upstreamSubtaskId} must satisfy ${requiredGate}.`,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType,
    requiredGate,
    reason,
  });

const validSubtask = {
  recordType: "SUBTASK",
  id: "st_schema",
  bigTaskId: "bt_hardening",
  title: "Schema hardening",
  goal: "Prove the maturity boundary.",
  scopeIn: ["S1A"],
  scopeOut: ["Lifecycle"],
  acceptanceCriteria: ["Deterministic"],
  untouchedAreas: ["S1B"],
  status: "TODO",
  maturity: "NOT_STARTED",
  startPolicy: "MANUAL",
  delegationPolicy: "NONE",
  recommendedReasoningLevel: "HIGH",
  promptSeed: "Harden S1A.",
} as const;

const gateSatisfied = (
  maturity: SubtaskMaturity,
  gate: Exclude<DependencyRequiredGate, "NONE">,
): boolean => gate === "HARDENED"
  ? maturity === "HARDENED" || maturity === "ACCEPTED"
  : maturity === "ACCEPTED";

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const oracleBlockers = (
  subtasks: readonly DependencyReadinessSubtask[],
  dependencies: readonly SubtaskDependency[],
  downstreamSubtaskId: string,
): readonly DependencyReadinessBlocker[] => {
  const byId = new Map(subtasks.map((value) => [value.id, value]));
  return dependencies
    .filter(
      (edge): edge is Extract<SubtaskDependency, { dependencyType: "BLOCKING" }> =>
        edge.dependencyType === "BLOCKING" &&
        edge.downstreamSubtaskId === downstreamSubtaskId,
    )
    .flatMap((edge) => {
      const upstream = byId.get(edge.upstreamSubtaskId);
      return upstream !== undefined && !gateSatisfied(upstream.maturity, edge.requiredGate)
        ? [{
            upstreamSubtaskId: edge.upstreamSubtaskId,
            requiredGate: edge.requiredGate,
            actualMaturity: upstream.maturity,
            reason: edge.reason,
          }]
        : [];
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.upstreamSubtaskId, right.upstreamSubtaskId) ||
        compareCodeUnits(left.requiredGate, right.requiredGate) ||
        compareCodeUnits(left.reason, right.reason),
    );
};

describe("S1A maturity boundary hardening", () => {
  it("accepts every persisted maturity but only NOT_STARTED at creation", () => {
    for (const maturity of MATURITIES) {
      expect(SubtaskSchema.safeParse({ ...validSubtask, maturity }).success).toBe(true);
      expect(SubtaskCreateInputSchema.safeParse({ ...validSubtask, maturity }).success).toBe(
        maturity === "NOT_STARTED",
      );
    }
  });

  it("keeps every board status independent at creation", () => {
    for (const status of STATUSES) {
      expect(SubtaskCreateInputSchema.parse({ ...validSubtask, status })).toMatchObject({
        status,
        maturity: "NOT_STARTED",
      });
    }
  });

  it("rejects missing, null, padded, case-shifted, empty, and extended creation maturity", () => {
    const missing: Record<string, unknown> = { ...validSubtask };
    delete missing.maturity;
    const invalid = [
      missing,
      { ...validSubtask, maturity: null },
      { ...validSubtask, maturity: "" },
      { ...validSubtask, maturity: " NOT_STARTED " },
      { ...validSubtask, maturity: "not_started" },
      { ...validSubtask, maturity: "Not_Started" },
      { ...validSubtask, hidden: true },
    ];
    invalid.forEach((value) => expect(SubtaskCreateInputSchema.safeParse(value).success).toBe(false));
  });

  it("matches an independent complete 4 by 4 transition oracle", () => {
    const allowed = new Set([
      "NOT_STARTED->IMPLEMENTED",
      "IMPLEMENTED->HARDENED",
      "HARDENED->ACCEPTED",
    ]);
    for (const from of MATURITIES) {
      for (const to of MATURITIES) {
        expect(validateSubtaskMaturityTransition(from, to).allowed).toBe(
          allowed.has(`${from}->${to}`),
        );
      }
    }
  });

  it("fails closed for malformed runtime transition values", () => {
    const invalidPairs = [
      [undefined, undefined],
      ["ACCEPTED", null],
      [null, "NOT_STARTED"],
      ["NOT_STARTED", "implemented"],
      [" HARDENED", "ACCEPTED"],
      [{}, "IMPLEMENTED"],
    ] as const;
    for (const [from, to] of invalidPairs) {
      expect(
        validateSubtaskMaturityTransition(
          from as unknown as SubtaskMaturity,
          to as unknown as SubtaskMaturity,
        ),
      ).toEqual({ allowed: false, errorCodes: ["UNSUPPORTED_MATURITY_TRANSITION"] });
    }
  });
});

describe("S1A dependency boundary and graph hardening", () => {
  it("covers every legal and illegal type/gate pair", () => {
    for (const [type, gate, accepted] of [
      ["BLOCKING", "NONE", false],
      ["BLOCKING", "HARDENED", true],
      ["BLOCKING", "ACCEPTED", true],
      ["INFORMATIONAL", "NONE", true],
      ["INFORMATIONAL", "HARDENED", false],
      ["INFORMATIONAL", "ACCEPTED", false],
    ] as const) {
      expect(
        SubtaskDependencySchema.safeParse({
          upstreamSubtaskId: "st_a",
          downstreamSubtaskId: "st_b",
          dependencyType: type,
          requiredGate: gate,
          reason: "Explicit evidence.",
        }).success,
      ).toBe(accepted);
    }
  });

  it("enforces trimming, UTF-16 limits, scripts, combining text, and no truncation", () => {
    const base = {
      upstreamSubtaskId: "st_a",
      downstreamSubtaskId: "st_b",
      dependencyType: "BLOCKING",
      requiredGate: "HARDENED",
    } as const;
    for (const reason of ["x", "中文", "日本語", "한국어", "e\u0301", "mixed 日本 🚀"]) {
      expect(SubtaskDependencySchema.parse({ ...base, reason: ` \t${reason}\n ` }).reason).toBe(
        reason,
      );
    }
    expect(SubtaskDependencySchema.parse({ ...base, reason: "x".repeat(1_000) }).reason)
      .toHaveLength(1_000);
    expect(SubtaskDependencySchema.safeParse({ ...base, reason: "x".repeat(1_001) }).success)
      .toBe(false);
    expect(SubtaskDependencySchema.parse({ ...base, reason: "🚀".repeat(500) }).reason)
      .toHaveLength(1_000);
    expect(SubtaskDependencySchema.safeParse({ ...base, reason: "🚀".repeat(501) }).success)
      .toBe(false);
    expect(SubtaskDependencySchema.safeParse({ ...base, reason: " \t\n " }).success).toBe(false);
    expect(SubtaskDependencySchema.safeParse({ ...base, reason: "ok", extra: true }).success)
      .toBe(false);
  });

  it("reports independent structural errors together", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b"), subtask("st_other", "NOT_STARTED", "bt_other")],
      [
        dependency("st_a", "st_a"),
        dependency("st_a", "st_missing"),
        dependency("st_missing", "st_b"),
        dependency("st_a", "st_b"),
        dependency("st_a", "st_b", "INFORMATIONAL", "NONE"),
        dependency("st_a", "st_other"),
      ],
    );
    expect(result.valid).toBe(false);
    expect(new Set(result.errors.map(({ code }) => code))).toEqual(
      new Set([
        "SELF_DEPENDENCY",
        "MISSING_DOWNSTREAM_SUBTASK",
        "MISSING_UPSTREAM_SUBTASK",
        "DUPLICATE_DEPENDENCY",
        "CROSS_BIG_TASK_DEPENDENCY",
      ]),
    );
  });

  it("uses only the blocking subgraph across cycle, tail, dense, and mixed topologies", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => subtask(`st_graph_${index}`));
    const cases: readonly [readonly SubtaskDependency[], boolean][] = [
      [[dependency("st_graph_0", "st_graph_1"), dependency("st_graph_1", "st_graph_0")], false],
      [[
        dependency("st_graph_0", "st_graph_1"),
        dependency("st_graph_1", "st_graph_2"),
        dependency("st_graph_2", "st_graph_0"),
        dependency("st_graph_2", "st_graph_3"),
        dependency("st_graph_4", "st_graph_0"),
      ], false],
      [[
        dependency("st_graph_0", "st_graph_1", "INFORMATIONAL", "NONE"),
        dependency("st_graph_1", "st_graph_2", "INFORMATIONAL", "NONE"),
        dependency("st_graph_2", "st_graph_0", "INFORMATIONAL", "NONE"),
      ], true],
      [[
        dependency("st_graph_0", "st_graph_1"),
        dependency("st_graph_1", "st_graph_0", "INFORMATIONAL", "NONE"),
        dependency("st_graph_1", "st_graph_2"),
        dependency("st_graph_2", "st_graph_3"),
      ], true],
      [Array.from({ length: 11 }, (_, index) =>
        dependency(`st_graph_${index}`, `st_graph_${index + 1}`)), true],
    ];
    for (const [edges, valid] of cases) {
      expect(validateSubtaskDependencies(nodes, edges).valid).toBe(valid);
    }
  });

  it("keeps cycle diagnostics deterministic without treating informational chords as cycles", () => {
    const nodes = Array.from({ length: 8 }, (_, index) => subtask(`st_scc_${index}`));
    const edges = [
      dependency("st_scc_0", "st_scc_1"),
      dependency("st_scc_1", "st_scc_0"),
      dependency("st_scc_1", "st_scc_2"),
      dependency("st_scc_3", "st_scc_4"),
      dependency("st_scc_4", "st_scc_3"),
      dependency("st_scc_4", "st_scc_5"),
      dependency("st_scc_5", "st_scc_6", "INFORMATIONAL", "NONE"),
      dependency("st_scc_6", "st_scc_3", "INFORMATIONAL", "NONE"),
    ];
    const forward = validateSubtaskDependencies(nodes, edges);
    const reverse = validateSubtaskDependencies(nodes, [...edges].reverse());
    expect(forward.valid).toBe(false);
    expect(reverse.valid).toBe(false);
    expect(forward.errors.find(({ code }) => code === "DEPENDENCY_CYCLE")?.subtaskIds).toEqual(
      reverse.errors.find(({ code }) => code === "DEPENDENCY_CYCLE")?.subtaskIds,
    );
  });
});

describe("S1A readiness campaigns", () => {
  it("filters and orders exactly 0, 1, 2, 5, and 20 direct unsatisfied blockers", () => {
    const downstream = subtask("st_downstream");
    const upstreams = Array.from({ length: 24 }, (_, index) =>
      subtask(`st_up_${index.toString().padStart(2, "0")}`, index < 20 ? "IMPLEMENTED" : "ACCEPTED"));
    const elsewhere = subtask("st_elsewhere");
    for (const blockerCount of [0, 1, 2, 5, 20]) {
      const edges = [
        ...upstreams.slice(0, blockerCount).map((upstream, index) =>
          dependency(
            upstream.id,
            downstream.id,
            "BLOCKING",
            index % 2 === 0 ? "HARDENED" : "ACCEPTED",
            `Evidence ${index}.`,
          )),
        dependency(upstreams[20]!.id, downstream.id, "BLOCKING", "HARDENED", "Satisfied."),
        dependency(upstreams[21]!.id, downstream.id, "INFORMATIONAL", "NONE", "Context."),
        dependency(downstream.id, elsewhere.id, "BLOCKING", "HARDENED", "Outgoing."),
        dependency(upstreams[23]!.id, elsewhere.id, "BLOCKING", "ACCEPTED", "Other target."),
      ];
      const tasks = [...upstreams, downstream, elsewhere];
      const result = evaluateSubtaskDependencyReadiness(tasks, edges, downstream.id);
      expect(result).toMatchObject({ valid: true, ready: blockerCount === 0 });
      expect(result.blockers).toHaveLength(blockerCount);
      expect(result.blockers).toEqual(oracleBlockers(tasks, edges, downstream.id));
    }
  });

  it("is input-order and locale independent for Unicode and punctuation identifiers", () => {
    const downstream = subtask("st_target");
    const upstreams = ["st_10", "st_2", "st_A", "st_a", "st_中", "st_日本", "st_🚀", "st_-dot."]
      .map((id) => subtask(id, "NOT_STARTED"));
    const edges = upstreams.map((upstream, index) =>
      dependency(upstream.id, downstream.id, "BLOCKING", index % 2 === 0 ? "HARDENED" : "ACCEPTED", `理由 ${index}`));
    const originalLocaleCompare = String.prototype.localeCompare;
    try {
      String.prototype.localeCompare = () => {
        throw new Error("locale-sensitive comparison must not be used");
      };
      const orders = [edges, [...edges].reverse(), [...edges.slice(3), ...edges.slice(0, 3)]];
      const results = orders.map((ordered) =>
        evaluateSubtaskDependencyReadiness([...upstreams, downstream], ordered, downstream.id).blockers);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(results[0]).toEqual(oracleBlockers([...upstreams, downstream], edges, downstream.id));
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it("fails closed without exceptions for malformed runtime inputs and duplicate identities", () => {
    const base = [subtask("st_upstream", "NOT_STARTED"), subtask("st_downstream")];
    const edge = dependency("st_upstream", "st_downstream", "BLOCKING", "ACCEPTED");
    const cases = [
      [{ ...base[0], maturity: "UNKNOWN" }, base[1]],
      [{ id: base[0]!.id, bigTaskId: base[0]!.bigTaskId }, base[1]],
      [{ ...base[0], maturity: null }, base[1]],
      [base[0], { ...base[0], maturity: "ACCEPTED" }, base[1]],
      [base[0], { ...base[0] }, base[1]],
      [{ ...base[0], bigTaskId: " bt_hardening" }, base[1]],
    ];
    for (const malformed of cases) {
      expect(() =>
        evaluateSubtaskDependencyReadiness(
          malformed as unknown as readonly DependencyReadinessSubtask[],
          [edge],
          taskId("st_downstream"),
        )).not.toThrow();
      expect(
        evaluateSubtaskDependencyReadiness(
          malformed as unknown as readonly DependencyReadinessSubtask[],
          [edge],
          taskId("st_downstream"),
        ),
      ).toEqual({ valid: false, ready: false, blockers: [], errors: [], errorCodes: [] });
    }
    expect(
      evaluateSubtaskDependencyReadiness([], [], taskId("st_downstream")),
    ).toMatchObject({ valid: false, ready: false, blockers: [] });
  });

  it("matches an independent oracle for at least 30 fixed seeds and 1,000 evaluations", () => {
    let evaluations = 0;
    for (let seed = 0; seed < 32; seed += 1) {
      const count = 10 + ((seed * 13) % 51);
      const subtasks = Array.from({ length: count }, (_, index) =>
        subtask(`st_seed_${seed}_${index}`, MATURITIES[(seed * 7 + index * 3) % MATURITIES.length]));
      const edges: SubtaskDependency[] = [];
      const edgeKeys = new Set<string>();
      const add = (edge: SubtaskDependency): void => {
        const key = `${edge.upstreamSubtaskId}->${edge.downstreamSubtaskId}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push(edge);
        }
      };
      for (let index = 1; index < count; index += 1) {
        const upstreamIndex = (seed * 11 + index * 5) % index;
        add(dependency(subtasks[upstreamIndex]!.id, subtasks[index]!.id, "BLOCKING", index % 3 === 0 ? "ACCEPTED" : "HARDENED", `seed ${seed} edge ${index}`));
        if (index > 3) {
          const second = (upstreamIndex + 1) % index;
          add(dependency(subtasks[second]!.id, subtasks[index]!.id, "BLOCKING", index % 4 === 0 ? "ACCEPTED" : "HARDENED", `seed ${seed} fan ${index}`));
        }
        const infoTarget = (index * 7 + seed) % count;
        if (infoTarget !== index) {
          add(dependency(subtasks[index]!.id, subtasks[infoTarget]!.id, "INFORMATIONAL", "NONE", `seed ${seed} information ${index}`));
        }
      }
      expect(validateSubtaskDependencies(subtasks, edges).valid).toBe(true);
      for (const downstream of subtasks) {
        const expected = oracleBlockers(subtasks, edges, downstream.id);
        expect(evaluateSubtaskDependencyReadiness(subtasks, edges, downstream.id)).toEqual({
          valid: true,
          ready: expected.length === 0,
          blockers: expected,
          errors: [],
          errorCodes: [],
        });
        evaluations += 1;
      }

      const cycleEdges = edges.filter((edge) =>
        !(
          (edge.upstreamSubtaskId === subtasks[0]!.id && edge.downstreamSubtaskId === subtasks[1]!.id) ||
          (edge.upstreamSubtaskId === subtasks[1]!.id && edge.downstreamSubtaskId === subtasks[0]!.id)
        ));
      cycleEdges.push(
        dependency(subtasks[0]!.id, subtasks[1]!.id),
        dependency(subtasks[1]!.id, subtasks[0]!.id),
      );
      expect(evaluateSubtaskDependencyReadiness(subtasks, cycleEdges, subtasks[1]!.id)).toMatchObject({
        valid: false,
        ready: false,
        blockers: [],
      });
    }
    expect(evaluations).toBeGreaterThanOrEqual(1_000);
  });

  it("handles a 240-Subtask mixed graph and a bounded introduced cycle", () => {
    const subtasks = Array.from({ length: 240 }, (_, index) =>
      subtask(`st_large_${index.toString().padStart(3, "0")}`, MATURITIES[index % 4]));
    const edges: SubtaskDependency[] = [];
    for (let index = 1; index < subtasks.length; index += 1) {
      edges.push(dependency(subtasks[index - 1]!.id, subtasks[index]!.id, "BLOCKING", index % 2 === 0 ? "HARDENED" : "ACCEPTED", `chain ${index}`));
      if (index >= 10 && index % 5 === 0) {
        edges.push(dependency(subtasks[index - 10]!.id, subtasks[index]!.id, "BLOCKING", "HARDENED", `fan ${index}`));
      }
      if (index > 1) {
        edges.push(dependency(subtasks[index]!.id, subtasks[index - 2]!.id, "INFORMATIONAL", "NONE", `information ${index}`));
      }
    }
    expect(validateSubtaskDependencies(subtasks, edges)).toEqual({ valid: true, errors: [] });
    for (const downstream of subtasks) {
      const expected = oracleBlockers(subtasks, edges, downstream.id);
      expect(evaluateSubtaskDependencyReadiness(subtasks, edges, downstream.id).blockers).toEqual(expected);
    }
    const cyclic = [...edges, dependency(subtasks[239]!.id, subtasks[0]!.id)];
    expect(validateSubtaskDependencies(subtasks, cyclic).valid).toBe(false);
  });
});
