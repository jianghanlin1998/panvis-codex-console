import { describe, expect, it } from "vitest";

import {
  SubtaskCreateInputSchema,
  TaskContractV0Schema,
} from "../src/index.js";

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
      "stage",
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

  it("maps every policy variant losslessly to the future canonical Subtask shape", () => {
    const startPolicies = ["MANUAL", "WHEN_READY"] as const;
    const delegationPolicies = [
      "NONE",
      "READ_ONLY_AUXILIARY",
      "REVIEW_ONLY",
    ] as const;
    const reasoningLevels = ["LOW", "MEDIUM", "HIGH", "XHIGH"] as const;

    for (const startPolicy of startPolicies) {
      for (const delegationPolicy of delegationPolicies) {
        for (const recommendedReasoningLevel of reasoningLevels) {
          const contract = TaskContractV0Schema.parse({
            ...validTaskContract(),
            title: "任务 تخطيط 日本語 👩‍💻 e\u0301",
            scopeOut: [],
            untouchedAreas: [],
            startPolicy,
            delegationPolicy,
            recommendedReasoningLevel,
          });
          const canonical = SubtaskCreateInputSchema.parse({
            recordType: "SUBTASK",
            id: contract.subtaskId,
            bigTaskId: contract.bigTaskId,
            title: contract.title,
            goal: contract.goal,
            scopeIn: contract.scopeIn,
            scopeOut: contract.scopeOut,
            acceptanceCriteria: contract.acceptanceCriteria,
            untouchedAreas: contract.untouchedAreas,
            status: "TODO",
            maturity: "NOT_STARTED",
            startPolicy: contract.startPolicy,
            delegationPolicy: contract.delegationPolicy,
            recommendedReasoningLevel: contract.recommendedReasoningLevel,
            promptSeed: contract.promptSeed,
          });

          expect(canonical).toEqual({
            recordType: "SUBTASK",
            id: contract.subtaskId,
            bigTaskId: contract.bigTaskId,
            title: contract.title,
            goal: contract.goal,
            scopeIn: contract.scopeIn,
            scopeOut: contract.scopeOut,
            acceptanceCriteria: contract.acceptanceCriteria,
            untouchedAreas: contract.untouchedAreas,
            status: "TODO",
            maturity: "NOT_STARTED",
            startPolicy,
            delegationPolicy,
            recommendedReasoningLevel,
            promptSeed: contract.promptSeed,
          });
        }
      }
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

  it("preserves authoritative list order and duplicate entries exactly", () => {
    const parsed = TaskContractV0Schema.parse({
      ...validTaskContract(),
      scopeIn: ["second", "first", "second"],
      scopeOut: ["out-b", "out-a"],
      acceptanceCriteria: ["accept-b", "accept-a", "accept-b"],
      untouchedAreas: ["untouched-b", "untouched-a"],
    });
    expect(parsed.scopeIn).toEqual(["second", "first", "second"]);
    expect(parsed.scopeOut).toEqual(["out-b", "out-a"]);
    expect(parsed.acceptanceCriteria).toEqual([
      "accept-b",
      "accept-a",
      "accept-b",
    ]);
    expect(parsed.untouchedAreas).toEqual(["untouched-b", "untouched-a"]);
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

  it("preserves opaque reference forms and enforces the UTF-16 unit boundary", () => {
    for (const taskContractRef of [
      "contracts/example.md",
      "../somewhere",
      "/absolute-looking/value",
      "https://example.invalid/contract",
      "urn:example:value",
      "任意の不透明な参照😀",
    ]) {
      expect(
        TaskContractV0Schema.parse({
          ...validTaskContract(),
          taskContractRef,
        }).taskContractRef,
      ).toBe(taskContractRef);
    }
    for (const length of [999, 1_000]) {
      expect(
        TaskContractV0Schema.parse({
          ...validTaskContract(),
          taskContractRef: "x".repeat(length),
        }).taskContractRef,
      ).toHaveLength(length);
    }
    expect(
      TaskContractV0Schema.safeParse({
        ...validTaskContract(),
        taskContractRef: "x".repeat(1_001),
      }).success,
    ).toBe(false);
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

  it("rejects ECMAScript-trim boundary whitespace without transforming content", () => {
    for (const whitespace of [" ", "\t", "\n", "\u00a0", "\ufeff", "\u3000"]) {
      for (const title of [`${whitespace}value`, `value${whitespace}`]) {
        expect(
          TaskContractV0Schema.safeParse({ ...validTaskContract(), title })
            .success,
        ).toBe(false);
      }
      const internal = `left${whitespace}right`;
      const parsed = TaskContractV0Schema.safeParse({
        ...validTaskContract(),
        title: internal,
      });
      if (whitespace === "\t" || whitespace === "\n") {
        expect(parsed.success).toBe(false);
      } else {
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.title).toBe(internal);
        }
      }
    }
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
