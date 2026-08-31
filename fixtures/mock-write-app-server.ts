import { execFileSync } from "node:child_process";
import { linkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;
type RequestId = number | string;
type Scenario =
  | "approval"
  | "hardlink-during-turn"
  | "head-drift-during-turn"
  | "interrupted"
  | "malformed-response-after-tools"
  | "malformed-tool"
  | "success"
  | "turn-failed"
  | "turn-started-before-response"
  | "turn-start-failed"
  | "tools-before-response"
  | "wait-for-interrupt";

const THREAD_ID = "thread-write-mock-77";
const TURN_ID = "turn-write-mock-88";
const scenario = readScenario();
const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
let initialized = false;
let accountRead = false;
let threadStarted = false;
let turnStarted = false;

lines.on("line", (line) => {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) {
    return;
  }
  if (typeof parsed.method === "string") {
    if (parsed.method === "initialized" && !("id" in parsed)) {
      initialized = true;
      return;
    }
    if (typeof parsed.id === "number" || typeof parsed.id === "string") {
      handleRequest(parsed.id, parsed.method, recordOf(parsed.params));
    }
  }
});

function handleRequest(id: RequestId, method: string, params: JsonRecord): void {
  if (method === "initialize") {
    send({
      id,
      result: {
        userAgent: "ctc-write-mock/1.0.0",
        codexHome: "/private/mock-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (!initialized) {
    sendError(id);
    return;
  }
  if (method === "account/read") {
    accountRead = params.refreshToken === false;
    send({
      id,
      result: {
        account: { type: "chatgpt", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (method === "thread/start") {
    if (!accountRead || !validThreadStart(params)) {
      sendError(id);
      return;
    }
    threadStarted = true;
    const thread = fixtureThread();
    send({
      id,
      result: {
        thread,
        model: "fixture-write-model",
        modelProvider: "fixture",
        cwd: process.cwd(),
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [process.cwd()],
          networkAccess: false,
        },
      },
    });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (method === "turn/start") {
    if (!threadStarted || turnStarted || !validTurnStart(params)) {
      sendError(id);
      return;
    }
    turnStarted = true;
    if (scenario === "turn-start-failed") {
      sendError(id);
      return;
    }
    const startedNotification = {
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: fixtureTurn("inProgress") },
    };
    if (
      scenario === "turn-started-before-response" ||
      scenario === "tools-before-response" ||
      scenario === "malformed-response-after-tools"
    ) {
      send(startedNotification);
    }
    if (
      scenario === "tools-before-response" ||
      scenario === "malformed-response-after-tools"
    ) {
      emitAllowedToolItems();
    }
    send({
      id,
      result: {
        turn: fixtureTurn(
          scenario === "malformed-response-after-tools"
            ? "completed"
            : "inProgress",
        ),
      },
    });
    if (
      scenario !== "turn-started-before-response" &&
      scenario !== "tools-before-response" &&
      scenario !== "malformed-response-after-tools"
    ) {
      send(startedNotification);
    }
    if (scenario === "malformed-response-after-tools") {
      return;
    }
    if (scenario === "wait-for-interrupt") {
      return;
    }
    if (scenario === "approval") {
      send({
        id: "write-approval-1",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "write-file-1",
          startedAtMs: 1,
        },
      });
      return;
    }
    if (scenario === "malformed-tool") {
      sendItem({ type: "commandExecution", id: "write-command-1" });
      return;
    }
    if (scenario !== "tools-before-response") {
      emitAllowedToolItems();
    }
    writeFileSync("owned-output.txt", "owned worktree write\n", {
      encoding: "utf8",
    });
    if (scenario === "hardlink-during-turn") {
      linkSync("owned-output.txt", "owned-output-alias.txt");
    }
    if (scenario === "head-drift-during-turn") {
      execFileSync("git", ["commit", "--allow-empty", "--message", "synthetic drift"], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
    }
    emitUsage();
    const status =
      scenario === "turn-failed"
        ? "failed"
        : scenario === "interrupted"
          ? "interrupted"
          : "completed";
    send({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: fixtureTurn(status) },
    });
    return;
  }
  if (method === "turn/interrupt") {
    if (
      !turnStarted ||
      params.threadId !== THREAD_ID ||
      params.turnId !== TURN_ID
    ) {
      sendError(id);
      return;
    }
    send({ id, result: {} });
    send({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: fixtureTurn("interrupted") },
    });
    return;
  }
  sendError(id);
}

function validThreadStart(params: JsonRecord): boolean {
  return (
    params.cwd === process.cwd() &&
    params.ephemeral === true &&
    params.approvalPolicy === "never" &&
    params.approvalsReviewer === "user" &&
    params.sandbox === "workspace-write" &&
    params.serviceName === "codex_task_console" &&
    !("model" in params) &&
    !("developerInstructions" in params)
  );
}

function validTurnStart(params: JsonRecord): boolean {
  const sandbox = recordOf(params.sandboxPolicy);
  const input = Array.isArray(params.input) ? params.input : [];
  const item = recordOf(input[0]);
  return (
    params.threadId === THREAD_ID &&
    params.cwd === process.cwd() &&
    params.approvalPolicy === "never" &&
    params.approvalsReviewer === "user" &&
    sandbox.type === "workspaceWrite" &&
    sandbox.networkAccess === false &&
    sandbox.excludeSlashTmp === true &&
    sandbox.excludeTmpdirEnvVar === false &&
    Array.isArray(sandbox.writableRoots) &&
    sandbox.writableRoots.length === 1 &&
    sandbox.writableRoots[0] === process.cwd() &&
    input.length === 1 &&
    item.type === "text" &&
    typeof item.text === "string" &&
    Array.isArray(item.text_elements) &&
    item.text_elements.length === 0
  );
}

function emitAllowedToolItems(): void {
  sendItemLifecycle({
    type: "commandExecution",
    id: "write-command-1",
    command: "printf synthetic",
    commandActions: [],
    cwd: process.cwd(),
    status: "completed",
  });
  sendItemLifecycle({
    type: "fileChange",
    id: "write-file-1",
    changes: [
      {
        path: "owned-output.txt",
        diff: "synthetic diff not retained",
        kind: { type: "add" },
      },
    ],
    status: "completed",
  });
  send({
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 2,
      item: {
        type: "agentMessage",
        id: "write-agent-1",
        text: "synthetic completion",
      },
    },
  });
}

function sendItemLifecycle(item: JsonRecord): void {
  send({
    method: "item/started",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: 0,
      item: { ...item, status: "inProgress" },
    },
  });
  sendItem(item);
}

function sendItem(item: JsonRecord): void {
  send({
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 1,
      item,
    },
  });
}

function emitUsage(): void {
  const usage = {
    totalTokens: 18,
    inputTokens: 12,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 0,
    outputTokens: 6,
    reasoningOutputTokens: 1,
  };
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
    },
  });
}

function fixtureThread(): JsonRecord {
  return {
    id: THREAD_ID,
    ephemeral: true,
    cwd: process.cwd(),
  };
}

function fixtureTurn(
  status: "completed" | "failed" | "inProgress" | "interrupted",
): JsonRecord {
  return { id: TURN_ID, items: [], status };
}

function readScenario(): Scenario {
  const value = process.argv
    .find((argument) => argument.startsWith("--scenario="))
    ?.slice("--scenario=".length);
  const allowed: readonly Scenario[] = [
    "approval",
    "hardlink-during-turn",
    "head-drift-during-turn",
    "interrupted",
    "malformed-response-after-tools",
    "malformed-tool",
    "success",
    "turn-failed",
    "turn-started-before-response",
    "turn-start-failed",
    "tools-before-response",
    "wait-for-interrupt",
  ];
  if (!allowed.includes(value as Scenario)) {
    process.exit(2);
  }
  return value as Scenario;
}

function recordOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(value: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendError(id: RequestId): void {
  send({ id, error: { code: -32_600, message: "Synthetic write mock error." } });
}
