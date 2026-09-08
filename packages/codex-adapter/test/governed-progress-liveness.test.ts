import { expect, it, vi } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { getGovernedProviderBridge } from "../../storage/src/governed-execution-public.js";
import { executeGovernedRoleCodexWithDependenciesForTest } from "../src/live-execution.js";
import { validateOwnedWorktreeHardlinkSafety } from "../src/worktree-filesystem-safety.js";
import { planningProviderFixture } from "./planning-provider-fixture.js";

it.each(["productive", "silent", "parent-deadline", "telemetry-unavailable"] as const)("uses the approved parent window with an independent idle limit: %s", async scenario => {
  let tick = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(tick++));
  try {
    f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, durationMilliseconds: 60_000 } });
    f.execution.start(f.approval.bigTaskId);
    const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Test role missing");
    if (scenario === "telemetry-unavailable") vi.spyOn(getGovernedProviderBridge(f.governed), "recordRoleProgress")
      .mockImplementation(() => { throw new Error("synthetic display write failure"); });
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const peer = planningProviderFixture(() => ({}), { governed: true, silentTurn: true, onTurnStarted: begin });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = executeGovernedRoleCodexWithDependenciesForTest(f.governed, prepared.authorization.authorizationId, {
      ...peer.dependencies, checkCompatibility: () => true, validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
      resolveOwnedWorktree: () => { throw new Error("Storage owns authority"); },
      generateChatThreadId: () => { throw new Error("Storage owns IDs"); }, generateExecutionRunId: () => { throw new Error("Storage owns IDs"); },
      limits: { ...peer.dependencies.limits, turnAbsoluteTimeoutMs: 100, turnIdleTimeoutMs: 25_000 },
    });
    await started;
    const { send, threadId, turnId } = peer.peers[0]!;
    const usage = () => send({ method: "thread/tokenUsage/updated", params: { threadId, turnId,
      tokenUsage: { total: { inputTokens: 12, cachedInputTokens: 8, cacheWriteInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 18 } } } });
    if (scenario === "silent") await vi.advanceTimersByTimeAsync(25_001);
    else {
      // Valid exact-turn progress carries this role beyond its old fixed cap.
      const steps = scenario === "parent-deadline" ? 3 : 2;
      for (let i = 0; i < steps; i++) { await vi.advanceTimersByTimeAsync(20_000); if (i + 1 < steps || scenario !== "parent-deadline") usage(); }
      if (scenario !== "parent-deadline") {
        expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ activeRoleCount: 1, knownTokens: 0,
          activeRole: { usageState: "IN_PROGRESS", progress: scenario === "telemetry-unavailable" ? null : { usage: { totalTokens: 18 } } } });
        send({ method: "item/completed", params: { threadId, turnId, item: { id: "answer", type: "agentMessage",
          text: JSON.stringify({ schemaVersion: 1, outcome: "READY", summary: "Synthetic completed work", findings: [], promotionCandidate: null }) } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }
    }
    const result = await running;
    expect(result).toMatchObject({ success: scenario === "productive" || scenario === "telemetry-unavailable",
      failureCode: scenario === "silent" || scenario === "parent-deadline" ? "APP_SERVER_TIMEOUT" : null,
      diagnostics: { turnStartRequests: 1, interruptRequests: scenario === "silent" || scenario === "parent-deadline" ? 1 : 0 } });
    expect(peer.launches).toHaveLength(1);
    expect(peer.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); f.close(); }
}, 30_000);
