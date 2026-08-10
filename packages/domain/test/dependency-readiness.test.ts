import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  evaluateSubtaskDependencyReadiness,
} from "../src/index.js";
import type {
  DependencyReadinessSubtask,
  DependencyRequiredGate,
  SubtaskDependency,
  SubtaskMaturity,
} from "../src/index.js";

const readinessSubtask = (
  id: string,
  maturity: SubtaskMaturity,
  bigTaskId = "bt_v1",
): DependencyReadinessSubtask => ({
  id: SubtaskIdSchema.parse(id),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
  maturity,
});

const blocking = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  requiredGate: Exclude<DependencyRequiredGate, "NONE">,
  reason = `Gate ${requiredGate} is required.`,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
    requiredGate,
    reason,
  });

const informational = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "INFORMATIONAL",
    requiredGate: "NONE",
    reason: "Related work is useful but does not gate execution.",
  });

describe("dependency readiness evaluation", () => {
  it.each<[SubtaskMaturity, "HARDENED" | "ACCEPTED", boolean]>([
    ["NOT_STARTED", "HARDENED", false],
    ["IMPLEMENTED", "HARDENED", false],
    ["HARDENED", "HARDENED", true],
    ["ACCEPTED", "HARDENED", true],
    ["NOT_STARTED", "ACCEPTED", false],
    ["IMPLEMENTED", "ACCEPTED", false],
    ["HARDENED", "ACCEPTED", false],
    ["ACCEPTED", "ACCEPTED", true],
  ])(
    "evaluates upstream %s against required %s",
    (maturity, requiredGate, ready) => {
      const result = evaluateSubtaskDependencyReadiness(
        [readinessSubtask("st_upstream", maturity), readinessSubtask("st_downstream", "NOT_STARTED")],
        [blocking("st_upstream", "st_downstream", requiredGate)],
        SubtaskIdSchema.parse("st_downstream"),
      );

      expect(result.valid).toBe(true);
      expect(result.ready).toBe(ready);
      expect(result.blockers).toHaveLength(ready ? 0 : 1);
    },
  );

  it.each<SubtaskMaturity>([
    "NOT_STARTED",
    "IMPLEMENTED",
    "HARDENED",
    "ACCEPTED",
  ])("never blocks an INFORMATIONAL + NONE edge at %s", (maturity) => {
    const result = evaluateSubtaskDependencyReadiness(
      [readinessSubtask("st_upstream", maturity), readinessSubtask("st_downstream", "NOT_STARTED")],
      [informational("st_upstream", "st_downstream")],
      SubtaskIdSchema.parse("st_downstream"),
    );

    expect(result).toMatchObject({ valid: true, ready: true, blockers: [] });
  });

  it("requires every blocking dependency to satisfy its gate", () => {
    const result = evaluateSubtaskDependencyReadiness(
      [
        readinessSubtask("st_z", "IMPLEMENTED"),
        readinessSubtask("st_a", "HARDENED"),
        readinessSubtask("st_m", "ACCEPTED"),
        readinessSubtask("st_downstream", "NOT_STARTED"),
      ],
      [
        blocking("st_z", "st_downstream", "HARDENED", "Z needs hardening."),
        blocking("st_m", "st_downstream", "HARDENED", "M needs hardening."),
        blocking("st_a", "st_downstream", "ACCEPTED", "A needs acceptance."),
      ],
      SubtaskIdSchema.parse("st_downstream"),
    );

    expect(result).toEqual({
      valid: true,
      ready: false,
      blockers: [
        {
          upstreamSubtaskId: "st_a",
          requiredGate: "ACCEPTED",
          actualMaturity: "HARDENED",
          reason: "A needs acceptance.",
        },
        {
          upstreamSubtaskId: "st_z",
          requiredGate: "HARDENED",
          actualMaturity: "IMPLEMENTED",
          reason: "Z needs hardening.",
        },
      ],
      errors: [],
      errorCodes: [],
    });
  });

  it("is ready with all blockers satisfied or no blocking dependencies", () => {
    const subtasks = [
      readinessSubtask("st_a", "ACCEPTED"),
      readinessSubtask("st_b", "HARDENED"),
      readinessSubtask("st_downstream", "NOT_STARTED"),
    ];
    expect(
      evaluateSubtaskDependencyReadiness(
        subtasks,
        [
          blocking("st_a", "st_downstream", "ACCEPTED"),
          blocking("st_b", "st_downstream", "HARDENED"),
        ],
        SubtaskIdSchema.parse("st_downstream"),
      ).ready,
    ).toBe(true);
    expect(
      evaluateSubtaskDependencyReadiness(
        subtasks,
        [informational("st_a", "st_downstream")],
        SubtaskIdSchema.parse("st_downstream"),
      ).ready,
    ).toBe(true);
  });

  it("fails closed for an invalid blocking graph", () => {
    const result = evaluateSubtaskDependencyReadiness(
      [readinessSubtask("st_a", "ACCEPTED"), readinessSubtask("st_b", "ACCEPTED")],
      [blocking("st_a", "st_b", "ACCEPTED"), blocking("st_b", "st_a", "ACCEPTED")],
      SubtaskIdSchema.parse("st_b"),
    );

    expect(result.valid).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.errorCodes).toContain("DEPENDENCY_CYCLE");
  });

  it.each([
    [
      "missing endpoint",
      [readinessSubtask("st_downstream", "NOT_STARTED")],
      [blocking("st_missing", "st_downstream", "ACCEPTED")],
      "MISSING_UPSTREAM_SUBTASK",
    ],
    [
      "cross-Big-Task edge",
      [
        readinessSubtask("st_upstream", "ACCEPTED", "bt_one"),
        readinessSubtask("st_downstream", "NOT_STARTED", "bt_two"),
      ],
      [blocking("st_upstream", "st_downstream", "ACCEPTED")],
      "CROSS_BIG_TASK_DEPENDENCY",
    ],
  ] as const)("fails closed for %s", (_label, subtasks, dependencies, errorCode) => {
    const result = evaluateSubtaskDependencyReadiness(
      subtasks,
      dependencies,
      SubtaskIdSchema.parse("st_downstream"),
    );

    expect(result).toMatchObject({ valid: false, ready: false, blockers: [] });
    expect(result.errorCodes).toContain(errorCode);
  });

  it("fails closed when the requested downstream Subtask does not exist", () => {
    const result = evaluateSubtaskDependencyReadiness(
      [readinessSubtask("st_upstream", "ACCEPTED")],
      [],
      SubtaskIdSchema.parse("st_missing"),
    );

    expect(result).toMatchObject({ valid: false, ready: false, blockers: [] });
    expect(result.errorCodes).toEqual(["MISSING_DOWNSTREAM_SUBTASK"]);
  });

  it("does not mutate caller arrays or objects", () => {
    const subtasks = Object.freeze([
      Object.freeze(readinessSubtask("st_upstream", "IMPLEMENTED")),
      Object.freeze(readinessSubtask("st_downstream", "NOT_STARTED")),
    ]);
    const dependencies = Object.freeze([
      Object.freeze(blocking("st_upstream", "st_downstream", "HARDENED")),
    ]);
    const snapshot = JSON.stringify({ subtasks, dependencies });

    evaluateSubtaskDependencyReadiness(
      subtasks,
      dependencies,
      SubtaskIdSchema.parse("st_downstream"),
    );

    expect(JSON.stringify({ subtasks, dependencies })).toBe(snapshot);
  });
});
