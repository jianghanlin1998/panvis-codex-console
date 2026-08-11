import { describe, expect, it } from "vitest";

import {
  RepositoryCommitShaSchema,
  SubtaskImplementationCheckpointIdSchema,
  SubtaskImplementationCheckpointSchema,
} from "../src/index.js";

const validCheckpoint = {
  id: "icp_initial_implementation",
  subtaskId: "st_a",
  repositoryCommitSha: "a".repeat(40),
  actorType: "CODEX",
  actorReference: "codex-task-1",
  sourceReference: "task://s1b2a",
  summary: "Initial implementation completed.",
  occurredAt: "2026-08-11T09:00:00+09:00",
} as const;

describe("Subtask Implementation Checkpoint domain contract", () => {
  it("accepts a valid dedicated identifier and rejects invalid cases", () => {
    expect(
      SubtaskImplementationCheckpointIdSchema.parse("icp_initial_implementation"),
    ).toBe("icp_initial_implementation");
    for (const invalid of ["", "icp_", "aud_wrong", "icp", `icp_${"x".repeat(125)}`]) {
      expect(SubtaskImplementationCheckpointIdSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it.each(["a".repeat(40), "0123456789abcdef".repeat(4)])(
    "accepts the lowercase hexadecimal repository SHA %s",
    (repositoryCommitSha) => {
      expect(RepositoryCommitShaSchema.parse(repositoryCommitSha)).toBe(
        repositoryCommitSha,
      );
    },
  );

  it.each([
    "A".repeat(40),
    `${"a".repeat(20)}A${"a".repeat(19)}`,
    `g${"a".repeat(39)}`,
    `${"a".repeat(39)}g`,
    `${"a".repeat(20)}g${"a".repeat(19)}`,
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
    ` ${"a".repeat(40)}`,
    `${"a".repeat(40)} `,
    `\t${"a".repeat(40)}`,
    `${"a".repeat(40)}\r\n`,
    `\u00a0${"a".repeat(40)}`,
    `${"a".repeat(20)} ${"a".repeat(19)}`,
    `${"a".repeat(20)}\0${"a".repeat(19)}`,
    `${"a".repeat(20)}\u0001${"a".repeat(19)}`,
  ])("rejects the invalid repository SHA %#", (repositoryCommitSha) => {
    expect(RepositoryCommitShaSchema.safeParse(repositoryCommitSha).success).toBe(false);
  });

  it.each(["HUMAN", "CODEX", "SYSTEM"] as const)(
    "accepts the closed %s actor type",
    (actorType) => {
      expect(
        SubtaskImplementationCheckpointSchema.parse({
          ...validCheckpoint,
          actorType,
        }).actorType,
      ).toBe(actorType);
    },
  );

  it("trims compact text and enforces exact UTF-16 code-unit boundaries", () => {
    expect(
      SubtaskImplementationCheckpointSchema.parse({
        ...validCheckpoint,
        actorReference: "  actor  ",
        sourceReference: "  source  ",
        summary: "  summary  ",
      }),
    ).toMatchObject({
      actorReference: "actor",
      sourceReference: "source",
      summary: "summary",
    });

    expect(
      SubtaskImplementationCheckpointSchema.safeParse({
        ...validCheckpoint,
        actorReference: "x".repeat(256),
        sourceReference: "x".repeat(2_048),
        summary: "x".repeat(1_000),
      }).success,
    ).toBe(true);
    for (const input of [
      { actorReference: "x".repeat(257) },
      { sourceReference: "x".repeat(2_049) },
      { summary: "x".repeat(1_001) },
      { actorReference: "   " },
      { sourceReference: "   " },
      { summary: "   " },
    ]) {
      expect(
        SubtaskImplementationCheckpointSchema.safeParse({
          ...validCheckpoint,
          ...input,
        }).success,
      ).toBe(false);
    }
  });

  it("uses JavaScript UTF-16 code-unit limits for supplementary Unicode", () => {
    const atBoundary = SubtaskImplementationCheckpointSchema.safeParse({
      ...validCheckpoint,
      actorReference: "🚀".repeat(128),
      sourceReference: "🚀".repeat(1_024),
      summary: "🚀".repeat(500),
    });
    expect(atBoundary.success).toBe(true);

    for (const input of [
      { actorReference: `${"🚀".repeat(127)}abc` },
      { sourceReference: `${"🚀".repeat(1_024)}x` },
      { summary: `${"🚀".repeat(500)}x` },
    ]) {
      expect(
        SubtaskImplementationCheckpointSchema.safeParse({
          ...validCheckpoint,
          ...input,
        }).success,
      ).toBe(false);
    }
  });

  it("applies JavaScript trim semantics without erasing permitted zero-width content", () => {
    expect(
      SubtaskImplementationCheckpointSchema.parse({
        ...validCheckpoint,
        actorReference: "\u00a0actor\u00a0",
        sourceReference: "\r\nsource\t",
        summary: " e\u0301 ",
      }),
    ).toMatchObject({
      actorReference: "actor",
      sourceReference: "source",
      summary: "e\u0301",
    });
    expect(
      SubtaskImplementationCheckpointSchema.parse({
        ...validCheckpoint,
        summary: "\u200b",
      }).summary,
    ).toBe("\u200b");
  });

  it("keeps identifier boundaries and permitted Unicode explicit", () => {
    expect(
      SubtaskImplementationCheckpointIdSchema.parse(`icp_${"x".repeat(124)}`),
    ).toHaveLength(128);
    expect(SubtaskImplementationCheckpointIdSchema.parse("icp_実装🚀")).toBe(
      "icp_実装🚀",
    );
    for (const invalid of [
      "icp_",
      `icp_${"x".repeat(125)}`,
      "icp_   ",
    ]) {
      expect(
        SubtaskImplementationCheckpointIdSchema.safeParse(invalid).success,
      ).toBe(false);
    }
    expect(SubtaskImplementationCheckpointIdSchema.parse(" icp_trimmed ")).toBe(
      "icp_trimmed",
    );
  });

  it("allows an omitted actor reference", () => {
    const { actorReference, ...withoutActorReference } = validCheckpoint;
    expect(actorReference).toBe("codex-task-1");
    expect(
      SubtaskImplementationCheckpointSchema.parse(withoutActorReference),
    ).not.toHaveProperty("actorReference");
  });

  it("normalizes valid offset-aware timestamps to canonical UTC", () => {
    expect(
      SubtaskImplementationCheckpointSchema.parse(validCheckpoint).occurredAt,
    ).toBe("2026-08-11T00:00:00.000Z");
    expect(
      SubtaskImplementationCheckpointSchema.safeParse({
        ...validCheckpoint,
        occurredAt: "2026-08-11T00:00:00",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed IDs, actor types, and excess fields strictly", () => {
    expect(
      SubtaskImplementationCheckpointSchema.safeParse({
        ...validCheckpoint,
        id: "aud_wrong",
      }).success,
    ).toBe(false);
    expect(
      SubtaskImplementationCheckpointSchema.safeParse({
        ...validCheckpoint,
        subtaskId: "bt_wrong",
      }).success,
    ).toBe(false);
    expect(
      SubtaskImplementationCheckpointSchema.safeParse({
        ...validCheckpoint,
        actorType: "AGENT",
      }).success,
    ).toBe(false);
    expect(
      SubtaskImplementationCheckpointSchema.safeParse({
        ...validCheckpoint,
        metadata: {},
      }).success,
    ).toBe(false);
  });
});
