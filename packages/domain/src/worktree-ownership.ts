import { z } from "zod";

import {
  ProjectIdSchema,
  SubtaskIdSchema,
  WorktreeOwnershipIdSchema,
} from "./identifiers.js";
import { RepositoryCommitShaSchema } from "./implementation-checkpoint.js";

const canonicalTimestamp = z
  .iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const WorktreeOwnershipStatusSchema = z.enum([
  "PROVISIONING",
  "ACTIVE",
  "RELEASING",
  "RELEASED",
  "FAILED",
]);

export const WorktreeOwnershipPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !/[\0\r\n]/.test(value));

export const WorktreeOwnershipBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^ctc\/worktree\/wt_[0-9a-f]{32}$/);

export const WorktreeOwnershipSchema = z
  .object({
    id: WorktreeOwnershipIdSchema,
    projectId: ProjectIdSchema,
    subtaskId: SubtaskIdSchema,
    status: WorktreeOwnershipStatusSchema,
    worktreePath: WorktreeOwnershipPathSchema,
    branchName: WorktreeOwnershipBranchSchema,
    startingCommitSha: RepositoryCommitShaSchema,
    releaseHeadSha: RepositoryCommitShaSchema.nullable(),
    createdAt: canonicalTimestamp,
    activatedAt: canonicalTimestamp.nullable(),
    releaseStartedAt: canonicalTimestamp.nullable(),
    releasedAt: canonicalTimestamp.nullable(),
    updatedAt: canonicalTimestamp,
  })
  .strict()
  .superRefine((ownership, context) => {
    if (ownership.branchName !== `ctc/worktree/${ownership.id}`) {
      context.addIssue({
        code: "custom",
        message: "The worktree branch must be derived from its ownership ID.",
        path: ["branchName"],
      });
    }

    const created = Date.parse(ownership.createdAt);
    const updated = Date.parse(ownership.updatedAt);
    const activated =
      ownership.activatedAt === null ? null : Date.parse(ownership.activatedAt);
    const releaseStarted =
      ownership.releaseStartedAt === null
        ? null
        : Date.parse(ownership.releaseStartedAt);
    const released =
      ownership.releasedAt === null ? null : Date.parse(ownership.releasedAt);
    const invalidLifecycle = (): void => {
      context.addIssue({
        code: "custom",
        message: "The worktree ownership lifecycle fields are inconsistent.",
        path: ["status"],
      });
    };

    switch (ownership.status) {
      case "PROVISIONING":
        if (
          ownership.activatedAt !== null ||
          ownership.releaseStartedAt !== null ||
          ownership.releasedAt !== null ||
          ownership.releaseHeadSha !== null ||
          updated !== created
        ) {
          invalidLifecycle();
        }
        break;
      case "FAILED":
        if (
          ownership.activatedAt !== null ||
          ownership.releaseStartedAt !== null ||
          ownership.releasedAt !== null ||
          ownership.releaseHeadSha !== null ||
          updated < created
        ) {
          invalidLifecycle();
        }
        break;
      case "ACTIVE":
        if (
          activated === null ||
          ownership.releaseStartedAt !== null ||
          ownership.releasedAt !== null ||
          ownership.releaseHeadSha !== null ||
          activated < created ||
          updated !== activated
        ) {
          invalidLifecycle();
        }
        break;
      case "RELEASING":
        if (
          activated === null ||
          releaseStarted === null ||
          ownership.releasedAt !== null ||
          ownership.releaseHeadSha === null ||
          activated < created ||
          releaseStarted < activated ||
          updated !== releaseStarted
        ) {
          invalidLifecycle();
        }
        break;
      case "RELEASED":
        if (
          activated === null ||
          releaseStarted === null ||
          released === null ||
          ownership.releaseHeadSha === null ||
          activated < created ||
          releaseStarted < activated ||
          released < releaseStarted ||
          updated !== released
        ) {
          invalidLifecycle();
        }
        break;
    }
  });

export type WorktreeOwnershipStatus = z.infer<
  typeof WorktreeOwnershipStatusSchema
>;
export type WorktreeOwnership = z.infer<typeof WorktreeOwnershipSchema>;
