import { z } from "zod";

import { ChatThreadIdSchema, ExecutionRunIdSchema, SubtaskIdSchema } from "./identifiers.js";

export const NativeSubagentPurposeSchema = z.enum([
  "CODEBASE_EXPLORATION",
  "TEST_GAP_ANALYSIS",
  "QA_REVIEW",
  "LOG_ANALYSIS",
  "DOCUMENTATION_VERIFICATION",
  "SECURITY_REVIEW",
  "SUMMARIZATION",
]);

export const NativeSubagentParentSchema = z.discriminatedUnion("parentType", [
  z
    .object({
      parentType: z.literal("PRIMARY_THREAD"),
      primaryThreadId: ChatThreadIdSchema,
    })
    .strict(),
  z
    .object({
      parentType: z.literal("PRIMARY_EXECUTION"),
      primaryExecutionRunId: ExecutionRunIdSchema,
    })
    .strict(),
]);

export const NativeSubagentOwnershipSchema = z
  .object({
    recordType: z.literal("NATIVE_SUBAGENT"),
    childThreadId: ChatThreadIdSchema,
    owningSubtaskId: SubtaskIdSchema,
    parent: NativeSubagentParentSchema,
    purpose: NativeSubagentPurposeSchema,
    lifecycleScope: z.literal("AUXILIARY"),
    usageAttribution: z.literal("OWNING_SUBTASK"),
  })
  .strict();

export type NativeSubagentPurpose = z.infer<typeof NativeSubagentPurposeSchema>;
export type NativeSubagentParent = z.infer<typeof NativeSubagentParentSchema>;
export type NativeSubagentOwnership = z.infer<typeof NativeSubagentOwnershipSchema>;
