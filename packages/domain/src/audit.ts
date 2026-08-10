import { z } from "zod";

import { ContextScopeSchema } from "./context.js";
import { AuditEventIdSchema } from "./identifiers.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

export const AuditActorTypeSchema = z.enum(["HUMAN", "CODEX", "SYSTEM"]);

export const AuditEventTypeSchema = compactText(64).regex(/^[A-Z][A-Z0-9_]*$/);

export const AuditEventSchema = z
  .object({
    id: AuditEventIdSchema,
    scope: ContextScopeSchema,
    eventType: AuditEventTypeSchema,
    actorType: AuditActorTypeSchema,
    actorReference: compactText(256).optional(),
    summary: compactText(1_000),
    subjectReference: compactText(512).optional(),
    occurredAt: z
      .iso.datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();

export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
