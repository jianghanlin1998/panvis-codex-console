import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type { TaskContractV0 } from "@codex-task-console/domain";
import type { PlanCandidate } from "@codex-task-console/orchestration";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeBigTask,
  makeProject,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_contract_corruption");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_contract_corruption");
const FIXED_TIME = "2026-08-09T00:00:00.000Z";

const plan = (): PlanCandidate => ({
  kind: "PLAN_CANDIDATE",
  projectId: PROJECT_ID,
  bigTaskId: BIG_TASK_ID,
  revision: 1,
  subtasks: [0, 1].map((index) => ({
    id: SubtaskIdSchema.parse(`st_corruption_${index}`),
    bigTaskId: BIG_TASK_ID,
    profile: "STANDARD" as const,
    taskContractRef: `corruption-ref-${index}`,
    writeEnabled: true,
  })),
  dependencies: [],
});

const contractsFor = (candidate: PlanCandidate): readonly TaskContractV0[] =>
  candidate.subtasks.map((subtask, index) =>
    TaskContractV0Schema.parse({
      taskContractRef: subtask.taskContractRef,
      projectId: candidate.projectId,
      bigTaskId: candidate.bigTaskId,
      subtaskId: subtask.id,
      title: `Corruption contract ${index}`,
      goal: `Reject malformed authority ${index}`,
      scopeIn: [`Scope ${index}`],
      scopeOut: [],
      acceptanceCriteria: [`Acceptance ${index}`],
      untouchedAreas: [],
      promptSeed: `Prompt ${index}`,
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
    }),
  );

const seedApprovedBundle = (databasePath: string): void => {
  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  storage.createProject(makeProject(PROJECT_ID, "contract-corruption"));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
  const candidate = plan();
  const bundle = storage.beginDurablePlanningBundle(
    candidate,
    contractsFor(candidate),
  );
  storage.recordDurableReviewerDecision(BIG_TASK_ID, {
    outcome: "APPROVE",
    planRevision: 1,
    candidateBinding: bundle.candidateBinding,
  });
  storage.close();
};

const dropArtifactUpdateTrigger = (sqlite: DatabaseSync): void => {
  sqlite.exec("DROP TRIGGER task_contracts_immutable_update");
};
const dropArtifactDeleteTrigger = (sqlite: DatabaseSync): void => {
  sqlite.exec("DROP TRIGGER task_contracts_immutable_delete");
};
const dropBindingUpdateTrigger = (sqlite: DatabaseSync): void => {
  sqlite.exec("DROP TRIGGER candidate_task_contract_bindings_immutable_update");
};
const dropBindingDeleteTrigger = (sqlite: DatabaseSync): void => {
  sqlite.exec("DROP TRIGGER candidate_task_contract_bindings_immutable_delete");
};

const readFirstPayload = (sqlite: DatabaseSync): Record<string, unknown> => {
  const row = sqlite
    .prepare(
      "SELECT contract_payload FROM task_contracts WHERE project_id = ? AND task_contract_ref = 'corruption-ref-0'",
    )
    .get(PROJECT_ID) as { readonly contract_payload: string };
  return JSON.parse(row.contract_payload) as Record<string, unknown>;
};

const replaceFirstPayload = (
  sqlite: DatabaseSync,
  transform: (payload: Record<string, unknown>) => string,
): void => {
  dropArtifactUpdateTrigger(sqlite);
  sqlite
    .prepare(
      "UPDATE task_contracts SET contract_payload = ? WHERE project_id = ? AND task_contract_ref = 'corruption-ref-0'",
    )
    .run(transform(readFirstPayload(sqlite)), PROJECT_ID);
};

type CorruptionMutation = (sqlite: DatabaseSync) => void;

const corruptionCases: readonly [string, CorruptionMutation][] = [
  ["artifact invalid JSON", (db) => replaceFirstPayload(db, () => "not-json")],
  [
    "artifact noncanonical JSON whitespace",
    (db) => replaceFirstPayload(db, (payload) => `${JSON.stringify(payload)} `),
  ],
  [
    "artifact duplicate JSON key",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify(payload).replace("{", '{"title":"duplicate",'),
      ),
  ],
  [
    "artifact missing title",
    (db) =>
      replaceFirstPayload(db, (payload) => {
        delete payload.title;
        return JSON.stringify(payload);
      }),
  ],
  [
    "artifact unknown status",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, status: "TODO" }),
      ),
  ],
  [
    "artifact payload ref substitution",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, taskContractRef: "different-ref" }),
      ),
  ],
  [
    "artifact payload Project substitution",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, projectId: "prj_different" }),
      ),
  ],
  [
    "artifact payload Big Task substitution",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, bigTaskId: "bt_different" }),
      ),
  ],
  [
    "artifact payload Subtask substitution",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, subtaskId: "st_different" }),
      ),
  ],
  [
    "artifact invalid start policy",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, startPolicy: "AUTOMATIC" }),
      ),
  ],
  [
    "artifact invalid delegation policy",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, delegationPolicy: "WRITE" }),
      ),
  ],
  [
    "artifact invalid reasoning level",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, recommendedReasoningLevel: "ULTRA" }),
      ),
  ],
  [
    "artifact empty scopeIn",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, scopeIn: [] }),
      ),
  ],
  [
    "artifact empty acceptance",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, acceptanceCriteria: [] }),
      ),
  ],
  [
    "artifact non-array scopeIn",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, scopeIn: "not-an-array" }),
      ),
  ],
  [
    "artifact non-string scopeOut item",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, scopeOut: [1] }),
      ),
  ],
  [
    "artifact title control character",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, title: "before\u0000after" }),
      ),
  ],
  [
    "artifact malformed UTF-16",
    (db) =>
      replaceFirstPayload(db, (payload) =>
        JSON.stringify({ ...payload, promptSeed: "before\ud800after" }),
      ),
  ],
  [
    "artifact row Project substitution",
    (db) => {
      dropArtifactUpdateTrigger(db);
      db.prepare("UPDATE task_contracts SET project_id = 'prj_wrong' WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "artifact row Big Task substitution",
    (db) => {
      dropArtifactUpdateTrigger(db);
      db.prepare("UPDATE task_contracts SET big_task_id = 'bt_wrong' WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "artifact row Subtask substitution",
    (db) => {
      dropArtifactUpdateTrigger(db);
      db.prepare("UPDATE task_contracts SET subtask_id = 'st_wrong' WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "artifact row ref substitution",
    (db) => {
      dropArtifactUpdateTrigger(db);
      db.prepare("UPDATE task_contracts SET task_contract_ref = 'row-wrong-ref' WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "artifact invalid timestamp",
    (db) => {
      dropArtifactUpdateTrigger(db);
      db.prepare("UPDATE task_contracts SET created_at = 'invalid' WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "artifact timestamp after association",
    (db) => {
      dropArtifactUpdateTrigger(db);
      db.prepare("UPDATE task_contracts SET created_at = '2026-08-10T00:00:00.000Z' WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "binding Project substitution",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET project_id = 'prj_wrong' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding Big Task substitution",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET big_task_id = 'bt_wrong' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding revision substitution",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET plan_revision = 2 WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding candidateBinding substitution",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET candidate_binding = 'wrong-binding' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding candidateBinding control",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET candidate_binding = ? WHERE subtask_id = 'st_corruption_0'").run("before\u0000after");
    },
  ],
  [
    "binding Subtask substitution",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET subtask_id = 'st_wrong' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding ref substitution",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET task_contract_ref = 'wrong-ref' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding invalid timestamp",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET created_at = 'invalid' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding timestamp after approval",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET created_at = '2026-08-10T00:00:00.000Z' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "binding timestamp before candidate",
    (db) => {
      dropBindingUpdateTrigger(db);
      db.prepare("UPDATE candidate_task_contract_bindings SET created_at = '2026-08-08T00:00:00.000Z' WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "one missing binding",
    (db) => {
      dropBindingDeleteTrigger(db);
      db.prepare("DELETE FROM candidate_task_contract_bindings WHERE subtask_id = 'st_corruption_0'").run();
    },
  ],
  [
    "all bindings and artifacts missing from a marked bundle",
    (db) => {
      dropBindingDeleteTrigger(db);
      dropArtifactDeleteTrigger(db);
      db.exec("DELETE FROM candidate_task_contract_bindings");
      db.exec("DELETE FROM task_contracts");
    },
  ],
  [
    "one missing artifact",
    (db) => {
      dropArtifactDeleteTrigger(db);
      db.prepare("DELETE FROM task_contracts WHERE task_contract_ref = 'corruption-ref-0'").run();
    },
  ],
  [
    "bundle marker removed",
    (db) => {
      db.exec("DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable");
      db.prepare("UPDATE orchestration_plan_candidates SET task_contract_count = NULL").run();
    },
  ],
  [
    "bundle marker undercounts",
    (db) => {
      db.exec("DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable");
      db.prepare("UPDATE orchestration_plan_candidates SET task_contract_count = 1").run();
    },
  ],
  [
    "bundle marker overcounts",
    (db) => {
      db.exec("DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable");
      db.prepare("UPDATE orchestration_plan_candidates SET task_contract_count = 3").run();
    },
  ],
  [
    "bundle marker invalid zero",
    (db) => {
      db.exec("DROP TRIGGER orchestration_plan_candidate_task_contract_count_immutable");
      db.prepare("UPDATE orchestration_plan_candidates SET task_contract_count = 0").run();
    },
  ],
  [
    "unbound valid artifact",
    (db) => {
      const payload = {
        ...readFirstPayload(db),
        taskContractRef: "orphan-ref",
      };
      db.prepare(
        "INSERT INTO task_contracts (project_id, task_contract_ref, big_task_id, subtask_id, contract_payload, created_at) VALUES (?, 'orphan-ref', ?, 'st_corruption_0', ?, ?)",
      ).run(PROJECT_ID, BIG_TASK_ID, JSON.stringify(payload), FIXED_TIME);
    },
  ],
  [
    "association for nonexistent candidate revision",
    (db) => {
      db.prepare(
        "INSERT INTO candidate_task_contract_bindings (project_id, big_task_id, plan_revision, candidate_binding, subtask_id, task_contract_ref, created_at) VALUES (?, ?, 99, 'nonexistent', 'st_extra', 'corruption-ref-0', ?)",
      ).run(PROJECT_ID, BIG_TASK_ID, FIXED_TIME);
    },
  ],
  [
    "extra current-candidate association",
    (db) => {
      const payload = {
        ...readFirstPayload(db),
        subtaskId: "st_extra",
        taskContractRef: "extra-current-ref",
      };
      db.prepare(
        "INSERT INTO task_contracts (project_id, task_contract_ref, big_task_id, subtask_id, contract_payload, created_at) VALUES (?, 'extra-current-ref', ?, 'st_extra', ?, ?)",
      ).run(PROJECT_ID, BIG_TASK_ID, JSON.stringify(payload), FIXED_TIME);
      const binding = db
        .prepare("SELECT candidate_binding FROM orchestration_plan_candidates WHERE big_task_id = ?")
        .get(BIG_TASK_ID) as { readonly candidate_binding: string };
      db.prepare(
        "INSERT INTO candidate_task_contract_bindings (project_id, big_task_id, plan_revision, candidate_binding, subtask_id, task_contract_ref, created_at) VALUES (?, ?, 1, ?, 'st_extra', 'extra-current-ref', ?)",
      ).run(PROJECT_ID, BIG_TASK_ID, binding.candidate_binding, FIXED_TIME);
    },
  ],
  [
    "physically duplicated association",
    (db) => {
      db.exec("DROP TRIGGER candidate_task_contract_bindings_immutable_update");
      db.exec("DROP TRIGGER candidate_task_contract_bindings_immutable_delete");
      db.exec("ALTER TABLE candidate_task_contract_bindings RENAME TO old_contract_bindings");
      db.exec(`CREATE TABLE candidate_task_contract_bindings (
        project_id TEXT NOT NULL,
        big_task_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        candidate_binding TEXT NOT NULL,
        subtask_id TEXT NOT NULL,
        task_contract_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec("INSERT INTO candidate_task_contract_bindings SELECT * FROM old_contract_bindings");
      db.exec("INSERT INTO candidate_task_contract_bindings SELECT * FROM old_contract_bindings WHERE subtask_id = 'st_corruption_0'");
      db.exec("DROP TABLE old_contract_bindings");
    },
  ],
  [
    "approval predates association",
    (db) => {
      db.prepare("UPDATE orchestration_review_decisions SET created_at = '2026-08-08T00:00:00.000Z'").run();
    },
  ],
  [
    "candidate timestamp diverges from association",
    (db) => {
      db.prepare("UPDATE orchestration_plan_candidates SET created_at = '2026-08-10T00:00:00.000Z'").run();
    },
  ],
];

describe("Task Contract stored-authority corruption", () => {
  it("enforces artifact, association, and bundle-marker immutability in SQLite", () => {
    withTemporaryDatabasePath((databasePath) => {
      seedApprovedBundle(databasePath);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        sqlite.prepare("UPDATE task_contracts SET contract_payload = 'x'").run(),
      ).toThrow();
      expect(() => sqlite.exec("DELETE FROM task_contracts")).toThrow();
      expect(() =>
        sqlite
          .prepare(
            "UPDATE candidate_task_contract_bindings SET candidate_binding = 'x'",
          )
          .run(),
      ).toThrow();
      expect(() =>
        sqlite.exec("DELETE FROM candidate_task_contract_bindings"),
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            "UPDATE orchestration_plan_candidates SET task_contract_count = NULL",
          )
          .run(),
      ).toThrow();
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      expect(reopened.getApprovedTaskContractAuthority(BIG_TASK_ID)).toMatchObject({
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY",
      });
      reopened.close();
    });
  });

  it.each(corruptionCases)("fails closed on %s", (_label, corrupt) => {
    withTemporaryDatabasePath((databasePath) => {
      seedApprovedBundle(databasePath);
      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      corrupt(sqlite);
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const error = captureTaskStorageError(() =>
        storage.getApprovedTaskContractAuthority(BIG_TASK_ID),
      );
      expect(error.code).toBe("MALFORMED_STORED_DATA");
      expect(error.message).toBe("Stored task data is malformed.");
      storage.close();
    });
  });
});
