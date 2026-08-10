import { describe, expect, it } from "vitest";

import {
  AuditEventSchema,
  AuditEventTypeSchema,
  ContextDigestSchema,
} from "../src/index.js";

const projectScope = {
  scopeType: "PROJECT",
  projectId: "prj_hardening",
} as const;

const bigTaskScope = {
  scopeType: "BIG_TASK",
  projectId: "prj_hardening",
  bigTaskId: "bt_hardening",
} as const;

const subtaskScope = {
  scopeType: "SUBTASK",
  projectId: "prj_hardening",
  bigTaskId: "bt_hardening",
  subtaskId: "st_hardening",
} as const;

const digestInput = {
  id: "dgt_hardening",
  scope: projectScope,
  body: "Current derived state.",
  provenance: {
    sourceType: "SYSTEM",
    sourceReference: "hardening#digest",
    effectiveAt: "2026-08-10T00:00:00.000Z",
  },
} as const;

const auditInput = {
  id: "aud_hardening",
  scope: projectScope,
  eventType: "TASK_REVIEWED",
  actorType: "SYSTEM",
  actorReference: "system:hardening",
  summary: "Reviewed persisted state.",
  subjectReference: "dgt_hardening",
  occurredAt: "2026-08-10T00:00:00.000Z",
} as const;

describe("S0B2b Context Digest domain hardening", () => {
  it.each([projectScope, bigTaskScope, subtaskScope])(
    "accepts canonical $scopeType exact scope",
    (scope) => {
      expect(ContextDigestSchema.parse({ ...digestInput, scope }).scope).toEqual(scope);
    },
  );

  it.each([
    ["one code unit", "x", true],
    ["exactly 8,000 code units", "x".repeat(8_000), true],
    ["8,001 code units", "x".repeat(8_001), false],
    ["Chinese", "上下文摘要", true],
    ["Japanese", "コンテキスト要約", true],
    ["Korean", "컨텍스트 요약", true],
    ["accented Latin", "Résumé déjà vu", true],
    ["combining Unicode", "e\u0301vidence", true],
    ["emoji within UTF-16 limit", "🚀".repeat(4_000), true],
    ["emoji beyond UTF-16 limit", "🚀".repeat(4_001), false],
    ["mixed scripts", "Evidence 証拠 증거 🚀", true],
    ["internal tab", "left\tright", true],
    ["internal line break", "line one\nline two", true],
    ["whitespace only", " \t\n ", false],
  ] as const)("handles $0 body", (_label, body, accepted) => {
    expect(ContextDigestSchema.safeParse({ ...digestInput, body }).success).toBe(
      accepted,
    );
  });

  it("canonicalizes ordinary, tab, and line-break padding without mutating input", () => {
    const input = {
      ...digestInput,
      body: " \tDerived state.\n ",
      provenance: {
        ...digestInput.provenance,
        sourceReference: " \trepository#digest\n ",
      },
    };
    const snapshot = structuredClone(input);

    expect(ContextDigestSchema.parse(input)).toMatchObject({
      body: "Derived state.",
      provenance: { sourceReference: "repository#digest" },
    });
    expect(input).toEqual(snapshot);
  });

  it.each([
    ["exact source reference maximum", "x".repeat(2_048), true],
    ["source reference maximum plus one", "x".repeat(2_049), false],
  ] as const)("enforces $0", (_label, sourceReference, accepted) => {
    expect(
      ContextDigestSchema.safeParse({
        ...digestInput,
        provenance: { ...digestInput.provenance, sourceReference },
      }).success,
    ).toBe(accepted);
  });

  it.each([
    ["canonical Z", "2026-08-10T00:00:00Z", "2026-08-10T00:00:00.000Z"],
    ["positive offset", "2026-08-10T09:00:00+09:00", "2026-08-10T00:00:00.000Z"],
    ["negative offset", "2026-08-09T19:00:00-05:00", "2026-08-10T00:00:00.000Z"],
    ["subsecond precision", "2026-08-10T00:00:00.1234Z", "2026-08-10T00:00:00.123Z"],
  ] as const)("normalizes $0 effectiveAt", (_label, effectiveAt, expected) => {
    expect(
      ContextDigestSchema.parse({
        ...digestInput,
        provenance: { ...digestInput.provenance, effectiveAt },
      }).provenance.effectiveAt,
    ).toBe(expected);
  });

  it.each([
    ["invalid time", "not-a-time"],
    ["missing offset", "2026-08-10T00:00:00"],
  ] as const)("rejects $0", (_label, effectiveAt) => {
    expect(
      ContextDigestSchema.safeParse({
        ...digestInput,
        provenance: { ...digestInput.provenance, effectiveAt },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["unknown root key", { ...digestInput, extra: true }],
    [
      "unknown provenance key",
      { ...digestInput, provenance: { ...digestInput.provenance, revision: 1 } },
    ],
    [
      "Project scope with Big Task",
      { ...digestInput, scope: { ...projectScope, bigTaskId: "bt_hardening" } },
    ],
    [
      "Big Task scope without Big Task",
      { ...digestInput, scope: { scopeType: "BIG_TASK", projectId: "prj_hardening" } },
    ],
    [
      "Subtask scope without Big Task",
      {
        ...digestInput,
        scope: {
          scopeType: "SUBTASK",
          projectId: "prj_hardening",
          subtaskId: "st_hardening",
        },
      },
    ],
    ["wrong identifier prefix", { ...digestInput, id: "ctx_hardening" }],
    ["empty Digest suffix", { ...digestInput, id: "dgt_" }],
  ] as const)("rejects $0", (_label, input) => {
    expect(ContextDigestSchema.safeParse(input).success).toBe(false);
  });
});

describe("S0B2b Audit Event domain hardening", () => {
  it.each(["HUMAN", "CODEX", "SYSTEM"] as const)(
    "accepts %s actor",
    (actorType) => {
      expect(AuditEventSchema.parse({ ...auditInput, actorType }).actorType).toBe(
        actorType,
      );
    },
  );

  it.each([projectScope, bigTaskScope, subtaskScope])(
    "accepts canonical $scopeType exact scope",
    (scope) => {
      expect(AuditEventSchema.parse({ ...auditInput, scope }).scope).toEqual(scope);
    },
  );

  it.each([
    ["one uppercase letter", "A", true],
    ["64 characters", `A${"1".repeat(63)}`, true],
    ["65 characters", `A${"1".repeat(64)}`, false],
    ["uppercase", "TASK_CREATED", true],
    ["digits", "TASK_123", true],
    ["underscores", "TASK__CREATED", true],
    ["lowercase", "task_created", false],
    ["hyphen", "TASK-CREATED", false],
    ["space", "TASK CREATED", false],
    ["leading digit", "1_TASK", false],
    ["Unicode letter", "ÉVENT", false],
    ["newline", "TASK\nCREATED", false],
    ["tab", "TASK\tCREATED", false],
  ] as const)("handles $0 event type", (_label, eventType, accepted) => {
    expect(AuditEventTypeSchema.safeParse(eventType).success).toBe(accepted);
  });

  it("normalizes padded eventType and compact optional text", () => {
    expect(
      AuditEventSchema.parse({
        ...auditInput,
        eventType: " TASK_REVIEWED ",
        actorReference: " actor ",
        summary: " summary ",
        subjectReference: " subject ",
      }),
    ).toMatchObject({
      eventType: "TASK_REVIEWED",
      actorReference: "actor",
      summary: "summary",
      subjectReference: "subject",
    });
  });

  it.each([
    ["actor absent", undefined, "actorReference", true],
    ["actor one", "x", "actorReference", true],
    ["actor maximum", "x".repeat(256), "actorReference", true],
    ["actor over maximum", "x".repeat(257), "actorReference", false],
    ["actor whitespace", " \t ", "actorReference", false],
    ["subject absent", undefined, "subjectReference", true],
    ["subject one", "x", "subjectReference", true],
    ["subject maximum", "x".repeat(512), "subjectReference", true],
    ["subject over maximum", "x".repeat(513), "subjectReference", false],
    ["subject whitespace", " \n ", "subjectReference", false],
  ] as const)("handles $0", (_label, value, field, accepted) => {
    const input = { ...auditInput, [field]: value };
    expect(AuditEventSchema.safeParse(input).success).toBe(accepted);
  });

  it.each([
    ["one code unit", "x", true],
    ["exact maximum", "x".repeat(1_000), true],
    ["maximum plus one", "x".repeat(1_001), false],
    ["CJK and accented", "审计 監査 감사 Résumé", true],
    ["combining Unicode", "e\u0301vidence", true],
    ["emoji within UTF-16 limit", "🚀".repeat(500), true],
    ["emoji beyond UTF-16 limit", "🚀".repeat(501), false],
    ["internal newline", "first\nsecond", true],
    ["whitespace only", " \t\n ", false],
  ] as const)("handles $0 summary", (_label, summary, accepted) => {
    expect(AuditEventSchema.safeParse({ ...auditInput, summary }).success).toBe(
      accepted,
    );
  });

  it.each([
    ["canonical Z", "2026-08-10T00:00:00Z", "2026-08-10T00:00:00.000Z"],
    ["positive offset", "2026-08-10T09:00:00+09:00", "2026-08-10T00:00:00.000Z"],
    ["negative offset", "2026-08-09T19:00:00-05:00", "2026-08-10T00:00:00.000Z"],
    ["subsecond", "2026-08-10T00:00:00.9876Z", "2026-08-10T00:00:00.987Z"],
  ] as const)("normalizes $0 occurredAt", (_label, occurredAt, expected) => {
    expect(
      AuditEventSchema.parse({ ...auditInput, occurredAt }).occurredAt,
    ).toBe(expected);
  });

  it.each([
    ["invalid time", { ...auditInput, occurredAt: "invalid" }],
    ["wrong identifier", { ...auditInput, id: "dgt_wrong" }],
    ["unknown key", { ...auditInput, payload: {} }],
    ["invalid actor", { ...auditInput, actorType: "PROVIDER" }],
    [
      "malformed Subtask scope",
      {
        ...auditInput,
        scope: {
          scopeType: "SUBTASK",
          projectId: "prj_hardening",
          subtaskId: "st_hardening",
        },
      },
    ],
  ] as const)("rejects $0", (_label, input) => {
    expect(AuditEventSchema.safeParse(input).success).toBe(false);
  });
});
