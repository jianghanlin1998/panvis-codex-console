import { describe, expect, it } from "vitest";

import { ContextDigestSchema } from "../src/index.js";

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

const validDigest = {
  id: "dgt_current",
  scope: scopes[0],
  body: "Current compact context.",
  provenance: {
    sourceType: "SYSTEM",
    sourceReference: "context-engine#current",
    effectiveAt: "2026-08-10T00:00:00Z",
  },
} as const;

describe("Context Digest domain contract", () => {
  it.each(scopes)("accepts the exact $scopeType scope", (scope) => {
    expect(ContextDigestSchema.parse({ ...validDigest, scope }).scope).toEqual(scope);
  });

  it("trims accepted compact body and provenance text", () => {
    expect(
      ContextDigestSchema.parse({
        ...validDigest,
        body: "  compact body  ",
        provenance: {
          ...validDigest.provenance,
          sourceReference: "  source#1  ",
        },
      }),
    ).toMatchObject({
      body: "compact body",
      provenance: { sourceReference: "source#1" },
    });
  });

  it("accepts body values from 1 through 8,000 JavaScript characters", () => {
    expect(ContextDigestSchema.safeParse({ ...validDigest, body: "x" }).success).toBe(true);
    expect(
      ContextDigestSchema.safeParse({ ...validDigest, body: "x".repeat(8_000) }).success,
    ).toBe(true);
    expect(
      ContextDigestSchema.safeParse({ ...validDigest, body: "🚀".repeat(4_000) }).success,
    ).toBe(true);
    expect(
      ContextDigestSchema.safeParse({ ...validDigest, body: "🚀".repeat(4_001) }).success,
    ).toBe(false);
  });

  it("rejects empty and over-maximum bodies without truncation", () => {
    const oversized = "x".repeat(8_001);
    expect(ContextDigestSchema.safeParse({ ...validDigest, body: " \t\n " }).success).toBe(
      false,
    );
    expect(ContextDigestSchema.safeParse({ ...validDigest, body: oversized }).success).toBe(
      false,
    );
    expect(oversized).toHaveLength(8_001);
  });

  it("normalizes offset-aware provenance time to canonical UTC", () => {
    const digest = ContextDigestSchema.parse({
      ...validDigest,
      provenance: {
        ...validDigest.provenance,
        effectiveAt: "2026-08-10T09:00:00+09:00",
      },
    });
    expect(digest.provenance.effectiveAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("enforces digest provenance reference bounds", () => {
    expect(
      ContextDigestSchema.safeParse({
        ...validDigest,
        provenance: {
          ...validDigest.provenance,
          sourceReference: "x".repeat(2_048),
        },
      }).success,
    ).toBe(true);
    expect(
      ContextDigestSchema.safeParse({
        ...validDigest,
        provenance: {
          ...validDigest.provenance,
          sourceReference: "x".repeat(2_049),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed scope shapes and unknown keys strictly", () => {
    expect(
      ContextDigestSchema.safeParse({
        ...validDigest,
        scope: { scopeType: "SUBTASK", projectId: "prj_console", subtaskId: "st_a" },
      }).success,
    ).toBe(false);
    expect(ContextDigestSchema.safeParse({ ...validDigest, metadata: {} }).success).toBe(false);
    expect(ContextDigestSchema.safeParse({ ...validDigest, id: "ctx_wrong" }).success).toBe(
      false,
    );
    expect(
      ContextDigestSchema.safeParse({
        ...validDigest,
        provenance: { ...validDigest.provenance, rawTranscript: "private" },
      }).success,
    ).toBe(false);
  });
});
