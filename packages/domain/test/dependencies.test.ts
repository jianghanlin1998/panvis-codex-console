import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  validateSubtaskDependencies,
} from "../src/index.js";
import type { DependencySubtask, SubtaskDependency } from "../src/index.js";

const subtask = (id: string, bigTaskId = "bt_v1"): DependencySubtask => ({
  id: SubtaskIdSchema.parse(id),
  bigTaskId: BigTaskIdSchema.parse(bigTaskId),
});

const dependency = (
  upstreamSubtaskId: string,
  downstreamSubtaskId: string,
): SubtaskDependency =>
  SubtaskDependencySchema.parse({
    upstreamSubtaskId,
    downstreamSubtaskId,
    dependencyType: "BLOCKING",
  });

const errorCodes = (
  result: ReturnType<typeof validateSubtaskDependencies>,
): readonly string[] => result.errors.map(({ code }) => code);

describe("Subtask dependency validation", () => {
  it("accepts a valid acyclic dependency graph", () => {
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

  it("rejects a missing dependency reference", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a")],
      [dependency("st_a", "st_missing")],
    );

    expect(errorCodes(result)).toEqual(["MISSING_DOWNSTREAM_SUBTASK"]);
  });

  it("rejects a duplicate edge", () => {
    const edge = dependency("st_a", "st_b");
    const result = validateSubtaskDependencies([subtask("st_a"), subtask("st_b")], [edge, edge]);

    expect(errorCodes(result)).toContain("DUPLICATE_DEPENDENCY");
  });

  it("rejects a direct cycle", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b")],
      [dependency("st_a", "st_b"), dependency("st_b", "st_a")],
    );

    expect(errorCodes(result)).toContain("DEPENDENCY_CYCLE");
  });

  it("rejects a multi-node cycle", () => {
    const result = validateSubtaskDependencies(
      [subtask("st_a"), subtask("st_b"), subtask("st_c")],
      [dependency("st_a", "st_b"), dependency("st_b", "st_c"), dependency("st_c", "st_a")],
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
