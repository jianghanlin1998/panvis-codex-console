import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_APP_SERVER_PROVIDER_DESCRIPTOR,
  CODEX_APP_SERVER_PROVIDER_ID,
  EXCLUDED_EXPERIMENTAL_CAPABILITIES,
  TESTED_CODEX_VERSION,
  mapCodexModelReference,
  mapCodexThreadReference,
  mapCodexTokenUsage,
  mapCodexTurnReference,
} from "../src/index.js";
import type { TokenUsageBreakdown } from "../src/index.js";

const fixtureUsage: TokenUsageBreakdown = {
  cachedInputTokens: 20,
  cacheWriteInputTokens: 0,
  inputTokens: 100,
  outputTokens: 40,
  reasoningOutputTokens: 5,
  totalTokens: 140,
};

describe("Codex provider descriptor", () => {
  it("uses the stable Codex App Server provider ID", () => {
    expect(CODEX_APP_SERVER_PROVIDER_ID).toBe("codex-app-server");
    expect(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR.providerId).toBe(
      CODEX_APP_SERVER_PROVIDER_ID,
    );
  });

  it("records the exact S0C-tested runtime version", () => {
    expect(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR.runtimeVersion).toBe(
      TESTED_CODEX_VERSION,
    );
    expect(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR.runtimeVersion).toBe(
      "codex-cli 0.148.0-alpha.9",
    );
  });

  it("claims only capabilities supported by the S0C surface", () => {
    expect(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR.capabilities).toEqual([
      "approval-requests",
      "interruption",
      "persistent-threads",
      "skills",
      "streamed-events",
      "thread-resume",
      "usage-updates",
    ]);
    expect(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR.capabilities).not.toContain("review");
    expect(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR.capabilities).not.toContain(
      "native-subagents",
    );
  });

  it("does not claim S0C experimental exclusions", () => {
    const descriptor = JSON.stringify(CODEX_APP_SERVER_PROVIDER_DESCRIPTOR);
    for (const exclusion of EXCLUDED_EXPERIMENTAL_CAPABILITIES) {
      expect(descriptor).not.toContain(exclusion);
    }
  });
});

describe("Codex provider mappings", () => {
  it("maps a thread ID deterministically", () => {
    const first = mapCodexThreadReference("thread-fixture-1");
    expect(mapCodexThreadReference("thread-fixture-1")).toEqual(first);
    expect(first).toEqual({
      providerId: "codex-app-server",
      providerThreadId: "thread-fixture-1",
    });
  });

  it("maps a Codex turn to a provider run deterministically", () => {
    expect(mapCodexTurnReference("thread-fixture-1", "turn-fixture-1")).toEqual({
      providerId: "codex-app-server",
      providerRunId: "turn-fixture-1",
      providerThreadId: "thread-fixture-1",
    });
  });

  it("maps a Codex model to the provider-neutral model reference", () => {
    expect(mapCodexModelReference("fixture-model-live")).toEqual({
      providerId: "codex-app-server",
      providerModelId: "fixture-model-live",
    });
  });

  it("maps S0C token usage without mutation or fabricated fields", () => {
    const before = structuredClone(fixtureUsage);
    expect(mapCodexTokenUsage(fixtureUsage)).toEqual({
      cachedInputTokens: 20,
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 5,
      totalTokens: 140,
    });
    expect(fixtureUsage).toEqual(before);
  });

  it("preserves optional normalized usage and rejects invalid values", () => {
    expect(
      mapCodexTokenUsage({
        ...fixtureUsage,
        reasoningOutputTokens: undefined,
      } as unknown as TokenUsageBreakdown),
    ).toEqual({
      cachedInputTokens: 20,
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
    });
    expect(() =>
      mapCodexTokenUsage({
        ...fixtureUsage,
        totalTokens: -1,
      }),
    ).toThrow();
  });

  it("keeps the mapping module free of filesystem, network, and process work", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/provider.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/u);
    expect(source).not.toMatch(/\b(?:fetch|process|WebSocket|XMLHttpRequest)\b/u);
  });
});

describe("provider dependency direction", () => {
  it("keeps domain independent and declares the adapter-to-domain dependency", () => {
    const domainPackage = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../domain/package.json", import.meta.url)),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    const adapterPackage = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(domainPackage.dependencies).not.toHaveProperty(
      "@codex-task-console/codex-adapter",
    );
    expect(adapterPackage.dependencies).toMatchObject({
      "@codex-task-console/domain": "workspace:*",
      "@codex-task-console/storage": "workspace:*",
    });
  });
});
