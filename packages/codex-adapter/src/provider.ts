import {
  ExecutionProviderDescriptorSchema,
  ExecutionProviderIdSchema,
  NormalizedUsageSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
} from "@codex-task-console/domain";
import type {
  ExecutionProviderDescriptor,
  ExecutionProviderId,
  NormalizedUsage,
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
} from "@codex-task-console/domain";

import { TESTED_CODEX_VERSION } from "./compatibility.js";
import type { TokenUsageBreakdown } from "./protocol.js";

export const CODEX_APP_SERVER_PROVIDER_ID: ExecutionProviderId =
  ExecutionProviderIdSchema.parse("codex-app-server");

export const CODEX_APP_SERVER_PROVIDER_DESCRIPTOR: ExecutionProviderDescriptor =
  ExecutionProviderDescriptorSchema.parse({
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    displayName: "Codex App Server",
    runtimeVersion: TESTED_CODEX_VERSION,
    capabilities: [
      "approval-requests",
      "interruption",
      "persistent-threads",
      "skills",
      "streamed-events",
      "thread-resume",
      "usage-updates",
    ],
  });

export function mapCodexThreadReference(providerThreadId: string): ProviderThreadReference {
  return ProviderThreadReferenceSchema.parse({
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    providerThreadId,
  });
}

export function mapCodexTurnReference(
  providerThreadId: string,
  providerTurnId: string,
): ProviderRunReference {
  return ProviderRunReferenceSchema.parse({
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    providerRunId: providerTurnId,
    providerThreadId,
  });
}

export function mapCodexModelReference(providerModelId: string): ProviderModelReference {
  return ProviderModelReferenceSchema.parse({
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    providerModelId,
  });
}

export function mapCodexTokenUsage(usage: TokenUsageBreakdown): NormalizedUsage {
  return NormalizedUsageSchema.parse({
    cachedInputTokens: usage.cachedInputTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
  });
}
