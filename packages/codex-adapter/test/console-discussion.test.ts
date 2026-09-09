import { describe, expect, it } from "vitest";
import { CONSOLE_DISCUSSION_OUTPUT_SCHEMA } from "@codex-task-console/domain";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { planningProviderFixture } from "./planning-provider-fixture.js";
import { executeConsoleDiscussionCodexForTest, executeBigTaskPlanningCodexForTest } from "../src/live-execution.js";
import { providerFailureCode } from "../src/provider-failure.js";
import type { JsonValue } from "../src/protocol.js";

describe("Console discussion provider diagnostics", () => {
  it("keeps the existing planning failure persistence shape for the same classified provider failure", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const peer = planningProviderFixture(() => null, { failedCodexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } } });
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PROVIDER_FAILED" });
      expect(result.runs[0]?.providerDiagnostics?.failureCode).toBe("TURN_FAILED");
      expect(result.runs[0]?.providerDiagnostics).not.toHaveProperty("providerFailureCode");
      f.reopen(); expect(f.planning.inspect(f.intake.bigTask.id)).toEqual(result);
    } finally { f.close(); }
  });
  it.each([
    [{ responseStreamConnectionFailed: { httpStatusCode: null } }, "MODEL_CONNECTION_FAILED"],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, "MODEL_CONNECTION_FAILED"],
    [{ httpConnectionFailed: { httpStatusCode: 400 } }, "MODEL_REQUEST_REJECTED"],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, "CHATGPT_AUTH_REQUIRED"],
    [{ httpConnectionFailed: { httpStatusCode: 429 } }, "MODEL_ACCOUNT_LIMIT"],
    ["contextWindowExceeded", "MODEL_CONTEXT_TOO_LARGE"],
    ["usageLimitExceeded", "MODEL_ACCOUNT_LIMIT"],
    ["BadRequest", "MODEL_REQUEST_REJECTED"],
    ["Other", undefined],
    [{ "private-provider-canary": {} }, undefined],
  ])("retains only the structured failure category for %j", async (info, expected) => {
    const f = makePlanningFixture();
    try {
      const peer = planningProviderFixture(() => { throw new Error("No answer expected"); }, { failedCodexErrorInfo: info });
      const result = await executeConsoleDiscussionCodexForTest(f.storage, '{"message":"Discuss"}', CONSOLE_DISCUSSION_OUTPUT_SCHEMA as JsonValue, () => 300_000, peer.dependencies);
      expect(result).toMatchObject({ success: false, failureCode: "TURN_FAILED", terminalTurnStatus: "failed", normalizedUsage: null,
        appServerChildCleaned: true, disposableWorkspaceCleaned: true });
      expect(result.diagnostics.providerFailureCode).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("private-provider-canary");
      expect(peer.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
    } finally { f.close(); }
  });
  it("does not turn arbitrary messages, malformed details, or unknown provider errors into a diagnosis", () => {
    for (const value of [null, "private-canary", { message: "private-canary" }, { codexErrorInfo: ["private-canary"] },
      { codexErrorInfo: { BadRequest: {}, Other: {} } }]) expect(providerFailureCode(value)).toBeUndefined();
  });
  it("returns a successful answer when usage is unavailable, without a Reviewer or task execution", async () => {
    const f = makePlanningFixture();
    try {
      const answer = { reply: "Here is the direction.", proposal: null, actions: [] };
      const peer = planningProviderFixture(() => answer, { omitUsage: true });
      const result = await executeConsoleDiscussionCodexForTest(f.storage, '{"message":"Discuss"}', CONSOLE_DISCUSSION_OUTPUT_SCHEMA as JsonValue, () => 300_000, peer.dependencies);
      expect(result).toMatchObject({ success: true, normalizedUsage: null, agentResponseText: JSON.stringify(answer) });
      expect(result.diagnostics.providerFailureCode).toBeUndefined();
      expect(peer.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
      expect(peer.requests.find(r => r.method === "turn/start")?.params.sandboxPolicy).toMatchObject({ type: "readOnly", networkAccess: false });
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toEqual([]);
    } finally { f.close(); }
  });
});
