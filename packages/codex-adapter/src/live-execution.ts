import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import type {
  ChatThreadId,
  ExecutionRunId,
  NormalizedUsage,
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
  RepositoryCommitSha,
  SubtaskId,
  WorktreeOwnershipId,
} from "@codex-task-console/domain";
import {
  ChatThreadIdSchema,
  ExecutionRunIdSchema,
} from "@codex-task-console/domain";
import {
  createWorktreeOwnershipManager,
  ExecutionInputPreflight,
  type ExecutionInputPreflightResult,
  type OperationalJitContextProfile,
  type ResolvedActiveOwnedWorktree,
  TaskStorage,
} from "@codex-task-console/storage";

import { TESTED_CODEX_VERSION } from "./compatibility.js";
import { checkOwnedCodexCompatibility } from "./c-lite-compatibility.js";
import {
  CODEX_APP_SERVER_PROVIDER_ID,
  mapCodexModelReference,
  mapCodexThreadReference,
  mapCodexTokenUsage,
  mapCodexTurnReference,
} from "./provider.js";
import { resolveActiveOwnedCodexRuntime } from "./runtime-ownership.js";
import type {
  CodexRuntimeTarget,
  ResolvedCodexRuntime,
} from "./runtime-ownership.js";
import type { JsonObject, JsonValue, TokenUsageBreakdown } from "./protocol.js";
import { validateOwnedWorktreeHardlinkSafety } from "./worktree-filesystem-safety.js";

const EXPECTED_RELEASE_VERSION = TESTED_CODEX_VERSION.replace("codex-cli ", "");
const CLIENT_INFO = Object.freeze({
  name: "codex_task_console",
  title: "Codex Task Console",
  version: "0.1.0",
});
const WORKSPACE_PREFIX = "ctc-live-codex-";
const WRITE_RUNTIME_PREFIX = "ctc-write-codex-";
const SAFE_CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const WRITE_DISABLED_FEATURES = Object.freeze([
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_updates",
  "multi_agent",
  "multi_agent_v2",
  "plugin_sharing",
  "plugins",
  "recommended_plugins",
  "remote_control",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "workspace_dependencies",
] as const);
const ACCOUNT_UPDATED_AUTH_MODES = [
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "headers",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey",
] as const;
const ACCOUNT_UPDATED_PLAN_TYPES = [
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
] as const;
const TURN_SCOPED_NOTIFICATION_METHODS = new Set([
  "turn/started",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "thread/tokenUsage/updated",
  "turn/completed",
]);
const MAX_WRITE_TOOL_ITEMS = 512;

const DEFAULT_LIMITS = Object.freeze({
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  turnTimeoutMs: 120_000,
  interruptTimeoutMs: 3_000,
  shutdownGraceMs: 2_000,
  terminateGraceMs: 2_000,
  maxJsonlLineBytes: 1024 * 1024,
  maxPendingRequests: 8,
  maxNotifications: 2_000,
  maxAgentResponseBytes: 16 * 1024,
  maxStderrBytes: 16 * 1024,
});

export const LIVE_CODEX_EXECUTION_FAILURE_CODES = [
  "INVALID_INPUT",
  "PREFLIGHT_FAILED",
  "PREFLIGHT_BLOCKED",
  "ACTIVE_RUNTIME_REQUIRED",
  "APP_SERVER_START_FAILED",
  "APP_SERVER_PROTOCOL_ERROR",
  "APP_SERVER_TIMEOUT",
  "APP_SERVER_EXITED",
  "JSONL_LIMIT_EXCEEDED",
  "CHATGPT_AUTH_REQUIRED",
  "AUTH_RESPONSE_MALFORMED",
  "EPHEMERAL_THREAD_REQUIRED",
  "READ_ONLY_POLICY_REQUIRED",
  "TURN_FAILED",
  "TURN_INTERRUPTED",
  "TERMINAL_EVENT_REQUIRED",
  "AGENT_RESPONSE_LIMIT_EXCEEDED",
  "APPROVAL_REQUESTED",
  "TOOL_ACTION_ATTEMPTED",
  "UNEXPECTED_SERVER_REQUEST",
  "PROCESS_CLEANUP_FAILED",
  "WORKSPACE_CLEANUP_FAILED",
] as const;

export type LiveCodexExecutionFailureCode =
  (typeof LIVE_CODEX_EXECUTION_FAILURE_CODES)[number];

export const OWNED_WORKTREE_CODEX_EXECUTION_FAILURE_CODES = [
  ...LIVE_CODEX_EXECUTION_FAILURE_CODES,
  "ACTIVE_WORKTREE_REQUIRED",
  "WORKTREE_AUTHORITY_DRIFT",
  "DURABLE_THREAD_PERSISTENCE_FAILED",
  "DURABLE_RUN_PERSISTENCE_FAILED",
  "PRIMARY_EXECUTION_CONFLICT",
  "WRITE_POLICY_REQUIRED",
  "WORKTREE_FILESYSTEM_UNSAFE",
] as const;

export type OwnedWorktreeCodexExecutionFailureCode =
  (typeof OWNED_WORKTREE_CODEX_EXECUTION_FAILURE_CODES)[number];

type CodexExecutionFailureCode = OwnedWorktreeCodexExecutionFailureCode;

export interface LiveCodexExecutionDiagnostics {
  readonly approvalRequestsDeclined: number;
  readonly interruptRequests: number;
  readonly notificationsReceived: number;
  readonly serverRequestsReceived: number;
  readonly toolActionsObserved: number;
  readonly turnStartRequests: number;
  readonly unknownNotificationsIgnored: number;
}

interface RuntimeSummary {
  readonly exactVersion: typeof TESTED_CODEX_VERSION;
  readonly releaseVersion: string;
  readonly target: CodexRuntimeTarget;
}

interface PreflightSummary {
  readonly profile: OperationalJitContextProfile;
  readonly status: ExecutionInputPreflightResult["status"];
  readonly utf8Bytes: number;
}

interface LiveThreadPolicy {
  readonly approvalPolicy: "never";
  readonly cwd: "DISPOSABLE_OS_TEMP";
  readonly ephemeral: true;
  readonly sandbox: "readOnly";
  readonly networkAccess: false;
}

interface OwnedWorktreeThreadPolicy {
  readonly approvalPolicy: "never";
  readonly cwd: "TRUSTED_ACTIVE_OWNED_WORKTREE";
  readonly ephemeral: true;
  readonly sandbox: "workspaceWrite";
  readonly writableRootCount: 1;
  readonly networkAccess: false;
}

interface LiveCodexExecutionResultBase {
  readonly providerId: typeof CODEX_APP_SERVER_PROVIDER_ID;
  readonly runtime: RuntimeSummary | null;
  readonly authType: "chatgpt" | null;
  readonly planType: string | null;
  readonly preflight: PreflightSummary | null;
  readonly providerThread: ProviderThreadReference | null;
  readonly providerRun: ProviderRunReference | null;
  readonly model: ProviderModelReference | null;
  readonly normalizedUsage: NormalizedUsage | null;
  readonly terminalTurnStatus: "completed" | "failed" | "interrupted" | null;
  readonly threadPolicy: LiveThreadPolicy | null;
  readonly diagnostics: LiveCodexExecutionDiagnostics;
  readonly appServerChildCleaned: boolean;
  readonly disposableWorkspaceCleaned: boolean;
}

export interface LiveCodexExecutionSuccess extends LiveCodexExecutionResultBase {
  readonly success: true;
  readonly failureCode: null;
  readonly agentResponseText: string;
}

export interface LiveCodexExecutionFailure extends LiveCodexExecutionResultBase {
  readonly success: false;
  readonly failureCode: LiveCodexExecutionFailureCode;
  readonly agentResponseText: null;
}

export type LiveCodexExecutionResult =
  | LiveCodexExecutionSuccess
  | LiveCodexExecutionFailure;

interface OwnedWorktreeCodexExecutionResultBase {
  readonly providerId: typeof CODEX_APP_SERVER_PROVIDER_ID;
  readonly runtime: RuntimeSummary | null;
  readonly authType: "chatgpt" | null;
  readonly planType: string | null;
  readonly preflight: PreflightSummary | null;
  readonly chatThreadId: ChatThreadId | null;
  readonly executionRunId: ExecutionRunId | null;
  readonly providerThread: ProviderThreadReference | null;
  readonly providerRun: ProviderRunReference | null;
  readonly model: ProviderModelReference | null;
  readonly normalizedUsage: NormalizedUsage | null;
  readonly terminalTurnStatus: "completed" | "failed" | "interrupted" | null;
  readonly worktreeOwnershipId: WorktreeOwnershipId | null;
  readonly worktreeStartingHeadSha: RepositoryCommitSha | null;
  readonly threadPolicy: OwnedWorktreeThreadPolicy | null;
  readonly diagnostics: LiveCodexExecutionDiagnostics;
  readonly appServerChildCleaned: boolean;
  readonly transientRuntimeCleaned: boolean;
}

export interface OwnedWorktreeCodexExecutionSuccess
  extends OwnedWorktreeCodexExecutionResultBase {
  readonly success: true;
  readonly failureCode: null;
}

export interface OwnedWorktreeCodexExecutionFailure
  extends OwnedWorktreeCodexExecutionResultBase {
  readonly success: false;
  readonly failureCode: OwnedWorktreeCodexExecutionFailureCode;
}

export type OwnedWorktreeCodexExecutionResult =
  | OwnedWorktreeCodexExecutionSuccess
  | OwnedWorktreeCodexExecutionFailure;

interface MutableDiagnostics {
  approvalRequestsDeclined: number;
  interruptRequests: number;
  notificationsReceived: number;
  serverRequestsReceived: number;
  toolActionsObserved: number;
  turnStartRequests: number;
  unknownNotificationsIgnored: number;
}

interface ExecutionEvidence {
  runtime: RuntimeSummary | null;
  authType: "chatgpt" | null;
  planType: string | null;
  preflight: PreflightSummary | null;
  providerThread: ProviderThreadReference | null;
  providerRun: ProviderRunReference | null;
  model: ProviderModelReference | null;
  normalizedUsage: NormalizedUsage | null;
  terminalTurnStatus: "completed" | "failed" | "interrupted" | null;
  threadPolicy: LiveThreadPolicy | null;
  agentResponseText: string;
  appServerChildCleaned: boolean;
  disposableWorkspaceCleaned: boolean;
}

interface OwnedWorktreeExecutionEvidence {
  runtime: RuntimeSummary | null;
  authType: "chatgpt" | null;
  planType: string | null;
  preflight: PreflightSummary | null;
  chatThreadId: ChatThreadId | null;
  executionRunId: ExecutionRunId | null;
  providerThread: ProviderThreadReference | null;
  providerRun: ProviderRunReference | null;
  model: ProviderModelReference | null;
  normalizedUsage: NormalizedUsage | null;
  terminalTurnStatus: "completed" | "failed" | "interrupted" | null;
  worktreeOwnershipId: WorktreeOwnershipId | null;
  worktreeStartingHeadSha: RepositoryCommitSha | null;
  threadPolicy: OwnedWorktreeThreadPolicy | null;
  appServerChildCleaned: boolean;
  transientRuntimeCleaned: boolean;
}

interface LiveExecutionLimits {
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly interruptTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly terminateGraceMs: number;
  readonly maxJsonlLineBytes: number;
  readonly maxPendingRequests: number;
  readonly maxNotifications: number;
  readonly maxAgentResponseBytes: number;
  readonly maxStderrBytes: number;
}

interface SpawnAppServerOptions extends SpawnOptionsWithoutStdio {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ["pipe", "pipe", "pipe"];
}

type SpawnAppServer = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnAppServerOptions,
) => ChildProcessWithoutNullStreams;

interface LiveExecutionDependencies {
  readonly resolveRuntime: () => ResolvedCodexRuntime;
  readonly spawnAppServer: SpawnAppServer;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly normalHomeDirectory: string;
  readonly createWorkspace: () => string;
  readonly removeWorkspace: (workspace: string) => void;
  readonly limits: LiveExecutionLimits;
}

type DurableOperation =
  | "RESERVE_ATTEMPT"
  | "BIND_THREAD"
  | "START_RUN"
  | "FINALIZE_ATTEMPT";

type WorktreeAuthorityGate =
  | "INITIAL_HARDLINK_SCAN"
  | "PRE_SPAWN_REVALIDATION"
  | "FINAL_PRE_TURN_HARDLINK_SCAN"
  | "POST_TURN_SUCCESS_GATE";

interface OwnedWorktreeExecutionDependencies extends LiveExecutionDependencies {
  readonly checkCompatibility: () => boolean;
  readonly resolveOwnedWorktree: (
    storage: TaskStorage,
    subtaskId: SubtaskId,
  ) => ResolvedActiveOwnedWorktree;
  readonly generateChatThreadId: () => ChatThreadId;
  readonly generateExecutionRunId: () => ExecutionRunId;
  readonly validateWorktreeFilesystem: (worktreePath: string) => void;
  readonly beforeDurableOperation?: (operation: DurableOperation) => void;
  readonly afterDurableOperation?: (operation: DurableOperation) => void;
  readonly beforeWorktreeAuthorityGate?: (gate: WorktreeAuthorityGate) => void;
}

class LiveExecutionError extends Error {
  readonly code: CodexExecutionFailureCode;

  constructor(code: CodexExecutionFailureCode) {
    super(code);
    this.name = "LiveExecutionError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly onResult: ((result: JsonValue) => void) | undefined;
  readonly reject: (error: LiveExecutionError) => void;
  readonly resolve: (result: JsonValue) => void;
  readonly timeout: NodeJS.Timeout;
}

interface RequestHooks {
  readonly onResult?: (result: JsonValue) => void;
  readonly onSent?: () => void;
}

interface TerminalEvent {
  readonly status: "completed" | "failed" | "interrupted";
}

interface WriteToolItemState {
  readonly type: "commandExecution" | "fileChange";
  state: "STARTED" | "COMPLETED";
}

type TurnEventPolicy =
  | Readonly<{ readonly kind: "READ_ONLY" }>
  | Readonly<{
      readonly kind: "WORKSPACE_WRITE";
      readonly worktreePath: string;
    }>;

class TurnEventTracker {
  threadId: string | null = null;
  turnId: string | null = null;
  terminal: TerminalEvent | null = null;
  normalizedUsage: NormalizedUsage | null = null;
  responseText = "";
  #chatGptAuthenticated = false;
  readonly #deltaItemIds = new Set<string>();
  readonly #writeToolItems = new Map<string, WriteToolItemState>();
  #failure: LiveExecutionError | null = null;
  #observedThreadId: string | null = null;
  #observedTurnId: string | null = null;
  #turnStartSent = false;
  #waiter:
    | {
        readonly reject: (error: LiveExecutionError) => void;
        readonly resolve: (event: TerminalEvent) => void;
      }
    | undefined;

  constructor(
    private readonly diagnostics: MutableDiagnostics,
    private readonly maxAgentResponseBytes: number,
    private readonly eventPolicy: TurnEventPolicy = { kind: "READ_ONLY" },
  ) {}

  fail(error: LiveExecutionError): void {
    if (this.#failure !== null) {
      return;
    }
    this.#failure = error;
    this.#waiter?.reject(error);
    this.#waiter = undefined;
  }

  establishChatGptAuth(): void {
    this.#chatGptAuthenticated = true;
  }

  assertChatGptAuthenticated(): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
    if (!this.#chatGptAuthenticated) {
      throw new LiveExecutionError("CHATGPT_AUTH_REQUIRED");
    }
  }

  handleNotification(method: string, params: unknown): boolean {
    if (
      method !== "thread/started" &&
      method !== "turn/started" &&
      method !== "item/started" &&
      method !== "item/completed" &&
      method !== "item/agentMessage/delta" &&
      method !== "item/commandExecution/outputDelta" &&
      method !== "item/fileChange/outputDelta" &&
      method !== "item/fileChange/patchUpdated" &&
      method !== "thread/tokenUsage/updated" &&
      method !== "turn/completed" &&
      method !== "serverRequest/resolved" &&
      method !== "account/updated"
    ) {
      return false;
    }
    if (method === "account/updated") {
      try {
        const record = requireRecordForCode(params, "AUTH_RESPONSE_MALFORMED");
        const authMode = parseAccountUpdatedNotification(record);
        if (authMode !== "chatgpt") {
          this.#chatGptAuthenticated = false;
          this.fail(new LiveExecutionError("CHATGPT_AUTH_REQUIRED"));
        }
      } catch (error: unknown) {
        this.#chatGptAuthenticated = false;
        this.fail(asLiveExecutionError(error));
      }
      return true;
    }
    if (
      this.terminal !== null &&
      TURN_SCOPED_NOTIFICATION_METHODS.has(method)
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    const record = requireRecord(params);
    switch (method) {
      case "thread/started": {
        const thread = requireRecord(record.thread);
        const threadId = requireBoundedString(thread.id, 512);
        if (thread.ephemeral !== true) {
          throw new LiveExecutionError("EPHEMERAL_THREAD_REQUIRED");
        }
        this.#observeNotificationThreadId(threadId);
        return true;
      }
      case "turn/started": {
        this.#requireTurnStartSent();
        this.#observeNotificationThreadId(
          requireBoundedString(record.threadId, 512),
        );
        const turn = requireRecord(record.turn);
        this.#observeNotificationTurnId(requireBoundedString(turn.id, 512));
        if (turn.status !== "inProgress") {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        return true;
      }
      case "item/started":
      case "item/completed": {
        this.#requireTurnStartSent();
        this.#observeNotificationThreadId(
          requireBoundedString(record.threadId, 512),
        );
        this.#observeNotificationTurnId(
          requireBoundedString(record.turnId, 512),
        );
        const item = requireRecord(record.item);
        const itemType = requireBoundedString(item.type, 64);
        if (itemType === "commandExecution" || itemType === "fileChange") {
          if (this.eventPolicy.kind === "READ_ONLY") {
            this.diagnostics.toolActionsObserved += 1;
            throw new LiveExecutionError("TOOL_ACTION_ATTEMPTED");
          }
          this.#observeWriteToolItem(
            method,
            item,
            itemType,
            this.eventPolicy.worktreePath,
          );
        } else if (
          itemType !== "userMessage" &&
          itemType !== "agentMessage" &&
          itemType !== "plan" &&
          itemType !== "reasoning"
        ) {
          this.diagnostics.toolActionsObserved += 1;
          throw new LiveExecutionError("TOOL_ACTION_ATTEMPTED");
        }
        if (
          method === "item/started" &&
          "status" in item &&
          item.status !== "inProgress"
        ) {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        if (
          method === "item/completed" &&
          "status" in item &&
          item.status === "inProgress"
        ) {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        if (method === "item/completed" && itemType === "agentMessage") {
          const itemId = requireBoundedString(item.id, 512);
          if (!this.#deltaItemIds.has(itemId)) {
            this.#appendAgentText(requireString(item.text));
          }
        }
        return true;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated": {
        this.#requireTurnStartSent();
        this.#observeNotificationThreadId(
          requireBoundedString(record.threadId, 512),
        );
        this.#observeNotificationTurnId(
          requireBoundedString(record.turnId, 512),
        );
        const itemId = requireBoundedString(record.itemId, 512);
        if (this.eventPolicy.kind === "READ_ONLY") {
          this.diagnostics.toolActionsObserved += 1;
          throw new LiveExecutionError("TOOL_ACTION_ATTEMPTED");
        }
        const expectedType =
          method === "item/commandExecution/outputDelta"
            ? "commandExecution"
            : "fileChange";
        this.#assertActiveWriteToolItem(itemId, expectedType);
        if (method === "item/fileChange/patchUpdated") {
          validateFileChanges(record.changes, this.eventPolicy.worktreePath);
        } else if (typeof record.delta !== "string") {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        return true;
      }
      case "item/agentMessage/delta": {
        this.#requireTurnStartSent();
        this.#observeNotificationThreadId(
          requireBoundedString(record.threadId, 512),
        );
        this.#observeNotificationTurnId(
          requireBoundedString(record.turnId, 512),
        );
        const itemId = requireBoundedString(record.itemId, 512);
        this.#deltaItemIds.add(itemId);
        this.#appendAgentText(requireString(record.delta));
        return true;
      }
      case "thread/tokenUsage/updated": {
        this.#requireTurnStartSent();
        this.#observeNotificationThreadId(
          requireBoundedString(record.threadId, 512),
        );
        this.#observeNotificationTurnId(
          requireBoundedString(record.turnId, 512),
        );
        const tokenUsage = requireRecord(record.tokenUsage);
        this.normalizedUsage = mapCodexTokenUsage(
          parseTokenUsageBreakdown(requireRecord(tokenUsage.total)),
        );
        return true;
      }
      case "turn/completed": {
        if (
          !this.#turnStartSent ||
          this.threadId === null ||
          this.turnId === null ||
          this.terminal !== null ||
          [...this.#writeToolItems.values()].some(
            (item) => item.state !== "COMPLETED",
          )
        ) {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        this.#assertAuthorizedThreadId(
          requireBoundedString(record.threadId, 512),
        );
        const turn = requireRecord(record.turn);
        this.#assertAuthorizedTurnId(requireBoundedString(turn.id, 512));
        const status = turn.status;
        if (
          status !== "completed" &&
          status !== "failed" &&
          status !== "interrupted"
        ) {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        this.terminal = { status };
        this.#waiter?.resolve(this.terminal);
        this.#waiter = undefined;
        return true;
      }
      case "serverRequest/resolved":
        this.#observeNotificationThreadId(
          requireBoundedString(record.threadId, 512),
        );
        if (
          typeof record.requestId !== "number" &&
          typeof record.requestId !== "string"
        ) {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        return true;
      default:
        return false;
    }
  }

  observeThreadResponse(threadId: string): void {
    if (
      this.threadId !== null ||
      (this.#observedThreadId !== null && this.#observedThreadId !== threadId)
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    this.threadId = threadId;
  }

  observeTurnStartSent(threadId: string): void {
    this.assertChatGptAuthenticated();
    this.#assertAuthorizedThreadId(threadId);
    if (this.#turnStartSent) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    this.#turnStartSent = true;
  }

  observeTurnResponse(turnId: string): void {
    this.#requireTurnStartSent();
    if (
      this.turnId !== null ||
      (this.#observedTurnId !== null && this.#observedTurnId !== turnId) ||
      this.terminal !== null
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    this.turnId = turnId;
  }

  waitForTerminal(timeoutMs: number): Promise<TerminalEvent> {
    if (this.#failure !== null) {
      return Promise.reject(this.#failure);
    }
    if (this.terminal !== null) {
      return Promise.resolve(this.terminal);
    }
    return new Promise<TerminalEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#waiter !== undefined) {
          this.#waiter = undefined;
          reject(new LiveExecutionError("APP_SERVER_TIMEOUT"));
        }
      }, timeoutMs);
      this.#waiter = {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
      };
    });
  }

  #observeNotificationThreadId(threadId: string): void {
    if (
      (this.threadId !== null && this.threadId !== threadId) ||
      (this.#observedThreadId !== null && this.#observedThreadId !== threadId)
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    this.#observedThreadId = threadId;
  }

  #observeNotificationTurnId(turnId: string): void {
    if (
      (this.turnId !== null && this.turnId !== turnId) ||
      (this.#observedTurnId !== null && this.#observedTurnId !== turnId)
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    this.#observedTurnId = turnId;
  }

  #assertAuthorizedThreadId(threadId: string): void {
    if (this.threadId === null || this.threadId !== threadId) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
  }

  #assertAuthorizedTurnId(turnId: string): void {
    if (this.turnId === null || this.turnId !== turnId) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
  }

  #requireTurnStartSent(): void {
    if (!this.#turnStartSent) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
  }

  #observeWriteToolItem(
    method: "item/started" | "item/completed",
    item: JsonObject,
    itemType: "commandExecution" | "fileChange",
    worktreePath: string,
  ): void {
    const itemId = requireBoundedString(item.id, 512);
    const existing = this.#writeToolItems.get(itemId);
    if (method === "item/started") {
      if (
        existing !== undefined ||
        this.#writeToolItems.size >= MAX_WRITE_TOOL_ITEMS ||
        item.status !== "inProgress"
      ) {
        throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
      }
      validateWriteThreadItem(item, itemType, worktreePath, "STARTED");
      this.#writeToolItems.set(itemId, { type: itemType, state: "STARTED" });
      this.diagnostics.toolActionsObserved += 1;
      return;
    }
    if (
      existing === undefined ||
      existing.type !== itemType ||
      existing.state !== "STARTED" ||
      item.status === "inProgress"
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    validateWriteThreadItem(item, itemType, worktreePath, "COMPLETED");
    existing.state = "COMPLETED";
  }

  #assertActiveWriteToolItem(
    itemId: string,
    expectedType: WriteToolItemState["type"],
  ): void {
    const item = this.#writeToolItems.get(itemId);
    if (
      item === undefined ||
      item.type !== expectedType ||
      item.state !== "STARTED"
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
  }

  #appendAgentText(text: string): void {
    const combined = this.responseText + text;
    if (Buffer.byteLength(combined, "utf8") > this.maxAgentResponseBytes) {
      throw new LiveExecutionError("AGENT_RESPONSE_LIMIT_EXCEEDED");
    }
    this.responseText = combined;
  }
}

class JsonlAppServerClient {
  readonly #pending = new Map<number | string, PendingRequest>();
  readonly #seenResponseIds = new Set<number | string>();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #stdoutBuffer = Buffer.alloc(0);
  #stderrBytes = 0;
  #failure: LiveExecutionError | null = null;
  #processClosed = false;
  #shuttingDown = false;
  #stdoutFinalized = false;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly limits: LiveExecutionLimits,
    private readonly diagnostics: MutableDiagnostics,
    private readonly events: TurnEventTracker,
  ) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#receiveStdout(chunk);
    });
    child.stdout.once("end", () => {
      this.#finalizeStdout(true);
    });
    child.stdout.once("close", () => {
      this.#finalizeStdout(false);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(chunk, "utf8");
      this.#stderrBytes = Math.min(
        this.limits.maxStderrBytes,
        this.#stderrBytes + bytes,
      );
    });
    child.once("error", () => {
      this.#fail(new LiveExecutionError("APP_SERVER_START_FAILED"));
    });
    child.once("close", () => {
      this.#processClosed = true;
      if (!this.#shuttingDown) {
        this.#fail(new LiveExecutionError("APP_SERVER_EXITED"));
      }
    });
  }

  get failure(): LiveExecutionError | null {
    return this.#failure;
  }

  get isRunning(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  async waitForSpawn(timeoutMs: number): Promise<void> {
    if (this.child.pid !== undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new LiveExecutionError("APP_SERVER_TIMEOUT"));
      }, timeoutMs);
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new LiveExecutionError("APP_SERVER_START_FAILED"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.child.off("spawn", onSpawn);
        this.child.off("error", onError);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });
  }

  request(
    id: number | string,
    method: string,
    params: JsonObject,
    timeoutMs: number,
    hooks: RequestHooks = {},
  ): Promise<JsonValue> {
    if (this.#failure !== null) {
      return Promise.reject(this.#failure);
    }
    if (
      this.#pending.has(id) ||
      this.#seenResponseIds.has(id) ||
      this.#pending.size >= this.limits.maxPendingRequests
    ) {
      return Promise.reject(new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR"));
    }
    const response = new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new LiveExecutionError("APP_SERVER_TIMEOUT"));
      }, timeoutMs);
      this.#pending.set(id, {
        onResult: hooks.onResult,
        reject,
        resolve,
        timeout,
      });
    });
    try {
      this.#send({ id, method, params });
      hooks.onSent?.();
    } catch (error: unknown) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
      }
      return Promise.reject(asLiveExecutionError(error));
    }
    return response;
  }

  notify(method: string, params: JsonObject = {}): void {
    this.#send({ method, params });
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  async shutdown(): Promise<boolean> {
    this.beginShutdown();
    try {
      if (!this.child.stdin.destroyed) {
        this.child.stdin.end();
      }
      if (await this.#waitForProcessClose(this.limits.shutdownGraceMs)) {
        return true;
      }
      this.child.kill("SIGTERM");
      if (await this.#waitForProcessClose(this.limits.terminateGraceMs)) {
        return true;
      }
      this.child.kill("SIGKILL");
      return await this.#waitForProcessClose(this.limits.terminateGraceMs);
    } catch {
      return false;
    }
  }

  #finalizeStdout(cleanEof: boolean): void {
    if (this.#stdoutFinalized) {
      return;
    }
    this.#stdoutFinalized = true;
    if (!cleanEof || this.#stdoutBuffer.byteLength !== 0) {
      this.#fail(new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR"));
    }
  }

  #waitForProcessClose(timeoutMs: number): Promise<boolean> {
    if (this.#processClosed) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.child.off("close", onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };
      this.child.once("close", onClose);
    });
  }

  #receiveStdout(chunk: Buffer | string): void {
    if (this.#failure !== null) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, bytes]);
    if (this.#stdoutBuffer.byteLength > this.limits.maxJsonlLineBytes) {
      const newlineIndex = this.#stdoutBuffer.indexOf(0x0a);
      if (newlineIndex < 0 || newlineIndex > this.limits.maxJsonlLineBytes) {
        this.#fail(new LiveExecutionError("JSONL_LIMIT_EXCEEDED"));
        return;
      }
    }

    while (true) {
      const newlineIndex = this.#stdoutBuffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        return;
      }
      let line = this.#stdoutBuffer.subarray(0, newlineIndex);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newlineIndex + 1);
      if (line.byteLength > this.limits.maxJsonlLineBytes) {
        this.#fail(new LiveExecutionError("JSONL_LIMIT_EXCEEDED"));
        return;
      }
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.byteLength === 0) {
        this.#fail(new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR"));
        return;
      }
      try {
        const text = this.#decoder.decode(line);
        const message = JSON.parse(text) as unknown;
        this.#handleMessage(message);
      } catch (error: unknown) {
        this.#fail(asLiveExecutionError(error));
        return;
      }
    }
  }

  #handleMessage(message: unknown): void {
    const record = requireRecord(message);
    if (typeof record.method === "string") {
      this.diagnostics.notificationsReceived += 1;
      if (this.diagnostics.notificationsReceived > this.limits.maxNotifications) {
        throw new LiveExecutionError("JSONL_LIMIT_EXCEEDED");
      }
      if ("id" in record) {
        if (typeof record.id !== "number" && typeof record.id !== "string") {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        this.#handleServerRequest(record.id, record.method);
        return;
      }
      const handled = this.events.handleNotification(record.method, record.params ?? {});
      if (!handled) {
        this.diagnostics.unknownNotificationsIgnored += 1;
      }
      return;
    }

    if ("id" in record) {
      if (typeof record.id !== "number" && typeof record.id !== "string") {
        throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
      }
      const id = record.id;
      const pending = this.#pending.get(id);
      if (pending === undefined || this.#seenResponseIds.has(id)) {
        throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
      }
      const hasResult = "result" in record;
      const hasError = "error" in record;
      if (hasResult === hasError) {
        throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
      }
      if (hasError) {
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        this.#seenResponseIds.add(id);
        pending.reject(new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR"));
      } else {
        const result = toJsonValue(record.result);
        pending.onResult?.(result);
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        this.#seenResponseIds.add(id);
        pending.resolve(result);
      }
      return;
    }

    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }

  #handleServerRequest(id: number | string, method: string): void {
    this.diagnostics.serverRequestsReceived += 1;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.diagnostics.approvalRequestsDeclined += 1;
      this.#send({ id, result: { decision: "decline" } });
      throw new LiveExecutionError("APPROVAL_REQUESTED");
    }
    this.#send({
      error: { code: -32_601, message: "Unsupported server request." },
      id,
    });
    throw new LiveExecutionError("UNEXPECTED_SERVER_REQUEST");
  }

  #send(message: JsonObject): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.limits.maxJsonlLineBytes) {
      throw new LiveExecutionError("JSONL_LIMIT_EXCEEDED");
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new LiveExecutionError("APP_SERVER_EXITED");
    }
    this.child.stdin.write(line, "utf8");
  }

  #fail(error: LiveExecutionError): void {
    if (this.#failure !== null) {
      return;
    }
    this.#failure = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.events.fail(error);
  }
}

export async function executeSingleSubtaskLiveCodex(
  storage: TaskStorage,
  subtaskId: SubtaskId,
  profile: OperationalJitContextProfile,
): Promise<LiveCodexExecutionResult> {
  return executeSingleSubtaskLiveCodexWithDependencies(
    storage,
    subtaskId,
    profile,
    productionDependencies(),
  );
}

export async function executeSingleSubtaskOwnedWorktreeCodex(
  storage: TaskStorage,
  subtaskId: SubtaskId,
): Promise<OwnedWorktreeCodexExecutionResult> {
  return executeSingleSubtaskOwnedWorktreeCodexWithDependencies(
    storage,
    subtaskId,
    productionOwnedWorktreeDependencies(),
  );
}

/** Internal deterministic-test hook; not exported from the package root. */
export async function executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
  storage: TaskStorage,
  subtaskId: SubtaskId,
  dependencies: OwnedWorktreeExecutionDependencies,
): Promise<OwnedWorktreeCodexExecutionResult> {
  if (process.env.NODE_ENV !== "test") {
    return immediateOwnedWorktreeFailure("INVALID_INPUT");
  }
  return executeSingleSubtaskOwnedWorktreeCodexWithDependencies(
    storage,
    subtaskId,
    dependencies,
  );
}

async function executeSingleSubtaskOwnedWorktreeCodexWithDependencies(
  storage: TaskStorage,
  subtaskId: SubtaskId,
  dependencies: OwnedWorktreeExecutionDependencies,
): Promise<OwnedWorktreeCodexExecutionResult> {
  const diagnostics = emptyDiagnostics();
  const evidence = emptyOwnedWorktreeEvidence();
  let failureCode: OwnedWorktreeCodexExecutionFailureCode | null = null;
  let preflight: ExecutionInputPreflightResult | undefined;
  let trustedWorktree: ResolvedActiveOwnedWorktree | undefined;
  let transientRuntime: string | undefined;
  let client: JsonlAppServerClient | undefined;
  let events: TurnEventTracker | undefined;
  let turnStartSent = false;
  let durableRunState: "NONE" | "CREATED" | "RUNNING" | "TERMINAL" = "NONE";

  try {
    if (!(storage instanceof TaskStorage) || typeof subtaskId !== "string") {
      throw new LiveExecutionError("INVALID_INPUT");
    }

    try {
      preflight = new ExecutionInputPreflight(
        storage,
      ).prepareExecutionInputForSubtask(
        subtaskId,
        "STANDARD_SUBTASK_EXECUTION",
      );
    } catch {
      throw new LiveExecutionError("PREFLIGHT_FAILED");
    }
    evidence.preflight = {
      profile: preflight.profile,
      status: preflight.status,
      utf8Bytes: preflight.utf8Bytes,
    };
    if (!preflight.allowed) {
      throw new LiveExecutionError("PREFLIGHT_BLOCKED");
    }

    try {
      trustedWorktree = dependencies.resolveOwnedWorktree(storage, subtaskId);
    } catch {
      throw new LiveExecutionError("ACTIVE_WORKTREE_REQUIRED");
    }
    assertActiveOwnedWorktree(trustedWorktree, subtaskId);
    evidence.worktreeOwnershipId = trustedWorktree.ownership.id;
    evidence.worktreeStartingHeadSha = trustedWorktree.currentHeadSha;
    dependencies.beforeWorktreeAuthorityGate?.("INITIAL_HARDLINK_SCAN");
    validateWorktreeFilesystem(
      dependencies,
      trustedWorktree.ownership.worktreePath,
    );

    let runtime: ResolvedCodexRuntime;
    try {
      runtime = dependencies.resolveRuntime();
    } catch {
      throw new LiveExecutionError("ACTIVE_RUNTIME_REQUIRED");
    }
    assertExactActiveRuntime(runtime);
    let compatible = false;
    try {
      compatible = dependencies.checkCompatibility();
    } catch {
      compatible = false;
    }
    if (!compatible) {
      throw new LiveExecutionError("ACTIVE_RUNTIME_REQUIRED");
    }
    evidence.runtime = {
      exactVersion: TESTED_CODEX_VERSION,
      releaseVersion: runtime.releaseVersion,
      target: runtime.target,
    };

    const chatThreadId = dependencies.generateChatThreadId();
    const executionRunId = dependencies.generateExecutionRunId();
    try {
      dependencies.beforeDurableOperation?.("RESERVE_ATTEMPT");
      storage.reservePrimaryExecutionAttempt({
        subtaskId,
        worktreeOwnershipId: trustedWorktree.ownership.id,
        chatThreadId,
        executionRunId,
        providerId: CODEX_APP_SERVER_PROVIDER_ID,
      });
      evidence.chatThreadId = chatThreadId;
      evidence.executionRunId = executionRunId;
      durableRunState = "CREATED";
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "CONFLICT"
      ) {
        throw new LiveExecutionError("PRIMARY_EXECUTION_CONFLICT");
      }
      throw new LiveExecutionError("DURABLE_RUN_PERSISTENCE_FAILED");
    }

    transientRuntime = dependencies.createWorkspace();
    assertDisposableWorkspace(transientRuntime);
    dependencies.beforeWorktreeAuthorityGate?.("PRE_SPAWN_REVALIDATION");
    const beforeSpawn = revalidateOwnedWorktree(
      dependencies,
      storage,
      subtaskId,
      trustedWorktree,
    );
    const worktreePath = beforeSpawn.ownership.worktreePath;
    const eventTracker = new TurnEventTracker(
      diagnostics,
      dependencies.limits.maxAgentResponseBytes,
      { kind: "WORKSPACE_WRITE", worktreePath },
    );
    events = eventTracker;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = dependencies.spawnAppServer(
        runtime.canonicalExecutablePath,
        ownedWriteAppServerArguments(),
        {
          cwd: worktreePath,
          env: buildLiveCodexChildEnvironment(
            dependencies.sourceEnvironment,
            dependencies.normalHomeDirectory,
            transientRuntime,
          ),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      throw new LiveExecutionError("APP_SERVER_START_FAILED");
    }
    client = new JsonlAppServerClient(
      child,
      dependencies.limits,
      diagnostics,
      eventTracker,
    );
    await client.waitForSpawn(dependencies.limits.startupTimeoutMs);

    const initializeResult = await client.request(
      1,
      "initialize",
      { clientInfo: CLIENT_INFO, capabilities: null },
      dependencies.limits.requestTimeoutMs,
    );
    validateInitializeResult(initializeResult);
    client.notify("initialized");

    const accountResult = await client.request(
      2,
      "account/read",
      { refreshToken: false },
      dependencies.limits.requestTimeoutMs,
      {
        onResult: (result) => {
          parseChatGptAccount(result);
          eventTracker.establishChatGptAuth();
        },
      },
    );
    evidence.planType = parseChatGptAccount(accountResult);
    evidence.authType = "chatgpt";
    eventTracker.assertChatGptAuthenticated();

    revalidateOwnedWorktree(
      dependencies,
      storage,
      subtaskId,
      trustedWorktree,
    );
    const threadResult = await client.request(
      3,
      "thread/start",
      {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: worktreePath,
        ephemeral: true,
        sandbox: "workspace-write",
        serviceName: CLIENT_INFO.name,
      },
      dependencies.limits.requestTimeoutMs,
      {
        onResult: (result) => {
          const authorizedThread = parseOwnedWorktreeThreadStartResult(
            result,
            worktreePath,
          );
          eventTracker.observeThreadResponse(authorizedThread.threadId);
        },
      },
    );
    const thread = parseOwnedWorktreeThreadStartResult(
      threadResult,
      worktreePath,
    );
    evidence.providerThread = mapCodexThreadReference(thread.threadId);
    evidence.model = mapCodexModelReference(thread.model);
    evidence.threadPolicy = {
      approvalPolicy: "never",
      cwd: "TRUSTED_ACTIVE_OWNED_WORKTREE",
      ephemeral: true,
      sandbox: "workspaceWrite",
      writableRootCount: 1,
      networkAccess: false,
    };
    try {
      dependencies.beforeDurableOperation?.("BIND_THREAD");
      storage.bindChatThreadProviderReference({
        chatThreadId,
        providerThread: evidence.providerThread,
      });
    } catch {
      throw new LiveExecutionError("DURABLE_THREAD_PERSISTENCE_FAILED");
    }

    eventTracker.assertChatGptAuthenticated();
    dependencies.beforeWorktreeAuthorityGate?.(
      "FINAL_PRE_TURN_HARDLINK_SCAN",
    );
    const finalPreTurn = revalidateOwnedWorktree(
      dependencies,
      storage,
      subtaskId,
      trustedWorktree,
    );
    validateWorktreeFilesystem(
      dependencies,
      finalPreTurn.ownership.worktreePath,
    );
    revalidateStandardSubtaskExecutionEligibility(storage, subtaskId);
    const turnResult = await client.request(
      4,
      "turn/start",
      {
        threadId: thread.threadId,
        input: [
          { type: "text", text: preflight.text, text_elements: [] },
        ],
        cwd: worktreePath,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [worktreePath],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: false,
        },
      },
      dependencies.limits.requestTimeoutMs,
      {
        onResult: (result) => {
          eventTracker.observeTurnResponse(parseTurnStartResult(result));
        },
        onSent: () => {
          diagnostics.turnStartRequests += 1;
          turnStartSent = true;
          eventTracker.observeTurnStartSent(thread.threadId);
        },
      },
    );
    const turnId = parseTurnStartResult(turnResult);
    if (eventTracker.turnId !== turnId) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    evidence.providerRun = mapCodexTurnReference(thread.threadId, turnId);
    try {
      dependencies.beforeDurableOperation?.("START_RUN");
      storage.startExecutionRun({
        executionRunId,
        providerRun: evidence.providerRun,
        providerModel: evidence.model,
      });
      durableRunState = "RUNNING";
      dependencies.afterDurableOperation?.("START_RUN");
    } catch {
      throw new LiveExecutionError("DURABLE_RUN_PERSISTENCE_FAILED");
    }

    const terminal = await eventTracker.waitForTerminal(
      dependencies.limits.turnTimeoutMs,
    );
    if (client.failure !== null) {
      throw client.failure;
    }
    eventTracker.assertChatGptAuthenticated();
    evidence.terminalTurnStatus = terminal.status;
    evidence.normalizedUsage = eventTracker.normalizedUsage;
    if (terminal.status === "failed") {
      throw new LiveExecutionError("TURN_FAILED");
    }
    if (terminal.status === "interrupted") {
      throw new LiveExecutionError("TURN_INTERRUPTED");
    }
  } catch (error: unknown) {
    failureCode = asOwnedWorktreeFailureCode(error);
    if (
      turnStartSent &&
      client !== undefined &&
      events?.threadId !== null &&
      events?.threadId !== undefined &&
      events.turnId !== null &&
      events.terminal === null &&
      client.failure === null &&
      client.isRunning &&
      diagnostics.interruptRequests === 0
    ) {
      diagnostics.interruptRequests += 1;
      try {
        await client.request(
          5,
          "turn/interrupt",
          { threadId: events.threadId, turnId: events.turnId },
          dependencies.limits.interruptTimeoutMs,
        );
      } catch {
        // Preserve the original sanitized failure and continue bounded shutdown.
      }
    }

  } finally {
    if (events !== undefined) {
      evidence.normalizedUsage ??= events.normalizedUsage;
      evidence.terminalTurnStatus ??= events.terminal?.status ?? null;
    }
    if (client !== undefined) {
      evidence.appServerChildCleaned = await client.shutdown();
      if (failureCode === null) {
        failureCode = client.failure?.code ?? null;
        if (!evidence.appServerChildCleaned && failureCode === null) {
          failureCode = "PROCESS_CLEANUP_FAILED";
        }
      }
    }
    if (transientRuntime !== undefined) {
      try {
        dependencies.removeWorkspace(transientRuntime);
        evidence.transientRuntimeCleaned = !existsSync(transientRuntime);
      } catch {
        evidence.transientRuntimeCleaned = false;
      }
      if (!evidence.transientRuntimeCleaned && failureCode === null) {
        failureCode = "WORKSPACE_CLEANUP_FAILED";
      }
    }
  }

  if (
    evidence.executionRunId !== null &&
    durableRunState === "RUNNING" &&
    evidence.terminalTurnStatus === "completed" &&
    trustedWorktree !== undefined
  ) {
    try {
      dependencies.beforeWorktreeAuthorityGate?.("POST_TURN_SUCCESS_GATE");
      const postTurn = revalidateOwnedWorktree(
        dependencies,
        storage,
        subtaskId,
        trustedWorktree,
      );
      validateWorktreeFilesystem(
        dependencies,
        postTurn.ownership.worktreePath,
      );
      revalidateStandardSubtaskExecutionEligibility(storage, subtaskId);
    } catch (error: unknown) {
      const authorityFailure = asOwnedWorktreeFailureCode(error);
      if (
        authorityFailure === "WORKTREE_AUTHORITY_DRIFT" ||
        authorityFailure === "WORKTREE_FILESYSTEM_UNSAFE" ||
        authorityFailure === "PRIMARY_EXECUTION_CONFLICT"
      ) {
        failureCode = authorityFailure;
      } else {
        failureCode = "WORKTREE_AUTHORITY_DRIFT";
      }
    }
  }

  if (
    evidence.executionRunId !== null &&
    (durableRunState === "CREATED" || durableRunState === "RUNNING") &&
    !(durableRunState === "CREATED" && turnStartSent)
  ) {
    const durableStatus =
      durableRunState === "RUNNING" &&
      failureCode === null &&
      evidence.terminalTurnStatus === "completed"
        ? "SUCCEEDED"
        : durableRunState === "RUNNING" &&
            evidence.terminalTurnStatus === "interrupted"
          ? "INTERRUPTED"
          : "FAILED";
    try {
      dependencies.beforeDurableOperation?.("FINALIZE_ATTEMPT");
      storage.finalizePrimaryExecutionAttempt({
        executionRunId: evidence.executionRunId,
        status: durableStatus,
        ...(durableRunState !== "RUNNING" || evidence.model === null
          ? {}
          : { providerModel: evidence.model }),
        ...(durableRunState !== "RUNNING" || evidence.normalizedUsage === null
          ? {}
          : { normalizedUsage: evidence.normalizedUsage }),
      });
      durableRunState = "TERMINAL";
    } catch {
      failureCode = "DURABLE_RUN_PERSISTENCE_FAILED";
    }
  }

  const common = ownedWorktreeResultBase(evidence, diagnostics);
  if (failureCode !== null) {
    return Object.freeze({ ...common, success: false, failureCode });
  }
  if (evidence.terminalTurnStatus !== "completed") {
    return Object.freeze({
      ...common,
      success: false,
      failureCode: "TERMINAL_EVENT_REQUIRED",
    });
  }
  return Object.freeze({ ...common, success: true, failureCode: null });
}

/** Internal deterministic-test hook; not exported from the package root. */
export async function executeSingleSubtaskLiveCodexWithDependenciesForTest(
  storage: TaskStorage,
  subtaskId: SubtaskId,
  profile: OperationalJitContextProfile,
  dependencies: LiveExecutionDependencies,
): Promise<LiveCodexExecutionResult> {
  if (process.env.NODE_ENV !== "test") {
    return immediateFailure("INVALID_INPUT");
  }
  return executeSingleSubtaskLiveCodexWithDependencies(
    storage,
    subtaskId,
    profile,
    dependencies,
  );
}

export function buildLiveCodexChildEnvironmentForTest(
  sourceEnvironment: NodeJS.ProcessEnv,
  normalHomeDirectory: string,
  workspace: string,
): NodeJS.ProcessEnv {
  if (process.env.NODE_ENV !== "test") {
    return {};
  }
  return buildLiveCodexChildEnvironment(
    sourceEnvironment,
    normalHomeDirectory,
    workspace,
  );
}

async function executeSingleSubtaskLiveCodexWithDependencies(
  storage: TaskStorage,
  subtaskId: SubtaskId,
  profile: OperationalJitContextProfile,
  dependencies: LiveExecutionDependencies,
): Promise<LiveCodexExecutionResult> {
  const diagnostics = emptyDiagnostics();
  const evidence = emptyEvidence();
  let failureCode: LiveCodexExecutionFailureCode | null = null;
  let preflight: ExecutionInputPreflightResult | undefined;
  let workspace: string | undefined;
  let client: JsonlAppServerClient | undefined;
  let events: TurnEventTracker | undefined;
  let turnStartSent = false;

  try {
    if (
      !(storage instanceof TaskStorage) ||
      typeof subtaskId !== "string" ||
      (profile !== "STANDARD_SUBTASK_EXECUTION" &&
        profile !== "FRESH_INDEPENDENT_QA")
    ) {
      throw new LiveExecutionError("INVALID_INPUT");
    }

    try {
      preflight = new ExecutionInputPreflight(
        storage,
      ).prepareExecutionInputForSubtask(subtaskId, profile);
    } catch {
      throw new LiveExecutionError("PREFLIGHT_FAILED");
    }
    evidence.preflight = {
      profile: preflight.profile,
      status: preflight.status,
      utf8Bytes: preflight.utf8Bytes,
    };
    if (!preflight.allowed) {
      throw new LiveExecutionError("PREFLIGHT_BLOCKED");
    }

    let runtime: ResolvedCodexRuntime;
    try {
      runtime = dependencies.resolveRuntime();
    } catch {
      throw new LiveExecutionError("ACTIVE_RUNTIME_REQUIRED");
    }
    assertExactActiveRuntime(runtime);
    evidence.runtime = {
      exactVersion: TESTED_CODEX_VERSION,
      releaseVersion: runtime.releaseVersion,
      target: runtime.target,
    };

    const executionWorkspace = dependencies.createWorkspace();
    workspace = executionWorkspace;
    assertDisposableWorkspace(executionWorkspace);
    const eventTracker = new TurnEventTracker(
      diagnostics,
      dependencies.limits.maxAgentResponseBytes,
    );
    events = eventTracker;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = dependencies.spawnAppServer(
        runtime.canonicalExecutablePath,
        ["app-server", "--listen", "stdio://"],
        {
          cwd: executionWorkspace,
          env: buildLiveCodexChildEnvironment(
            dependencies.sourceEnvironment,
            dependencies.normalHomeDirectory,
            executionWorkspace,
          ),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      throw new LiveExecutionError("APP_SERVER_START_FAILED");
    }
    client = new JsonlAppServerClient(
      child,
      dependencies.limits,
      diagnostics,
      eventTracker,
    );
    await client.waitForSpawn(dependencies.limits.startupTimeoutMs);

    const initializeResult = await client.request(
      1,
      "initialize",
      {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      },
      dependencies.limits.requestTimeoutMs,
    );
    validateInitializeResult(initializeResult);
    client.notify("initialized");

    const accountResult = await client.request(
      2,
      "account/read",
      { refreshToken: false },
      dependencies.limits.requestTimeoutMs,
      {
        onResult: (result) => {
          parseChatGptAccount(result);
          eventTracker.establishChatGptAuth();
        },
      },
    );
    evidence.planType = parseChatGptAccount(accountResult);
    evidence.authType = "chatgpt";
    eventTracker.assertChatGptAuthenticated();

    const threadResult = await client.request(
      3,
      "thread/start",
      {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: executionWorkspace,
        ephemeral: true,
        sandbox: "read-only",
        serviceName: CLIENT_INFO.name,
      },
      dependencies.limits.requestTimeoutMs,
      {
        onResult: (result) => {
          const authorizedThread = parseThreadStartResult(
            result,
            executionWorkspace,
          );
          eventTracker.observeThreadResponse(authorizedThread.threadId);
        },
      },
    );
    const thread = parseThreadStartResult(threadResult, executionWorkspace);
    evidence.providerThread = mapCodexThreadReference(thread.threadId);
    evidence.model = mapCodexModelReference(thread.model);
    evidence.threadPolicy = {
      approvalPolicy: "never",
      cwd: "DISPOSABLE_OS_TEMP",
      ephemeral: true,
      sandbox: "readOnly",
      networkAccess: false,
    };

    eventTracker.assertChatGptAuthenticated();
    const turnResult = await client.request(
      4,
      "turn/start",
      {
        threadId: thread.threadId,
        input: [
          {
            type: "text",
            text: preflight.text,
            text_elements: [],
          },
        ],
        cwd: executionWorkspace,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      dependencies.limits.requestTimeoutMs,
      {
        onResult: (result) => {
          eventTracker.observeTurnResponse(parseTurnStartResult(result));
        },
        onSent: () => {
          diagnostics.turnStartRequests += 1;
          turnStartSent = true;
          eventTracker.observeTurnStartSent(thread.threadId);
        },
      },
    );
    const turnId = parseTurnStartResult(turnResult);
    if (eventTracker.turnId !== turnId) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    evidence.providerRun = mapCodexTurnReference(thread.threadId, turnId);

    const terminal = await eventTracker.waitForTerminal(
      dependencies.limits.turnTimeoutMs,
    );
    if (client.failure !== null) {
      throw client.failure;
    }
    eventTracker.assertChatGptAuthenticated();
    evidence.terminalTurnStatus = terminal.status;
    evidence.normalizedUsage = eventTracker.normalizedUsage;
    if (terminal.status === "failed") {
      throw new LiveExecutionError("TURN_FAILED");
    }
    if (terminal.status === "interrupted") {
      throw new LiveExecutionError("TURN_INTERRUPTED");
    }
    evidence.agentResponseText = eventTracker.responseText;
  } catch (error: unknown) {
    failureCode = asReadOnlyFailureCode(error);
    if (
      turnStartSent &&
      client !== undefined &&
      events?.threadId !== null &&
      events?.threadId !== undefined &&
      events.turnId !== null &&
      events.terminal === null &&
      client.failure === null &&
      client.isRunning &&
      diagnostics.interruptRequests === 0
    ) {
      diagnostics.interruptRequests += 1;
      try {
        await client.request(
          5,
          "turn/interrupt",
          { threadId: events.threadId, turnId: events.turnId },
          dependencies.limits.interruptTimeoutMs,
        );
      } catch {
        // Preserve the original sanitized failure and continue bounded shutdown.
      }
    }
  } finally {
    if (events !== undefined) {
      evidence.normalizedUsage ??= events.normalizedUsage;
      evidence.terminalTurnStatus ??= events.terminal?.status ?? null;
    }
    if (client !== undefined) {
      evidence.appServerChildCleaned = await client.shutdown();
      if (failureCode === null) {
        failureCode =
          client.failure === null
            ? null
            : asReadOnlyFailureCode(client.failure);
        if (!evidence.appServerChildCleaned && failureCode === null) {
          failureCode = "PROCESS_CLEANUP_FAILED";
        }
      }
    }
    if (workspace !== undefined) {
      try {
        dependencies.removeWorkspace(workspace);
        evidence.disposableWorkspaceCleaned = !existsSync(workspace);
      } catch {
        evidence.disposableWorkspaceCleaned = false;
      }
      if (!evidence.disposableWorkspaceCleaned && failureCode === null) {
        failureCode = "WORKSPACE_CLEANUP_FAILED";
      }
    }
  }

  const common = resultBase(evidence, diagnostics);
  if (failureCode !== null) {
    return Object.freeze({
      ...common,
      success: false,
      failureCode,
      agentResponseText: null,
    });
  }
  if (evidence.terminalTurnStatus !== "completed") {
    return Object.freeze({
      ...common,
      success: false,
      failureCode: "TERMINAL_EVENT_REQUIRED",
      agentResponseText: null,
    });
  }
  return Object.freeze({
    ...common,
    success: true,
    failureCode: null,
    agentResponseText: evidence.agentResponseText,
  });
}

function productionDependencies(): LiveExecutionDependencies {
  return {
    resolveRuntime: resolveActiveOwnedCodexRuntime,
    spawnAppServer: (executable, arguments_, options) =>
      spawn(executable, [...arguments_], options),
    sourceEnvironment: process.env,
    normalHomeDirectory: homedir(),
    createWorkspace: createDisposableWorkspace,
    removeWorkspace,
    limits: DEFAULT_LIMITS,
  };
}

function productionOwnedWorktreeDependencies(): OwnedWorktreeExecutionDependencies {
  return {
    ...productionDependencies(),
    checkCompatibility: () => checkOwnedCodexCompatibility().compatible,
    createWorkspace: createWriteRuntimeDirectory,
    resolveOwnedWorktree: (storage, subtaskId) =>
      createWorktreeOwnershipManager(
        storage,
      ).resolveActiveOwnedWorktreeForSubtask(subtaskId),
    generateChatThreadId: () =>
      ChatThreadIdSchema.parse(`thr_${randomBytes(16).toString("hex")}`),
    generateExecutionRunId: () =>
      ExecutionRunIdSchema.parse(`run_${randomBytes(16).toString("hex")}`),
    validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
  };
}

function ownedWriteAppServerArguments(): readonly string[] {
  return Object.freeze([
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
    "--config",
    "orchestrator.mcp.enabled=false",
    "--config",
    'web_search="disabled"',
    ...WRITE_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ]);
}

function validateWorktreeFilesystem(
  dependencies: OwnedWorktreeExecutionDependencies,
  worktreePath: string,
): void {
  try {
    dependencies.validateWorktreeFilesystem(worktreePath);
  } catch {
    throw new LiveExecutionError("WORKTREE_FILESYSTEM_UNSAFE");
  }
}

function buildLiveCodexChildEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  normalHomeDirectory: string,
  workspace: string,
): NodeJS.ProcessEnv {
  if (
    !isAbsolute(normalHomeDirectory) ||
    normalHomeDirectory.includes("\0") ||
    !isAbsolute(workspace)
  ) {
    throw new LiveExecutionError("APP_SERVER_START_FAILED");
  }
  const childEnvironment: NodeJS.ProcessEnv = {
    HOME: normalHomeDirectory,
    PATH: SAFE_CHILD_PATH,
    TMPDIR: workspace,
  };
  for (const name of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "SHELL",
    "TERM",
    "USER",
  ]) {
    const value = sourceEnvironment[name];
    if (isBoundedEnvironmentValue(value)) {
      childEnvironment[name] = value;
    }
  }
  const codexHome = sourceEnvironment.CODEX_HOME;
  if (
    isBoundedEnvironmentValue(codexHome) &&
    isAbsolute(codexHome) &&
    !codexHome.includes("\0")
  ) {
    childEnvironment.CODEX_HOME = codexHome;
  }
  return childEnvironment;
}

function isBoundedEnvironmentValue(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

function createDisposableWorkspace(): string {
  const canonicalTemporaryRoot = realpathSync(tmpdir());
  const workspace = mkdtempSync(join(canonicalTemporaryRoot, WORKSPACE_PREFIX));
  chmodSync(workspace, 0o700);
  assertDisposableWorkspace(workspace);
  return workspace;
}

function createWriteRuntimeDirectory(): string {
  const canonicalTemporaryRoot = realpathSync(tmpdir());
  const runtimeDirectory = mkdtempSync(
    join(canonicalTemporaryRoot, WRITE_RUNTIME_PREFIX),
  );
  chmodSync(runtimeDirectory, 0o700);
  assertDisposableWorkspace(runtimeDirectory);
  return runtimeDirectory;
}

function assertDisposableWorkspace(workspace: string): void {
  const canonicalTemporaryRoot = realpathSync(tmpdir());
  const canonicalWorkspace = realpathSync(workspace);
  const workspaceStat = lstatSync(workspace);
  const relativePath = relative(canonicalTemporaryRoot, canonicalWorkspace);
  if (
    canonicalWorkspace !== workspace ||
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    !workspaceStat.isDirectory() ||
    workspaceStat.isSymbolicLink() ||
    (workspaceStat.mode & 0o077) !== 0
  ) {
    throw new LiveExecutionError("APP_SERVER_START_FAILED");
  }
}

function removeWorkspace(workspace: string): void {
  assertDisposableWorkspace(workspace);
  rmSync(workspace, { force: true, maxRetries: 2, recursive: true, retryDelay: 10 });
}

function assertExactActiveRuntime(runtime: ResolvedCodexRuntime): void {
  if (
    runtime.source !== "OWNED_RELEASE" ||
    runtime.exactVersionOutput !== TESTED_CODEX_VERSION ||
    runtime.releaseVersion !== EXPECTED_RELEASE_VERSION ||
    runtime.target !== "aarch64-apple-darwin" ||
    !isAbsolute(runtime.canonicalExecutablePath)
  ) {
    throw new LiveExecutionError("ACTIVE_RUNTIME_REQUIRED");
  }
}

function assertActiveOwnedWorktree(
  resolved: ResolvedActiveOwnedWorktree,
  subtaskId: SubtaskId,
): void {
  if (
    resolved.ownership.status !== "ACTIVE" ||
    resolved.ownership.subtaskId !== subtaskId ||
    !isAbsolute(resolved.ownership.worktreePath)
  ) {
    throw new LiveExecutionError("ACTIVE_WORKTREE_REQUIRED");
  }
}

function revalidateOwnedWorktree(
  dependencies: OwnedWorktreeExecutionDependencies,
  storage: TaskStorage,
  subtaskId: SubtaskId,
  trusted: ResolvedActiveOwnedWorktree,
): ResolvedActiveOwnedWorktree {
  let current: ResolvedActiveOwnedWorktree;
  try {
    current = dependencies.resolveOwnedWorktree(storage, subtaskId);
    assertActiveOwnedWorktree(current, subtaskId);
  } catch {
    throw new LiveExecutionError("WORKTREE_AUTHORITY_DRIFT");
  }
  const left = trusted.ownership;
  const right = current.ownership;
  if (
    left.id !== right.id ||
    left.projectId !== right.projectId ||
    left.subtaskId !== right.subtaskId ||
    left.worktreePath !== right.worktreePath ||
    left.branchName !== right.branchName ||
    left.startingCommitSha !== right.startingCommitSha ||
    left.createdAt !== right.createdAt ||
    left.activatedAt !== right.activatedAt ||
    trusted.currentHeadSha !== current.currentHeadSha
  ) {
    throw new LiveExecutionError("WORKTREE_AUTHORITY_DRIFT");
  }
  return current;
}

function revalidateStandardSubtaskExecutionEligibility(
  storage: TaskStorage,
  subtaskId: SubtaskId,
): void {
  let eligible = false;
  try {
    eligible = storage.runInTransaction((snapshot) => {
      const subtask = snapshot.getSubtaskById(subtaskId);
      const readiness =
        snapshot.evaluateStoredSubtaskDependencyReadiness(subtaskId);
      return (
        subtask?.status === "IN_PROGRESS" &&
        readiness.valid &&
        readiness.ready
      );
    });
  } catch {
    eligible = false;
  }
  if (!eligible) {
    throw new LiveExecutionError("PRIMARY_EXECUTION_CONFLICT");
  }
}

function validateInitializeResult(result: JsonValue): void {
  const record = requireRecord(result);
  requireBoundedString(record.userAgent, 512);
  requireBoundedString(record.codexHome, 4_096);
  requireBoundedString(record.platformFamily, 64);
  requireBoundedString(record.platformOs, 64);
}

function parseAccountUpdatedNotification(
  record: JsonObject,
): (typeof ACCOUNT_UPDATED_AUTH_MODES)[number] | null {
  if (!("authMode" in record) || !("planType" in record)) {
    throw new LiveExecutionError("AUTH_RESPONSE_MALFORMED");
  }
  if (
    record.planType !== null &&
    (typeof record.planType !== "string" ||
      !(ACCOUNT_UPDATED_PLAN_TYPES as readonly string[]).includes(record.planType))
  ) {
    throw new LiveExecutionError("AUTH_RESPONSE_MALFORMED");
  }
  if (record.authMode === null) {
    return null;
  }
  if (
    typeof record.authMode !== "string" ||
    !(ACCOUNT_UPDATED_AUTH_MODES as readonly string[]).includes(record.authMode)
  ) {
    throw new LiveExecutionError("AUTH_RESPONSE_MALFORMED");
  }
  return record.authMode as (typeof ACCOUNT_UPDATED_AUTH_MODES)[number];
}

function parseChatGptAccount(result: JsonValue): string | null {
  const record = requireRecord(result);
  if (typeof record.requiresOpenaiAuth !== "boolean") {
    throw new LiveExecutionError("AUTH_RESPONSE_MALFORMED");
  }
  if (record.account === null) {
    throw new LiveExecutionError("CHATGPT_AUTH_REQUIRED");
  }
  const account = requireRecordForCode(record.account, "AUTH_RESPONSE_MALFORMED");
  if (account.type !== "chatgpt") {
    if (typeof account.type !== "string") {
      throw new LiveExecutionError("AUTH_RESPONSE_MALFORMED");
    }
    throw new LiveExecutionError("CHATGPT_AUTH_REQUIRED");
  }
  if (account.planType === null || account.planType === undefined) {
    return null;
  }
  return requireBoundedStringForCode(
    account.planType,
    64,
    "AUTH_RESPONSE_MALFORMED",
  );
}

function parseThreadStartResult(
  result: JsonValue,
  workspace: string,
): { readonly threadId: string; readonly model: string } {
  const record = requireRecord(result);
  const thread = requireRecord(record.thread);
  const threadId = requireBoundedString(thread.id, 512);
  if (thread.ephemeral !== true) {
    throw new LiveExecutionError("EPHEMERAL_THREAD_REQUIRED");
  }
  if (record.cwd !== workspace || record.approvalPolicy !== "never") {
    throw new LiveExecutionError("READ_ONLY_POLICY_REQUIRED");
  }
  const sandbox = requireRecord(record.sandbox);
  if (sandbox.type !== "readOnly" || sandbox.networkAccess !== false) {
    throw new LiveExecutionError("READ_ONLY_POLICY_REQUIRED");
  }
  if (record.approvalsReviewer !== "user") {
    throw new LiveExecutionError("READ_ONLY_POLICY_REQUIRED");
  }
  return {
    threadId,
    model: requireBoundedString(record.model, 512),
  };
}

function parseOwnedWorktreeThreadStartResult(
  result: JsonValue,
  worktreePath: string,
): { readonly threadId: string; readonly model: string } {
  const record = requireRecord(result);
  const thread = requireRecord(record.thread);
  const threadId = requireBoundedString(thread.id, 512);
  if (thread.ephemeral !== true) {
    throw new LiveExecutionError("EPHEMERAL_THREAD_REQUIRED");
  }
  if (record.cwd !== worktreePath || record.approvalPolicy !== "never") {
    throw new LiveExecutionError("WRITE_POLICY_REQUIRED");
  }
  const sandbox = requireRecord(record.sandbox);
  if (
    sandbox.type !== "workspaceWrite" ||
    sandbox.networkAccess !== false ||
    !Array.isArray(sandbox.writableRoots) ||
    sandbox.writableRoots.length !== 1 ||
    sandbox.writableRoots[0] !== worktreePath
  ) {
    throw new LiveExecutionError("WRITE_POLICY_REQUIRED");
  }
  if (record.approvalsReviewer !== "user") {
    throw new LiveExecutionError("WRITE_POLICY_REQUIRED");
  }
  return {
    threadId,
    model: requireBoundedString(record.model, 512),
  };
}

function validateWriteThreadItem(
  item: JsonObject,
  itemType: "commandExecution" | "fileChange",
  worktreePath: string,
  phase: "STARTED" | "COMPLETED",
): void {
  requireBoundedString(item.id, 512);
  if (
    (phase === "STARTED" && item.status !== "inProgress") ||
    (phase === "COMPLETED" &&
      item.status !== "completed" &&
      item.status !== "failed" &&
      item.status !== "declined")
  ) {
    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }
  if (itemType === "commandExecution") {
    requireString(item.command);
    validateCommandActions(item.commandActions);
    const commandCwd = requireBoundedString(item.cwd, 4_096);
    if (!commandCwdIsWithin(commandCwd, worktreePath)) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    return;
  }
  validateFileChanges(item.changes, worktreePath);
}

function validateCommandActions(value: unknown): void {
  if (!Array.isArray(value) || value.length > 512) {
    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }
  for (const action of value) {
    const record = requireRecord(action);
    const type = requireBoundedString(record.type, 64);
    requireString(record.command);
    switch (type) {
      case "read":
        requireBoundedString(record.name, 512);
        requireBoundedString(record.path, 4_096);
        break;
      case "listFiles":
        if (
          record.path !== undefined &&
          record.path !== null &&
          typeof record.path !== "string"
        ) {
          throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
        }
        break;
      case "search":
        for (const optional of [record.path, record.query]) {
          if (
            optional !== undefined &&
            optional !== null &&
            typeof optional !== "string"
          ) {
            throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
          }
        }
        break;
      case "unknown":
        break;
      default:
        throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
  }
}

function validateFileChanges(value: unknown, worktreePath: string): void {
  if (!Array.isArray(value) || value.length > 512) {
    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }
  for (const change of value) {
    const record = requireRecord(change);
    requireString(record.diff);
    const changePath = requireBoundedString(record.path, 4_096);
    if (!fileChangePathIsWithin(changePath, worktreePath)) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    const kind = requireRecord(record.kind);
    if (
      kind.type !== "add" &&
      kind.type !== "delete" &&
      kind.type !== "update"
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
    if (
      kind.type === "update" &&
      kind.move_path !== undefined &&
      kind.move_path !== null &&
      !fileChangePathIsWithin(
        requireBoundedString(kind.move_path, 4_096),
        worktreePath,
      )
    ) {
      throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
    }
  }
}

function commandCwdIsWithin(candidate: string, root: string): boolean {
  if (!isAbsolute(candidate) || !isAbsolute(root)) {
    return false;
  }
  try {
    const rootPath = realpathSync.native(root);
    const candidateStat = lstatSync(candidate);
    if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
      return false;
    }
    const candidatePath = realpathSync.native(candidate);
    return pathIsLexicallyWithin(candidatePath, rootPath);
  } catch {
    return false;
  }
}

function fileChangePathIsWithin(candidate: string, root: string): boolean {
  if (
    isAbsolute(candidate) ||
    candidate.includes("\0") ||
    candidate.split(sep).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false;
  }
  try {
    const rootPath = realpathSync.native(root);
    const target = resolve(rootPath, candidate);
    if (!pathIsLexicallyWithin(target, rootPath) || target === rootPath) {
      return false;
    }
    let ancestor = target;
    try {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || targetStat.isDirectory()) {
        return false;
      }
      ancestor = dirname(target);
    } catch {
      ancestor = dirname(target);
      while (ancestor !== rootPath) {
        try {
          const ancestorStat = lstatSync(ancestor);
          if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
            return false;
          }
          break;
        } catch {
          const parent = dirname(ancestor);
          if (parent === ancestor) {
            return false;
          }
          ancestor = parent;
        }
      }
    }
    return pathIsLexicallyWithin(realpathSync.native(ancestor), rootPath);
  } catch {
    return false;
  }
}

function pathIsLexicallyWithin(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

/** Internal deterministic-test hooks; not exported from the package root. */
export function commandCwdIsWithinForTest(candidate: string, root: string): boolean {
  return process.env.NODE_ENV === "test" && commandCwdIsWithin(candidate, root);
}

export function fileChangePathIsWithinForTest(candidate: string, root: string): boolean {
  return process.env.NODE_ENV === "test" && fileChangePathIsWithin(candidate, root);
}

function parseTurnStartResult(result: JsonValue): string {
  const record = requireRecord(result);
  const turn = requireRecord(record.turn);
  const turnId = requireBoundedString(turn.id, 512);
  if (turn.status !== "inProgress") {
    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }
  return turnId;
}

function parseTokenUsageBreakdown(record: JsonObject): TokenUsageBreakdown {
  return {
    totalTokens: requireNonNegativeInteger(record.totalTokens),
    inputTokens: requireNonNegativeInteger(record.inputTokens),
    cachedInputTokens: requireNonNegativeInteger(record.cachedInputTokens),
    cacheWriteInputTokens: requireNonNegativeInteger(record.cacheWriteInputTokens),
    outputTokens: requireNonNegativeInteger(record.outputTokens),
    reasoningOutputTokens: requireNonNegativeInteger(record.reasoningOutputTokens),
  };
}

function requireNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }
  return value as number;
}

function requireRecord(value: unknown): JsonObject {
  return requireRecordForCode(value, "APP_SERVER_PROTOCOL_ERROR");
}

function requireRecordForCode(
  value: unknown,
  code: CodexExecutionFailureCode,
): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiveExecutionError(code);
  }
  return value as JsonObject;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
  }
  return value;
}

function requireBoundedString(value: unknown, maximumLength: number): string {
  return requireBoundedStringForCode(
    value,
    maximumLength,
    "APP_SERVER_PROTOCOL_ERROR",
  );
}

function requireBoundedStringForCode(
  value: unknown,
  maximumLength: number,
  code: CodexExecutionFailureCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    throw new LiveExecutionError(code);
  }
  return value;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  throw new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
}

function asLiveExecutionError(error: unknown): LiveExecutionError {
  return error instanceof LiveExecutionError
    ? error
    : new LiveExecutionError("APP_SERVER_PROTOCOL_ERROR");
}

function asReadOnlyFailureCode(error: unknown): LiveCodexExecutionFailureCode {
  const code = asLiveExecutionError(error).code;
  return (LIVE_CODEX_EXECUTION_FAILURE_CODES as readonly string[]).includes(code)
    ? (code as LiveCodexExecutionFailureCode)
    : "APP_SERVER_PROTOCOL_ERROR";
}

function asOwnedWorktreeFailureCode(
  error: unknown,
): OwnedWorktreeCodexExecutionFailureCode {
  return asLiveExecutionError(error).code;
}

function emptyDiagnostics(): MutableDiagnostics {
  return {
    approvalRequestsDeclined: 0,
    interruptRequests: 0,
    notificationsReceived: 0,
    serverRequestsReceived: 0,
    toolActionsObserved: 0,
    turnStartRequests: 0,
    unknownNotificationsIgnored: 0,
  };
}

/** Internal deterministic-test hook; not exported from the package root. */
export function validateWriteTurnNotificationSequenceForTest(
  worktreePath: string,
  notifications: readonly Readonly<{
    readonly method: string;
    readonly params: unknown;
  }>[],
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new LiveExecutionError("INVALID_INPUT");
  }
  const tracker = new TurnEventTracker(emptyDiagnostics(), 1_024, {
    kind: "WORKSPACE_WRITE",
    worktreePath,
  });
  tracker.establishChatGptAuth();
  tracker.observeThreadResponse("thread-test");
  tracker.observeTurnStartSent("thread-test");
  tracker.observeTurnResponse("turn-test");
  for (const notification of notifications) {
    tracker.handleNotification(notification.method, notification.params);
  }
}

function emptyEvidence(): ExecutionEvidence {
  return {
    runtime: null,
    authType: null,
    planType: null,
    preflight: null,
    providerThread: null,
    providerRun: null,
    model: null,
    normalizedUsage: null,
    terminalTurnStatus: null,
    threadPolicy: null,
    agentResponseText: "",
    appServerChildCleaned: true,
    disposableWorkspaceCleaned: true,
  };
}

function emptyOwnedWorktreeEvidence(): OwnedWorktreeExecutionEvidence {
  return {
    runtime: null,
    authType: null,
    planType: null,
    preflight: null,
    chatThreadId: null,
    executionRunId: null,
    providerThread: null,
    providerRun: null,
    model: null,
    normalizedUsage: null,
    terminalTurnStatus: null,
    worktreeOwnershipId: null,
    worktreeStartingHeadSha: null,
    threadPolicy: null,
    appServerChildCleaned: true,
    transientRuntimeCleaned: true,
  };
}

function resultBase(
  evidence: ExecutionEvidence,
  diagnostics: MutableDiagnostics,
): LiveCodexExecutionResultBase {
  return {
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    runtime: evidence.runtime,
    authType: evidence.authType,
    planType: evidence.planType,
    preflight: evidence.preflight,
    providerThread: evidence.providerThread,
    providerRun: evidence.providerRun,
    model: evidence.model,
    normalizedUsage: evidence.normalizedUsage,
    terminalTurnStatus: evidence.terminalTurnStatus,
    threadPolicy: evidence.threadPolicy,
    diagnostics: Object.freeze({ ...diagnostics }),
    appServerChildCleaned: evidence.appServerChildCleaned,
    disposableWorkspaceCleaned: evidence.disposableWorkspaceCleaned,
  };
}

function immediateFailure(
  failureCode: LiveCodexExecutionFailureCode,
): LiveCodexExecutionFailure {
  return Object.freeze({
    ...resultBase(emptyEvidence(), emptyDiagnostics()),
    success: false,
    failureCode,
    agentResponseText: null,
  });
}

function ownedWorktreeResultBase(
  evidence: OwnedWorktreeExecutionEvidence,
  diagnostics: MutableDiagnostics,
): OwnedWorktreeCodexExecutionResultBase {
  return {
    providerId: CODEX_APP_SERVER_PROVIDER_ID,
    runtime: evidence.runtime,
    authType: evidence.authType,
    planType: evidence.planType,
    preflight: evidence.preflight,
    chatThreadId: evidence.chatThreadId,
    executionRunId: evidence.executionRunId,
    providerThread: evidence.providerThread,
    providerRun: evidence.providerRun,
    model: evidence.model,
    normalizedUsage: evidence.normalizedUsage,
    terminalTurnStatus: evidence.terminalTurnStatus,
    worktreeOwnershipId: evidence.worktreeOwnershipId,
    worktreeStartingHeadSha: evidence.worktreeStartingHeadSha,
    threadPolicy: evidence.threadPolicy,
    diagnostics: Object.freeze({ ...diagnostics }),
    appServerChildCleaned: evidence.appServerChildCleaned,
    transientRuntimeCleaned: evidence.transientRuntimeCleaned,
  };
}

function immediateOwnedWorktreeFailure(
  failureCode: OwnedWorktreeCodexExecutionFailureCode,
): OwnedWorktreeCodexExecutionFailure {
  return Object.freeze({
    ...ownedWorktreeResultBase(
      emptyOwnedWorktreeEvidence(),
      emptyDiagnostics(),
    ),
    success: false,
    failureCode,
  });
}
