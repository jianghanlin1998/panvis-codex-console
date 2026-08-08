import { z } from "zod";

import { BigTaskIdSchema, ContextItemIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";

const nonEmptyText = z.string().trim().min(1);

export const ContextKindSchema = z.enum([
  "DECISION",
  "REQUIREMENT",
  "CONSTRAINT",
  "ENGINEERING_FACT",
  "OPEN_QUESTION",
  "RISK",
]);
export const ContextStatusSchema = z.enum([
  "PROPOSED",
  "ACTIVE",
  "SUPERSEDED",
  "REJECTED",
  "RESOLVED",
]);
export const ContextAuthoritySchema = z.enum([
  "HUMAN",
  "REPO_EVIDENCE",
  "CODEX_CANDIDATE",
  "SYSTEM",
]);
export const ContextSourceTypeSchema = z.enum([
  "CHAT_MESSAGE",
  "REPO",
  "HANDOFF",
  "IMPORT",
  "MANUAL",
  "SYSTEM",
]);

export const ContextProvenanceSchema = z
  .object({
    sourceType: ContextSourceTypeSchema,
    sourceReference: nonEmptyText,
    effectiveAt: z.iso.datetime({ offset: true }),
    supersedesContextItemId: ContextItemIdSchema.optional(),
  })
  .strict();

export const ContextItemSchema = z
  .object({
    id: ContextItemIdSchema,
    projectId: ProjectIdSchema,
    bigTaskId: BigTaskIdSchema.optional(),
    subtaskId: SubtaskIdSchema.optional(),
    kind: ContextKindSchema,
    status: ContextStatusSchema,
    authority: ContextAuthoritySchema,
    title: nonEmptyText,
    body: nonEmptyText,
    provenance: ContextProvenanceSchema,
  })
  .strict();

export type ContextKind = z.infer<typeof ContextKindSchema>;
export type ContextStatus = z.infer<typeof ContextStatusSchema>;
export type ContextAuthority = z.infer<typeof ContextAuthoritySchema>;
export type ContextSourceType = z.infer<typeof ContextSourceTypeSchema>;
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;
export type ContextItem = z.infer<typeof ContextItemSchema>;
