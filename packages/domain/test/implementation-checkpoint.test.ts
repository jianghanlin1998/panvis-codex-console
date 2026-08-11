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
    `${"a".repeat(39)}g`,
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
    ` ${"a".repeat(40)}`,
    `${"a".repeat(40)} `,
    `${"a".repeat(20)} ${"a".repeat(19)}`,
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
