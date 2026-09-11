import { describe, expect, it } from "vitest";
import { CONSOLE_DISCUSSION_OUTPUT_SCHEMA, ConsoleDiscussionAnswerSchema } from "../src/console-workspace.js";

describe("Console discussion structured-output contract", () => {
  it("uses the provider-supported object/anyOf subset including nested action scopes", () => {
    let unions = 0;
    function check(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(check); return; }
      if (!value || typeof value !== "object") return;
      const schema = value as Record<string, unknown>;
      expect(schema).not.toHaveProperty("oneOf");
      if (schema.anyOf) unions++;
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties as object));
      }
      Object.values(schema).forEach(check);
    }
    expect(CONSOLE_DISCUSSION_OUTPUT_SCHEMA.type).toBe("object");
    check(CONSOLE_DISCUSSION_OUTPUT_SCHEMA);
    expect(unions).toBeGreaterThanOrEqual(3);
    const actions = (CONSOLE_DISCUSSION_OUTPUT_SCHEMA.properties!.actions as { items: { anyOf: Array<{ properties: { kind: { const: string } } }> } }).items;
    expect(actions.anyOf.map(branch => branch.properties.kind.const)).toEqual(["RECOVER_TASK", "CONFIRM_DRAFT", "APPROVE_PLAN", "ADVANCE_TASK", "PAUSE_TASK", "AMEND_PLAN_REVIEW", "CREATE_TASK", "SET_REVIEW_LEVEL"]);
  });
  it("preserves local validation and exact action kinds after changing only the provider schema representation", () => {
    const base = { reply: "Draft only", proposal: null };
    const valid = { kind: "SET_REVIEW_LEVEL", scope: { kind: "PROJECT", id: "prj_schema_test" }, expectedRevision: 0, reviewLevel: "LIGHT" };
    expect(ConsoleDiscussionAnswerSchema.safeParse({ ...base, actions: [valid] }).success).toBe(true);
    for (const action of [{ ...valid, kind: "APPROVE_EXECUTION" }, { ...valid, scope: { kind: "PROJECT", id: "bt_wrong_kind" } },
      { ...valid, unexpected: true }]) expect(ConsoleDiscussionAnswerSchema.safeParse({ ...base, actions: [action] }).success).toBe(false);
  });
});
