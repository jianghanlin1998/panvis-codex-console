import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ContextItemSchema,
  ProjectSchema,
  SubtaskCreateInputSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import {
  ExecutionInputPreflight,
  openTaskDatabase,
  type TaskStorage,
} from "@codex-task-console/storage";
import {
  buildLiveCodexChildEnvironmentForTest,
  executeSingleSubtaskLiveCodexWithDependenciesForTest,
} from "../src/live-execution.js";
import { TESTED_CODEX_VERSION } from "../src/index.js";

type TestDependencies = Parameters<
  typeof executeSingleSubtaskLiveCodexWithDependenciesForTest
>[3];
type TestScenario =
  | "account-null"
  | "account-update-apikey-before-turn"
  | "account-update-apikey-during-turn"
  | "account-update-bedrock-before-turn"
  | "account-update-chatgpt-before-turn"
  | "account-update-malformed-before-turn"
  | "account-update-missing-before-turn"
  | "account-update-null-before-turn"
  | "account-update-unknown-before-turn"
  | "api-key"
  | "bedrock"
  | "command-approval"
  | "disconnect"
  | "duplicate-response"
  | "early-exit"
  | "file-approval"
  | "initialize-malformed"
  | "interrupt-failure"
  | "malformed-account"
  | "malformed-json"
  | "notification-overflow"
  | "oversized-jsonl"
  | "shutdown-hang"
  | "shutdown-needs-kill"
  | "shutdown-needs-term"
  | "stderr-secret"
  | "success"
  | "terminal-before-turn-identity"
  | "terminal-before-turn-start"
  | "terminal-conflicting"
  | "terminal-duplicate"
  | "terminal-duplicate-delayed"
  | "terminal-other-thread"
  | "terminal-other-turn"
  | "timeout"
  | "tool-action"
  | "turn-response-timeout"
  | "turn-failed"
  | "unknown-account"
  | "unknown-request"
  | "wrong-response-id";

const FIXED_GIT_DATE = "2026-08-29T00:00:00Z";
const PROJECT_ID = "prj_live_execution";
const BIG_TASK_ID = "bt_live_execution";
const SUBTASK_ID = SubtaskIdSchema.parse("st_live_execution");
const MOCK_LIVE_FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/mock-live-app-server.ts", import.meta.url),
);
const FAKE_OWNED_EXECUTABLE =
  "/owned/codex/0.148.0-alpha.9-aarch64-apple-darwin/bin/codex";
const BASE_LIMITS = Object.freeze({
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  turnTimeoutMs: 2_000,
  interruptTimeoutMs: 500,
  shutdownGraceMs: 500,
  terminateGraceMs: 500,
  maxJsonlLineBytes: 256 * 1_024,
  maxPendingRequests: 8,
  maxNotifications: 64,
  maxAgentResponseBytes: 4_096,
  maxStderrBytes: 128,
});

interface LaunchObservation {
  readonly arguments_: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly shell: false;
}

interface DependencyHarness {
  readonly children: ReturnType<typeof spawn>[];
  readonly dependencies: TestDependencies;
  readonly killSignals: Array<NodeJS.Signals | number | undefined>;
  readonly launches: LaunchObservation[];
  readonly workspaces: string[];
}

const liveChildren = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  liveChildren.clear();
});

describe.sequential("Single-Subtask Live Codex App Server Execution V0", () => {
  it("uses canonical preflight text byte-for-byte and maps the completed live result", async () => {
    await withFixtureStorage(async (storage) => {
      const expected = new ExecutionInputPreflight(
        storage,
      ).prepareExecutionInputForSubtask(
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
      );
      if (!expected.allowed) {
        throw new Error("Expected allowed fixture preflight.");
      }
      const harness = makeDependencies("success");
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      const expectedHash = createHash("sha256")
        .update(expected.text, "utf8")
        .digest("hex");

      expect(result).toMatchObject({
        success: true,
        failureCode: null,
        authType: "chatgpt",
        planType: "pro",
        terminalTurnStatus: "completed",
        threadPolicy: {
          approvalPolicy: "never",
          cwd: "DISPOSABLE_OS_TEMP",
          ephemeral: true,
          sandbox: "readOnly",
          networkAccess: false,
        },
        normalizedUsage: {
          inputTokens: 21,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningTokens: 1,
          totalTokens: 26,
        },
        diagnostics: {
          approvalRequestsDeclined: 0,
          interruptRequests: 0,
          toolActionsObserved: 0,
          turnStartRequests: 1,
          unknownNotificationsIgnored: 1,
        },
        appServerChildCleaned: true,
        disposableWorkspaceCleaned: true,
      });
      expect(result.agentResponseText).toBe(`CTC_MOCK_LIVE_OK:${expectedHash}`);
      expect(result.providerThread).toMatchObject({
        providerId: "codex-app-server",
        providerThreadId: "thread-live-mock-77",
      });
      expect(result.providerRun).toMatchObject({
        providerRunId: "turn-live-mock-88",
      });
      expect(result.model).toMatchObject({
        providerId: "codex-app-server",
        providerModelId: "fixture-live-model",
      });
      expect(harness.launches).toHaveLength(1);
      expect(harness.launches[0]).toMatchObject({
        executable: FAKE_OWNED_EXECUTABLE,
        arguments_: ["app-server", "--listen", "stdio://"],
        shell: false,
      });
      expect(harness.launches[0]?.cwd).not.toContain("panvis-codex-console");
      expect(harness.workspaces.every((path) => !path.includes("panvis-codex-console"))).toBe(
        true,
      );
      expect(harness.workspaces.every((path) => !existsSync(path))).toBe(true);
      expect(harness.children).toHaveLength(1);
      expect(
        harness.children[0]?.exitCode !== null ||
          harness.children[0]?.signalCode !== null,
      ).toBe(true);
      expect(harness.killSignals).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(
        /must-not-leak|fixture\/normal-home|fixture\/normal-codex-home/i,
      );
    });
  });

  it("has no caller text or preflight-result parameter on the trusted public operation", async () => {
    const { executeSingleSubtaskLiveCodex } = await import("../src/index.js");
    expect(executeSingleSubtaskLiveCodex).toHaveLength(3);
  });

  it("blocks HARD_CAP_EXCEEDED before process or model start", async () => {
    await withFixtureStorage(async (storage) => {
      addLargeActiveContext(storage);
      const harness = makeDependencies("success");
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PREFLIGHT_BLOCKED",
        preflight: { status: "HARD_CAP_EXCEEDED" },
        diagnostics: { turnStartRequests: 0 },
      });
      expect(harness.launches).toHaveLength(0);
    });
  });

  it("uses only an exact active owned .9 runtime and never ambient PATH authority", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("success", {
        sourceEnvironment: {
          PATH: "/attacker/bin",
          OPENAI_API_KEY: "openai-key-sentinel",
        },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result.success).toBe(true);
      expect(harness.launches[0]?.executable).toBe(FAKE_OWNED_EXECUTABLE);
      expect(harness.launches[0]?.env.PATH).toBe(
        "/usr/bin:/bin:/usr/sbin:/sbin",
      );
    });
  });

  it.each([
    ["wrong source", { source: "DEVELOPMENT_OVERRIDE" }],
    ["wrong exact version", { exactVersionOutput: "codex-cli 0.148.0-alpha.10" }],
    ["wrong release", { releaseVersion: "0.148.0-alpha.10" }],
    ["wrong target", { target: "x86_64-apple-darwin" }],
  ] as const)("blocks %s before launch", async (_name, override) => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("success", { runtimeOverride: override });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result.failureCode).toBe("ACTIVE_RUNTIME_REQUIRED");
      expect(result.diagnostics.turnStartRequests).toBe(0);
      expect(harness.launches).toHaveLength(0);
    });
  });

  it("blocks a missing active runtime before launch", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("success", { resolverThrows: true });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result.failureCode).toBe("ACTIVE_RUNTIME_REQUIRED");
      expect(harness.launches).toHaveLength(0);
    });
  });

  it.each([
    ["api-key", "CHATGPT_AUTH_REQUIRED"],
    ["bedrock", "CHATGPT_AUTH_REQUIRED"],
    ["account-null", "CHATGPT_AUTH_REQUIRED"],
    ["unknown-account", "CHATGPT_AUTH_REQUIRED"],
    ["malformed-account", "AUTH_RESPONSE_MALFORMED"],
  ] as const)("blocks %s auth before thread and turn start", async (scenario, code) => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies(scenario);
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: code,
        providerThread: null,
        providerRun: null,
        diagnostics: { turnStartRequests: 0 },
      });
      expect(JSON.stringify(result)).not.toMatch(/must-not-leak|example\.invalid/i);
    });
  });

  it("allows an exact chatgpt account/updated notification before the turn", async () => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, "account-update-chatgpt-before-turn");
      expect(result).toMatchObject({
        success: true,
        failureCode: null,
        authType: "chatgpt",
        diagnostics: { turnStartRequests: 1 },
      });
    });
  });

  it.each([
    ["account-update-apikey-before-turn", "CHATGPT_AUTH_REQUIRED"],
    ["account-update-bedrock-before-turn", "CHATGPT_AUTH_REQUIRED"],
    ["account-update-null-before-turn", "CHATGPT_AUTH_REQUIRED"],
    ["account-update-missing-before-turn", "AUTH_RESPONSE_MALFORMED"],
    ["account-update-malformed-before-turn", "AUTH_RESPONSE_MALFORMED"],
    ["account-update-unknown-before-turn", "AUTH_RESPONSE_MALFORMED"],
  ] as const)("blocks %s before turn/start", async (scenario, code) => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, scenario);
      expect(result).toMatchObject({
        success: false,
        failureCode: code,
        providerRun: null,
        diagnostics: { turnStartRequests: 0 },
      });
      expect(JSON.stringify(result)).not.toMatch(/must-not-leak|unknown-auth-mode/i);
    });
  });

  it("fails and interrupts at most once for an auth downgrade during the active turn", async () => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, "account-update-apikey-during-turn");
      expect(result).toMatchObject({
        success: false,
        failureCode: "CHATGPT_AUTH_REQUIRED",
        diagnostics: { interruptRequests: 1, turnStartRequests: 1 },
      });
      expect(result.providerRun?.providerRunId).toBe("turn-live-mock-88");
      expect(result.diagnostics.interruptRequests).toBeLessThanOrEqual(1);
    });
  });

  it.each([
    ["terminal-before-turn-start", 0],
    ["terminal-before-turn-identity", 1],
    ["terminal-other-thread", 1],
    ["terminal-other-turn", 1],
    ["terminal-duplicate", 1],
    ["terminal-duplicate-delayed", 1],
    ["terminal-conflicting", 1],
  ] as const)("rejects %s lifecycle authority", async (scenario, turnStartRequests) => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, scenario);
      expect(result).toMatchObject({
        success: false,
        failureCode: "APP_SERVER_PROTOCOL_ERROR",
        diagnostics: { turnStartRequests },
      });
    });
  });

  it("passes only the minimal auth-capable environment and removes key/token/secret/auth vars", () => {
    const environment = buildLiveCodexChildEnvironmentForTest(
      {
        LANG: "en_US.UTF-8",
        CODEX_HOME: "/normal/codex-home",
        OPENAI_API_KEY: "key-sentinel",
        OPENAI_ADMIN_KEY: "admin-sentinel",
        CUSTOM_TOKEN: "token-sentinel",
        SERVICE_SECRET: "secret-sentinel",
        PROVIDER_AUTH: "auth-sentinel",
        UNRELATED_VALUE: "unrelated-sentinel",
      },
      "/normal/home",
      "/private/tmp/ctc-live-test",
    );
    expect(environment).toEqual({
      HOME: "/normal/home",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/private/tmp/ctc-live-test",
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/normal/codex-home",
    });
  });

  it.each([
    ["initialize-malformed", "APP_SERVER_PROTOCOL_ERROR"],
    ["wrong-response-id", "APP_SERVER_PROTOCOL_ERROR"],
    ["duplicate-response", "APP_SERVER_PROTOCOL_ERROR"],
    ["early-exit", "APP_SERVER_EXITED"],
  ] as const)("fails closed for %s", async (scenario, code) => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, scenario);
      expect(result.failureCode).toBe(code);
      expect(result.diagnostics.turnStartRequests).toBe(0);
      expect(result.appServerChildCleaned).toBe(true);
    });
  });

  it("fails closed when process startup throws", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("success", { launcherThrows: true });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result.failureCode).toBe("APP_SERVER_START_FAILED");
      expect(result.disposableWorkspaceCleaned).toBe(true);
    });
  });

  it.each(["command-approval", "file-approval"] as const)(
    "declines and fails %s without accepting authority",
    async (scenario) => {
      await withFixtureStorage(async (storage) => {
        const result = await runScenario(storage, scenario);
        expect(result).toMatchObject({
          success: false,
          failureCode: "APPROVAL_REQUESTED",
          diagnostics: {
            approvalRequestsDeclined: 1,
            serverRequestsReceived: 1,
            turnStartRequests: 1,
          },
        });
      });
    },
  );

  it("fails closed on an unexpected authority-bearing server request", async () => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, "unknown-request");
      expect(result).toMatchObject({
        failureCode: "UNEXPECTED_SERVER_REQUEST",
        diagnostics: { serverRequestsReceived: 1 },
      });
    });
  });

  it("fails when the model attempts any tool action", async () => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, "tool-action");
      expect(result).toMatchObject({
        failureCode: "TOOL_ACTION_ATTEMPTED",
        diagnostics: { toolActionsObserved: 1 },
      });
    });
  });

  it("times out once, interrupts once, and never retries the real turn", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("timeout", {
        limits: { turnTimeoutMs: 30 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "APP_SERVER_TIMEOUT",
        diagnostics: { interruptRequests: 1, turnStartRequests: 1 },
        appServerChildCleaned: true,
        disposableWorkspaceCleaned: true,
      });
      expect(harness.children).toHaveLength(1);
      expect(
        harness.children[0]?.exitCode !== null ||
          harness.children[0]?.signalCode !== null,
      ).toBe(true);
      expect(harness.workspaces.every((path) => !existsSync(path))).toBe(true);
    });
  });

  it("does not retry when turn/start times out after the request is sent", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("turn-response-timeout", {
        limits: { requestTimeoutMs: 500 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "APP_SERVER_TIMEOUT",
        providerRun: null,
        diagnostics: { interruptRequests: 0, turnStartRequests: 1 },
        appServerChildCleaned: true,
        disposableWorkspaceCleaned: true,
      });
    });
  });

  it("preserves the original turn timeout when the one interrupt fails", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("interrupt-failure", {
        limits: { turnTimeoutMs: 30 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "APP_SERVER_TIMEOUT",
        diagnostics: { interruptRequests: 1, turnStartRequests: 1 },
        appServerChildCleaned: true,
        disposableWorkspaceCleaned: true,
      });
    });
  });

  it.each([
    ["shutdown-needs-term", ["SIGTERM"]],
    ["shutdown-needs-kill", ["SIGTERM", "SIGKILL"]],
  ] as const)("uses bounded shutdown fallback for %s", async (scenario, signals) => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies(scenario, {
        limits: { shutdownGraceMs: 30, terminateGraceMs: 30 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: true,
        diagnostics: { turnStartRequests: 1 },
        appServerChildCleaned: true,
        disposableWorkspaceCleaned: true,
      });
      expect(harness.killSignals).toEqual(signals);
      expect(
        harness.children[0]?.exitCode !== null ||
          harness.children[0]?.signalCode !== null,
      ).toBe(true);
      expect(harness.workspaces.every((path) => !existsSync(path))).toBe(true);
    });
  });

  it("fails closed when bounded direct-child shutdown cannot clean the child", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("shutdown-hang", {
        ignoredKillAttempts: 2,
        limits: { shutdownGraceMs: 20, terminateGraceMs: 20 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PROCESS_CLEANUP_FAILED",
        diagnostics: { turnStartRequests: 1 },
        appServerChildCleaned: false,
        disposableWorkspaceCleaned: true,
      });
      expect(harness.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(harness.workspaces.every((path) => !existsSync(path))).toBe(true);
    });
  });

  it("fails closed and reports a disposable-workspace cleanup failure", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("success", {
        removeWorkspaceThrows: true,
      });
      try {
        const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
          storage,
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
          harness.dependencies,
        );
        expect(result).toMatchObject({
          success: false,
          failureCode: "WORKSPACE_CLEANUP_FAILED",
          appServerChildCleaned: true,
          disposableWorkspaceCleaned: false,
        });
      } finally {
        for (const workspace of harness.workspaces) {
          rmSync(workspace, { force: true, recursive: true });
        }
      }
    });
  });

  it.each([
    ["malformed-json", "APP_SERVER_PROTOCOL_ERROR"],
    ["oversized-jsonl", "JSONL_LIMIT_EXCEEDED"],
    ["disconnect", "APP_SERVER_EXITED"],
    ["turn-failed", "TURN_FAILED"],
  ] as const)("sanitizes %s failure", async (scenario, code) => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, scenario);
      expect(result.failureCode).toBe(code);
      expect(result.diagnostics.turnStartRequests).toBe(1);
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic failure|malformed-live-json|RAW_PROVIDER/i,
      );
    });
  });

  it("bounds unknown notifications", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("notification-overflow", {
        limits: { maxNotifications: 5 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result.failureCode).toBe("JSONL_LIMIT_EXCEEDED");
      expect(result.diagnostics.turnStartRequests).toBe(1);
    });
  });

  it("bounds accumulated agent response bytes", async () => {
    await withFixtureStorage(async (storage) => {
      const harness = makeDependencies("success", {
        limits: { maxAgentResponseBytes: 16 },
      });
      const result = await executeSingleSubtaskLiveCodexWithDependenciesForTest(
        storage,
        SUBTASK_ID,
        "STANDARD_SUBTASK_EXECUTION",
        harness.dependencies,
      );
      expect(result.failureCode).toBe("AGENT_RESPONSE_LIMIT_EXCEEDED");
      expect(result.agentResponseText).toBeNull();
    });
  });

  it("never exposes retained provider stderr", async () => {
    await withFixtureStorage(async (storage) => {
      const result = await runScenario(storage, "stderr-secret");
      expect(result.success).toBe(true);
      expect(JSON.stringify(result)).not.toContain("RAW_PROVIDER_SECRET_SENTINEL");
    });
  });
});

async function runScenario(storage: TaskStorage, scenario: TestScenario) {
  const harness = makeDependencies(
    scenario,
    scenario === "oversized-jsonl"
      ? { limits: { maxJsonlLineBytes: 16_384 } }
      : {},
  );
  return executeSingleSubtaskLiveCodexWithDependenciesForTest(
    storage,
    SUBTASK_ID,
    "STANDARD_SUBTASK_EXECUTION",
    harness.dependencies,
  );
}

function makeDependencies(
  scenario: TestScenario,
  options: {
    readonly ignoredKillAttempts?: number;
    readonly launcherThrows?: boolean;
    readonly limits?: Partial<TestDependencies["limits"]>;
    readonly removeWorkspaceThrows?: boolean;
    readonly resolverThrows?: boolean;
    readonly runtimeOverride?: Partial<ReturnType<TestDependencies["resolveRuntime"]>>;
    readonly sourceEnvironment?: NodeJS.ProcessEnv;
  } = {},
): DependencyHarness {
  const children: ReturnType<typeof spawn>[] = [];
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const launches: LaunchObservation[] = [];
  const workspaces: string[] = [];
  const runtime = {
    canonicalExecutablePath: FAKE_OWNED_EXECUTABLE,
    exactVersionOutput: TESTED_CODEX_VERSION,
    executable: true as const,
    readable: true as const,
    releaseVersion: "0.148.0-alpha.9",
    source: "OWNED_RELEASE" as const,
    target: "aarch64-apple-darwin" as const,
    ...options.runtimeOverride,
  } as ReturnType<TestDependencies["resolveRuntime"]>;

  const dependencies: TestDependencies = {
    resolveRuntime: () => {
      if (options.resolverThrows === true) {
        throw new Error("synthetic resolver failure");
      }
      return runtime;
    },
    spawnAppServer: (executable, arguments_, spawnOptions) => {
      if (options.launcherThrows === true) {
        throw new Error("synthetic launcher failure");
      }
      launches.push({
        executable,
        arguments_: [...arguments_],
        cwd: spawnOptions.cwd,
        env: { ...spawnOptions.env },
        shell: spawnOptions.shell,
      });
      const child = spawn(
        process.execPath,
        [MOCK_LIVE_FIXTURE_PATH, `--scenario=${scenario}`],
        spawnOptions,
      );
      children.push(child);
      const killChild = child.kill.bind(child);
      child.kill = ((signal?: NodeJS.Signals | number) => {
        killSignals.push(signal);
        if (killSignals.length <= (options.ignoredKillAttempts ?? 0)) {
          return false;
        }
        return killChild(signal);
      }) as typeof child.kill;
      liveChildren.add(child);
      child.once("close", () => liveChildren.delete(child));
      return child;
    },
    sourceEnvironment: options.sourceEnvironment ?? {
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/fixture/normal-codex-home",
      OPENAI_API_KEY: "must-not-pass-openai-key",
      OPENAI_ADMIN_KEY: "must-not-pass-admin-key",
      CUSTOM_TOKEN: "must-not-pass-token",
    },
    normalHomeDirectory: "/fixture/normal-home",
    createWorkspace: () => {
      const workspace = mkdtempSync(
        join(realpathSync(tmpdir()), "ctc-live-test-workspace-"),
      );
      chmodSync(workspace, 0o700);
      workspaces.push(workspace);
      return workspace;
    },
    removeWorkspace: (workspace) => {
      if (options.removeWorkspaceThrows === true) {
        throw new Error("synthetic workspace cleanup failure");
      }
      rmSync(workspace, { force: true, recursive: true });
    },
    limits: { ...BASE_LIMITS, ...options.limits },
  };
  return { children, dependencies, killSignals, launches, workspaces };
}

async function withFixtureStorage<T>(
  operation: (storage: TaskStorage) => Promise<T>,
): Promise<T> {
  const repositoryPath = mkdtempSync(join(tmpdir(), "ctc-live-test-repository-"));
  const storage = openTaskDatabase({
    databasePath: ":memory:",
    clock: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  try {
    initializeSyntheticRepository(repositoryPath);
    seedHierarchy(storage, repositoryPath);
    return await operation(storage);
  } finally {
    storage.close();
    rmSync(repositoryPath, { force: true, recursive: true });
  }
}

function initializeSyntheticRepository(repositoryPath: string): void {
  runGit(repositoryPath, ["init", "--initial-branch", "main"]);
  writeFileSync(join(repositoryPath, "AGENTS.md"), "# Live mock rules\n", {
    encoding: "utf8",
  });
  writeFileSync(join(repositoryPath, "tracked.txt"), "live fixture\n", {
    encoding: "utf8",
  });
  runGit(repositoryPath, ["add", "--all"]);
  runGit(repositoryPath, ["commit", "--message", "live fixture"]);
  const head = runGit(repositoryPath, ["rev-parse", "HEAD"]);
  runGit(repositoryPath, ["update-ref", "refs/remotes/origin/main", head]);
}

function runGit(repositoryPath: string, arguments_: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repositoryPath,
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXED_GIT_DATE,
        GIT_AUTHOR_EMAIL: "live-fixture@example.invalid",
        GIT_AUTHOR_NAME: "Live Execution Fixture",
        GIT_COMMITTER_DATE: FIXED_GIT_DATE,
        GIT_COMMITTER_EMAIL: "live-fixture@example.invalid",
        GIT_COMMITTER_NAME: "Live Execution Fixture",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trimEnd();
}

function seedHierarchy(storage: TaskStorage, repositoryPath: string): void {
  storage.createProject(
    ProjectSchema.parse({
      recordType: "PROJECT",
      id: PROJECT_ID,
      name: "Live Execution Fixture",
      slug: "live-execution-fixture",
      repository: { kind: "PATH", path: repositoryPath },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 1,
    }),
  );
  storage.createBigTask(
    BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: BIG_TASK_ID,
      projectId: PROJECT_ID,
      title: "Exercise bounded live execution",
      goal: "Prove the trusted one-turn App Server path.",
      rationale: "Deterministic mock coverage precedes the authorized smoke.",
      scopeIn: ["One ephemeral read-only turn"],
      scopeOut: ["Persistence", "worktrees", "orchestration"],
      acceptanceCriteria: ["One bounded turn completes"],
      status: "IN_PROGRESS",
    }),
  );
  storage.createSubtask(
    SubtaskCreateInputSchema.parse({
      recordType: "SUBTASK",
      id: SUBTASK_ID,
      bigTaskId: BIG_TASK_ID,
      title: "Return the live smoke marker",
      goal: "Return the marker CTC_LIVE_SMOKE_OK and perform no other action.",
      scopeIn: ["Return one marker"],
      scopeOut: ["File, command, tool, and network actions"],
      acceptanceCriteria: ["Response contains CTC_LIVE_SMOKE_OK"],
      untouchedAreas: ["All files and external systems"],
      status: "TODO",
      maturity: "NOT_STARTED",
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "LOW",
      promptSeed:
        "Return the marker CTC_LIVE_SMOKE_OK. Do not inspect files, call tools, modify anything, or perform network/tool actions.",
    }),
  );
}

function addLargeActiveContext(storage: TaskStorage): void {
  for (let index = 0; index < 20; index += 1) {
    storage.createContextItem(
      ContextItemSchema.parse({
        id: `ctx_live_large_${index}`,
        projectId: PROJECT_ID,
        kind: "ENGINEERING_FACT",
        status: "ACTIVE",
        authority: "REPO_EVIDENCE",
        title: `Large live fixture ${index}`,
        body: `LIVE_LARGE_${index}_${"x".repeat(3_750)}`,
        provenance: {
          sourceType: "REPO",
          sourceReference: `repository#live-large-${index}`,
          effectiveAt: "2026-08-29T00:00:00.000Z",
        },
      }),
    );
  }
}
