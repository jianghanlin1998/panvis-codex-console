import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  DependencyRequiredGateSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  validateSubtaskDependencies,
} from "../src/index.js";
import type {
  DependencyRequiredGate,
  DependencySubtask,
  DependencyType,
  SubtaskDependency,
} from "../src/index.js";

const subtask = (id: string, bigTaskId = "bt_v1"): DependencySubtask => ({
  id: SubtaskIdSchema.parse(id),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
});

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
  dependencyType: DependencyType = "BLOCKING",
  requiredGate: DependencyRequiredGate =
    dependencyType === "BLOCKING" ? "ACCEPTED" : "NONE",
  reason = "The downstream contract relies on this relationship.",
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType,
    requiredGate,
    reason,
  });

const errorCodes = (
  result: ReturnType<typeof validateSubtaskDependencies>,
): readonly string[] => result.errors.map(({ code }) => code);

describe("Subtask dependency schema", () => {
  it.each([
    ["BLOCKING", "HARDENED"],
    ["BLOCKING", "ACCEPTED"],
    ["INFORMATIONAL", "NONE"],
  ] as const)("accepts %s + %s", (dependencyType, requiredGate) => {
    expect(
      dependency("st_a", "st_b", dependencyType, requiredGate),
    ).toMatchObject({ dependencyType, requiredGate });
  });

  it.each([
    ["BLOCKING", "NONE"],
    ["INFORMATIONAL", "HARDENED"],
    ["INFORMATIONAL", "ACCEPTED"],
  ] as const)("rejects illegal %s + %s", (dependencyType, requiredGate) => {
    expect(
      SubtaskDependencySchema.safeParse({
        upstreamSubtaskId: "st_a",
        downstreamSubtaskId: "st_b",
        dependencyType,
        requiredGate,
        reason: "Explicit relationship reason.",
      }).success,
    ).toBe(false);
  });

  it("exports exactly the three V1 required gates", () => {
    expect(DependencyRequiredGateSchema.options).toEqual([
      "NONE",
      "HARDENED",
      "ACCEPTED",
    ]);
  });

  it("trims non-empty reasons and rejects empty reasons", () => {
    expect(
      SubtaskDependencySchema.parse({
        upstreamSubtaskId: "st_a",
        downstreamSubtaskId: "st_b",
        dependencyType: "BLOCKING",
        requiredGate: "ACCEPTED",
        reason: "  Accepted persistence is required.  ",
      }).reason,
    ).toBe("Accepted persistence is required.");
    expect(
      SubtaskDependencySchema.safeParse({
        upstreamSubtaskId: "st_a",
        downstreamSubtaskId: "st_b",
        dependencyType: "BLOCKING",
        requiredGate: "ACCEPTED",
        reason: " \t\n ",
      }).success,
    ).toBe(false);
  });

  it("accepts 1,000 UTF-16 code units and rejects 1,001 without truncation", () => {
    const base = {
      upstreamSubtaskId: "st_a",
      downstreamSubtaskId: "st_b",
      dependencyType: "BLOCKING",
      requiredGate: "HARDENED",
    } as const;
    expect(SubtaskDependencySchema.parse({ ...base, reason: "a".repeat(1_000) }).reason)
      .toHaveLength(1_000);
    expect(
      SubtaskDependencySchema.safeParse({ ...base, reason: "a".repeat(1_001) }).success,
    ).toBe(false);
  });

  it("rejects unknown fields strictly", () => {
    expect(
      SubtaskDependencySchema.safeParse({
        ...dependency("st_a", "st_b"),
        metadata: { hidden: true },
      }).success,
    ).toBe(false);
  });
});

describe("Subtask dependency structural validation", () => {
  it("accepts a valid acyclic blocking dependency graph", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b"), subtask("st_c")],
      [dependency("st_a", "st_b"), dependency("st_b", "st_c")],
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects self-dependency", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a")],
      [dependency("st_a", "st_a")],
    );

    expect(errorCodes(result)).toContain("SELF_DEPENDENCY");
  });

  it("rejects missing upstream and downstream references", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a")],
      [dependency("st_missing_upstream", "st_a"), dependency("st_a", "st_missing_downstream")],
    );

    expect(errorCodes(result)).toEqual([
      "MISSING_UPSTREAM_SUBTASK",
      "MISSING_DOWNSTREAM_SUBTASK",
    ]);
  });

  it("rejects a duplicate endpoint pair regardless of semantic fields", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b")],
      [
        dependency("st_a", "st_b", "BLOCKING", "HARDENED"),
        dependency("st_a", "st_b", "INFORMATIONAL", "NONE"),
      ],
    );

    expect(errorCodes(result)).toContain("DUPLICATE_DEPENDENCY");
  });

  it("rejects direct and multi-node blocking cycles", () => {
    const direct = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b")],
      [dependency("st_a", "st_b"), dependency("st_b", "st_a")],
    );
    const multiNode = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b"), subtask("st_c")],
      [dependency("st_a", "st_b"), dependency("st_b", "st_c"), dependency("st_c", "st_a")],
    );

    expect(errorCodes(direct)).toContain("DEPENDENCY_CYCLE");
    expect(errorCodes(multiNode)).toContain("DEPENDENCY_CYCLE");
  });

  it("allows an informational cycle because it cannot block readiness", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b")],
      [
        dependency("st_a", "st_b", "INFORMATIONAL", "NONE"),
        dependency("st_b", "st_a", "INFORMATIONAL", "NONE"),
      ],
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("allows a mixed reverse pair with no blocking-only cycle", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b")],
      [
        dependency("st_a", "st_b", "BLOCKING", "HARDENED"),
        dependency("st_b", "st_a", "INFORMATIONAL", "NONE"),
      ],
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("finds a blocking cycle inside a larger mixed graph", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b"), subtask("st_c"), subtask("st_d")],
      [
        dependency("st_a", "st_b", "BLOCKING", "HARDENED"),
        dependency("st_b", "st_c", "INFORMATIONAL", "NONE"),
        dependency("st_c", "st_a", "BLOCKING", "ACCEPTED"),
        dependency("st_b", "st_d", "BLOCKING", "ACCEPTED"),
        dependency("st_d", "st_a", "BLOCKING", "HARDENED"),
      ],
    );

    expect(errorCodes(result)).toContain("DEPENDENCY_CYCLE");
  });

  it("rejects a cross-Big-Task dependency", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a", "bt_one"), subtask("st_b", "bt_two")],
      [dependency("st_a", "st_b")],
    );

    expect(errorCodes(result)).toEqual(["CROSS_BIG_TASK_DEPENDENCY"]);
  });
});
