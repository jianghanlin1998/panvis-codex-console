import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ContextScopeSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  SubtaskDependency,
  SubtaskId,
  SubtaskMaturity,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";

import {
  FIXED_TIME,
  captureTaskStorageError,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeDependency,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const TARGET_BIG_TASK_ID = BigTaskIdSchema.parse("bt_readiness");
const OTHER_BIG_TASK_ID = BigTaskIdSchema.parse("bt_readiness_other");
const THIRD_BIG_TASK_ID = BigTaskIdSchema.parse("bt_readiness_third");
const TARGET_ID = SubtaskIdSchema.parse("st_readiness_target");

const targetSubtaskIds = [
  "st_readiness_upstream",
  "st_readiness_satisfied",
  "st_readiness_alpha",
  "st_readiness_zulu",
  TARGET_ID,
  "st_readiness_other_target",
] as const;

const populateReadinessHierarchy = (
  storage: TaskStorage,
  dependencies: readonly SubtaskDependency[] = [],
): void => {
  storage.createProject(makeProject());
  for (const bigTaskId of [
    TARGET_BIG_TASK_ID,
    OTHER_BIG_TASK_ID,
    THIRD_BIG_TASK_ID,
  ]) {
    storage.createBigTask(makeBigTask(bigTaskId));
  }
  for (const subtaskId of targetSubtaskIds) {
    storage.createSubtask(makeSubtask(subtaskId, TARGET_BIG_TASK_ID));
  }
  storage.createSubtask(makeSubtask("st_readiness_foreign_a", OTHER_BIG_TASK_ID));
  storage.createSubtask(makeSubtask("st_readiness_foreign_b", OTHER_BIG_TASK_ID));
  storage.createSubtask(makeSubtask("st_readiness_third_a", THIRD_BIG_TASK_ID));
  storage.createSubtask(makeSubtask("st_readiness_third_b", THIRD_BIG_TASK_ID));
  storage.replaceDependenciesForBigTask(TARGET_BIG_TASK_ID, dependencies);
};

const seedReadinessDatabase = (
  databasePath: string,
  dependencies: readonly SubtaskDependency[] = [],
): void => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  try {
    populateReadinessHierarchy(storage, dependencies);
  } finally {
    storage.close();
  }
};

const setMaturities = (
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

const evaluate = (databasePath: string, subtaskId: SubtaskId = TARGET_ID) => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  try {
    return storage.evaluateStoredSubtaskDependencyReadiness(subtaskId);
  } finally {
    storage.close();
  }
};

const snapshotReadinessEvidence = (databasePath: string) => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      subtasks: sqlite.prepare("SELECT * FROM subtasks ORDER BY id").all(),
      dependencies: sqlite
        .prepare(
          "SELECT * FROM task_dependencies ORDER BY upstream_subtask_id, downstream_subtask_id",
        )
        .all(),
      auditEvents: sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all(),
    };
  } finally {
    sqlite.close();
  }
};

const expectMalformedStoredData = (operation: () => unknown): void => {
  const error = captureTaskStorageError(operation);
  expect(error).toMatchObject({ code: "MALFORMED_STORED_DATA" });
  expect(error.message).not.toMatch(
    /SQLite|SQL|task_dependencies|subtasks|maturity|required_gate|reason|\/Users\/|Zod|stack/i,
  );
};

describe("stored Subtask dependency readiness", () => {
  it("returns ready for a target with no dependencies", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);

      expect(evaluate(databasePath)).toEqual({
        valid: true,
        ready: true,
        blockers: [],
        errors: [],
        errorCodes: [],
      });
    });
  });

  it.each<
    readonly [
      SubtaskMaturity,
      "HARDENED" | "ACCEPTED",
      boolean,
    ]
  >([
    ["IMPLEMENTED", "HARDENED", false],
    ["HARDENED", "HARDENED", true],
    ["ACCEPTED", "HARDENED", true],
    ["HARDENED", "ACCEPTED", false],
    ["ACCEPTED", "ACCEPTED", true],
  ])(
    "evaluates stored upstream %s against required %s",
    (maturity, requiredGate, ready) => {
      withTemporaryDatabasePath((databasePath) => {
        const dependency = makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "BLOCKING",
          requiredGate,
          "Stored gate evidence.",
        );
        seedReadinessDatabase(databasePath, [dependency]);
        setMaturities(databasePath, { st_readiness_upstream: maturity });

        const result = evaluate(databasePath);
        expect(result).toMatchObject({ valid: true, ready });
        expect(result.blockers).toEqual(
          ready
            ? []
            : [
                {
                  upstreamSubtaskId: "st_readiness_upstream",
                  requiredGate,
                  actualMaturity: maturity,
                  reason: dependency.reason,
                },
              ],
        );
      });
    },
  );

  it("never blocks on an informational stored dependency", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath, [
        makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "INFORMATIONAL",
          "NONE",
          "Useful context only.",
        ),
      ]);

      expect(evaluate(databasePath)).toMatchObject({
        valid: true,
        ready: true,
        blockers: [],
      });
    });
  });

  it("filters exact blockers deterministically within the owning Big Task", () => {
    withTemporaryDatabasePath((databasePath) => {
      const dependencies = [
        makeDependency(
          "st_readiness_zulu",
          TARGET_ID,
          "BLOCKING",
          "HARDENED",
          "Zulu needs hardening.",
        ),
        makeDependency(
          "st_readiness_satisfied",
          TARGET_ID,
          "BLOCKING",
          "HARDENED",
          "Already satisfied.",
        ),
        makeDependency(
          "st_readiness_alpha",
          TARGET_ID,
          "BLOCKING",
          "ACCEPTED",
          "Alpha needs acceptance.",
        ),
        makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "INFORMATIONAL",
          "NONE",
          "Information only.",
        ),
        makeDependency(
          TARGET_ID,
          "st_readiness_other_target",
          "BLOCKING",
          "HARDENED",
          "Outgoing edge.",
        ),
        makeDependency(
          "st_readiness_zulu",
          "st_readiness_other_target",
          "BLOCKING",
          "ACCEPTED",
          "Different downstream.",
        ),
      ];
      seedReadinessDatabase(databasePath, dependencies);
      setMaturities(databasePath, {
        st_readiness_alpha: "HARDENED",
        st_readiness_satisfied: "ACCEPTED",
      });
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        storage.replaceDependenciesForBigTask(OTHER_BIG_TASK_ID, [
          makeDependency(
            "st_readiness_foreign_a",
            "st_readiness_foreign_b",
            "BLOCKING",
            "HARDENED",
            "Unrelated dependency.",
          ),
        ]);
        storage.replaceDependenciesForBigTask(THIRD_BIG_TASK_ID, [
          makeDependency(
            "st_readiness_third_a",
            "st_readiness_third_b",
            "INFORMATIONAL",
            "NONE",
            "Unrelated information.",
          ),
        ]);

        expect(storage.evaluateStoredSubtaskDependencyReadiness(TARGET_ID)).toEqual({
          valid: true,
          ready: false,
          blockers: [
            {
              upstreamSubtaskId: "st_readiness_alpha",
              requiredGate: "ACCEPTED",
              actualMaturity: "HARDENED",
              reason: "Alpha needs acceptance.",
            },
            {
              upstreamSubtaskId: "st_readiness_zulu",
              requiredGate: "HARDENED",
              actualMaturity: "NOT_STARTED",
              reason: "Zulu needs hardening.",
            },
          ],
          errors: [],
          errorCodes: [],
        });
      } finally {
        storage.close();
      }
    });
  });

  it("reuses an existing synchronous storage transaction", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(
          storage.runInTransaction((transaction) =>
            transaction.evaluateStoredSubtaskDependencyReadiness(TARGET_ID),
          ),
        ).toMatchObject({ valid: true, ready: true, blockers: [] });
      } finally {
        storage.close();
      }
    });
  });
});

describe("stored readiness input and lifecycle boundaries", () => {
  it("rejects a malformed or noncanonical Subtask ID", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(() =>
          storage.evaluateStoredSubtaskDependencyReadiness(
            " st_readiness_target " as SubtaskId,
          ),
        ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
      } finally {
        storage.close();
      }
    });
  });

  it("uses PARENT_NOT_FOUND for a nonexistent target", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(() =>
          storage.evaluateStoredSubtaskDependencyReadiness(
            SubtaskIdSchema.parse("st_readiness_missing"),
          ),
        ).toThrow(expect.objectContaining({ code: "PARENT_NOT_FOUND" }));
      } finally {
        storage.close();
      }
    });
  });

  it("uses the sanitized closed-database behavior", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.close();

      expect(() =>
        storage.evaluateStoredSubtaskDependencyReadiness(TARGET_ID),
      ).toThrow(expect.objectContaining({ code: "DATABASE_CLOSED" }));
    });
  });

  it("does not mutate the caller's Subtask ID", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);
      const input = SubtaskIdSchema.parse("st_readiness_target");
      const before = input;

      evaluate(databasePath, input);

      expect(input).toBe(before);
    });
  });
});

describe("stored readiness corruption isolation", () => {
  const corruptionCases = [
    [
      "invalid target maturity",
      (sqlite: DatabaseSync) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite
          .prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?")
          .run(TARGET_ID);
      },
    ],
    [
      "invalid other relevant Subtask maturity",
      (sqlite: DatabaseSync) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite
          .prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?")
          .run("st_readiness_other_target");
      },
    ],
    [
      "malformed dependency type",
      (sqlite: DatabaseSync) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite
          .prepare("UPDATE task_dependencies SET dependency_type = 'UNKNOWN'")
          .run();
      },
    ],
    [
      "malformed dependency gate",
      (sqlite: DatabaseSync) => {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite
          .prepare("UPDATE task_dependencies SET required_gate = 'NONE'")
          .run();
      },
    ],
    [
      "noncanonical dependency reason",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare("UPDATE task_dependencies SET reason = ' padded reason '")
          .run();
      },
    ],
    [
      "missing relevant endpoint",
      (sqlite: DatabaseSync) => {
        sqlite.exec("PRAGMA foreign_keys = OFF");
        sqlite
          .prepare(
            "UPDATE task_dependencies SET upstream_subtask_id = 'st_readiness_missing'",
          )
          .run();
      },
    ],
    [
      "cross-Big-Task endpoint",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare(
            "UPDATE task_dependencies SET upstream_subtask_id = 'st_readiness_foreign_a'",
          )
          .run();
      },
    ],
    [
      "blocking cycle",
      (sqlite: DatabaseSync) => {
        sqlite
          .prepare(
            "INSERT INTO task_dependencies VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            TARGET_ID,
            "st_readiness_upstream",
            "BLOCKING",
            "HARDENED",
            "Cycle edge.",
            FIXED_TIME,
          );
      },
    ],
  ] as const;

  it.each(corruptionCases)("fails closed for %s without mutation", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath, [
        makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "BLOCKING",
          "HARDENED",
          "Relevant dependency.",
        ),
      ]);
      const sqlite = new DatabaseSync(databasePath);
      try {
        corrupt(sqlite);
      } finally {
        sqlite.close();
      }
      const before = snapshotReadinessEvidence(databasePath);

      expectMalformedStoredData(() => evaluate(databasePath));

      expect(snapshotReadinessEvidence(databasePath)).toEqual(before);
    });
  });

  it("ignores malformed durable evidence in an unrelated Big Task", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.replaceDependenciesForBigTask(OTHER_BIG_TASK_ID, [
        makeDependency(
          "st_readiness_foreign_a",
          "st_readiness_foreign_b",
          "BLOCKING",
          "HARDENED",
          "Foreign dependency.",
        ),
      ]);
      storage.close();
      const sqlite = new DatabaseSync(databasePath);
      try {
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        sqlite
          .prepare("UPDATE subtasks SET maturity = 'UNKNOWN' WHERE id = ?")
          .run("st_readiness_foreign_a");
        sqlite
          .prepare(
            "UPDATE task_dependencies SET reason = ' padded foreign reason '",
          )
          .run();
      } finally {
        sqlite.close();
      }

      expect(evaluate(databasePath)).toMatchObject({
        valid: true,
        ready: true,
        blockers: [],
      });
    });
  });
});

describe("stored readiness snapshot durability and side effects", () => {
  it("preserves representative ready and blocked results through two reopens", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      populateReadinessHierarchy(storage, [
        makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "BLOCKING",
          "HARDENED",
          "Reopen blocker.",
        ),
      ]);
      setMaturities(databasePath, { st_readiness_upstream: "IMPLEMENTED" });
      const assertResults = (current: TaskStorage): void => {
        expect(
          current.evaluateStoredSubtaskDependencyReadiness(TARGET_ID),
        ).toMatchObject({ valid: true, ready: false });
        expect(
          current.evaluateStoredSubtaskDependencyReadiness(
            SubtaskIdSchema.parse("st_readiness_other_target"),
          ),
        ).toMatchObject({ valid: true, ready: true, blockers: [] });
      };
      assertResults(storage);
      storage.close();

      for (let reopenIndex = 0; reopenIndex < 2; reopenIndex += 1) {
        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          assertResults(reopened);
        } finally {
          reopened.close();
        }
      }
    });
  });

  it("returns one complete state while a two-connection replacement is uncommitted", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath, [
        makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "BLOCKING",
          "HARDENED",
          "Snapshot blocker.",
        ),
      ]);
      setMaturities(databasePath, { st_readiness_upstream: "IMPLEMENTED" });
      const reader = openTaskDatabase({ databasePath, clock: fixedClock });
      const writer = new DatabaseSync(databasePath);
      try {
        writer.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        writer
          .prepare("UPDATE subtasks SET maturity = 'HARDENED' WHERE id = ?")
          .run("st_readiness_upstream");
        writer
          .prepare("UPDATE task_dependencies SET required_gate = 'ACCEPTED'")
          .run();

        expect(reader.evaluateStoredSubtaskDependencyReadiness(TARGET_ID)).toMatchObject({
          valid: true,
          ready: false,
          blockers: [
            {
              actualMaturity: "IMPLEMENTED",
              requiredGate: "HARDENED",
            },
          ],
        });

        writer.exec("COMMIT");
        expect(reader.evaluateStoredSubtaskDependencyReadiness(TARGET_ID)).toMatchObject({
          valid: true,
          ready: false,
          blockers: [
            {
              actualMaturity: "HARDENED",
              requiredGate: "ACCEPTED",
            },
          ],
        });
      } finally {
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        reader.close();
      }
    });
  });

  it("does not alter task, dependency, timestamp, or Audit Event rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedReadinessDatabase(databasePath, [
        makeDependency(
          "st_readiness_upstream",
          TARGET_ID,
          "BLOCKING",
          "HARDENED",
          "Read-only evidence.",
        ),
      ]);
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const scope = ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: makeProject().id,
        bigTaskId: TARGET_BIG_TASK_ID,
        subtaskId: TARGET_ID,
      });
      storage.appendAuditEvent(
        makeAuditEvent("aud_readiness_existing", scope),
      );
      const before = snapshotReadinessEvidence(databasePath);

      storage.evaluateStoredSubtaskDependencyReadiness(TARGET_ID);

      expect(snapshotReadinessEvidence(databasePath)).toEqual(before);
      expect(storage.listAuditEventsByScope(scope)).toHaveLength(1);
      storage.close();
    });
  });
});
