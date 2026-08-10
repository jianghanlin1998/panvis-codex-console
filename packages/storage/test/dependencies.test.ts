import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { SubtaskDependency } from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";

import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeBigTask,
  makeDependency,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

describe("dependency persistence", () => {
  it("round-trips every legal gate combination and explicit reason", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const dependencies = [
        makeDependency(
          "st_a",
          "st_b",
          "BLOCKING",
          "HARDENED",
          "Stable lifecycle contract is required.",
        ),
        makeDependency(
          "st_a",
          "st_c",
          "INFORMATIONAL",
          "NONE",
          "Related design conclusions may help.",
        ),
        makeDependency(
          "st_b",
          "st_c",
          "BLOCKING",
          "ACCEPTED",
          "Accepted persistence isolation is required.",
        ),
      ];

      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, dependencies)).toEqual(
        dependencies,
      );
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(dependencies);
    });
  });

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

  it("persists informational cycles and mixed reverse pairs without blocking-cycle rejection", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const informationalCycle = [
        makeDependency("st_a", "st_b", "INFORMATIONAL"),
        makeDependency("st_b", "st_a", "INFORMATIONAL"),
      ];
      expect(
        storage.replaceDependenciesForBigTask(makeBigTask().id, informationalCycle),
      ).toEqual(informationalCycle);

      const mixedReversePair = [
        makeDependency("st_a", "st_b", "BLOCKING", "HARDENED"),
        makeDependency("st_b", "st_a", "INFORMATIONAL"),
      ];
      expect(
        storage.replaceDependenciesForBigTask(makeBigTask().id, mixedReversePair),
      ).toEqual(mixedReversePair);
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

  it("rolls back deletion when insertion preparation fails", () => {
    let clockIsInvalid = false;
    const storage = openTaskDatabase({
      databasePath: ":memory:",
      clock: () => (clockIsInvalid ? new Date(Number.NaN) : fixedClock()),
    });
    try {
      createHierarchy(storage);
      const previous = [makeDependency("st_a", "st_b")];
      storage.replaceDependenciesForBigTask(makeBigTask().id, previous);

      clockIsInvalid = true;
      expect(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [
          makeDependency("st_b", "st_c", "BLOCKING", "HARDENED"),
        ]),
      ).toThrow(expect.objectContaining({ code: "STORAGE_OPERATION_FAILED" }));
      clockIsInvalid = false;
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(previous);
    } finally {
      storage.close();
    }
  });

  it("preserves dependency semantics through repeated reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(first);
      const dependencies = [
        makeDependency("st_a", "st_b", "BLOCKING", "HARDENED", "Hardening is enough."),
        makeDependency("st_b", "st_c", "INFORMATIONAL", "NONE", "Useful context only."),
      ];
      first.replaceDependenciesForBigTask(makeBigTask().id, dependencies);
      first.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(reopened.listDependenciesForBigTask(makeBigTask().id)).toEqual(dependencies);
        } finally {
          reopened.close();
        }
      }
    });
  });

  it.each([
    ["BLOCKING", "NONE"],
    ["INFORMATIONAL", "HARDENED"],
    ["INFORMATIONAL", "ACCEPTED"],
  ] as const)("rejects caller input with illegal %s + %s", (dependencyType, requiredGate) => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const invalid = {
        upstreamSubtaskId: "st_a",
        downstreamSubtaskId: "st_b",
        dependencyType,
        requiredGate,
        reason: "Explicit reason.",
      } as unknown as SubtaskDependency;
      expect(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [invalid]),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    });
  });

  it.each([
    ["BLOCKING + NONE", "required_gate", "NONE"],
    ["INFORMATIONAL + ACCEPTED", "required_gate", "ACCEPTED"],
    ["noncanonical reason", "reason", " padded reason "],
  ] as const)("fails closed for stored %s corruption", (_label, column, value) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const dependency =
        _label === "INFORMATIONAL + ACCEPTED"
          ? makeDependency("st_a", "st_b", "INFORMATIONAL")
          : makeDependency("st_a", "st_b");
      storage.replaceDependenciesForBigTask(makeBigTask().id, [dependency]);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare(`UPDATE task_dependencies SET ${column} = ? WHERE upstream_subtask_id = ?`)
        .run(value, "st_a");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(() => reopened.listDependenciesForBigTask(makeBigTask().id)).toThrow(
          expect.objectContaining({ code: "MALFORMED_STORED_DATA" }),
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed for a corrupted cross-Big-Task endpoint hierarchy", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.createBigTask(makeBigTask("bt_other"));
      storage.createSubtask(makeSubtask("st_other", "bt_other"));
      storage.replaceDependenciesForBigTask(makeBigTask().id, [
        makeDependency("st_a", "st_b"),
      ]);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          "UPDATE task_dependencies SET upstream_subtask_id = ? WHERE upstream_subtask_id = ?",
        )
        .run("st_other", "st_a");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(() => reopened.listDependenciesForBigTask(makeBigTask().id)).toThrow(
          expect.objectContaining({ code: "MALFORMED_STORED_DATA" }),
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed for a missing stored endpoint", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      storage.replaceDependenciesForBigTask(makeBigTask().id, [
        makeDependency("st_a", "st_b"),
      ]);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite
        .prepare(
          "UPDATE task_dependencies SET upstream_subtask_id = ? WHERE upstream_subtask_id = ?",
        )
        .run("st_missing", "st_a");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(() => reopened.listDependenciesForBigTask(makeBigTask().id)).toThrow(
          expect.objectContaining({ code: "MALFORMED_STORED_DATA" }),
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("enforces required gate, legal combinations, and reason bounds in SQLite", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const dependency = makeDependency("st_a", "st_b");
      storage.replaceDependenciesForBigTask(makeBigTask().id, [dependency]);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        const updateGate = sqlite.prepare(
          "UPDATE task_dependencies SET required_gate = ? WHERE upstream_subtask_id = ?",
        );
        expect(() => updateGate.run("UNKNOWN", "st_a")).toThrow();
        expect(() => updateGate.run("NONE", "st_a")).toThrow();
        const updateTypeAndGate = sqlite.prepare(
          `UPDATE task_dependencies
           SET dependency_type = ?, required_gate = ?
           WHERE upstream_subtask_id = ?`,
        );
        expect(() => updateTypeAndGate.run("INFORMATIONAL", "ACCEPTED", "st_a")).toThrow();
        const updateReason = sqlite.prepare(
          "UPDATE task_dependencies SET reason = ? WHERE upstream_subtask_id = ?",
        );
        expect(() => updateReason.run("   ", "st_a")).toThrow();
        expect(() => updateReason.run("a".repeat(1_001), "st_a")).toThrow();
      } finally {
        sqlite.close();
      }

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.listDependenciesForBigTask(makeBigTask().id)).toEqual([dependency]);
      } finally {
        reopened.close();
      }
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
