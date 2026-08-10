import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  DurableTaskSchema,
  ProjectSchema,
  SubtaskCreateInputSchema,
  SubtaskMaturitySchema,
  SubtaskSchema,
} from "../src/index.js";

const validProject = {
  recordType: "PROJECT",
  id: "prj_console",
  name: "Codex Task Console",
  slug: "codex-task-console",
  repository: { kind: "PATH", path: "/workspace/panvis-codex-console" },
  defaultBranch: "main",
  maxActiveCodingSubtasks: 2,
} as const;

const validBigTask = {
  recordType: "BIG_TASK",
  id: "bt_v1",
  projectId: "prj_console",
  title: "Codex Task Console V1",
  goal: "Build the bounded V1 workbench.",
  rationale: "Give Codex work deterministic task boundaries.",
  scopeIn: ["Foundation"],
  scopeOut: ["Cloud hosting"],
  acceptanceCriteria: ["Contracts are deterministic"],
  status: "IN_PROGRESS",
} as const;

const validSubtask = {
  recordType: "SUBTASK",
  id: "st_s0a",
  bigTaskId: "bt_v1",
  title: "S0A",
  goal: "Create core domain contracts.",
  scopeIn: ["Schemas"],
  scopeOut: ["Storage"],
  acceptanceCriteria: ["All deterministic tests pass"],
  untouchedAreas: ["Panvis"],
  status: "TODO",
  maturity: "NOT_STARTED",
  startPolicy: "MANUAL",
  delegationPolicy: "NONE",
  recommendedReasoningLevel: "HIGH",
  promptSeed: "Implement the approved S0A domain foundation.",
} as const;

describe("task schemas", () => {
  it("parses a valid Project", () => {
    expect(ProjectSchema.parse(validProject).id).toBe("prj_console");
  });

  it("parses a valid Big Task", () => {
    expect(BigTaskSchema.parse(validBigTask).id).toBe("bt_v1");
  });

  it("parses a valid Subtask", () => {
    expect(SubtaskSchema.parse(validSubtask).promptSeed).toBe(validSubtask.promptSeed);
  });

  it("defines exactly four explicit Subtask maturity values", () => {
    expect(SubtaskMaturitySchema.options).toEqual([
      "NOT_STARTED",
      "IMPLEMENTED",
      "HARDENED",
      "ACCEPTED",
    ]);
    expect(SubtaskMaturitySchema.safeParse("DONE").success).toBe(false);
  });

  it("requires explicit maturity independently of board status", () => {
    const withoutMaturity: Record<string, unknown> = { ...validSubtask };
    delete withoutMaturity.maturity;
    expect(SubtaskSchema.safeParse(withoutMaturity).success).toBe(false);
    expect(SubtaskSchema.parse({ ...validSubtask, status: "DONE" }).maturity).toBe(
      "NOT_STARTED",
    );
    expect(
      SubtaskSchema.parse({ ...validSubtask, status: "TODO", maturity: "ACCEPTED" })
        .maturity,
    ).toBe("ACCEPTED");
  });

  it("limits the Subtask creation contract to NOT_STARTED maturity", () => {
    expect(SubtaskCreateInputSchema.parse(validSubtask).maturity).toBe("NOT_STARTED");
    for (const maturity of ["IMPLEMENTED", "HARDENED", "ACCEPTED"] as const) {
      expect(
        SubtaskCreateInputSchema.safeParse({ ...validSubtask, maturity }).success,
      ).toBe(false);
    }
  });

  it("rejects an invalid task status", () => {
    expect(SubtaskSchema.safeParse({ ...validSubtask, status: "BLOCKED" }).success).toBe(false);
  });

  it("rejects an unsupported start policy", () => {
    expect(SubtaskSchema.safeParse({ ...validSubtask, startPolicy: "AUTOMATIC" }).success).toBe(
      false,
    );
  });

  it("rejects an unsupported delegation policy", () => {
    expect(
      SubtaskSchema.safeParse({ ...validSubtask, delegationPolicy: "WRITE_IMPLEMENTATION" })
        .success,
    ).toBe(false);
  });

  it("does not parse a native subagent as a durable task", () => {
    const nativeSubagent = {
      recordType: "NATIVE_SUBAGENT",
      childThreadId: "thr_child",
      owningSubtaskId: "st_s0a",
    };

    expect(DurableTaskSchema.safeParse(nativeSubagent).success).toBe(false);
  });
});
