import { describe, expect, it } from "vitest";

import {
  WorktreeOwnershipBranchSchema,
  WorktreeOwnershipIdSchema,
  WorktreeOwnershipPathSchema,
  WorktreeOwnershipSchema,
  WorktreeOwnershipStatusSchema,
} from "../src/index.js";

const id = `wt_${"a".repeat(32)}`;
const createdAt = "2026-08-31T00:00:00.000Z";
const activatedAt = "2026-08-31T00:01:00.000Z";
const releaseStartedAt = "2026-08-31T00:02:00.000Z";
const releasedAt = "2026-08-31T00:03:00.000Z";

const base = {
  id,
  projectId: "prj_worktree",
  subtaskId: "st_worktree",
  worktreePath: `/private/console/worktrees/${id}`,
  branchName: `ctc/worktree/${id}`,
  startingCommitSha: "1".repeat(40),
  createdAt,
} as const;

describe("WorktreeOwnership domain contract", () => {
  it("uses a strict internally safe opaque identifier", () => {
    expect(WorktreeOwnershipIdSchema.parse(id)).toBe(id);
    for (const invalid of [
      "wt_short",
      `wt_${"A".repeat(32)}`,
      `wt_${"g".repeat(32)}`,
      `wt_${"a".repeat(31)}`,
      `wt_${"a".repeat(33)}`,
      ` wt_${"a".repeat(32)}`,
      `wt_${"a".repeat(31)}/`,
    ]) {
      expect(WorktreeOwnershipIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("closes the lifecycle state vocabulary", () => {
    expect(WorktreeOwnershipStatusSchema.options).toEqual([
      "PROVISIONING",
      "ACTIVE",
      "RELEASING",
      "RELEASED",
      "FAILED",
    ]);
  });

  it.each([
    {
      status: "PROVISIONING",
      releaseHeadSha: null,
      activatedAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      updatedAt: createdAt,
    },
    {
      status: "ACTIVE",
      releaseHeadSha: null,
      activatedAt,
      releaseStartedAt: null,
      releasedAt: null,
      updatedAt: activatedAt,
    },
    {
      status: "RELEASING",
      releaseHeadSha: "2".repeat(40),
      activatedAt,
      releaseStartedAt,
      releasedAt: null,
      updatedAt: releaseStartedAt,
    },
    {
      status: "RELEASED",
      releaseHeadSha: "2".repeat(40),
      activatedAt,
      releaseStartedAt,
      releasedAt,
      updatedAt: releasedAt,
    },
    {
      status: "FAILED",
      releaseHeadSha: null,
      activatedAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      updatedAt: releasedAt,
    },
  ] as const)("accepts a valid $status lifecycle", (lifecycle) => {
    expect(
      WorktreeOwnershipSchema.parse({ ...base, ...lifecycle }),
    ).toMatchObject(lifecycle);
  });

  it("rejects invalid timestamp/status combinations and branch substitution", () => {
    const validActive = {
      ...base,
      status: "ACTIVE",
      releaseHeadSha: null,
      activatedAt,
      releaseStartedAt: null,
      releasedAt: null,
      updatedAt: activatedAt,
    } as const;
    for (const invalid of [
      { ...validActive, activatedAt: null },
      { ...validActive, releaseHeadSha: "2".repeat(40) },
      { ...validActive, updatedAt: releaseStartedAt },
      { ...validActive, activatedAt: "2026-08-30T23:59:00.000Z" },
      { ...validActive, branchName: "ctc/worktree/wt_ffffffffffffffffffffffffffffffff" },
      { ...validActive, extra: true },
    ]) {
      expect(WorktreeOwnershipSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("bounds paths, branches, and commit SHAs", () => {
    expect(WorktreeOwnershipPathSchema.safeParse("relative/path").success).toBe(false);
    expect(WorktreeOwnershipPathSchema.safeParse(`/tmp/${"x".repeat(4_092)}`).success).toBe(
      false,
    );
    expect(WorktreeOwnershipPathSchema.safeParse("/tmp/a\0b").success).toBe(false);
    expect(WorktreeOwnershipBranchSchema.parse(`ctc/worktree/${id}`)).toBe(
      `ctc/worktree/${id}`,
    );
    expect(
      WorktreeOwnershipSchema.safeParse({
        ...base,
        status: "PROVISIONING",
        startingCommitSha: "A".repeat(40),
        releaseHeadSha: null,
        activatedAt: null,
        releaseStartedAt: null,
        releasedAt: null,
        updatedAt: createdAt,
      }).success,
    ).toBe(false);
  });
});
