import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  ProjectSchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type { PlanCandidate } from "@codex-task-console/orchestration";
import { governedStableId } from "../src/governed-evidence-validation.js";
import { openTaskDatabase } from "../src/index.js";
import { fixedClock, makeBigTask, withTemporaryDatabasePath } from "./fixtures.js";

const migrationsRoot = fileURLToPath(new URL("../drizzle", import.meta.url));
const acceptedStep8cMigrationNames = [
  "20260809002701_public_mephisto",
  "20260809150746_groovy_iron_monger",
  "20260810133952_messy_shatterstar",
  "20260810161248_crazy_lightspeed",
  "20260811143107_spicy_apocalypse",
  "20260830145904_tough_puma",
  "20260830155716_spicy_dust",
  "20260830175200_acoustic_scream",
  "20260831044031_tired_riptide",
  "20260902135340_material_master_chief",
  "20260902152406_simple_exodus",
  "20260902171242_grey_toad",
  "20260903034830_stormy_marvel_apes",
  "20260903063931_big_reavers",
  "20260903095250_old_gressill",
  "20260903130845_equal_proteus",
] as const;
const governedTables = [
  "governed_big_task_completion_receipts",
  "governed_budget_extensions",
  "governed_dispatch_gate_snapshots",
  "governed_dispatch_receipts",
  "governed_finding_resolutions",
  "governed_findings",
  "governed_gate_observations",
          "governed_gate_sources",
  "governed_handoffs",
  "governed_manual_start_authorities",
  "governed_promoted_context_dispositions",
  "governed_promotion_candidates",
  "governed_provider_claims",
          "governed_provider_input_observations",
          "governed_provider_turn_starts",
  "governed_result_provenance",
  "governed_role_authorizations",
  "governed_role_execution_links",
  "governed_role_results",
] as const;

describe("Operational Governed Execution V0 migration", () => {
  it.each(["STEP_8C", "STEP_8D_IMPLEMENTED", "STEP_8D_LEGACY_AUTHORITY", "STEP_8D_HARDENED"])("preserves %s without fabricating new governed authority", predecessor => {
    withTemporaryDatabasePath((databasePath) => {
      const priorFolder = join(databasePath, "..", "step8d-prior-migrations");
      mkdirSync(priorFolder, { recursive: true });
      for (const name of [...acceptedStep8cMigrationNames, ...(predecessor !== "STEP_8C" ? ["20260903184138_omniscient_lyja"] : []), ...(predecessor === "STEP_8D_HARDENED" ? ["20260905045319_governed_hardening", "20260905050930_governed_gate_sources"] : [])]) {
        cpSync(join(migrationsRoot, name), join(priorFolder, name), {
          recursive: true,
        });
      }

      const projectId = ProjectIdSchema.parse("prj_step8d_migration");
      const bigTaskId = BigTaskIdSchema.parse("bt_step8d_migration");
      const subtaskId = SubtaskIdSchema.parse("st_step8d_migration");
      let storage = openTaskDatabase({
        databasePath,
        migrationsFolder: priorFolder,
        clock: fixedClock,
      });
      storage.createProject(
        ProjectSchema.parse({
          recordType: "PROJECT",
          id: projectId,
          name: "Step 8D migration",
          slug: "step-8d-migration",
          repository: { kind: "PATH", path: "/tmp/step-8d-migration" },
          defaultBranch: "main",
          maxActiveCodingSubtasks: 2,
        }),
      );
      storage.createBigTask(makeBigTask(bigTaskId, projectId));
      const plan: PlanCandidate = {
        kind: "PLAN_CANDIDATE",
        projectId,
        bigTaskId,
        revision: 1,
        subtasks: [
          {
            id: subtaskId,
            bigTaskId,
            profile: "STANDARD",
            taskContractRef: "contract/step8d-migration",
            writeEnabled: true,
          },
        ],
        dependencies: [],
      };
      const contract = TaskContractV0Schema.parse({
        taskContractRef: plan.subtasks[0]!.taskContractRef,
        projectId,
        bigTaskId,
        subtaskId,
        title: "Step 8D migration",
        goal: "Preserve accepted Step 8C authority.",
        scopeIn: ["Migration"],
        scopeOut: ["Fabricated governed history"],
        acceptanceCriteria: ["Existing authority is unchanged."],
        untouchedAreas: [],
        promptSeed: "Preserve this exact workflow.",
        startPolicy: "WHEN_READY",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
      });
      const planning = storage.beginDurablePlanningBundle(plan, [contract]);
      storage.recordDurableReviewerDecision(bigTaskId, {
        outcome: "APPROVE",
        planRevision: 1,
        candidateBinding: planning.reviewState.candidateBinding,
      });
      storage.materializeDurablePlan(bigTaskId);
      storage.materializeApprovedCanonicalTasks(bigTaskId);
      storage.initializeDurableSubtaskWorkflows(bigTaskId);
      const before = storage.getDurableWorkflowControlView(subtaskId);
      storage.close();
      const legacy = predecessor === "STEP_8D_LEGACY_AUTHORITY" || predecessor === "STEP_8D_HARDENED";
      if (legacy) {
        // Implementation-format evidence has the exact old producer shape but no
        // new durable gate source. Migration must preserve it without adopting it.
        const db = new DatabaseSync(databasePath);
        const kind = "REPOSITORY_PREFLIGHT_PASSED";
        const source = "repository:legacy-fixture";
        const aid = governedStableId("wfa", subtaskId, 1, kind, source);
        const values = [projectId,bigTaskId,1,before!.candidateBinding,subtaskId,1,"MATERIALIZE",0,
          kind,"PASS","OPERATIONAL_GATE",source,before!.initializedAt];
        db.prepare(`INSERT INTO durable_workflow_evidence_authorities
          (authority_id,project_id,big_task_id,plan_revision,candidate_binding,subtask_id,expected_sequence,
           observed_stage,observed_repair_cycles_used,source_type,evidence_kind,outcome,producer,source_reference,occurred_at,recorded_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(aid,...values.slice(0,8),"REPOSITORY_PREFLIGHT",...values.slice(8),before!.initializedAt);
        db.prepare(`INSERT INTO durable_workflow_evidence
          (evidence_id,authority_id,project_id,big_task_id,plan_revision,candidate_binding,subtask_id,expected_sequence,
           observed_stage,observed_repair_cycles_used,evidence_kind,outcome,producer,source_reference,occurred_at,accepted_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(governedStableId("wfe",aid),aid,...values,before!.initializedAt);
        if (predecessor === "STEP_8D_HARDENED") {
          db.prepare("INSERT INTO governed_gate_sources (authority_id, source_type, source_reference, payload) VALUES (?, ?, ?, ?)")
            .run(aid,"REPOSITORY_PREFLIGHT",source,JSON.stringify(values));
        }
        db.close();
      }

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      if (legacy) expect(() => storage.getDurableWorkflowControlView(subtaskId)).toThrow(/malformed/u);
      else expect(storage.getDurableWorkflowControlView(subtaskId)).toEqual(before);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const table of governedTables) {
        expect(
          sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: table === "governed_gate_sources" && predecessor === "STEP_8D_HARDENED" ? 1 : 0 });
      }
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get(),
      ).toEqual({ count: 20 });
      sqlite.close();

      storage = openTaskDatabase({ databasePath, clock: fixedClock });
      if (legacy) expect(() => storage.getDurableWorkflowControlView(subtaskId)).toThrow(/malformed/u);
      else expect(storage.getDurableWorkflowControlView(subtaskId)).toEqual(before);
      storage.close();
    });
  });
});
