import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;
type RequestId = number | string;
type Scenario =
  | "command-approval"
  | "failure"
  | "file-approval"
  | "interrupt"
  | "stream";

interface PendingApproval {
  readonly id: RequestId;
  readonly itemId: string;
  readonly kind: "command" | "file";
}

const FIXED_SECONDS = 1_786_219_200;
const FIXED_MILLISECONDS = FIXED_SECONDS * 1_000;
const THREAD_ID = "thread-fixture-1";
const KNOWN_RESUME_THREAD_ID = "thread-fixture-known";
const TURN_ID = "turn-fixture-1";
const AGENT_ITEM_ID = "item-agent-fixture-1";
const COMMAND_ITEM_ID = "item-command-fixture-1";
const FILE_ITEM_ID = "item-file-fixture-1";
const scenario = readScenario();
const knownThreads = new Set([KNOWN_RESUME_THREAD_ID]);
const goals = new Map<string, JsonRecord>();
let initializeReceived = false;
let initializedReceived = false;
let activeTurn = false;
let pendingApproval: PendingApproval | undefined;

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

process.on("SIGTERM", () => {
  process.exit(0);
});

lines.on("line", (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    fail(null, -32_700, "Malformed JSON input.");
    return;
  }

  if (!isRecord(message)) {
    fail(null, -32_600, "Invalid protocol message.");
    return;
  }

  if (typeof message.method === "string") {
    if (message.method === "initialized" && !("id" in message)) {
      handleInitializedNotification();
      return;
    }
    if (!(typeof message.id === "number" || typeof message.id === "string")) {
      fail(null, -32_600, "Request ID is required.");
      return;
    }
    handleRequest(message.id, message.method, getParams(message));
    return;
  }

  if (typeof message.id === "number" || typeof message.id === "string") {
    handleClientResponse(message.id, message.result);
    return;
  }

  fail(null, -32_600, "Invalid protocol message.");
});

lines.on("close", () => {
  if (pendingApproval !== undefined) {
    diagnostic("Client disconnected with a pending approval request.");
    process.exitCode = 2;
  }
});

function handleInitializedNotification(): void {
  if (!initializeReceived || initializedReceived) {
    fail(null, -32_600, "Unexpected initialized notification.");
    return;
  }
  initializedReceived = true;
}

function handleRequest(id: RequestId, method: string, params: JsonRecord): void {
  if (method === "initialize") {
    if (initializeReceived) {
      sendError(id, -32_002, "Already initialized.");
      return;
    }
    initializeReceived = true;
    send({
      id,
      result: {
        platformFamily: "unix",
        platformOs: "fixture-os",
        userAgent: "codex-task-console-mock/1.0.0",
      },
    });
    return;
  }

  if (!initializedReceived) {
    sendError(id, -32_001, "Not initialized.");
    return;
  }

  switch (method) {
    case "skills/list":
      sendSkills(id, params);
      return;
    case "thread/goal/get":
      sendGoal(id, params);
      return;
    case "thread/goal/set":
      setGoal(id, params);
      return;
    case "thread/resume":
      resumeThread(id, params);
      return;
    case "thread/start":
      startThread(id);
      return;
    case "turn/interrupt":
      interruptTurn(id, params);
      return;
    case "turn/start":
      startTurn(id, params);
      return;
    default:
      sendError(id, -32_601, "Unknown method.");
  }
}

function startThread(id: RequestId): void {
  knownThreads.add(THREAD_ID);
  const thread = fixtureThread(THREAD_ID);
  send({ id, result: { instructionSources: [], thread } });
  send({ method: "thread/started", params: { thread } });
}

function resumeThread(id: RequestId, params: JsonRecord): void {
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  if (!knownThreads.has(threadId)) {
    sendError(id, -32_004, "Unknown fixture thread.");
    return;
  }
  send({ id, result: { instructionSources: [], thread: fixtureThread(threadId) } });
}

function setGoal(id: RequestId, params: JsonRecord): void {
  const threadId = readThreadId(params);
  if (threadId === undefined) {
    sendError(id, -32_600, "A known thread ID is required.");
    return;
  }
  const prior = goals.get(threadId);
  const objective =
    typeof params.objective === "string" ? params.objective : prior?.objective;
  if (typeof objective !== "string" || objective.trim().length === 0) {
    sendError(id, -32_600, "A non-empty goal objective is required.");
    return;
  }
  const goal: JsonRecord = {
    createdAt: FIXED_SECONDS,
    objective,
    status: typeof params.status === "string" ? params.status : "active",
    threadId,
    timeUsedSeconds: 0,
    tokenBudget: typeof params.tokenBudget === "number" ? params.tokenBudget : null,
    tokensUsed: 0,
    updatedAt: FIXED_SECONDS,
  };
  goals.set(threadId, goal);
  send({ id, result: { goal } });
  send({ method: "thread/goal/updated", params: { goal, threadId } });
}

function sendGoal(id: RequestId, params: JsonRecord): void {
  const threadId = readThreadId(params);
  if (threadId === undefined) {
    sendError(id, -32_600, "A known thread ID is required.");
    return;
  }
  send({ id, result: { goal: goals.get(threadId) ?? null } });
}

function sendSkills(id: RequestId, params: JsonRecord): void {
  const requestedCwds = Array.isArray(params.cwds)
    ? params.cwds.filter((value): value is string => typeof value === "string")
    : ["/fixture/workspace"];
  send({
    id,
    result: {
      data: requestedCwds.map((cwd) => ({
        cwd,
        errors: [],
        skills: [
          {
            description: "Execute an approved repository Task Contract.",
            enabled: true,
            name: "task-execution",
            path: "/fixture/workspace/.agents/skills/task-execution/SKILL.md",
          },
        ],
      })),
    },
  });
}

function startTurn(id: RequestId, params: JsonRecord): void {
  const threadId = readThreadId(params);
  if (threadId === undefined) {
    sendError(id, -32_600, "A known thread ID is required.");
    return;
  }
  if (activeTurn) {
    sendError(id, -32_600, "A fixture turn is already active.");
    return;
  }
  if (scenario === "failure") {
    sendError(id, -32_005, "Sanitized fixture protocol failure.");
    return;
  }

  activeTurn = true;
  const turn = fixtureTurn("inProgress", []);
  send({ id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });

  if (scenario === "stream") {
    streamAgentMessage(threadId);
  } else if (scenario === "command-approval") {
    requestCommandApproval(threadId);
  } else if (scenario === "file-approval") {
    requestFileApproval(threadId);
  } else {
    startInterruptibleMessage(threadId);
  }
}

function streamAgentMessage(threadId: string): void {
  sendItemStarted(threadId, { id: AGENT_ITEM_ID, memoryCitation: null, phase: null, text: "", type: "agentMessage" });
  send({
    method: "item/agentMessage/delta",
    params: { delta: "Deterministic ", itemId: AGENT_ITEM_ID, threadId, turnId: TURN_ID },
  });
  send({
    method: "item/agentMessage/delta",
    params: { delta: "fixture response.", itemId: AGENT_ITEM_ID, threadId, turnId: TURN_ID },
  });
  const completedItem = {
    id: AGENT_ITEM_ID,
    memoryCitation: null,
    phase: null,
    text: "Deterministic fixture response.",
    type: "agentMessage",
  };
  sendItemCompleted(threadId, completedItem);
  sendTokenUsage(threadId);
  completeTurn(threadId, "completed", [completedItem]);
}

function requestCommandApproval(threadId: string): void {
  const item = commandItem("inProgress");
  sendItemStarted(threadId, item);
  pendingApproval = {
    id: "approval-command-fixture-1",
    itemId: COMMAND_ITEM_ID,
    kind: "command",
  };
  send({
    id: pendingApproval.id,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "fixture-command --dry-run",
      cwd: "/fixture/workspace",
      environmentId: null,
      itemId: COMMAND_ITEM_ID,
      reason: "Deterministic approval fixture.",
      startedAtMs: FIXED_MILLISECONDS,
      threadId,
      turnId: TURN_ID,
    },
  });
}

function requestFileApproval(threadId: string): void {
  const item = fileItem("inProgress");
  sendItemStarted(threadId, item);
  pendingApproval = {
    id: "approval-file-fixture-1",
    itemId: FILE_ITEM_ID,
    kind: "file",
  };
  send({
    id: pendingApproval.id,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: FILE_ITEM_ID,
      reason: "Deterministic approval fixture; no file is written.",
      startedAtMs: FIXED_MILLISECONDS,
      threadId,
      turnId: TURN_ID,
    },
  });
}

function handleClientResponse(id: RequestId, result: unknown): void {
  if (pendingApproval === undefined || pendingApproval.id !== id) {
    fail(id, -32_600, "Unexpected response ID.");
    return;
  }
  const decision = isRecord(result) ? result.decision : undefined;
  if (
    decision !== "accept" &&
    decision !== "acceptForSession" &&
    decision !== "cancel" &&
    decision !== "decline"
  ) {
    fail(id, -32_600, "Invalid approval decision.");
    return;
  }

  const accepted = decision === "accept" || decision === "acceptForSession";
  const resolved = pendingApproval;
  pendingApproval = undefined;
  send({
    method: "serverRequest/resolved",
    params: { requestId: id, threadId: THREAD_ID },
  });
  const completedItem =
    resolved.kind === "command"
      ? commandItem(accepted ? "completed" : "declined")
      : fileItem(accepted ? "completed" : "declined");
  sendItemCompleted(THREAD_ID, completedItem);
  completeTurn(THREAD_ID, "completed", [completedItem]);
}

function startInterruptibleMessage(threadId: string): void {
  sendItemStarted(threadId, { id: AGENT_ITEM_ID, memoryCitation: null, phase: null, text: "", type: "agentMessage" });
  send({
    method: "item/agentMessage/delta",
    params: { delta: "Partial fixture response.", itemId: AGENT_ITEM_ID, threadId, turnId: TURN_ID },
  });
}

function interruptTurn(id: RequestId, params: JsonRecord): void {
  if (
    !activeTurn ||
    params.threadId !== THREAD_ID ||
    params.turnId !== TURN_ID
  ) {
    sendError(id, -32_600, "No matching active fixture turn.");
    return;
  }
  send({ id, result: {} });
  const partialItem = {
    id: AGENT_ITEM_ID,
    memoryCitation: null,
    phase: null,
    text: "Partial fixture response.",
    type: "agentMessage",
  };
  sendItemCompleted(THREAD_ID, partialItem);
  completeTurn(THREAD_ID, "interrupted", [partialItem]);
}

function completeTurn(threadId: string, status: "completed" | "interrupted", items: JsonRecord[]): void {
  activeTurn = false;
  send({
    method: "turn/completed",
    params: { threadId, turn: fixtureTurn(status, items) },
  });
}

function sendTokenUsage(threadId: string): void {
  const usage = {
    cachedInputTokens: 20,
    cacheWriteInputTokens: 0,
    inputTokens: 100,
    outputTokens: 40,
    reasoningOutputTokens: 5,
    totalTokens: 140,
  };
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      tokenUsage: { last: usage, modelContextWindow: 200_000, total: usage },
      turnId: TURN_ID,
    },
  });
}

function sendItemStarted(threadId: string, item: JsonRecord): void {
  send({
    method: "item/started",
    params: { item, startedAtMs: FIXED_MILLISECONDS, threadId, turnId: TURN_ID },
  });
}

function sendItemCompleted(threadId: string, item: JsonRecord): void {
  send({
    method: "item/completed",
    params: { completedAtMs: FIXED_MILLISECONDS, item, threadId, turnId: TURN_ID },
  });
}

function commandItem(status: "completed" | "declined" | "inProgress"): JsonRecord {
  return {
    aggregatedOutput: null,
    command: "fixture-command --dry-run",
    commandActions: [],
    cwd: "/fixture/workspace",
    durationMs: null,
    exitCode: null,
    id: COMMAND_ITEM_ID,
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status,
    type: "commandExecution",
  };
}

function fileItem(status: "completed" | "declined" | "inProgress"): JsonRecord {
  return {
    changes: [
      {
        diff: "+fixture content\n",
        kind: { type: "add" },
        path: "/fixture/workspace/example.txt",
      },
    ],
    id: FILE_ITEM_ID,
    status,
    type: "fileChange",
  };
}

function fixtureThread(id: string): JsonRecord {
  return {
    createdAt: FIXED_SECONDS,
    cwd: "/fixture/workspace",
    ephemeral: false,
    id,
    modelProvider: "fixture",
    preview: "",
    sessionId: id,
    status: { type: "idle" },
    turns: [],
    updatedAt: FIXED_SECONDS,
  };
}

function fixtureTurn(status: "completed" | "inProgress" | "interrupted", items: JsonRecord[]): JsonRecord {
  return {
    completedAt: status === "inProgress" ? null : FIXED_SECONDS,
    durationMs: status === "inProgress" ? null : 0,
    error: null,
    id: TURN_ID,
    items,
    itemsView: "full",
    startedAt: FIXED_SECONDS,
    status,
  };
}

function readThreadId(params: JsonRecord): string | undefined {
  return typeof params.threadId === "string" && knownThreads.has(params.threadId)
    ? params.threadId
    : undefined;
}

function getParams(message: JsonRecord): JsonRecord {
  return isRecord(message.params) ? message.params : {};
}

function sendError(id: RequestId | null, code: number, message: string): void {
  send({ error: { code, message }, id });
}

function fail(id: RequestId | null, code: number, message: string): void {
  sendError(id, code, message);
  diagnostic(message);
  lines.close();
  setImmediate(() => {
    process.exit(1);
  });
}

function send(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function diagnostic(message: string): void {
  process.stderr.write(`mock-app-server: ${message}\n`);
}

function readScenario(): Scenario {
  const argument = process.argv.find((value) => value.startsWith("--scenario="));
  const value = argument?.slice("--scenario=".length);
  if (
    value === "command-approval" ||
    value === "failure" ||
    value === "file-approval" ||
    value === "interrupt" ||
    value === "stream"
  ) {
    return value;
  }
  process.stderr.write("mock-app-server: A supported fixture scenario is required.\n");
  process.exit(2);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
