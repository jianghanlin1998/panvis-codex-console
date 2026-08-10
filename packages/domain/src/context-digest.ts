import { z } from "zod";

import { ContextSourceTypeSchema, ContextScopeSchema } from "./context.js";
import { ContextDigestIdSchema } from "./identifiers.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

export const ContextDigestProvenanceSchema = z
  .object({
    sourceType: ContextSourceTypeSchema,
    sourceReference: compactText(2_048),
    effectiveAt: z
      .iso.datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();

export const ContextDigestSchema = z
  .object({
    id: ContextDigestIdSchema,
    scope: ContextScopeSchema,
    body: compactText(8_000),
    provenance: ContextDigestProvenanceSchema,
  })
  .strict();

export type ContextDigestProvenance = z.infer<typeof ContextDigestProvenanceSchema>;
export type ContextDigest = z.infer<typeof ContextDigestSchema>;
