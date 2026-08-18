import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXCLUDED_EXPERIMENTAL_CAPABILITIES,
  SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  SUPPORTED_CLIENT_REQUEST_METHODS,
  SUPPORTED_SERVER_NOTIFICATION_METHODS,
  SUPPORTED_SERVER_REQUEST_METHODS,
  TESTED_CODEX_VERSION,
  type ApprovalDecision,
} from "../src/index.js";

const evidence = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/codex-0.148.0-alpha.9-compatibility.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  readonly codexVersion: string;
  readonly consumedShapes: Readonly<Record<string, readonly string[]>>;
  readonly generatedOn: string;
  readonly generatedWithoutExperimental: boolean;
  readonly methods: {
    readonly clientNotifications: readonly string[];
    readonly clientRequests: readonly string[];
    readonly serverNotifications: readonly string[];
    readonly serverRequests: readonly string[];
  };
  readonly requiredRequestParams: Readonly<Record<string, readonly string[]>>;
  readonly schemaBundleSha256: Readonly<Record<string, string>>;
  readonly schemaFileCount: number;
};

const SUPPORTED_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "cancel",
  "decline",
] as const satisfies readonly ApprovalDecision[];

describe("Codex 0.148 stable-surface evidence", () => {
  it("records the exact non-experimental generated schema provenance", () => {
    expect(evidence).toMatchObject({
      codexVersion: TESTED_CODEX_VERSION,
      generatedOn: "2026-08-18",
      generatedWithoutExperimental: true,
      schemaFileCount: 934,
      schemaBundleSha256: {
        "codex_app_server_protocol.schemas.json":
          "9ebe992f44965fb6b033b90bc12b3283b0ce9b117d20b9120ab94a7534886970",
        "codex_app_server_protocol.v2.schemas.json":
          "f63c8dd74f724835cd88c1a392cb451f903f46d8f72fec4a257df61d52867891",
      },
    });
  });

  it("keeps every supported method in its generated 0.148 direction", () => {
    expect(evidence.methods).toEqual({
      clientNotifications: SUPPORTED_CLIENT_NOTIFICATION_METHODS,
      clientRequests: SUPPORTED_CLIENT_REQUEST_METHODS,
      serverNotifications: SUPPORTED_SERVER_NOTIFICATION_METHODS,
      serverRequests: SUPPORTED_SERVER_REQUEST_METHODS,
    });
  });

  it("locks the required request fields used by the current contract", () => {
    expect(evidence.requiredRequestParams).toEqual({
      initialize: ["clientInfo"],
      "skills/list": [],
      "thread/goal/get": ["threadId"],
      "thread/goal/set": ["threadId"],
      "thread/resume": ["threadId"],
      "thread/start": [],
      "turn/interrupt": ["threadId", "turnId"],
      "turn/start": ["input", "threadId"],
    });
  });

  it("locks the consumed response, input, usage, and approval shape", () => {
    expect(evidence.consumedShapes).toMatchObject({
      initializeResponseRequired: [
        "codexHome",
        "platformFamily",
        "platformOs",
        "userAgent",
      ],
      textInputDefaultFields: ["text_elements"],
      textInputRequired: ["text", "type"],
      threadTokenUsageProperties: ["last", "modelContextWindow", "total"],
      threadTokenUsageRequired: ["last", "total"],
      tokenUsageBreakdownRequired: [
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ],
      commandApprovalRequired: ["itemId", "startedAtMs", "threadId", "turnId"],
      fileChangeApprovalRequired: ["itemId", "startedAtMs", "threadId", "turnId"],
      supportedApprovalDecisions: SUPPORTED_APPROVAL_DECISIONS,
      threadRequired: [
        "cliVersion",
        "createdAt",
        "cwd",
        "ephemeral",
        "id",
        "modelProvider",
        "preview",
        "sessionId",
        "source",
        "status",
        "turns",
        "updatedAt",
      ],
      threadStartResponseRequired: [
        "approvalPolicy",
        "approvalsReviewer",
        "cwd",
        "model",
        "modelProvider",
        "sandbox",
        "thread",
      ],
      threadStartProperties: [
        "baseInstructions",
        "developerInstructions",
        "model",
        "modelProvider",
      ],
      turnStartProperties: ["input", "model", "threadId"],
      turnRequired: ["id", "items", "status"],
    });
  });

  it("does not activate an excluded experimental capability", () => {
    const supportedMethods = Object.values(evidence.methods).flat().join(" ");
    for (const exclusion of EXCLUDED_EXPERIMENTAL_CAPABILITIES) {
      expect(supportedMethods).not.toContain(exclusion);
    }
  });
});
