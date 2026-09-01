import { z } from "zod";

import { isWellFormedUnicode } from "./well-formed-unicode.js";

const boundedProviderOwnedIdentifier = <Brand extends string>() =>
  z
    .string()
    .min(1)
    .max(512)
    .refine(isWellFormedUnicode, {
      message: "Provider-owned identifiers must be well-formed Unicode",
    })
    .refine((value) => value.trim() === value && value.length > 0, {
      message: "Provider-owned identifiers must be non-empty and have no surrounding whitespace",
    })
    .brand<Brand>();

const boundedDisplayString = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value && value.length > 0, {
    message: "Display values must be non-empty and have no surrounding whitespace",
  });

export const ExecutionProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Execution provider IDs must be stable lowercase slugs",
  })
  .brand<"ExecutionProviderId">();

export const ProviderThreadIdSchema = boundedProviderOwnedIdentifier<"ProviderThreadId">();
export const ProviderRunIdSchema = boundedProviderOwnedIdentifier<"ProviderRunId">();
export const ProviderModelIdSchema = boundedProviderOwnedIdentifier<"ProviderModelId">();

export const EXECUTION_PROVIDER_CAPABILITIES = [
  "approval-requests",
  "interruption",
  "native-subagents",
  "persistent-threads",
  "review",
  "skills",
  "streamed-events",
  "thread-resume",
  "usage-updates",
] as const;

export const ExecutionProviderCapabilitySchema = z.enum(EXECUTION_PROVIDER_CAPABILITIES);

export const ProviderCapabilitySetSchema = z
  .array(ExecutionProviderCapabilitySchema)
  .max(EXECUTION_PROVIDER_CAPABILITIES.length)
  .superRefine((capabilities, context) => {
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "Provider capabilities must be unique",
      });
    }

    for (let index = 1; index < capabilities.length; index += 1) {
      const previous = capabilities[index - 1];
      const current = capabilities[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: "custom",
          message: "Provider capabilities must use canonical ascending order",
          path: [index],
        });
        break;
      }
    }
  })
  .readonly();

export const ExecutionProviderDescriptorSchema = z
  .object({
    providerId: ExecutionProviderIdSchema,
    displayName: boundedDisplayString,
    runtimeVersion: boundedDisplayString.optional(),
    capabilities: ProviderCapabilitySetSchema,
  })
  .strict()
  .readonly();

export const ProviderThreadReferenceSchema = z
  .object({
    providerId: ExecutionProviderIdSchema,
    providerThreadId: ProviderThreadIdSchema,
  })
  .strict()
  .readonly();

export const ProviderRunReferenceSchema = z
  .object({
    providerId: ExecutionProviderIdSchema,
    providerThreadId: ProviderThreadIdSchema,
    providerRunId: ProviderRunIdSchema,
  })
  .strict()
  .readonly();

export const ProviderModelReferenceSchema = z
  .object({
    providerId: ExecutionProviderIdSchema,
    providerModelId: ProviderModelIdSchema,
  })
  .strict()
  .readonly();

const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const NormalizedUsageSchema = z
  .object({
    inputTokens: nonNegativeInteger.optional(),
    cachedInputTokens: nonNegativeInteger.optional(),
    outputTokens: nonNegativeInteger.optional(),
    reasoningTokens: nonNegativeInteger.optional(),
    totalTokens: nonNegativeInteger.optional(),
    runtimeSeconds: z.number().finite().nonnegative().optional(),
    toolCallCount: nonNegativeInteger.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.totalTokens !== undefined &&
      usage.totalTokens !== usage.inputTokens + usage.outputTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "Total tokens must equal input tokens plus output tokens when all are reported",
        path: ["totalTokens"],
      });
    }
  })
  .readonly();

export type ExecutionProviderId = z.infer<typeof ExecutionProviderIdSchema>;
export type ProviderThreadId = z.infer<typeof ProviderThreadIdSchema>;
export type ProviderRunId = z.infer<typeof ProviderRunIdSchema>;
export type ProviderModelId = z.infer<typeof ProviderModelIdSchema>;
export type ExecutionProviderCapability = z.infer<
  typeof ExecutionProviderCapabilitySchema
>;
export type ProviderCapabilitySet = z.infer<typeof ProviderCapabilitySetSchema>;
export type ExecutionProviderDescriptor = z.infer<
  typeof ExecutionProviderDescriptorSchema
>;
export type ProviderThreadReference = z.infer<typeof ProviderThreadReferenceSchema>;
export type ProviderRunReference = z.infer<typeof ProviderRunReferenceSchema>;
export type ProviderModelReference = z.infer<typeof ProviderModelReferenceSchema>;
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;
