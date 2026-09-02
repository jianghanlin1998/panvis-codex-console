import { describe, expect, it } from "vitest";

import { TaskContractV0Schema } from "../src/index.js";

const validTaskContract = () => ({
  taskContractRef: "contracts/st_authority-v1",
  projectId: "prj_authority",
  bigTaskId: "bt_authority",
  subtaskId: "st_authority",
  title: "Immutable Task Contract authority",
  goal: "Preserve exact executable intent.",
  scopeIn: ["Domain contract", "Durable persistence"],
  scopeOut: [],
  acceptanceCriteria: ["The exact contract round-trips."],
  untouchedAreas: [],
  promptSeed: "Implement only the approved bounded intent.",
  startPolicy: "MANUAL" as const,
  delegationPolicy: "READ_ONLY_AUXILIARY" as const,
  recommendedReasoningLevel: "HIGH" as const,
});

describe("TaskContractV0Schema", () => {
  it("accepts exactly the Planner-owned immutable content shape", () => {
    expect(TaskContractV0Schema.parse(validTaskContract())).toEqual(
      validTaskContract(),
    );
    for (const forbidden of [
      "status",
      "maturity",
      "profile",
      "writeEnabled",
      "provider",
      "worktree",
      "executionStage",
      "qaState",
      "runtimeState",
    ]) {
      expect(
        TaskContractV0Schema.safeParse({
          ...validTaskContract(),
          [forbidden]: "FORBIDDEN",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects every missing field and every unknown key", () => {
    for (const key of Object.keys(validTaskContract())) {
      const input: Record<string, unknown> = { ...validTaskContract() };
      delete input[key];
      expect(TaskContractV0Schema.safeParse(input).success).toBe(false);
    }
    expect(
      TaskContractV0Schema.safeParse({ ...validTaskContract(), unknown: true })
        .success,
    ).toBe(false);
  });

  it("preserves Subtask list cardinality semantics", () => {
    expect(
      TaskContractV0Schema.safeParse({ ...validTaskContract(), scopeIn: [] })
        .success,
    ).toBe(false);
    expect(
      TaskContractV0Schema.safeParse({
        ...validTaskContract(),
        acceptanceCriteria: [],
      }).success,
    ).toBe(false);
    expect(
      TaskContractV0Schema.safeParse({
        ...validTaskContract(),
        scopeOut: [],
        untouchedAreas: [],
      }).success,
    ).toBe(true);
  });

  it("requires canonical exact identifiers and the accepted opaque ref boundary", () => {
    for (const mutation of [
      { projectId: " prj_authority " },
      { bigTaskId: "bt_" },
      { subtaskId: "wrong_authority" },
      { taskContractRef: " contracts/st_authority-v1 " },
      { taskContractRef: "" },
      { taskContractRef: "x".repeat(1_001) },
    ]) {
      expect(
        TaskContractV0Schema.safeParse({ ...validTaskContract(), ...mutation })
          .success,
      ).toBe(false);
    }
    expect(
      TaskContractV0Schema.parse({
        ...validTaskContract(),
        taskContractRef: "looks/like/a/path-or-url:https://example.invalid/x",
      }).taskContractRef,
    ).toBe("looks/like/a/path-or-url:https://example.invalid/x");
  });

  it("enforces the exact existing policy enums", () => {
    for (const mutation of [
      { startPolicy: "AUTOMATIC" },
      { delegationPolicy: "WRITE_IMPLEMENTATION" },
      { recommendedReasoningLevel: "ULTRA" },
    ]) {
      expect(
        TaskContractV0Schema.safeParse({ ...validTaskContract(), ...mutation })
          .success,
      ).toBe(false);
    }
  });

  it("rejects every C0, DEL/C1 code point in every durable text position", () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ];
    for (const codePoint of controls) {
      const text = `before${String.fromCodePoint(codePoint)}after`;
      for (const mutation of [
        { taskContractRef: text },
        { title: text },
        { goal: text },
        { scopeIn: [text] },
        { scopeOut: [text] },
        { acceptanceCriteria: [text] },
        { untouchedAreas: [text] },
        { promptSeed: text },
      ]) {
        expect(
          TaskContractV0Schema.safeParse({ ...validTaskContract(), ...mutation })
            .success,
        ).toBe(false);
      }
    }
  });

  it("rejects malformed UTF-16 without stripping or replacement", () => {
    for (const malformed of [
      "\ud800",
      "\udc00",
      "before\ud800after",
      "before\udc00after",
    ]) {
      expect(
        TaskContractV0Schema.safeParse({
          ...validTaskContract(),
          promptSeed: malformed,
        }).success,
      ).toBe(false);
    }
  });

  it("preserves composed/decomposed multilingual content exactly", () => {
    const composed = TaskContractV0Schema.parse({
      ...validTaskContract(),
      title: "任务 café 😀",
    });
    const decomposed = TaskContractV0Schema.parse({
      ...validTaskContract(),
      title: "任务 cafe\u0301 😀",
    });
    expect(composed.title).toBe("任务 café 😀");
    expect(decomposed.title).toBe("任务 cafe\u0301 😀");
    expect(composed.title).not.toBe(decomposed.title);
  });

  it("does not invent arbitrary Task Contract content size limits", () => {
    const large = "x".repeat(20_000);
    expect(
      TaskContractV0Schema.parse({ ...validTaskContract(), promptSeed: large })
        .promptSeed,
    ).toHaveLength(20_000);
  });

  it("detaches inputs and exposes a transitively immutable value", () => {
    const input = validTaskContract();
    const parsed = TaskContractV0Schema.parse(input);
    input.scopeIn.push("Late mutation");
    expect(parsed.scopeIn).toEqual(["Domain contract", "Durable persistence"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scopeIn)).toBe(true);
    expect(Object.isFrozen(parsed.scopeOut)).toBe(true);
    expect(Object.isFrozen(parsed.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(parsed.untouchedAreas)).toBe(true);
  });
});
