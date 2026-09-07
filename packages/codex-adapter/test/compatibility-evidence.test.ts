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
      new URL("./fixtures/codex-0.153.3-compatibility.json", import.meta.url),
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

describe("Codex 0.153.3 stable-surface evidence", () => {
  it("records the exact non-experimental generated schema provenance", () => {
    expect(evidence).toMatchObject({
      codexVersion: TESTED_CODEX_VERSION,
      generatedOn: "2026-09-07",
      generatedWithoutExperimental: true,
      schemaFileCount: 1010,
      restrictedThreadConfig: {
        internalRequestMethods: ["config/read"],
        readProperties: ["cwd", "includeLayers"],
        responseRequired: ["config", "origins"],
        threadConfigTypes: ["object", "null"],
      },
      schemaBundleSha256: {
        "codex_app_server_protocol.schemas.json":
          "e8284c5cb8157554a3dd1e035aadbd4325aea501af56887e9c2e12eb1b9b9448",
        "codex_app_server_protocol.v2.schemas.json":
          "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
      },
    });
  });

  it("keeps every supported method in its generated 0.153.3 direction", () => {
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
        "projectId",
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
        "approvalPolicy",
        "approvalsReviewer",
        "baseInstructions",
        "cwd",
        "developerInstructions",
        "ephemeral",
        "model",
        "modelProvider",
        "sandbox",
        "serviceName",
      ],
      turnStartProperties: [
        "approvalPolicy",
        "approvalsReviewer",
        "cwd",
        "input",
        "model",
        "sandboxPolicy",
        "threadId",
      ],
      workspaceWritePolicyProperties: [
        "excludeSlashTmp",
        "excludeTmpdirEnvVar",
        "networkAccess",
        "type",
        "writableRoots",
      ],
      commandExecutionItemRequired: [
        "command",
        "commandActions",
        "cwd",
        "id",
        "status",
        "type",
      ],
      fileChangeItemRequired: ["changes", "id", "status", "type"],
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
