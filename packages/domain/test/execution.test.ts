import { describe, expect, it } from "vitest";

import {
  ExecutionProviderDescriptorSchema,
  ExecutionProviderIdSchema,
  NormalizedUsageSchema,
  ProviderCapabilitySetSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
} from "../src/index.js";

const validDescriptor = {
  providerId: "codex-app-server",
  displayName: "Codex App Server",
  runtimeVersion: "codex-cli fixture-version",
  capabilities: ["skills", "streamed-events", "usage-updates"],
} as const;

describe("provider identifiers and descriptors", () => {
  it("parses a stable provider ID", () => {
    expect(ExecutionProviderIdSchema.parse("codex-app-server")).toBe("codex-app-server");
  });

  it("rejects empty and oversized provider IDs", () => {
    expect(ExecutionProviderIdSchema.safeParse("").success).toBe(false);
    expect(ExecutionProviderIdSchema.safeParse("a".repeat(65)).success).toBe(false);
  });

  it("parses a provider descriptor", () => {
    expect(ExecutionProviderDescriptorSchema.parse(validDescriptor)).toEqual(validDescriptor);
  });

  it("rejects duplicate or non-canonical capability sets", () => {
    expect(ProviderCapabilitySetSchema.safeParse(["skills", "skills"]).success).toBe(false);
    expect(
      ProviderCapabilitySetSchema.safeParse(["usage-updates", "skills"]).success,
    ).toBe(false);
  });

  it("rejects unknown capabilities", () => {
    expect(ProviderCapabilitySetSchema.safeParse(["model-marketplace"]).success).toBe(false);
  });

  it("does not accept authentication or metadata fields", () => {
    expect(
      ExecutionProviderDescriptorSchema.safeParse({
        ...validDescriptor,
        authenticationToken: "not-allowed",
      }).success,
    ).toBe(false);
    expect(
      ExecutionProviderDescriptorSchema.safeParse({
        ...validDescriptor,
        metadata: { arbitrary: true },
      }).success,
    ).toBe(false);
  });
});

describe("provider references", () => {
  it("parses a provider thread reference and keeps IDs separate", () => {
    const reference = ProviderThreadReferenceSchema.parse({
      providerId: "codex-app-server",
      providerThreadId: "thread-fixture-1",
    });
    expect(reference.providerId).toBe("codex-app-server");
    expect(reference.providerThreadId).toBe("thread-fixture-1");
  });

  it("rejects malformed provider thread IDs", () => {
    expect(
      ProviderThreadReferenceSchema.safeParse({
        providerId: "codex-app-server",
        providerThreadId: "",
      }).success,
    ).toBe(false);
    expect(
      ProviderThreadReferenceSchema.safeParse({
        providerId: "codex-app-server",
        providerThreadId: "x".repeat(513),
      }).success,
    ).toBe(false);
  });

  it("parses a provider run reference without Codex terminology", () => {
    const reference = ProviderRunReferenceSchema.parse({
      providerId: "codex-app-server",
      providerThreadId: "thread-fixture-1",
      providerRunId: "turn-fixture-1",
    });
    expect(reference.providerRunId).toBe("turn-fixture-1");
    expect(Object.keys(reference)).not.toContain("codexTurnId");
  });

  it("parses a provider model reference", () => {
    expect(
      ProviderModelReferenceSchema.parse({
        providerId: "codex-app-server",
        providerModelId: "provider-model-id",
      }),
    ).toEqual({
      providerId: "codex-app-server",
      providerModelId: "provider-model-id",
    });
  });

  it("exposes no Codex-named fields in core references", () => {
    const reference = ProviderThreadReferenceSchema.parse({
      providerId: "codex-app-server",
      providerThreadId: "opaque-thread-id",
    });
    expect(Object.keys(reference).some((key) => key.toLowerCase().includes("codex"))).toBe(
      false,
    );
  });
});

describe("normalized provider usage", () => {
  it("parses portable usage fields", () => {
    expect(
      NormalizedUsageSchema.parse({
        cachedInputTokens: 20,
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 5,
        runtimeSeconds: 1.25,
        toolCallCount: 2,
        totalTokens: 140,
      }),
    ).toMatchObject({ totalTokens: 140 });
  });

  it("rejects negative token values", () => {
    expect(NormalizedUsageSchema.safeParse({ inputTokens: -1 }).success).toBe(false);
  });

  it("allows unsupported and reasoning fields to be absent", () => {
    expect(NormalizedUsageSchema.parse({ totalTokens: 4 })).toEqual({ totalTokens: 4 });
  });

  it("rejects inconsistent total tokens when input and output are reported", () => {
    expect(
      NormalizedUsageSchema.safeParse({
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 141,
      }).success,
    ).toBe(false);
  });

  it("requires optional runtime and tool counts to be non-negative", () => {
    expect(NormalizedUsageSchema.safeParse({ runtimeSeconds: -0.1 }).success).toBe(false);
    expect(NormalizedUsageSchema.safeParse({ toolCallCount: -1 }).success).toBe(false);
  });

  it("does not require or accept monetary cost", () => {
    expect(NormalizedUsageSchema.parse({ inputTokens: 1 })).toEqual({ inputTokens: 1 });
    expect(NormalizedUsageSchema.safeParse({ costUsd: 0.01 }).success).toBe(false);
  });
});
