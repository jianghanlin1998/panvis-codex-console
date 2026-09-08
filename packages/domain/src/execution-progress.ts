import { z } from "zod";
import { NormalizedUsageSchema } from "./execution.js";

/** Safe runtime signals only: never raw prompts, commands, paths or provider errors. */
export const ExecutionProgressSchema = z.object({
  observedAt: z.iso.datetime(),
  activity: z.enum(["STARTING", "THINKING", "READING_OR_TESTING", "EDITING", "RESPONDING"]),
  toolActions: z.number().int().nonnegative(),
  notifications: z.number().int().nonnegative(),
  usage: NormalizedUsageSchema.nullable(),
}).strict();
export type ExecutionProgress = z.infer<typeof ExecutionProgressSchema>;

const measuredTotal = z.object({ known: z.number().int().nonnegative(), missingRuns: z.number().int().nonnegative() }).strict();
export const ExecutionUsageBreakdownSchema = z.object({
  completedRuns: z.number().int().nonnegative(),
  inputTokens: measuredTotal,
  cachedInputTokens: measuredTotal,
  outputTokens: measuredTotal,
  reasoningTokens: measuredTotal,
  accounting: z.literal("TOKENS_NOT_CURRENCY"),
}).strict().refine(value => [value.inputTokens, value.cachedInputTokens, value.outputTokens, value.reasoningTokens]
  .every(total => total.missingRuns <= value.completedRuns));
export type ExecutionUsageBreakdown = z.infer<typeof ExecutionUsageBreakdownSchema>;
