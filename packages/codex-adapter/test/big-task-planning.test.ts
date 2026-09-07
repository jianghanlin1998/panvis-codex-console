import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { executeBigTaskPlanningCodexForTest } from "../src/live-execution.js";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { planningProviderFixture } from "./planning-provider-fixture.js";

describe("real Big Task planning adapter with deterministic JSONL peer", () => {
  it("accepts a valid bounded plan delivered in more than 2,000 tiny text deltas", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const proposal = { ...f.proposal, tasks: f.proposal.tasks.map((task) => ({ ...task, goal: "x".repeat(1_000) })) };
      const provider = planningProviderFixture(() => proposal, { streamResponse: true });
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, {
        ...provider.dependencies, limits: { ...provider.dependencies.limits, maxNotifications: 2_000 },
      });
      expect(result).toMatchObject({ phase: "READY", nextRole: "REVIEWER", totalTokens: 100 });
      expect(result.runs[0]?.providerDiagnostics?.failureCode).toBeNull();
      expect(result.runs[0]?.providerDiagnostics?.notificationsReceived).toBeGreaterThan(2_000);
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)?.reviewState.candidate.subtasks).toHaveLength(2);
    } finally { f.close(); }
  });

  it.each([
    ["oversized UTF-8 output", Array.from("你".repeat(5_462)), undefined, "AGENT_RESPONSE_LIMIT_EXCEEDED"],
    ["empty-delta flood", Array.from({ length: 65 }, () => ""), undefined, "JSONL_LIMIT_EXCEEDED"],
    ["foreign thread", ["x"], "unrelated-thread", "APP_SERVER_PROTOCOL_ERROR"],
  ] as const)("keeps byte, control-event and authority limits for %s", async (_name, agentChunks, deltaThreadId, failureCode) => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, { agentChunks, ...(deltaThreadId === undefined ? {} : { deltaThreadId }) });
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PROVIDER_FAILED", totalTokens: 100 });
      expect(result.runs[0]?.providerDiagnostics).toMatchObject({ failureCode, appServerChildCleaned: true, disposableWorkspaceCleaned: true });
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
      expect(provider.launches).toHaveLength(1);
    } finally { f.close(); }
  });

  it.each(["initialize", "account/read", "config/read", "thread/start", "turn/start"])("enforces the approved deadline while %s acknowledgement is pending", async (method) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T06:00:00.000Z"));
    const f = makePlanningFixture(() => new Date());
    try {
      f.planning.accept({ ...f.intake, budgetException: { approved: true, mode: "MEASURE_ONLY", reason: "Setup deadline regression", expiresAt: "2026-09-07T06:00:05.000Z" } });
      const provider = planningProviderFixture(() => f.proposal, { silentTurn: true, delayedReply: { method, milliseconds: 10_000 } });
      const pending = executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, {
        ...provider.dependencies, limits: { ...provider.dependencies.limits, requestTimeoutMs: 15_000 },
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.planning.inspect(f.intake.bigTask.id).phase).toBe("RUNNING");
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "TIME_LIMIT_REACHED", usageComplete: false });
      expect(result.runs[0]?.endedAt).toBe("2026-09-07T06:00:05.000Z");
      expect(result.runs[0]?.providerDiagnostics).toMatchObject({ failureCode: "APP_SERVER_TIMEOUT", appServerChildCleaned: true, disposableWorkspaceCleaned: true });
      expect(provider.launches).toHaveLength(1);
      expect(provider.requests.filter(r => r.method === "turn/start")).toHaveLength(method === "turn/start" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.planning.inspect(f.intake.bigTask.id)).toEqual(result);
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); vi.useRealTimers(); }
  });

  it("interrupts an active provider at the exception deadline and retains the exact timeout cause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T06:00:00.000Z"));
    const f = makePlanningFixture(() => new Date());
    try {
      f.planning.accept({ ...f.intake, budgetException: { approved: true, mode: "MEASURE_ONLY", reason: "Deadline test", expiresAt: "2026-09-07T06:00:05.000Z" } });
      const provider = planningProviderFixture(() => f.proposal, { silentTurn: true });
      const pending = executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, {
        ...provider.dependencies, limits: { ...provider.dependencies.limits, turnIdleTimeoutMs: 30_000, turnAbsoluteTimeoutMs: 60_000 },
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.planning.inspect(f.intake.bigTask.id).phase).toBe("RUNNING");
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "TIME_LIMIT_REACHED", usageComplete: false });
      expect(result.runs[0]?.providerDiagnostics).toMatchObject({ failureCode: "APP_SERVER_TIMEOUT", interruptRequests: 1, appServerChildCleaned: true, disposableWorkspaceCleaned: true });
      expect(provider.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
      expect(provider.launches).toHaveLength(1);
    } finally { f.close(); vi.useRealTimers(); }
  });

  it("persists a bounded failure code and counts instead of discarding the adapter cause or exposing provider text", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, { extraNotifications: 65 });
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PROVIDER_FAILED", usageComplete: false });
      expect(result.runs[0]?.providerDiagnostics).toEqual({ failureCode: "JSONL_LIMIT_EXCEEDED", notificationsReceived: 65,
        unknownNotificationsIgnored: 64, interruptRequests: 0, appServerChildCleaned: true, disposableWorkspaceCleaned: true });
      expect(JSON.stringify(result)).not.toContain("private-provider-canary");
      f.reopen();
      expect(f.planning.inspect(f.intake.bigTask.id)).toEqual(result);
      expect(provider.launches).toHaveLength(1);
    } finally { f.close(); }
  });

  it("finishes and independently reviews a measured trial above the baseline token cap", async () => {
    const f = makePlanningFixture(() => new Date("2026-09-07T06:00:00.000Z"));
    try {
      f.planning.accept({ ...f.intake, budgetException: { approved: true, mode: "MEASURE_ONLY", reason: "One approved trial.", expiresAt: "2026-09-07T08:00:00.000Z" } });
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
        outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
        candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
      }, { tokens: 150_000 });
      expect((await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies)).phase).toBe("READY");
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result).toMatchObject({ phase: "APPROVED", totalTokens: 300_000, usageComplete: true, tokenLimit: 120_000 });
      expect(provider.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
      expect(provider.launches).toHaveLength(2);
      for (const packet of provider.packets) {
        expect(packet.instruction).toContain("hard limit of 16,384 UTF-8 bytes");
        expect(packet.instruction).toContain("trimmed single-line string of at most 1,000 characters");
        expect(packet.instruction).toContain("Preserve all goal coverage and acceptance criteria");
        expect(packet.instruction).toContain(packet.role === "PLANNER" ? "return HUMAN_REQUIRED" : "use ESCALATE");
      }
    } finally { f.close(); }
  });

  it("disables every configured MCP server for both fresh roles without forwarding other config", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
        outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
        candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
      }, { configReadResult: { config: {
        model: "config-private-canary", model_reasoning_effort: "config-private-canary",
        mcp_servers: Object.fromEntries([
          ["fixture.with.dots", { enabled: true, command: "config-private-canary" }],
          ["already-disabled", { enabled: false }], ["__proto__", {}],
        ]),
      }, origins: {} } });
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result.phase).toBe("APPROVED");
      const reads = provider.requests.filter((request) => request.method === "config/read");
      const starts = provider.requests.filter((request) => request.method === "thread/start");
      expect(reads).toHaveLength(2);
      expect(starts).toHaveLength(2);
      for (const [index, start] of starts.entries()) {
        expect(reads[index]!.params).toEqual({ cwd: start.params.cwd, includeLayers: false });
        expect(start.params.config).toEqual({ mcp_servers: Object.fromEntries([
          ["fixture.with.dots", { enabled: false }], ["already-disabled", { enabled: false }], ["__proto__", { enabled: false }],
        ]) });
      }
      expect(JSON.stringify(provider.requests)).not.toContain("config-private-canary");
      expect(JSON.stringify(result)).not.toContain("config-private-canary");
    } finally { f.close(); }
  });

  it.each([
    null, {}, { config: null }, { config: { mcp_servers: [] } },
    { config: { mcp_servers: { fixture: null } } },
    { config: { mcp_servers: { "": {} } } },
    { config: { mcp_servers: { ["x".repeat(257)]: {} } } },
    { config: { mcp_servers: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`mcp-${i}`, {}])) } },
  ])("stops malformed or oversized MCP config before creating a thread (%#)", async (configReadResult) => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, { configReadResult });
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PROVIDER_FAILED" });
      expect(provider.requests.filter((request) => request.method === "config/read")).toHaveLength(1);
      expect(provider.requests.filter((request) => request.method === "thread/start" || request.method === "turn/start")).toHaveLength(0);
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
      expect(provider.workspaces.every((path) => !existsSync(path))).toBe(true);
    } finally { f.close(); }
  });

  it("uses the explicit local proxy for both fresh planning roles and preserves their sandbox", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
        outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
        candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
      });
      const dependencies = { ...provider.dependencies, sourceEnvironment: {
        CTC_CODEX_HTTPS_PROXY: "http://127.0.0.1:10808",
        OPENAI_API_KEY: "key-sentinel", ALL_PROXY: "http://unrelated.invalid:8080",
      } };
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, dependencies);
      expect((await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, dependencies)).phase).toBe("APPROVED");
      expect(provider.launches).toHaveLength(2);
      for (const launch of provider.launches) {
        expect(launch.options.env?.HTTPS_PROXY).toBe("http://127.0.0.1:10808");
        expect(launch.options.env?.OPENAI_API_KEY).toBeUndefined();
        expect(launch.options.env?.ALL_PROXY).toBeUndefined();
      }
      const starts = provider.requests.filter((request) => request.method === "thread/start");
      expect(starts).toHaveLength(2);
      for (const request of starts) {
        expect(request.params).toMatchObject({ approvalPolicy: "never", sandbox: "read-only" });
      }
    } finally { f.close(); }
  });

  it("stops an invalid proxy before provider launch without retrying or exposing its value", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal);
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, {
        ...provider.dependencies, sourceEnvironment: { CTC_CODEX_HTTPS_PROXY: "http://user:proxy-secret@remote.invalid:8080" },
      });
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PROVIDER_FAILED" });
      expect(provider.launches).toHaveLength(0);
      expect(provider.requests).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain("proxy-secret");
    } finally { f.close(); }
  });

  it.each([0, 64])("reviews the full 24-task limit with %i dependencies using a bounded exact digest", async (dependencyCount) => {
    const f = makePlanningFixture();
    try {
      const tasks = Array.from({ length: 24 }, (_, index) => ({
        key: `t${index}`, title: "x", goal: "x", scopeIn: ["x"], scopeOut: [],
        acceptanceCriteria: ["x"], untouchedAreas: [], promptSeed: "x", profile: "LOW", writeEnabled: false,
      }));
      const dependencies = tasks.flatMap((downstream, index) => tasks.slice(0, index).map((upstream) => ({
        upstreamKey: upstream.key, downstreamKey: downstream.key, requiredGate: "ACCEPTED",
        reason: "r".repeat(90),
      }))).slice(0, dependencyCount);
      const proposal = { outcome: "PROPOSE", questions: [], tasks, dependencies };
      expect(Buffer.byteLength(JSON.stringify(proposal), "utf8")).toBeLessThanOrEqual(16_384);
      f.planning.accept(f.intake);
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? proposal : {
        outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
        candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
      });
      expect((await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies)).nextRole).toBe("REVIEWER");
      const bundle = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!;
      expect(bundle.candidateBinding.length).toBeGreaterThan(1_000);
      if (dependencyCount === 64) {
        expect(Buffer.byteLength(JSON.stringify({ candidateBinding: bundle.candidateBinding }), "utf8")).toBeGreaterThan(16_384);
      }
      expect((await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies)).phase).toBe("APPROVED");
      expect(provider.packets[1]!.proposal!.candidateBinding).toBe(createHash("sha256").update(bundle.candidateBinding, "utf8").digest("hex"));
      expect(provider.packets[1]!.proposal!.candidateBinding).toHaveLength(64);
      expect(provider.launches).toHaveLength(2);
      f.reopen();
      const approved = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!;
      expect(approved.candidateBinding).toBe(bundle.candidateBinding);
      expect(approved.reviewState.phase).toBe("APPROVED");
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
    } finally { f.close(); }
  });

  it("creates the candidate from provider output, invokes a fresh review and retains separate usage", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
        outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
        candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
      });
      const first = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(first).toMatchObject({ phase: "READY", nextRole: "REVIEWER", totalTokens: 100 });
      const second = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(second).toMatchObject({ phase: "APPROVED", totalTokens: 200 });
      expect(provider.packets.map((packet) => packet.role)).toEqual(["PLANNER", "REVIEWER"]);
      expect(provider.packets[0]?.proposal).toBeNull();
      expect(provider.packets[1]).not.toHaveProperty("revisionRequirements");
      expect(provider.launches).toHaveLength(2);
      expect(provider.workspaces.every((workspace) => !existsSync(workspace))).toBe(true);
      expect(new Set(provider.launches.map((launch) => launch.options.cwd)).size).toBe(2);
      for (const launch of provider.launches) {
        expect(launch.args).toContain("--strict-config");
        expect(launch.args).toContain('web_search="disabled"');
        expect(launch.options.shell).toBe(false);
      }
      for (const request of provider.requests.filter((request) => request.method === "turn/start")) {
        expect(request.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
        expect(request.params.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
      }
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
    } finally { f.close(); }
  });

  it.each([
    ["unknown usage", { omitUsage: true }, "USAGE_UNKNOWN"],
    ["budget exhaustion", { tokens: 120_000 }, "BUDGET_BLOCKED"],
    ["API key authentication", { apiKey: true }, "PROVIDER_FAILED"],
    ["tool attempt", { toolAttempt: true }, "PROVIDER_FAILED"],
  ] as const)("stops on %s and does not repeat the provider turn", async (_name, options, reason) => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, options);
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: reason });
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
      await expect(executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies)).rejects.toThrow();
      expect(provider.launches).toHaveLength(1);
      expect(provider.requests.filter((request) => request.method === "turn/start")).toHaveLength("apiKey" in options ? 0 : 1);
    } finally { f.close(); }
  });

  it("refuses a reused Planner thread before the Reviewer turn starts", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, { duplicateThread: true });
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result.phase).toBe("HUMAN_REQUIRED");
      expect(provider.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    } finally { f.close(); }
  });
});
