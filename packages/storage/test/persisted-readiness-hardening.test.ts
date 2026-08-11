import { DatabaseSync, StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ContextScopeSchema,
  SubtaskIdSchema,
  evaluateSubtaskDependencyReadiness,
} from "@codex-task-console/domain";
import type {
  DependencyReadinessResult,
  Subtask,
  SubtaskDependency,
  SubtaskId,
  SubtaskMaturity,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";

import {
  FIXED_TIME,
  captureTaskStorageError,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const TARGET_BIG_TASK = BigTaskIdSchema.parse("bt_hardening_target");
const OTHER_BIG_TASK = BigTaskIdSchema.parse("bt_hardening_other");
const THIRD_BIG_TASK = BigTaskIdSchema.parse("bt_hardening_third");
const FOREIGN_BIG_TASK = BigTaskIdSchema.parse("bt_hardening_foreign");
const TARGET = SubtaskIdSchema.parse("st_hardening_target");
const UPSTREAM_A = SubtaskIdSchema.parse("st_hardening_upstream_a");
const UPSTREAM_B = SubtaskIdSchema.parse("st_hardening_upstream_b");
const LOCAL_A = SubtaskIdSchema.parse("st_hardening_local_a");
const LOCAL_B = SubtaskIdSchema.parse("st_hardening_local_b");
const FOREIGN_A = SubtaskIdSchema.parse("st_hardening_foreign_a");
const FOREIGN_B = SubtaskIdSchema.parse("st_hardening_foreign_b");

const TARGET_IDS = [TARGET, UPSTREAM_A, UPSTREAM_B, LOCAL_A, LOCAL_B] as const;

const seedScopes = (
  databasePath: string,
  targetDependencies: readonly SubtaskDependency[] = [],
): void => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  try {
    storage.createProject(makeProject("prj_hardening_a", "hardening-a"));
    storage.createProject(makeProject("prj_hardening_b", "hardening-b"));
    for (const bigTaskId of [TARGET_BIG_TASK, OTHER_BIG_TASK, THIRD_BIG_TASK]) {
      storage.createBigTask(makeBigTask(bigTaskId, "prj_hardening_a"));
    }
    storage.createBigTask(makeBigTask(FOREIGN_BIG_TASK, "prj_hardening_b"));
    for (const subtaskId of TARGET_IDS) {
      storage.createSubtask(makeSubtask(subtaskId, TARGET_BIG_TASK));
    }
    for (const [bigTaskId, prefix] of [
      [OTHER_BIG_TASK, "other"],
      [THIRD_BIG_TASK, "third"],
      [FOREIGN_BIG_TASK, "foreign"],
    ] as const) {
      storage.createSubtask(makeSubtask(`st_hardening_${prefix}_a`, bigTaskId));
      storage.createSubtask(makeSubtask(`st_hardening_${prefix}_b`, bigTaskId));
    }
    storage.replaceDependenciesForBigTask(TARGET_BIG_TASK, targetDependencies);
  } finally {
    storage.close();
  }
};

const updateMaturities = (
  databasePath: string,
  maturities: Readonly<Record<string, SubtaskMaturity>>,
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    const update = sqlite.prepare("UPDATE subtasks SET maturity = ? WHERE id = ?");
    for (const [subtaskId, maturity] of Object.entries(maturities)) {
      update.run(maturity, subtaskId);
    }
  } finally {
    sqlite.close();
  }
};

const read = (
  databasePath: string,
  subtaskId: SubtaskId = TARGET,
): DependencyReadinessResult => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  try {
    return storage.evaluateStoredSubtaskDependencyReadiness(subtaskId);
  } finally {
    storage.close();
  }
};

const expectSanitizedStorageError = (
  operation: () => unknown,
  code?: string,
): ReturnType<typeof captureTaskStorageError> => {
  const error = captureTaskStorageError(operation);
  if (code !== undefined) {
    expect(error.code).toBe(code);
  }
  expect(error.message).not.toMatch(
    /SQLite|\bSQL\b|task_dependencies|subtasks|big_tasks|projects|required_gate|filesystem|\/Users\/|private|Zod|stack|constraint/i,
  );
  return error;
};

const applicationSnapshot = (
  databasePath: string,
): Readonly<Record<string, readonly Record<string, unknown>[]>> => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "projects",
        "big_tasks",
        "subtasks",
        "task_dependencies",
        "context_items",
        "context_digests",
        "audit_events",
      ].map((table) => [
        table,
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    sqlite.close();
  }
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const independentReadinessOracle = (
  subtasks: readonly Pick<Subtask, "id" | "bigTaskId" | "maturity">[],
  dependencies: readonly SubtaskDependency[],
  target: SubtaskId,
): DependencyReadinessResult => {
  const subtasksById = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
  const blockers = dependencies
    .filter(
      (dependency) =>
        dependency.dependencyType === "BLOCKING" &&
        dependency.downstreamSubtaskId === target,
    )
    .flatMap((dependency) => {
      if (dependency.dependencyType !== "BLOCKING") {
        return [];
      }
      const upstream = subtasksById.get(dependency.upstreamSubtaskId);
      if (upstream === undefined) {
        throw new Error("The valid-graph oracle requires a real upstream Subtask.");
      }
      const satisfied =
        dependency.requiredGate === "ACCEPTED"
          ? upstream.maturity === "ACCEPTED"
          : upstream.maturity === "HARDENED" || upstream.maturity === "ACCEPTED";
      return satisfied
        ? []
        : [
            {
              upstreamSubtaskId: dependency.upstreamSubtaskId,
              requiredGate: dependency.requiredGate,
              actualMaturity: upstream.maturity,
              reason: dependency.reason,
            },
          ];
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.upstreamSubtaskId, right.upstreamSubtaskId) ||
        compareCodeUnits(left.requiredGate, right.requiredGate) ||
        compareCodeUnits(left.reason, right.reason),
    );
  return {
    valid: true,
    ready: blockers.length === 0,
    blockers,
    errors: [],
    errorCodes: [],
  };
};

const runSqlMutation = (
  databasePath: string,
  mutation: (sqlite: DatabaseSync) => void,
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    mutation(sqlite);
  } finally {
    sqlite.close();
  }
};

describe("S1B1 hardening input, parity, and complete-scope invariants", () => {
  it("rejects the complete caller-input matrix without leaking a read transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const invalidInputs: readonly unknown[] = [
          ` ${TARGET} `,
          `\t${TARGET}`,
          `${TARGET}\n`,
          "bt_wrong_prefix",
          "st_",
          "",
          null,
          undefined,
          17,
          {},
          [],
        ];
        for (const input of invalidInputs) {
          expectSanitizedStorageError(
            () =>
              storage.evaluateStoredSubtaskDependencyReadiness(
                input as SubtaskId,
              ),
            "INVALID_INPUT",
          );
          expect(
            storage.runInTransaction((transaction) =>
              transaction.evaluateStoredSubtaskDependencyReadiness(TARGET),
            ),
          ).toMatchObject({ valid: true, ready: true });
        }

        expectSanitizedStorageError(
          () =>
            storage.evaluateStoredSubtaskDependencyReadiness(
              SubtaskIdSchema.parse("st_hardening_missing"),
            ),
          "PARENT_NOT_FOUND",
        );
        expect(
          storage.runInTransaction((transaction) =>
            transaction.evaluateStoredSubtaskDependencyReadiness(TARGET),
          ),
        ).toMatchObject({ valid: true, ready: true });
      } finally {
        storage.close();
      }

      const closed = openTaskDatabase({ databasePath, clock: fixedClock });
      closed.close();
      expectSanitizedStorageError(
        () => closed.evaluateStoredSubtaskDependencyReadiness(TARGET),
        "DATABASE_CLOSED",
      );
    });
  });

  it("matches accepted S1A and an independent oracle across basic stored graphs", () => {
    const scenarios = [
      {
        dependencies: [] as readonly SubtaskDependency[],
        maturities: {},
      },
      {
        dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
        maturities: { [UPSTREAM_A]: "IMPLEMENTED" },
      },
      {
        dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
        maturities: { [UPSTREAM_A]: "HARDENED" },
      },
      {
        dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "ACCEPTED")],
        maturities: { [UPSTREAM_A]: "HARDENED" },
      },
      {
        dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "ACCEPTED")],
        maturities: { [UPSTREAM_A]: "ACCEPTED" },
      },
      {
        dependencies: [makeDependency(UPSTREAM_A, TARGET, "INFORMATIONAL", "NONE")],
        maturities: { [UPSTREAM_A]: "NOT_STARTED" },
      },
      {
        dependencies: [
          makeDependency(UPSTREAM_B, TARGET, "BLOCKING", "HARDENED", "Zulu."),
          makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "ACCEPTED", "Alpha."),
          makeDependency(LOCAL_A, LOCAL_B, "BLOCKING", "HARDENED", "Local."),
        ],
        maturities: {
          [UPSTREAM_A]: "HARDENED",
          [UPSTREAM_B]: "IMPLEMENTED",
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      withTemporaryDatabasePath((databasePath) => {
        seedScopes(databasePath, scenario.dependencies);
        updateMaturities(databasePath, scenario.maturities);
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const subtasks = storage.listSubtasksByBigTask(TARGET_BIG_TASK);
          const dependencies = storage.listDependenciesForBigTask(TARGET_BIG_TASK);
          const stored = storage.evaluateStoredSubtaskDependencyReadiness(TARGET);
          const readinessSubtasks = subtasks.map(({ id, bigTaskId, maturity }) => ({
            id,
            bigTaskId,
            maturity,
          }));
          expect(stored).toEqual(
            evaluateSubtaskDependencyReadiness(
              readinessSubtasks,
              dependencies,
              TARGET,
            ),
          );
          expect(stored).toEqual(
            independentReadinessOracle(readinessSubtasks, dependencies, TARGET),
          );
        } finally {
          storage.close();
        }
      });
    }
  });

  it("validates the entire owning Big Task while excluding valid local nonblockers", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(LOCAL_A, LOCAL_B, "BLOCKING", "HARDENED", "Disconnected."),
      ]);
      expect(read(databasePath)).toEqual({
        valid: true,
        ready: true,
        blockers: [],
        errors: [],
        errorCodes: [],
      });
    });

    const sameScopeCorruptions: readonly [
      string,
      (sqlite: DatabaseSync) => void,
    ][] = [
      ["disconnected blocking cycle", (sqlite) => {
        sqlite.prepare(
          "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Reverse.', ?)",
        ).run(LOCAL_B, LOCAL_A, FIXED_TIME);
      }],
      ["self edge away from target", (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare(
          "UPDATE task_dependencies SET downstream_subtask_id = upstream_subtask_id WHERE upstream_subtask_id = ?",
        ).run(LOCAL_A);
      }],
      ["missing endpoint away from target", (sqlite) => {
        sqlite.exec("PRAGMA foreign_keys = OFF");
        sqlite.prepare(
          "UPDATE task_dependencies SET downstream_subtask_id = 'st_hardening_missing' WHERE upstream_subtask_id = ?",
        ).run(LOCAL_A);
      }],
      ["cross-Big-Task endpoint away from target", (sqlite) => {
        sqlite.prepare(
          "UPDATE task_dependencies SET downstream_subtask_id = ? WHERE upstream_subtask_id = ?",
        ).run(FOREIGN_A, LOCAL_A);
      }],
      ["malformed reason away from target", (sqlite) => {
        sqlite.prepare(
          "UPDATE task_dependencies SET reason = ' padded ' WHERE upstream_subtask_id = ?",
        ).run(LOCAL_A);
      }],
      ["malformed maturity away from target", (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(LOCAL_B);
      }],
    ];

    for (const [, corrupt] of sameScopeCorruptions) {
      withTemporaryDatabasePath((databasePath) => {
        seedScopes(databasePath, [
          makeDependency(LOCAL_A, LOCAL_B, "BLOCKING", "HARDENED", "Local."),
        ]);
        runSqlMutation(databasePath, corrupt);
        const before = applicationSnapshot(databasePath);
        expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
        expect(applicationSnapshot(databasePath)).toEqual(before);
      });
    }
  });
});

describe("S1B1 hardening corruption blast radius", () => {
  const subtaskCorruptions: readonly [
    string,
    (sqlite: DatabaseSync) => void,
  ][] = [
    ["target invalid maturity", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(TARGET);
    }],
    ["upstream padded maturity", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET maturity = ' HARDENED' WHERE id = ?").run(UPSTREAM_A);
    }],
    ["unconnected same-scope invalid maturity", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(LOCAL_B);
    }],
    ["target malformed structured field", (sqlite) => {
      sqlite.prepare("UPDATE subtasks SET scope_in = 'not-json' WHERE id = ?").run(TARGET);
    }],
    ["target noncanonical text", (sqlite) => {
      sqlite.prepare("UPDATE subtasks SET title = ' padded title ' WHERE id = ?").run(TARGET);
    }],
    ["target noncanonical structured encoding", (sqlite) => {
      sqlite.prepare("UPDATE subtasks SET scope_in = '[ \"Persist\", \"st_hardening_target\" ]' WHERE id = ?").run(TARGET);
    }],
    ["same-scope empty structured field", (sqlite) => {
      sqlite.prepare("UPDATE subtasks SET acceptance_criteria = '[]' WHERE id = ?").run(LOCAL_A);
    }],
    ["target invalid status", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET status = 'UNKNOWN' WHERE id = ?").run(TARGET);
    }],
    ["upstream invalid start policy", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET start_policy = 'UNKNOWN' WHERE id = ?").run(UPSTREAM_A);
    }],
    ["same-scope invalid delegation policy", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET delegation_policy = 'UNKNOWN' WHERE id = ?").run(LOCAL_A);
    }],
    ["same-scope invalid reasoning level", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET recommended_reasoning_level = 'UNKNOWN' WHERE id = ?").run(LOCAL_B);
    }],
    ["same-scope malformed ID", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE subtasks SET id = ' st_hardening_local_b ' WHERE id = ?").run(LOCAL_B);
    }],
    ["target missing Big Task parent", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE subtasks SET big_task_id = 'bt_hardening_missing' WHERE id = ?").run(TARGET);
    }],
    ["connected upstream missing Big Task parent", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE subtasks SET big_task_id = 'bt_hardening_missing' WHERE id = ?").run(UPSTREAM_A);
    }],
  ];

  it.each(subtaskCorruptions)("fails closed for relevant Subtask corruption: %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED", "Relevant."),
      ]);
      runSqlMutation(databasePath, corrupt);
      const before = applicationSnapshot(databasePath);
      expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  const dependencyCorruptions: readonly [
    string,
    (sqlite: DatabaseSync) => void,
  ][] = [
    ["invalid dependency type", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'UNKNOWN' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["invalid required gate", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET required_gate = 'UNKNOWN' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["blocking plus NONE", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET required_gate = 'NONE' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["informational plus HARDENED", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'INFORMATIONAL', required_gate = 'HARDENED' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["informational plus ACCEPTED", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET dependency_type = 'INFORMATIONAL', required_gate = 'ACCEPTED' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["padded reason", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ' padded ' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["whitespace-only reason", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ? WHERE upstream_subtask_id = ?").run("\t\n", UPSTREAM_A);
    }],
    ["UTF-16 reason overflow", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ? WHERE upstream_subtask_id = ?").run("🚀".repeat(501), UPSTREAM_A);
    }],
    ["noncanonical endpoint", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE task_dependencies SET upstream_subtask_id = ' st_hardening_upstream_a ' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["self edge", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET downstream_subtask_id = upstream_subtask_id WHERE upstream_subtask_id = ?").run(LOCAL_A);
    }],
    ["missing upstream", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE task_dependencies SET upstream_subtask_id = 'st_hardening_missing' WHERE upstream_subtask_id = ?").run(UPSTREAM_A);
    }],
    ["missing downstream", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE task_dependencies SET downstream_subtask_id = 'st_hardening_missing' WHERE upstream_subtask_id = ?").run(LOCAL_A);
    }],
    ["cross-Big-Task upstream", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET upstream_subtask_id = ? WHERE upstream_subtask_id = ?").run(FOREIGN_A, UPSTREAM_A);
    }],
    ["cross-Big-Task downstream", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET downstream_subtask_id = ? WHERE upstream_subtask_id = ?").run(FOREIGN_B, LOCAL_A);
    }],
    ["blocking cycle", (sqlite) => {
      sqlite.prepare(
        "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Reverse.', ?)",
      ).run(LOCAL_B, LOCAL_A, FIXED_TIME);
    }],
  ];

  it.each(dependencyCorruptions)("fails closed for relevant dependency corruption: %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED", "Relevant."),
        makeDependency(LOCAL_A, LOCAL_B, "BLOCKING", "HARDENED", "Local."),
      ]);
      runSqlMutation(databasePath, corrupt);
      const before = applicationSnapshot(databasePath);
      expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it("relies on the physical primary key to reject duplicate dependency rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED", "Unique."),
      ]);
      const sqlite = new DatabaseSync(databasePath);
      try {
        expect(() =>
          sqlite.prepare(
            "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Duplicate.', ?)",
          ).run(UPSTREAM_A, TARGET, FIXED_TIME),
        ).toThrow();
      } finally {
        sqlite.close();
      }
    });
  });

  const unrelatedCorruptions: readonly [
    string,
    (sqlite: DatabaseSync) => void,
  ][] = [
    ["foreign invalid maturity", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(FOREIGN_A);
    }],
    ["foreign malformed text", (sqlite) => {
      sqlite.prepare("UPDATE subtasks SET scope_in = 'not-json' WHERE id = ?").run(FOREIGN_A);
    }],
    ["foreign invalid status", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE subtasks SET status = 'UNKNOWN' WHERE id = ?").run(FOREIGN_A);
    }],
    ["unrelated malformed gate", (sqlite) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE task_dependencies SET required_gate = 'NONE' WHERE upstream_subtask_id = ?").run(FOREIGN_A);
    }],
    ["unrelated malformed reason", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET reason = ' padded ' WHERE upstream_subtask_id = ?").run(FOREIGN_A);
    }],
    ["unrelated blocking cycle", (sqlite) => {
      sqlite.prepare(
        "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Reverse.', ?)",
      ).run(FOREIGN_B, FOREIGN_A, FIXED_TIME);
    }],
    ["unrelated cross-Big-Task edge", (sqlite) => {
      sqlite.prepare("UPDATE task_dependencies SET downstream_subtask_id = 'st_hardening_third_a' WHERE upstream_subtask_id = ?").run(FOREIGN_A);
    }],
    ["unrelated missing parent", (sqlite) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE subtasks SET big_task_id = 'bt_hardening_missing' WHERE id = ?").run(FOREIGN_A);
    }],
  ];

  it.each(unrelatedCorruptions)("isolates unrelated corruption: %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.replaceDependenciesForBigTask(FOREIGN_BIG_TASK, [
        makeDependency(FOREIGN_A, FOREIGN_B, "BLOCKING", "HARDENED", "Foreign."),
      ]);
      storage.close();
      runSqlMutation(databasePath, corrupt);
      const before = applicationSnapshot(databasePath);
      expect(read(databasePath)).toMatchObject({ valid: true, ready: true, blockers: [] });
      expect(applicationSnapshot(databasePath)).toEqual(before);
    });
  });

  it("turns foreign corruption into relevant failure only when a dependency connects it", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      runSqlMutation(databasePath, (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(FOREIGN_A);
        sqlite.prepare(
          "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Connected foreign.', ?)",
        ).run(FOREIGN_A, TARGET, FIXED_TIME);
      });
      expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
    });
  });

  it.each([
    ["malformed owning Big Task", (sqlite: DatabaseSync) => {
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite.prepare("UPDATE big_tasks SET status = 'UNKNOWN' WHERE id = ?").run(TARGET_BIG_TASK);
    }],
    ["noncanonical owning Big Task", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE big_tasks SET title = ' padded title ' WHERE id = ?").run(TARGET_BIG_TASK);
    }],
    ["noncanonical owning Big Task structure", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE big_tasks SET scope_in = '[ \"Core task storage\", \"bt_hardening_target\" ]' WHERE id = ?").run(TARGET_BIG_TASK);
    }],
    ["malformed owning Project", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE projects SET slug = ' padded ' WHERE id = 'prj_hardening_a'").run();
    }],
    ["noncanonical owning Project", (sqlite: DatabaseSync) => {
      sqlite.prepare("UPDATE projects SET name = ' padded name ' WHERE id = 'prj_hardening_a'").run();
    }],
    ["missing owning Project", (sqlite: DatabaseSync) => {
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("UPDATE big_tasks SET project_id = 'prj_hardening_missing' WHERE id = ?").run(TARGET_BIG_TASK);
    }],
  ] as const)("fails closed for target hierarchy corruption: %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      runSqlMutation(databasePath, corrupt);
      expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
    });
  });

  it("enforces both cross-scope endpoint directions and ignores foreign-to-foreign edges", () => {
    for (const [upstream, downstream] of [
      [LOCAL_A, FOREIGN_A],
      [FOREIGN_A, LOCAL_A],
    ] as const) {
      withTemporaryDatabasePath((databasePath) => {
        seedScopes(databasePath);
        runSqlMutation(databasePath, (sqlite) => {
          sqlite.prepare(
            "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Cross scope.', ?)",
          ).run(upstream, downstream, FIXED_TIME);
        });
        expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
        expectSanitizedStorageError(
          () => read(databasePath, FOREIGN_A),
          "MALFORMED_STORED_DATA",
        );
      });
    }

    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      runSqlMutation(databasePath, (sqlite) => {
        sqlite.prepare(
          "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'Foreign only.', ?)",
        ).run(FOREIGN_A, FOREIGN_B, FIXED_TIME);
      });
      expect(read(databasePath)).toMatchObject({ valid: true, ready: true });
      expect(read(databasePath, FOREIGN_B)).toMatchObject({ valid: true, ready: false });
    });
  });
});

interface SnapshotScenario {
  readonly label: string;
  readonly dependencies: readonly SubtaskDependency[];
  readonly maturities: Readonly<Record<string, SubtaskMaturity>>;
  readonly mutate: (writer: DatabaseSync) => void;
  readonly oldReady: boolean;
  readonly newReady: boolean;
}

const snapshotScenarios: readonly SnapshotScenario[] = [
  {
    label: "IMPLEMENTED to HARDENED",
    dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
    maturities: { [UPSTREAM_A]: "IMPLEMENTED" },
    mutate: (writer) => {
      writer.prepare("UPDATE subtasks SET maturity = 'HARDENED' WHERE id = ?").run(UPSTREAM_A);
    },
    oldReady: false,
    newReady: true,
  },
  {
    label: "HARDENED to ACCEPTED",
    dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "ACCEPTED")],
    maturities: { [UPSTREAM_A]: "HARDENED" },
    mutate: (writer) => {
      writer.prepare("UPDATE subtasks SET maturity = 'ACCEPTED' WHERE id = ?").run(UPSTREAM_A);
    },
    oldReady: false,
    newReady: true,
  },
  {
    label: "gate HARDENED to ACCEPTED",
    dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
    maturities: { [UPSTREAM_A]: "HARDENED" },
    mutate: (writer) => {
      writer.prepare("UPDATE task_dependencies SET required_gate = 'ACCEPTED'").run();
    },
    oldReady: true,
    newReady: false,
  },
  {
    label: "blocked dependency set to ready set",
    dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
    maturities: { [UPSTREAM_A]: "IMPLEMENTED" },
    mutate: (writer) => {
      writer.prepare("DELETE FROM task_dependencies").run();
    },
    oldReady: false,
    newReady: true,
  },
  {
    label: "ready dependency set to blocked set",
    dependencies: [],
    maturities: { [UPSTREAM_A]: "IMPLEMENTED" },
    mutate: (writer) => {
      writer.prepare(
        "INSERT INTO task_dependencies (upstream_subtask_id, downstream_subtask_id, dependency_type, required_gate, reason, created_at) VALUES (?, ?, 'BLOCKING', 'HARDENED', 'New blocker.', ?)",
      ).run(UPSTREAM_A, TARGET, FIXED_TIME);
    },
    oldReady: true,
    newReady: false,
  },
  {
    label: "combined false-ready adversary",
    dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
    maturities: { [UPSTREAM_A]: "IMPLEMENTED" },
    mutate: (writer) => {
      writer.prepare("UPDATE subtasks SET maturity = 'HARDENED' WHERE id = ?").run(UPSTREAM_A);
      writer.prepare("UPDATE task_dependencies SET required_gate = 'ACCEPTED'").run();
    },
    oldReady: false,
    newReady: false,
  },
  {
    label: "combined false-block adversary",
    dependencies: [makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED")],
    maturities: { [UPSTREAM_A]: "HARDENED" },
    mutate: (writer) => {
      writer.prepare("UPDATE subtasks SET maturity = 'ACCEPTED' WHERE id = ?").run(UPSTREAM_A);
      writer.prepare("UPDATE task_dependencies SET required_gate = 'ACCEPTED'").run();
    },
    oldReady: true,
    newReady: true,
  },
  {
    label: "multiple blocker replacement",
    dependencies: [
      makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED", "First."),
      makeDependency(UPSTREAM_B, TARGET, "BLOCKING", "ACCEPTED", "Second."),
    ],
    maturities: { [UPSTREAM_A]: "IMPLEMENTED", [UPSTREAM_B]: "HARDENED" },
    mutate: (writer) => {
      writer.prepare("DELETE FROM task_dependencies").run();
      writer.prepare("UPDATE subtasks SET maturity = 'ACCEPTED' WHERE id IN (?, ?)").run(UPSTREAM_A, UPSTREAM_B);
    },
    oldReady: false,
    newReady: true,
  },
];

const commitAfterFirstSubtaskRead = <T>(
  writer: DatabaseSync,
  operation: () => T,
): T => {
  const prototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
    readonly sourceSQL: string;
  };
  const originalGet = prototype.get;
  let commitCount = 0;
  prototype.get = function (...parameters: unknown[]): unknown {
    const result = Reflect.apply(originalGet, this, parameters);
    if (commitCount === 0 && /from\s+"?subtasks"?/i.test(this.sourceSQL)) {
      writer.exec("COMMIT");
      commitCount += 1;
    }
    return result;
  };
  try {
    const result = operation();
    expect(commitCount).toBe(1);
    return result;
  } finally {
    prototype.get = originalGet;
  }
};

describe("S1B1 deterministic snapshot interleavings", () => {
  it.each(snapshotScenarios)("returns the complete old state after snapshot: $label", (scenario) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, scenario.dependencies);
      updateMaturities(databasePath, scenario.maturities);
      const journal = new DatabaseSync(databasePath);
      journal.exec("PRAGMA journal_mode = WAL");
      journal.close();

      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const expectedOld = reader.evaluateStoredSubtaskDependencyReadiness(TARGET);
      expect(expectedOld.ready).toBe(scenario.oldReady);
      const writer = new DatabaseSync(databasePath);
      try {
        writer.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        scenario.mutate(writer);
        const interleaved = commitAfterFirstSubtaskRead(writer, () =>
          reader.evaluateStoredSubtaskDependencyReadiness(TARGET),
        );
        expect(interleaved).toEqual(expectedOld);
        const completeNew = reader.evaluateStoredSubtaskDependencyReadiness(TARGET);
        expect(completeNew.ready).toBe(scenario.newReady);
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it.each(snapshotScenarios)("returns the complete new state when commit precedes first read: $label", (scenario) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, scenario.dependencies);
      updateMaturities(databasePath, scenario.maturities);
      const writer = new DatabaseSync(databasePath);
      writer.exec("BEGIN IMMEDIATE");
      scenario.mutate(writer);
      writer.exec("COMMIT");
      writer.close();

      const result = read(databasePath);
      expect(result.ready).toBe(scenario.newReady);
      expect(result).toEqual(read(databasePath));
    });
  });
});

describe("S1B1 transaction ownership, cleanup, and failure sanitization", () => {
  it("reuses the caller transaction without committing or rolling it back", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        storage.runInTransaction((transaction) => {
          const created = makeSubtask("st_hardening_created_inside", TARGET_BIG_TASK);
          transaction.createSubtask(created);
          expect(
            transaction.evaluateStoredSubtaskDependencyReadiness(created.id),
          ).toMatchObject({ valid: true, ready: true });
          transaction.createSubtask(
            makeSubtask("st_hardening_created_after_read", TARGET_BIG_TASK),
          );
        });
        expect(
          storage.getSubtaskById(SubtaskIdSchema.parse("st_hardening_created_inside")),
        ).not.toBeNull();
        expect(
          storage.getSubtaskById(SubtaskIdSchema.parse("st_hardening_created_after_read")),
        ).not.toBeNull();

        expectSanitizedStorageError(
          () =>
            storage.runInTransaction((transaction) => {
              transaction.createSubtask(
                makeSubtask("st_hardening_rolled_back", TARGET_BIG_TASK),
              );
              transaction.evaluateStoredSubtaskDependencyReadiness(TARGET);
              throw new Error("private caller rollback");
            }),
          "TRANSACTION_FAILED",
        );
        expect(
          storage.getSubtaskById(SubtaskIdSchema.parse("st_hardening_rolled_back")),
        ).toBeNull();
      } finally {
        storage.close();
      }
    });
  });

  it("leaves failure handling under the caller transaction's control", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED"),
      ]);
      runSqlMutation(databasePath, (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(UPSTREAM_A);
      });
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        storage.runInTransaction((transaction) => {
          expectSanitizedStorageError(
            () => transaction.evaluateStoredSubtaskDependencyReadiness(TARGET),
            "MALFORMED_STORED_DATA",
          );
          transaction.createSubtask(
            makeSubtask("st_hardening_after_caught_failure", THIRD_BIG_TASK),
          );
        });
        expect(
          storage.getSubtaskById(
            SubtaskIdSchema.parse("st_hardening_after_caught_failure"),
          ),
        ).not.toBeNull();

        expectSanitizedStorageError(
          () =>
            storage.runInTransaction((transaction) => {
              transaction.createSubtask(
                makeSubtask("st_hardening_before_uncaught_failure", THIRD_BIG_TASK),
              );
              transaction.evaluateStoredSubtaskDependencyReadiness(TARGET);
            }),
          "MALFORMED_STORED_DATA",
        );
        expect(
          storage.getSubtaskById(
            SubtaskIdSchema.parse("st_hardening_before_uncaught_failure"),
          ),
        ).toBeNull();
      } finally {
        storage.close();
      }
    });
  });

  it("cleans up standalone read transactions after representative failures", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED"),
      ]);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectSanitizedStorageError(
          () =>
            storage.evaluateStoredSubtaskDependencyReadiness(
              SubtaskIdSchema.parse("st_hardening_missing"),
            ),
          "PARENT_NOT_FOUND",
        );
        expect(
          storage.evaluateStoredSubtaskDependencyReadiness(
            SubtaskIdSchema.parse("st_hardening_third_a"),
          ),
        ).toMatchObject({ valid: true, ready: true });
        storage.createSubtask(makeSubtask("st_hardening_after_missing", THIRD_BIG_TASK));
      } finally {
        storage.close();
      }

      runSqlMutation(databasePath, (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE task_dependencies SET required_gate = 'NONE'").run();
      });
      const malformed = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectSanitizedStorageError(
          () => malformed.evaluateStoredSubtaskDependencyReadiness(TARGET),
          "MALFORMED_STORED_DATA",
        );
        expect(
          malformed.evaluateStoredSubtaskDependencyReadiness(
            SubtaskIdSchema.parse("st_hardening_third_a"),
          ),
        ).toMatchObject({ valid: true, ready: true });
        malformed.createSubtask(
          makeSubtask("st_hardening_after_malformed", THIRD_BIG_TASK),
        );
      } finally {
        malformed.close();
      }
    });
  });

  it.each(["BEGIN", "COMMIT"] as const)("sanitizes injected %s failure and remains usable", (phase) => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const prototype = DatabaseSync.prototype as unknown as {
        exec: (sql: string) => void;
      };
      const originalExec = prototype.exec;
      let injected = 0;
      prototype.exec = function (sql: string): void {
        if (sql === phase && injected === 0) {
          injected += 1;
          throw new Error(`private ${phase} diagnostic`);
        }
        Reflect.apply(originalExec, this, [sql]);
      };
      try {
        expectSanitizedStorageError(
          () => storage.evaluateStoredSubtaskDependencyReadiness(TARGET),
          "TRANSACTION_FAILED",
        );
      } finally {
        prototype.exec = originalExec;
      }
      try {
        expect(injected).toBe(1);
        expect(storage.evaluateStoredSubtaskDependencyReadiness(TARGET)).toMatchObject({
          valid: true,
          ready: true,
        });
      } finally {
        storage.close();
      }
    });
  });

  it("executes and sanitizes operation rollback and rollback-failure paths", () => {
    for (const failRollback of [false, true]) {
      withTemporaryDatabasePath((databasePath) => {
        seedScopes(databasePath, [
          makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED"),
        ]);
        runSqlMutation(databasePath, (sqlite) => {
          sqlite.exec("PRAGMA ignore_check_constraints = ON");
          sqlite.prepare("UPDATE task_dependencies SET required_gate = 'NONE'").run();
        });
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        const prototype = DatabaseSync.prototype as unknown as {
          exec: (sql: string) => void;
        };
        const originalExec = prototype.exec;
        let rollbacks = 0;
        prototype.exec = function (sql: string): void {
          if (sql === "ROLLBACK") {
            rollbacks += 1;
            if (failRollback) {
              throw new Error("private rollback diagnostic");
            }
          }
          Reflect.apply(originalExec, this, [sql]);
        };
        try {
          expectSanitizedStorageError(
            () => storage.evaluateStoredSubtaskDependencyReadiness(TARGET),
            failRollback ? "TRANSACTION_FAILED" : "MALFORMED_STORED_DATA",
          );
        } finally {
          prototype.exec = originalExec;
        }
        expect(rollbacks).toBe(1);
        storage.close();

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(
            reopened.evaluateStoredSubtaskDependencyReadiness(
              SubtaskIdSchema.parse("st_hardening_third_a"),
            ),
          ).toMatchObject({ valid: true, ready: true });
        } finally {
          reopened.close();
        }
      });
    }
  });
});

describe("S1B1 read-only and reopen invariants", () => {
  it("leaves every application table byte-for-byte unchanged across success and failure", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED", "Blocked."),
      ]);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const scope = ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: "prj_hardening_a",
        bigTaskId: TARGET_BIG_TASK,
        subtaskId: TARGET,
      });
      storage.createContextItem(makeContextItem("ctx_hardening", scope));
      storage.createContextDigest(makeContextDigest("dgt_hardening", scope));
      storage.appendAuditEvent(makeAuditEvent("aud_hardening", scope));
      const before = applicationSnapshot(databasePath);
      expect(storage.evaluateStoredSubtaskDependencyReadiness(TARGET)).toMatchObject({
        valid: true,
        ready: false,
      });
      expect(
        storage.evaluateStoredSubtaskDependencyReadiness(
          SubtaskIdSchema.parse("st_hardening_third_a"),
        ),
      ).toMatchObject({ valid: true, ready: true });
      expectSanitizedStorageError(
        () =>
          storage.evaluateStoredSubtaskDependencyReadiness(
            SubtaskIdSchema.parse("st_hardening_missing"),
          ),
        "PARENT_NOT_FOUND",
      );
      for (let repeat = 0; repeat < 4; repeat += 1) {
        storage.evaluateStoredSubtaskDependencyReadiness(TARGET);
      }
      storage.runInTransaction((transaction) => {
        transaction.evaluateStoredSubtaskDependencyReadiness(TARGET);
      });
      expect(applicationSnapshot(databasePath)).toEqual(before);
      storage.close();

      runSqlMutation(databasePath, (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(UPSTREAM_A);
      });
      const malformedBefore = applicationSnapshot(databasePath);
      expectSanitizedStorageError(() => read(databasePath), "MALFORMED_STORED_DATA");
      expect(applicationSnapshot(databasePath)).toEqual(malformedBefore);
    });
  });

  it("keeps ready, blocked, malformed, and unrelated classifications stable across reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedScopes(databasePath, [
        makeDependency(UPSTREAM_A, TARGET, "BLOCKING", "HARDENED", "Stable."),
      ]);
      runSqlMutation(databasePath, (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?").run(FOREIGN_A);
      });
      for (let reopen = 0; reopen < 3; reopen += 1) {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expect(storage.evaluateStoredSubtaskDependencyReadiness(TARGET)).toMatchObject({
            valid: true,
            ready: false,
          });
          expect(
            storage.evaluateStoredSubtaskDependencyReadiness(
              SubtaskIdSchema.parse("st_hardening_third_a"),
            ),
          ).toMatchObject({ valid: true, ready: true });
          expectSanitizedStorageError(
            () => storage.evaluateStoredSubtaskDependencyReadiness(FOREIGN_A),
            "MALFORMED_STORED_DATA",
          );
        } finally {
          storage.close();
        }
      }
    });
  });
});

describe("S1B1 property-style storage parity", () => {
  it("matches two independent oracles for 25 fixed seeds and at least 1,000 stored evaluations", () => {
    withTemporaryDatabasePath((databasePath) => {
      const expected = new Map<
        string,
        {
          readonly subtasks: readonly Pick<Subtask, "id" | "bigTaskId" | "maturity">[];
          readonly dependencies: readonly SubtaskDependency[];
        }
      >();
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject("prj_property", "property"));
      for (let seed = 0; seed < 25; seed += 1) {
        const bigTask = makeBigTask(`bt_property_${seed}`, "prj_property");
        storage.createBigTask(bigTask);
        const count = 10 + ((seed * 17) % 71);
        const subtasks = Array.from({ length: count }, (_, index) => {
          const created = makeSubtask(`st_property_${seed}_${index}`, bigTask.id);
          storage.createSubtask(created);
          return {
            id: created.id,
            bigTaskId: created.bigTaskId,
            maturity: (["NOT_STARTED", "IMPLEMENTED", "HARDENED", "ACCEPTED"] as const)[
              (seed * 7 + index * 3) % 4
            ]!,
          };
        });
        const dependencies: SubtaskDependency[] = [];
        const edgeKeys = new Set<string>();
        const add = (dependency: SubtaskDependency): void => {
          const key = `${dependency.upstreamSubtaskId}->${dependency.downstreamSubtaskId}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            dependencies.push(dependency);
          }
        };
        for (let index = 1; index < count; index += 1) {
          const upstream = (seed * 11 + index * 5) % index;
          add(makeDependency(
            subtasks[upstream]!.id,
            subtasks[index]!.id,
            "BLOCKING",
            index % 3 === 0 ? "ACCEPTED" : "HARDENED",
            `Property ${seed} edge ${index}.`,
          ));
          if (index > 3) {
            add(makeDependency(
              subtasks[(upstream + 1) % index]!.id,
              subtasks[index]!.id,
              "BLOCKING",
              index % 4 === 0 ? "ACCEPTED" : "HARDENED",
              `Property ${seed} fan ${index}.`,
            ));
          }
          const informationTarget = (index * 7 + seed) % count;
          if (informationTarget !== index) {
            add(makeDependency(
              subtasks[index]!.id,
              subtasks[informationTarget]!.id,
              "INFORMATIONAL",
              "NONE",
              `Property ${seed} information ${index}.`,
            ));
          }
        }
        storage.replaceDependenciesForBigTask(bigTask.id, dependencies);
        expected.set(bigTask.id, { subtasks, dependencies });
      }
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const update = sqlite.prepare("UPDATE subtasks SET maturity = ? WHERE id = ?");
      for (const graph of expected.values()) {
        for (const subtask of graph.subtasks) {
          update.run(subtask.maturity, subtask.id);
        }
      }
      sqlite.close();

      let evaluations = 0;
      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        for (const [bigTaskId, graph] of expected) {
          const storedSubtasks = reopened.listSubtasksByBigTask(
            BigTaskIdSchema.parse(bigTaskId),
          );
          const storedDependencies = reopened.listDependenciesForBigTask(
            BigTaskIdSchema.parse(bigTaskId),
          );
          for (const target of graph.subtasks) {
            const actual = reopened.evaluateStoredSubtaskDependencyReadiness(target.id);
            expect(actual).toEqual(
              evaluateSubtaskDependencyReadiness(
                graph.subtasks,
                graph.dependencies,
                target.id,
              ),
            );
            expect(actual).toEqual(
              independentReadinessOracle(
                graph.subtasks,
                graph.dependencies,
                target.id,
              ),
            );
            expect(storedSubtasks).toHaveLength(graph.subtasks.length);
            expect(storedDependencies).toHaveLength(graph.dependencies.length);
            evaluations += 1;
          }
        }
      } finally {
        reopened.close();
      }
      expect(evaluations).toBeGreaterThanOrEqual(1_000);

      for (const seed of [0, 6, 12, 18, 24]) {
        const graph = expected.get(`bt_property_${seed}`)!;
        const repeat = read(databasePath, graph.subtasks.at(-1)!.id);
        expect(repeat).toEqual(
          independentReadinessOracle(
            graph.subtasks,
            graph.dependencies,
            graph.subtasks.at(-1)!.id,
          ),
        );
      }
    });
  }, 30_000);
});

const seedLargeGraph = (
  sqlite: DatabaseSync,
  bigTaskId: string,
  targetId: string,
  prefix: string,
  generatedCount: number,
): void => {
  sqlite.prepare(
    `WITH RECURSIVE ids(n) AS (
       VALUES(0)
       UNION ALL SELECT n + 1 FROM ids WHERE n < ?
     )
     INSERT INTO subtasks (
       id, big_task_id, title, goal, scope_in, scope_out, acceptance_criteria,
       untouched_areas, status, maturity, start_policy, delegation_policy,
       recommended_reasoning_level, prompt_seed, created_at, updated_at
     )
     SELECT printf(?, n), ?, title, goal, scope_in, scope_out, acceptance_criteria,
       untouched_areas, status, 'HARDENED', start_policy, delegation_policy,
       recommended_reasoning_level, prompt_seed, created_at, updated_at
     FROM ids CROSS JOIN subtasks AS template
     WHERE template.id = ?`,
  ).run(generatedCount - 1, `${prefix}%05d`, bigTaskId, targetId);
  if (generatedCount > 1) {
    sqlite.prepare(
      `WITH RECURSIVE ids(n) AS (
         VALUES(0)
         UNION ALL SELECT n + 1 FROM ids WHERE n < ?
       )
       INSERT INTO task_dependencies (
         upstream_subtask_id, downstream_subtask_id, dependency_type,
         required_gate, reason, created_at
       )
       SELECT printf(?, n), printf(?, n + 1), 'BLOCKING', 'HARDENED',
         'Large graph evidence.', ? FROM ids`,
    ).run(generatedCount - 2, `${prefix}%05d`, `${prefix}%05d`, FIXED_TIME);
  }
  sqlite.prepare(
    `INSERT INTO task_dependencies (
       upstream_subtask_id, downstream_subtask_id, dependency_type,
       required_gate, reason, created_at
     ) VALUES (printf(?, ?), ?, 'BLOCKING', 'HARDENED', 'Large target evidence.', ?)`,
  ).run(`${prefix}%05d`, generatedCount - 1, targetId, FIXED_TIME);
};

describe("S1B1 large graph and hidden query bounds", () => {
  it("avoids the SQLite bind-variable ceiling through 250, 1,000, 5,000, and above-limit graphs", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      setup.createProject(makeProject("prj_large", "large"));
      const compileProbe = new DatabaseSync(databasePath, { readOnly: true });
      const option = compileProbe
        .prepare(
          "SELECT compile_options FROM pragma_compile_options WHERE compile_options LIKE 'MAX_VARIABLE_NUMBER=%'",
        )
        .get() as { readonly compile_options?: string } | undefined;
      compileProbe.close();
      const variableLimit = Number(option?.compile_options?.split("=")[1] ?? 32_766);
      expect(Number.isInteger(variableLimit)).toBe(true);
      const sizes = [250, 1_000, 5_000, variableLimit + 2];
      for (const size of sizes) {
        const bigTaskId = BigTaskIdSchema.parse(`bt_large_${size}`);
        const targetId = SubtaskIdSchema.parse(`st_large_${size}_target`);
        setup.createBigTask(makeBigTask(bigTaskId, "prj_large"));
        setup.createSubtask(makeSubtask(targetId, bigTaskId));
      }
      setup.close();

      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.exec("BEGIN");
        for (const size of sizes) {
          seedLargeGraph(
            sqlite,
            `bt_large_${size}`,
            `st_large_${size}_target`,
            `st_large_${size}_node_`,
            size - 1,
          );
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        if (sqlite.isTransaction) {
          sqlite.exec("ROLLBACK");
        }
        throw error;
      } finally {
        sqlite.close();
      }

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        for (const size of sizes) {
          expect(
            storage.evaluateStoredSubtaskDependencyReadiness(
              SubtaskIdSchema.parse(`st_large_${size}_target`),
            ),
          ).toEqual({
            valid: true,
            ready: true,
            blockers: [],
            errors: [],
            errorCodes: [],
          });
        }
      } finally {
        storage.close();
      }
    });
  }, 30_000);

  it("keeps exact corruption blast radius across 12 Big Tasks and 600 Subtasks", () => {
    withTemporaryDatabasePath((databasePath) => {
      const setup = openTaskDatabase({ databasePath, clock: fixedClock });
      setup.createProject(makeProject("prj_blast_a", "blast-a"));
      setup.createProject(makeProject("prj_blast_b", "blast-b"));
      for (let bigIndex = 0; bigIndex < 12; bigIndex += 1) {
        const projectId = bigIndex < 6 ? "prj_blast_a" : "prj_blast_b";
        const bigTaskId = BigTaskIdSchema.parse(`bt_blast_${bigIndex}`);
        setup.createBigTask(makeBigTask(bigTaskId, projectId));
        for (let taskIndex = 0; taskIndex < 50; taskIndex += 1) {
          setup.createSubtask(makeSubtask(`st_blast_${bigIndex}_${taskIndex}`, bigTaskId));
        }
        setup.replaceDependenciesForBigTask(bigTaskId, [
          makeDependency(
            `st_blast_${bigIndex}_0`,
            `st_blast_${bigIndex}_1`,
            "BLOCKING",
            "HARDENED",
            `Blast ${bigIndex}.`,
          ),
        ]);
      }
      setup.close();

      runSqlMutation(databasePath, (sqlite) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite.prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = 'st_blast_0_20'").run();
        sqlite.prepare("UPDATE task_dependencies SET reason = ' padded ' WHERE upstream_subtask_id = 'st_blast_1_0'").run();
        sqlite.prepare("UPDATE subtasks SET status = 'UNKNOWN' WHERE id = 'st_blast_7_20'").run();
      });

      for (const corruptTarget of ["st_blast_0_1", "st_blast_1_1", "st_blast_7_1"]) {
        expectSanitizedStorageError(
          () => read(databasePath, SubtaskIdSchema.parse(corruptTarget)),
          "MALFORMED_STORED_DATA",
        );
      }
      for (const cleanTarget of ["st_blast_2_1", "st_blast_5_1", "st_blast_6_1", "st_blast_11_1"]) {
        expect(read(databasePath, SubtaskIdSchema.parse(cleanTarget))).toMatchObject({
          valid: true,
          ready: false,
        });
      }
    });
  }, 30_000);
});
