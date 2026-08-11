import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ContextScopeSchema,
  evaluateSubtaskDependencyReadiness,
} from "@codex-task-console/domain";
import type {
  ContextScope,
  Subtask,
  SubtaskCreateInput,
  SubtaskDependency,
  SubtaskMaturity,
  SubtaskStatus,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";

import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";
import {
  LEGACY_BLOCKING_REASON,
  LEGACY_INFORMATIONAL_REASON,
  insertLegacyAuditEvent,
  insertLegacyBigTask,
  insertLegacyContextDigest,
  insertLegacyContextItem,
  insertLegacyDependency,
  insertLegacyProject,
  insertLegacySubtask,
} from "./legacy-fixtures.js";

const acceptedMigrationDirectories = [
  "20260809002701_public_mephisto",
  "20260809150746_groovy_iron_monger",
  "20260810133952_messy_shatterstar",
] as const;

const snapshot = (
  databasePath: string,
  table: string,
  columns = "*",
): readonly Record<string, unknown>[] => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all();
  } finally {
    sqlite.close();
  }
};

const createPriorMigrationFolder = (databasePath: string): string => {
  const folder = join(dirname(databasePath), "accepted-s0b2b-migrations");
  mkdirSync(folder);
  for (const directory of acceptedMigrationDirectories) {
    const source = fileURLToPath(new URL(`../drizzle/${directory}`, import.meta.url));
    cpSync(source, join(folder, basename(source)), { recursive: true });
  }
  return folder;
};

const createTwoBigTaskHierarchy = (storage: TaskStorage): void => {
  storage.createProject(makeProject());
  storage.createBigTask(makeBigTask("bt_a"));
  storage.createBigTask(makeBigTask("bt_b"));
  storage.createBigTask(makeBigTask("bt_c"));
  for (const id of ["st_a0", "st_a1", "st_a2"]) {
    storage.createSubtask(makeSubtask(id, "bt_a"));
  }
  for (const id of ["st_b0", "st_b1", "st_b2"]) {
    storage.createSubtask(makeSubtask(id, "bt_b"));
  }
  for (const id of ["st_c0", "st_c1", "st_c2"]) {
    storage.createSubtask(makeSubtask(id, "bt_c"));
  }
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortDependencies = (
  dependencies: readonly SubtaskDependency[],
): readonly SubtaskDependency[] => [...dependencies].sort(
  (left, right) =>
    compareCodeUnits(left.upstreamSubtaskId, right.upstreamSubtaskId) ||
    compareCodeUnits(left.downstreamSubtaskId, right.downstreamSubtaskId) ||
    compareCodeUnits(left.dependencyType, right.dependencyType),
);

const expectSanitized = (operation: () => unknown): void => {
  const error = captureTaskStorageError(operation);
  expect(error.message).not.toMatch(
    /SQLite|SQL|task_dependencies|subtasks|maturity|required_gate|\/Users\/|private|Zod|stack/i,
  );
};

describe("S1A direct SQLite and corruption hardening", () => {
  it("enforces 18 direct maturity and dependency constraints", () => {
    const invalidMutations: readonly ((sqlite: DatabaseSync) => void)[] = [
      (sqlite) => sqlite.prepare("UPDATE subtasks SET maturity = NULL WHERE id = 'st_a'").run(),
      (sqlite) => sqlite.prepare("UPDATE subtasks SET maturity = '' WHERE id = 'st_a'").run(),
      (sqlite) => sqlite.prepare("UPDATE subtasks SET maturity = ' HARDENED' WHERE id = 'st_a'").run(),
      (sqlite) => sqlite.prepare("UPDATE subtasks SET maturity = 'hardened' WHERE id = 'st_a'").run(),
      (sqlite) => sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = 'st_a'").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'UNKNOWN'").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET required_gate = 'UNKNOWN'").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET required_gate = 'NONE'").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'INFORMATIONAL', required_gate = 'HARDENED'").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'INFORMATIONAL', required_gate = 'ACCEPTED'").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET reason = ''").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET reason = '   '").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET reason = ?").run("x".repeat(1_001)),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET downstream_subtask_id = upstream_subtask_id").run(),
      (sqlite) => sqlite.prepare(
        "INSERT INTO task_dependencies SELECT upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at FROM task_dependencies",
      ).run(),
      (sqlite) => sqlite.prepare(
        "INSERT INTO task_dependencies VALUES ('st_missing', 'st_b', 'BLOCKING', 'HARDENED', 'missing', '2026-08-11T00:00:00.000Z')",
      ).run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET upstream_subtask_id = NULL").run(),
      (sqlite) => sqlite.prepare("UPDATE task_dependencies SET reason = NULL").run(),
    ];

    for (const mutate of invalidMutations) {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        createHierarchy(storage);
        storage.replaceDependenciesForBigTask(makeBigTask().id, [makeDependency("st_a", "st_b")]);
        storage.close();
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA foreign_keys = ON");
        try {
          expect(() => mutate(sqlite)).toThrow();
        } finally {
          sqlite.close();
        }
      });
    }
  });

  it("round-trips every valid persisted maturity independently of board status", () => {
    withTemporaryDatabasePath((databasePath) => {
      const statuses: readonly SubtaskStatus[] = [
        "TODO", "IN_PROGRESS", "QA_DEBUG", "DONE", "DROPPED", "ARCHIVED",
      ];
      const maturities: readonly SubtaskMaturity[] = [
        "NOT_STARTED", "IMPLEMENTED", "HARDENED", "ACCEPTED",
      ];
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      const created = statuses.flatMap((status, statusIndex) =>
        maturities.map((maturity, maturityIndex) => ({
          input: makeSubtask(`st_pair_${statusIndex}_${maturityIndex}`, makeBigTask().id, status),
          maturity,
        })));
      created.forEach(({ input }) => storage.createSubtask(input));
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const update = sqlite.prepare("UPDATE subtasks SET maturity = ? WHERE id = ?");
      created.forEach(({ input, maturity }) => update.run(maturity, input.id));
      sqlite.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          for (const { input, maturity } of created) {
            expect(reopened.getSubtaskById(input.id)).toEqual({ ...input, maturity });
          }
        } finally {
          reopened.close();
        }
      }
    });
  });

  it.each(["", " HARDENED", "hardened", "UNKNOWN"])(
    "fails closed for stored maturity corruption %j while isolating a valid Big Task",
    (corruptMaturity) => {
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        createTwoBigTaskHierarchy(storage);
        storage.close();
        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = ? WHERE id = 'st_a0'").run(corruptMaturity);
        sqlite.close();

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectSanitized(() => reopened.getSubtaskById(makeSubtask("st_a0", "bt_a").id));
          expectSanitized(() => reopened.listSubtasksByBigTask(makeBigTask("bt_a").id));
          expect(reopened.listSubtasksByBigTask(makeBigTask("bt_b").id)).toHaveLength(3);
        } finally {
          reopened.close();
        }
      });
    },
  );

  it.each([
    ["illegal gate", (sqlite: DatabaseSync) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET required_gate = 'NONE' WHERE upstream_subtask_id = 'st_a0'").run();
    }],
    ["invalid type", (sqlite: DatabaseSync) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'UNKNOWN' WHERE upstream_subtask_id = 'st_a0'").run();
    }],
    ["padded reason", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ' padded ' WHERE upstream_subtask_id = 'st_a0'").run();
    }],
    ["tab reason accepted by SQLite", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ? WHERE upstream_subtask_id = 'st_a0'").run("\t\n");
    }],
    ["UTF-16 mismatch accepted by SQLite", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ? WHERE upstream_subtask_id = 'st_a0'").run("🚀".repeat(501));
    }],
    ["self edge", (sqlite: DatabaseSync) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET downstream_subtask_id = upstream_subtask_id WHERE upstream_subtask_id = 'st_a0'").run();
    }],
    ["missing endpoint", (sqlite: DatabaseSync) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE task_dependencies SET upstream_subtask_id = 'st_missing' WHERE upstream_subtask_id = 'st_a0'").run();
    }],
    ["cross-Big-Task endpoint", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE task_dependencies SET upstream_subtask_id = 'st_b2' WHERE upstream_subtask_id = 'st_a0'").run();
    }],
    ["endpoint ownership changed", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE subtasks SET big_task_id = 'bt_b' WHERE id = 'st_a0'").run();
    }],
  ] as const)("fails closed for %s without contaminating unrelated dependency reads", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createTwoBigTaskHierarchy(storage);
      const first = makeDependency("st_a0", "st_a1", "BLOCKING", "HARDENED", "A evidence.");
      const second = makeDependency("st_b0", "st_b1", "BLOCKING", "ACCEPTED", "B evidence.");
      const unrelated = makeDependency("st_c0", "st_c1", "BLOCKING", "HARDENED", "C evidence.");
      storage.replaceDependenciesForBigTask(makeBigTask("bt_a").id, [first]);
      storage.replaceDependenciesForBigTask(makeBigTask("bt_b").id, [second]);
      storage.replaceDependenciesForBigTask(makeBigTask("bt_c").id, [unrelated]);
      storage.close();
      const sqlite = new DatabaseSync(databasePath);
      corrupt(sqlite);
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectSanitized(() => reopened.listDependenciesForBigTask(makeBigTask("bt_a").id));
        expect(reopened.listDependenciesForBigTask(makeBigTask("bt_c").id)).toEqual([unrelated]);
      } finally {
        reopened.close();
      }
    });
  });
});

describe("S1A replacement atomicity, failure, and concurrency hardening", () => {
  it("preserves exact replacement semantics through empty, changed, and large sets", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      storage.createBigTask(makeBigTask());
      for (let index = 0; index < 80; index += 1) {
        storage.createSubtask(makeSubtask(`st_replace_${index}`));
      }
      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, [])).toEqual([]);
      const first = [makeDependency("st_replace_0", "st_replace_1", "BLOCKING", "HARDENED")];
      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, first)).toEqual(first);
      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, [])).toEqual([]);
      const large = Array.from({ length: 79 }, (_, index) =>
        makeDependency(
          `st_replace_${index}`,
          `st_replace_${index + 1}`,
          index % 3 === 0 ? "INFORMATIONAL" : "BLOCKING",
          index % 3 === 0 ? "NONE" : index % 2 === 0 ? "ACCEPTED" : "HARDENED",
          `Replacement ${index}.`,
        ));
      expect(storage.replaceDependenciesForBigTask(makeBigTask().id, large)).toEqual(
        sortDependencies(large),
      );
    });
  });

  it("keeps the durable snapshot exact across 30 rejected replacements", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const before = [makeDependency("st_a", "st_b", "BLOCKING", "HARDENED", "before")];
      storage.replaceDependenciesForBigTask(makeBigTask().id, before);
      for (let index = 0; index < 30; index += 1) {
        const invalid = index % 3 === 0
          ? [makeDependency("st_a", "st_a")]
          : index % 3 === 1
            ? [makeDependency("st_a", "st_b"), makeDependency("st_a", "st_b")]
            : [makeDependency("st_a", "st_b"), makeDependency("st_b", "st_a")];
        expectSanitized(() => storage.replaceDependenciesForBigTask(makeBigTask().id, invalid));
        expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(before);
      }
    });
  });

  it("rolls back a trigger failure after delete and sanitizes the private diagnostic", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const before = [makeDependency("st_a", "st_b")];
      storage.replaceDependenciesForBigTask(makeBigTask().id, before);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(
        "CREATE TRIGGER reject_dependency_insert BEFORE INSERT ON task_dependencies BEGIN SELECT RAISE(ABORT, 'private dependency failure'); END",
      );
      sqlite.close();
      expectSanitized(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [makeDependency("st_b", "st_c")]),
      );
      expect(storage.listDependenciesForBigTask(makeBigTask().id)).toEqual(before);
      storage.close();
    });
  });

  it("returns a sanitized closed-database error without mutation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      const before = [makeDependency("st_a", "st_b")];
      storage.replaceDependenciesForBigTask(makeBigTask().id, before);
      storage.close();
      expectSanitized(() =>
        storage.replaceDependenciesForBigTask(makeBigTask().id, [makeDependency("st_b", "st_c")]),
      );
      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.listDependenciesForBigTask(makeBigTask().id)).toEqual(before);
      } finally {
        reopened.close();
      }
    });
  });

  it("serializes competing same-Big-Task complete replacements without a mixed set", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(setup);
      setup.replaceDependenciesForBigTask(makeBigTask().id, [makeDependency("st_a", "st_b")]);
      setup.close();

      const first = new DatabaseSync(databasePath);
      const second = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        first.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        first.exec("DELETE FROM task_dependencies");
        first.prepare(
          "INSERT INTO task_dependencies VALUES (?, ?, ?, ?, ?, ?)",
        ).run("st_b", "st_c", "BLOCKING", "HARDENED", "First complete replacement.", "2026-08-11T00:00:00.000Z");
        expectSanitized(() =>
          second.replaceDependenciesForBigTask(makeBigTask().id, [
            makeDependency("st_a", "st_c", "BLOCKING", "ACCEPTED", "Second replacement."),
          ]),
        );
        first.exec("COMMIT");
        expect(second.listDependenciesForBigTask(makeBigTask().id)).toEqual([
          makeDependency("st_b", "st_c", "BLOCKING", "HARDENED", "First complete replacement."),
        ]);
        const secondSet = [makeDependency("st_a", "st_c", "BLOCKING", "ACCEPTED", "Second replacement.")];
        expect(second.replaceDependenciesForBigTask(makeBigTask().id, secondSet)).toEqual(secondSet);
      } finally {
        if (first.isTransaction) {
          first.exec("ROLLBACK");
        }
        first.close();
        second.close();
      }
    });
  }, 15_000);

  it("isolates different Big Tasks when one replacement owns the writer lock", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      createTwoBigTaskHierarchy(setup);
      const aBefore = [makeDependency("st_a0", "st_a1")];
      const bBefore = [makeDependency("st_b0", "st_b1")];
      setup.replaceDependenciesForBigTask(makeBigTask("bt_a").id, aBefore);
      setup.replaceDependenciesForBigTask(makeBigTask("bt_b").id, bBefore);
      setup.close();

      const first = new DatabaseSync(databasePath);
      const second = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        first.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        first.prepare("DELETE FROM task_dependencies WHERE downstream_subtask_id = 'st_a1'").run();
        first.prepare("INSERT INTO task_dependencies VALUES (?, ?, ?, ?, ?, ?)").run(
          "st_a1", "st_a2", "BLOCKING", "ACCEPTED", "A committed whole.", "2026-08-11T00:00:00.000Z",
        );
        expectSanitized(() =>
          second.replaceDependenciesForBigTask(makeBigTask("bt_b").id, [
            makeDependency("st_b1", "st_b2", "BLOCKING", "HARDENED"),
          ]),
        );
        first.exec("COMMIT");
        expect(second.listDependenciesForBigTask(makeBigTask("bt_a").id)).toEqual([
          makeDependency("st_a1", "st_a2", "BLOCKING", "ACCEPTED", "A committed whole."),
        ]);
        expect(second.listDependenciesForBigTask(makeBigTask("bt_b").id)).toEqual(bBefore);
        expect(second.replaceDependenciesForBigTask(makeBigTask("bt_b").id, [
          makeDependency("st_b1", "st_b2", "BLOCKING", "HARDENED"),
        ])).toHaveLength(1);
      } finally {
        if (first.isTransaction) {
          first.exec("ROLLBACK");
        }
        first.close();
        second.close();
      }
    });
  }, 15_000);
});

describe("S1A storage/readiness parity and migration hardening", () => {
  it("preserves readiness parity for 10 Big Tasks, 100 Subtasks, and 150 dependencies through two reopens", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject());
      const expectedSubtasks = new Map<string, Subtask[]>();
      const expectedDependencies = new Map<string, SubtaskDependency[]>();
      for (let bigIndex = 0; bigIndex < 10; bigIndex += 1) {
        const bigTask = makeBigTask(`bt_parity_${bigIndex}`);
        storage.createBigTask(bigTask);
        const tasks = Array.from({ length: 10 }, (_, taskIndex) =>
          makeSubtask(
            `st_parity_${bigIndex}_${taskIndex}`,
            bigTask.id,
            (["TODO", "IN_PROGRESS", "QA_DEBUG", "DONE", "DROPPED", "ARCHIVED"] as const)[
              (bigIndex + taskIndex) % 6
            ],
          ));
        tasks.forEach((task) => storage.createSubtask(task));
        expectedSubtasks.set(bigTask.id, tasks);
      }
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const updateMaturity = sqlite.prepare("UPDATE subtasks SET maturity = ? WHERE id = ?");
      for (let bigIndex = 0; bigIndex < 10; bigIndex += 1) {
        const bigTaskId = `bt_parity_${bigIndex}`;
        const tasks = expectedSubtasks.get(bigTaskId)!;
        const mature = tasks.map((task, taskIndex) => {
          const maturity = (["NOT_STARTED", "IMPLEMENTED", "HARDENED", "ACCEPTED"] as const)[
            (bigIndex * 3 + taskIndex) % 4
          ]!;
          updateMaturity.run(maturity, task.id);
          return { ...task, maturity };
        });
        expectedSubtasks.set(bigTaskId, mature);
      }
      sqlite.close();

      const populated = openTaskDatabase({ databasePath, clock: fixedClock });
      for (let bigIndex = 0; bigIndex < 10; bigIndex += 1) {
        const bigTaskId = makeBigTask(`bt_parity_${bigIndex}`).id;
        const edges: SubtaskDependency[] = [];
        for (let taskIndex = 1; taskIndex < 10; taskIndex += 1) {
          edges.push(makeDependency(
            `st_parity_${bigIndex}_${taskIndex - 1}`,
            `st_parity_${bigIndex}_${taskIndex}`,
            taskIndex % 4 === 0 ? "INFORMATIONAL" : "BLOCKING",
            taskIndex % 4 === 0 ? "NONE" : taskIndex % 2 === 0 ? "HARDENED" : "ACCEPTED",
            `Parity chain ${bigIndex}-${taskIndex}.`,
          ));
        }
        for (let taskIndex = 0; taskIndex < 6; taskIndex += 1) {
          edges.push(makeDependency(
            `st_parity_${bigIndex}_${taskIndex}`,
            `st_parity_${bigIndex}_${taskIndex + 2}`,
            "BLOCKING",
            taskIndex % 2 === 0 ? "HARDENED" : "ACCEPTED",
            `Parity fan ${bigIndex}-${taskIndex}.`,
          ));
        }
        expect(populated.replaceDependenciesForBigTask(bigTaskId, edges)).toHaveLength(15);
        expectedDependencies.set(bigTaskId, [...sortDependencies(edges)]);
      }
      populated.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          for (let bigIndex = 0; bigIndex < 10; bigIndex += 1) {
            const bigTaskId = makeBigTask(`bt_parity_${bigIndex}`).id;
            const tasks = reopened.listSubtasksByBigTask(bigTaskId);
            const edges = reopened.listDependenciesForBigTask(bigTaskId);
            expect(tasks).toEqual(expectedSubtasks.get(bigTaskId));
            expect(edges).toEqual(expectedDependencies.get(bigTaskId));
            for (const downstream of tasks) {
              const readiness = evaluateSubtaskDependencyReadiness(
                tasks.map(({ id, bigTaskId: owner, maturity }) => ({ id, bigTaskId: owner, maturity })),
                edges,
                downstream.id,
              );
              const blockers = edges.filter((edge) => {
                if (edge.dependencyType !== "BLOCKING" || edge.downstreamSubtaskId !== downstream.id) {
                  return false;
                }
                const upstream = tasks.find(({ id }) => id === edge.upstreamSubtaskId)!;
                return edge.requiredGate === "ACCEPTED"
                  ? upstream.maturity !== "ACCEPTED"
                  : upstream.maturity !== "HARDENED" && upstream.maturity !== "ACCEPTED";
              });
              expect(readiness).toMatchObject({
                valid: true,
                ready: blockers.length === 0,
              });
              expect(readiness.blockers).toHaveLength(blockers.length);
            }
          }
        } finally {
          reopened.close();
        }
      }
    });
  });

  it("migrates 8 Projects, 24 Big Tasks, 120 Subtasks, 100 dependencies, 250 Context Items, 20 Digests, and 100 Audit Events", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorMigrations = createPriorMigrationFolder(databasePath);
      openTaskDatabase({ databasePath, clock: fixedClock, migrationsFolder: priorMigrations }).close();
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      const projects = Array.from({ length: 8 }, (_, index) =>
        makeProject(`prj_migration_${index}`, `migration-${index}`));
      const bigTasks = projects.flatMap((project, projectIndex) =>
        Array.from({ length: 3 }, (_, bigIndex) =>
          makeBigTask(`bt_migration_${projectIndex}_${bigIndex}`, project.id, bigIndex === 2 ? "DONE" : "IN_PROGRESS")));
      const statuses = ["TODO", "IN_PROGRESS", "QA_DEBUG", "DONE", "DROPPED", "ARCHIVED"] as const;
      const subtasks = bigTasks.flatMap((bigTask, bigIndex) =>
        Array.from({ length: 5 }, (_, taskIndex) =>
          makeSubtask(`st_migration_${bigIndex}_${taskIndex}`, bigTask.id, statuses[(bigIndex + taskIndex) % statuses.length])));
      const dependencies = bigTasks.flatMap((bigTask, bigIndex) => {
        const owned = subtasks.filter(({ bigTaskId }) => bigTaskId === bigTask.id);
        const chain = Array.from({ length: 4 }, (_, index) =>
          makeDependency(owned[index]!.id, owned[index + 1]!.id, "BLOCKING", "ACCEPTED"));
        return bigIndex < 4
          ? [...chain, makeDependency(owned[0]!.id, owned[2]!.id, "INFORMATIONAL")]
          : chain;
      });
      projects.forEach((project) => insertLegacyProject(sqlite, project));
      bigTasks.forEach((bigTask) => insertLegacyBigTask(sqlite, bigTask));
      subtasks.forEach((task) => insertLegacySubtask(sqlite, task));
      dependencies.forEach((edge) => insertLegacyDependency(sqlite, edge));

      const scopes: ContextScope[] = [
        ...projects.map(({ id }) => ContextScopeSchema.parse({ scopeType: "PROJECT", projectId: id })),
        ...bigTasks.map(({ id, projectId }) => ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId: id })),
        ...subtasks.map((task) => {
          const owner = bigTasks.find(({ id }) => id === task.bigTaskId)!;
          return ContextScopeSchema.parse({
            scopeType: "SUBTASK",
            projectId: owner.projectId,
            bigTaskId: owner.id,
            subtaskId: task.id,
          });
        }),
      ];
      const contextItems = Array.from({ length: 250 }, (_, index) =>
        makeContextItem(`ctx_migration_${index}`, scopes[(index * 37) % scopes.length]!));
      const digests = Array.from({ length: 20 }, (_, index) =>
        makeContextDigest(`dgt_migration_${index}`, scopes[8 + index]!));
      const auditEvents = Array.from({ length: 100 }, (_, index) =>
        makeAuditEvent(`aud_migration_${index}`, scopes[(index * 29) % scopes.length]!));
      contextItems.forEach((item) => insertLegacyContextItem(sqlite, item));
      digests.forEach((digest) => insertLegacyContextDigest(sqlite, digest));
      auditEvents.forEach((event) => insertLegacyAuditEvent(sqlite, event));
      sqlite.close();

      expect(projects).toHaveLength(8);
      expect(bigTasks).toHaveLength(24);
      expect(subtasks).toHaveLength(120);
      expect(dependencies).toHaveLength(100);
      expect(new Set(subtasks.map(({ status }) => status))).toEqual(new Set(statuses));

      const oldColumns = {
        subtasks: "id, big_task_id, title, goal, scope_in, scope_out, acceptance_criteria, untouched_areas, status, start_policy, delegation_policy, recommended_reasoning_level, prompt_seed, created_at, updated_at",
        dependencies: "upstream_subtask_id, downstream_subtask_id, dependency_type, created_at",
      } as const;
      const before = {
        projects: snapshot(databasePath, "projects"),
        bigTasks: snapshot(databasePath, "big_tasks"),
        subtasks: snapshot(databasePath, "subtasks", oldColumns.subtasks),
        dependencies: snapshot(databasePath, "task_dependencies", oldColumns.dependencies),
        contextItems: snapshot(databasePath, "context_items"),
        digests: snapshot(databasePath, "context_digests"),
        auditEvents: snapshot(databasePath, "audit_events"),
      };

      const migrated = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        for (const bigTask of bigTasks) {
          expect(migrated.listSubtasksByBigTask(bigTask.id)).toEqual(
            subtasks.filter(({ bigTaskId: owner }) => owner === bigTask.id),
          );
          expect(migrated.listDependenciesForBigTask(bigTask.id)).toEqual(
            sortDependencies(dependencies
              .filter((edge) => subtasks.find(({ id }) => id === edge.upstreamSubtaskId)?.bigTaskId === bigTask.id)
              .map((edge) => edge.dependencyType === "BLOCKING"
                ? { ...edge, requiredGate: "ACCEPTED" as const, reason: LEGACY_BLOCKING_REASON }
                : { ...edge, requiredGate: "NONE" as const, reason: LEGACY_INFORMATIONAL_REASON })),
          );
        }
        contextItems.forEach((item) => expect(migrated.getContextItemById(item.id)).toEqual(item));
        digests.forEach((digest) => expect(migrated.getContextDigestById(digest.id)).toEqual(digest));
        auditEvents.forEach((event) => expect(migrated.getAuditEventById(event.id)).toEqual(event));
        expect(migrated.isForeignKeyEnforcementEnabled()).toBe(true);
      } finally {
        migrated.close();
      }

      expect(snapshot(databasePath, "projects")).toEqual(before.projects);
      expect(snapshot(databasePath, "big_tasks")).toEqual(before.bigTasks);
      expect(snapshot(databasePath, "subtasks", oldColumns.subtasks)).toEqual(before.subtasks);
      expect(snapshot(databasePath, "task_dependencies", oldColumns.dependencies)).toEqual(before.dependencies);
      expect(snapshot(databasePath, "context_items")).toEqual(before.contextItems);
      expect(snapshot(databasePath, "context_digests")).toEqual(before.digests);
      expect(snapshot(databasePath, "audit_events")).toEqual(before.auditEvents);

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        expect(reopened.isForeignKeyEnforcementEnabled()).toBe(true);
        expect(reopened.listSubtasksByBigTask(bigTasks[0]!.id)).toHaveLength(5);
        reopened.close();
      }
    });
  });

  it("preserves the pre-S1A database across deterministic migration failure and reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const priorMigrations = createPriorMigrationFolder(databasePath);
      openTaskDatabase({ databasePath, clock: fixedClock, migrationsFolder: priorMigrations }).close();
      const sqlite = new DatabaseSync(databasePath);
      insertLegacyProject(sqlite, makeProject());
      insertLegacyBigTask(sqlite, makeBigTask());
      insertLegacySubtask(sqlite, makeSubtask("st_a"));
      insertLegacySubtask(sqlite, makeSubtask("st_b"));
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare(
        "INSERT INTO task_dependencies VALUES ('st_a', 'st_b', 'UNKNOWN', '2026-08-11T00:00:00.000Z')",
      ).run();
      sqlite.close();
      const beforeSubtasks = snapshot(databasePath, "subtasks");
      const beforeDependencies = snapshot(databasePath, "task_dependencies");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => openTaskDatabase({ databasePath, clock: fixedClock })).toThrow(
          expect.objectContaining({ code: "MIGRATION_FAILED" }),
        );
        expect(snapshot(databasePath, "subtasks")).toEqual(beforeSubtasks);
        expect(snapshot(databasePath, "task_dependencies")).toEqual(beforeDependencies);
      }
    });
  });

  it("sanitizes at least 40 distinct S1A caller failures without mutating durable state", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const before = storage.listSubtasksByBigTask(makeBigTask().id);
      for (let index = 0; index < 40; index += 1) {
        const invalid = {
          ...makeSubtask(`st_invalid_${index}`),
          maturity: index % 4 === 0 ? "IMPLEMENTED" : index % 4 === 1 ? "HARDENED" : index % 4 === 2 ? "ACCEPTED" : `UNKNOWN_${index}`,
        } as unknown as SubtaskCreateInput;
        expectSanitized(() => storage.createSubtask(invalid));
      }
      expect(storage.listSubtasksByBigTask(makeBigTask().id)).toEqual(before);
    });
  });
});
