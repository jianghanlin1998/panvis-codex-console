import { z } from "zod";

import { AuditActorTypeSchema } from "./audit.js";
import {
  SubtaskIdSchema,
  SubtaskImplementationCheckpointIdSchema,
} from "./identifiers.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

export const RepositoryCommitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const SubtaskImplementationCheckpointSchema = z
  .object({
    id: SubtaskImplementationCheckpointIdSchema,
    subtaskId: SubtaskIdSchema,
    repositoryCommitSha: RepositoryCommitShaSchema,
    actorType: AuditActorTypeSchema,
    actorReference: compactText(256).optional(),
    sourceReference: compactText(2_048),
    summary: compactText(1_000),
    occurredAt: z
      .iso.datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();

export type RepositoryCommitSha = z.infer<typeof RepositoryCommitShaSchema>;
export type SubtaskImplementationCheckpoint = z.infer<
  typeof SubtaskImplementationCheckpointSchema
>;
