import { z } from "zod";

import { BigTaskIdSchema, ContextItemIdSchema, ProjectIdSchema, SubtaskIdSchema } from "./identifiers.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

const contextTitle = compactText(256);
const contextBody = compactText(4_000);
const sourceReference = compactText(2_048);

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
    sourceReference,
    effectiveAt: z
      .iso.datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    supersedesContextItemId: ContextItemIdSchema.optional(),
  })
  .strict();

export const ContextScopeSchema = z.discriminatedUnion("scopeType", [
  z
    .object({
      scopeType: z.literal("PROJECT"),
      projectId: ProjectIdSchema,
    })
    .strict(),
  z
    .object({
      scopeType: z.literal("BIG_TASK"),
      projectId: ProjectIdSchema,
      bigTaskId: BigTaskIdSchema,
    })
    .strict(),
  z
    .object({
      scopeType: z.literal("SUBTASK"),
      projectId: ProjectIdSchema,
      bigTaskId: BigTaskIdSchema,
      subtaskId: SubtaskIdSchema,
    })
    .strict(),
]);

const contextItemBaseShape = {
  id: ContextItemIdSchema,
  projectId: ProjectIdSchema,
  kind: ContextKindSchema,
  status: ContextStatusSchema,
  authority: ContextAuthoritySchema,
  title: contextTitle,
  body: contextBody,
  provenance: ContextProvenanceSchema,
} as const;

export const ContextItemSchema = z.union([
  z.object(contextItemBaseShape).strict(),
  z
    .object({
      ...contextItemBaseShape,
      bigTaskId: BigTaskIdSchema,
    })
    .strict(),
  z
    .object({
      ...contextItemBaseShape,
      bigTaskId: BigTaskIdSchema,
      subtaskId: SubtaskIdSchema,
    })
    .strict(),
]);

export type ContextKind = z.infer<typeof ContextKindSchema>;
export type ContextStatus = z.infer<typeof ContextStatusSchema>;
export type ContextAuthority = z.infer<typeof ContextAuthoritySchema>;
export type ContextSourceType = z.infer<typeof ContextSourceTypeSchema>;
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;
export type ContextScope = z.infer<typeof ContextScopeSchema>;
export type ContextItem = z.infer<typeof ContextItemSchema>;

export const deriveContextScope = (contextItem: ContextItem): ContextScope => {
  const validContextItem = ContextItemSchema.parse(contextItem);
  if ("subtaskId" in validContextItem) {
    return {
      scopeType: "SUBTASK",
      projectId: validContextItem.projectId,
      bigTaskId: validContextItem.bigTaskId,
      subtaskId: validContextItem.subtaskId,
    };
  }
  if ("bigTaskId" in validContextItem) {
    return {
      scopeType: "BIG_TASK",
      projectId: validContextItem.projectId,
      bigTaskId: validContextItem.bigTaskId,
    };
  }
  return {
    scopeType: "PROJECT",
    projectId: validContextItem.projectId,
  };
};
