import { describe, expect, it } from "vitest";

import {
  captureTaskStorageError,
  createHierarchy,
  makeBigTask,
  makeDependency,
  makeProject,
  makeSubtask,
  withMemoryStorage,
} from "./fixtures.js";

describe("dependency persistence", () => {
  it("persists a valid acyclic dependency set", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const dependencies = [makeDependency("st_a", "st_b"), makeDependency("st_b", "st_c")];
      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, dependencies)).toEqual(
        dependencies,
      );
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(dependencies);
    });
  });

  it("orders dependency lists deterministically", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      storage.replaceDependenciesForBigTask(makeBigTask().id, [
        makeDependency("st_b", "st_c", "INFORMATIONAL"),
        makeDependency("st_a", "st_c"),
        makeDependency("st_a", "st_b"),
      ]);
      expect(
        storage
          .listDependenciesForBigTask(makeBigTask().id)
          .map(({ upstreamSubtaskId, downstreamSubtaskId }) =>
            `${upstreamSubtaskId}->${downstreamSubtaskId}`,
          ),
      ).toEqual(["st_a->st_b", "st_a->st_c", "st_b->st_c"]);
    });
  });

  it.each([
    ["self dependency", [makeDependency("st_a", "st_a")], "SELF_DEPENDENCY"],
    [
      "duplicate edge",
      [makeDependency("st_a", "st_b"), makeDependency("st_a", "st_b")],
      "DUPLICATE_DEPENDENCY",
    ],
    ["missing reference", [makeDependency("st_a", "st_missing")], "MISSING_DOWNSTREAM_SUBTASK"],
    [
      "direct cycle",
      [makeDependency("st_a", "st_b"), makeDependency("st_b", "st_a")],
      "DEPENDENCY_CYCLE",
    ],
    [
      "multi-node cycle",
      [
        makeDependency("st_a", "st_b"),
        makeDependency("st_b", "st_c"),
        makeDependency("st_c", "st_a"),
      ],
      "DEPENDENCY_CYCLE",
    ],
  ] as const)("rejects %s", (_name, dependencies, expectedCode) => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const error = captureTaskStorageError(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, dependencies),
      );
      expect(error.code).toBe("DEPENDENCY_VALIDATION_FAILED");
      expect(error.validationCodes).toContain(expectedCode);
    });
  });

  it("rejects cross-Big-Task dependencies", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      storage.createBigTask(makeBigTask("bt_other"));
      storage.createSubtask(makeSubtask("st_other", "bt_other"));

      const error = captureTaskStorageError(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [
          makeDependency("st_a", "st_other"),
        ]),
      );
      expect(error.validationCodes).toContain("CROSS_BIG_TASK_DEPENDENCY");
    });
  });

  it("leaves the previous set unchanged after invalid replacement", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const previous = [makeDependency("st_a", "st_b")];
      storage.replaceDependenciesForBigTask(makeBigTask().id, previous);
      captureTaskStorageError(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [
          makeDependency("st_a", "st_b"),
          makeDependency("st_b", "st_a"),
        ]),
      );
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(previous);
    });
  });

  it("atomically replaces a valid previous dependency set", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      storage.replaceDependenciesForBigTask(makeBigTask().id, [makeDependency("st_a", "st_b")]);
      const replacement = [makeDependency("st_b", "st_c", "INFORMATIONAL")];
      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, replacement)).toEqual(
        replacement,
      );
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(replacement);
    });
  });

  it("limits dependency lists to one Big Task", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      storage.createBigTask(makeBigTask("bt_other"));
      storage.createSubtask(makeSubtask("st_x", "bt_other"));
      storage.createSubtask(makeSubtask("st_y", "bt_other"));
      storage.replaceDependenciesForBigTask(makeBigTask().id, [makeDependency("st_a", "st_b")]);
      storage.replaceDependenciesForBigTask(makeBigTask("bt_other").id, [
        makeDependency("st_x", "st_y"),
      ]);

      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual([
        makeDependency("st_a", "st_b"),
      ]);
      expect(storage.listDependenciesForBigTask(makeBigTask("bt_other").id)).toEqual([
        makeDependency("st_x", "st_y"),
      ]);
    });
  });

  it("rejects dependencies scoped entirely to a different Big Task", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      storage.createBigTask(makeBigTask("bt_other"));
      storage.createSubtask(makeSubtask("st_x", "bt_other"));
      storage.createSubtask(makeSubtask("st_y", "bt_other"));

      const error = captureTaskStorageError(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [
          makeDependency("st_x", "st_y"),
        ]),
      );
      expect(error.validationCodes).toEqual(["DEPENDENCY_BIG_TASK_MISMATCH"]);
    });
  });
});
