import { describe, expect, it } from "vitest";

import { AuditEventSchema, AuditEventTypeSchema } from "../src/index.js";

const scopes = [
  { scopeType: "PROJECT", projectId: "prj_console" },
  { scopeType: "BIG_TASK", projectId: "prj_console", bigTaskId: "bt_v1" },
  {
    scopeType: "SUBTASK",
    projectId: "prj_console",
    bigTaskId: "bt_v1",
    subtaskId: "st_a",
  },
] as const;

const validEvent = {
  id: "aud_task_created",
  scope: scopes[0],
  eventType: "TASK_CREATED",
  actorType: "CODEX",
  actorReference: "codex-session-1",
  summary: "Created a durable task.",
  subjectReference: "bt_v1",
  occurredAt: "2026-08-10T00:00:00Z",
} as const;

describe("Audit Event domain contract", () => {
  it.each(["HUMAN", "CODEX", "SYSTEM"] as const)("accepts the %s actor type", (actorType) => {
    expect(AuditEventSchema.parse({ ...validEvent, actorType }).actorType).toBe(actorType);
  });

  it.each(scopes)("accepts the exact $scopeType scope", (scope) => {
    expect(AuditEventSchema.parse({ ...validEvent, scope }).scope).toEqual(scope);
  });

  it("enforces stable event-type slug boundaries", () => {
    expect(AuditEventTypeSchema.safeParse("A").success).toBe(true);
    expect(AuditEventTypeSchema.safeParse(`A${"1".repeat(63)}`).success).toBe(true);
    for (const invalid of ["", "1_EVENT", "task_created", "TASK-CREATED", `A${"1".repeat(64)}`]) {
      expect(AuditEventTypeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("trims compact text and enforces summary and optional-reference bounds", () => {
    expect(
      AuditEventSchema.parse({
        ...validEvent,
        actorReference: "  actor-1  ",
        summary: "  summary  ",
        subjectReference: "  subject-1  ",
      }),
    ).toMatchObject({
      actorReference: "actor-1",
      summary: "summary",
      subjectReference: "subject-1",
    });
    expect(
      AuditEventSchema.safeParse({ ...validEvent, summary: "x".repeat(1_000) }).success,
    ).toBe(true);
    expect(
      AuditEventSchema.safeParse({ ...validEvent, summary: "x".repeat(1_001) }).success,
    ).toBe(false);
    expect(
      AuditEventSchema.safeParse({ ...validEvent, actorReference: "x".repeat(257) }).success,
    ).toBe(false);
    expect(
      AuditEventSchema.safeParse({ ...validEvent, actorReference: "x".repeat(256) }).success,
    ).toBe(true);
    expect(
      AuditEventSchema.safeParse({ ...validEvent, subjectReference: "x".repeat(513) }).success,
    ).toBe(false);
    expect(
      AuditEventSchema.safeParse({ ...validEvent, subjectReference: "x".repeat(512) }).success,
    ).toBe(true);
  });

  it("normalizes occurredAt to canonical UTC", () => {
    expect(
      AuditEventSchema.parse({
        ...validEvent,
        occurredAt: "2026-08-10T09:00:00+09:00",
      }).occurredAt,
    ).toBe("2026-08-10T00:00:00.000Z");
  });

  it("rejects malformed scopes, empty optional values, and unknown keys strictly", () => {
    expect(
      AuditEventSchema.safeParse({
        ...validEvent,
        scope: { scopeType: "SUBTASK", projectId: "prj_console", subtaskId: "st_a" },
      }).success,
    ).toBe(false);
    expect(AuditEventSchema.safeParse({ ...validEvent, actorReference: "   " }).success).toBe(
      false,
    );
    expect(AuditEventSchema.safeParse({ ...validEvent, payload: {} }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...validEvent, id: "dgt_wrong" }).success).toBe(false);
  });
});
