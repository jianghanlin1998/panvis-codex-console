import { z } from "zod";

const identifierSchema = <Brand extends string>(prefix: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => value.startsWith(`${prefix}_`) && value.length > prefix.length + 1, {
      message: `Identifier must use the ${prefix}_ prefix`,
    })
    .brand<Brand>();

export const ProjectIdSchema = identifierSchema<"ProjectId">("prj");
export const BigTaskIdSchema = identifierSchema<"BigTaskId">("bt");
export const SubtaskIdSchema = identifierSchema<"SubtaskId">("st");
export const ChatThreadIdSchema = identifierSchema<"ChatThreadId">("thr");
export const ExecutionRunIdSchema = identifierSchema<"ExecutionRunId">("run");
export const ContextItemIdSchema = identifierSchema<"ContextItemId">("ctx");
export const ContextDigestIdSchema = identifierSchema<"ContextDigestId">("dgt");
export const AuditEventIdSchema = identifierSchema<"AuditEventId">("aud");

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type BigTaskId = z.infer<typeof BigTaskIdSchema>;
export type SubtaskId = z.infer<typeof SubtaskIdSchema>;
export type ChatThreadId = z.infer<typeof ChatThreadIdSchema>;
export type ExecutionRunId = z.infer<typeof ExecutionRunIdSchema>;
export type ContextItemId = z.infer<typeof ContextItemIdSchema>;
export type ContextDigestId = z.infer<typeof ContextDigestIdSchema>;
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;
