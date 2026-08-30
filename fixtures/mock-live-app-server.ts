import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;
type RequestId = number | string;
type Scenario =
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
  | "terminal-eof-complete-json"
  | "terminal-eof-partial-json"
  | "terminal-before-turn-identity"
  | "terminal-before-turn-start"
  | "terminal-conflicting"
  | "terminal-duplicate"
  | "terminal-duplicate-delayed"
  | "terminal-other-thread"
  | "terminal-other-turn"
  | "terminal-post-agent-delta"
  | "terminal-post-item-completed"
  | "terminal-post-usage"
  | "timeout"
  | "tool-action"
  | "turn-response-timeout"
  | "turn-failed"
  | "unknown-account"
  | "unknown-request"
  | "wrong-response-id";

const THREAD_ID = "thread-live-mock-77";
const TURN_ID = "turn-live-mock-88";
const AGENT_ITEM_ID = "item-live-agent-99";
const FIXED_SECONDS = 1_788_019_200;
const scenario = readScenario();
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let initializeReceived = false;
let initializedReceived = false;
let accountReadReceived = false;
let threadStarted = false;
let activeTurn = false;
let turnStartCount = 0;

process.on("SIGTERM", () => {
  if (scenario !== "shutdown-needs-kill") {
    process.exit(0);
  }
});

lines.on("line", (line) => {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    sendError(null, -32_700);
    return;
  }
  if (!isRecord(message)) {
    sendError(null, -32_600);
    return;
  }
  if (typeof message.method === "string") {
    if (message.method === "initialized" && !("id" in message)) {
      initializedReceived = initializeReceived && !initializedReceived;
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") {
      sendError(null, -32_600);
      return;
    }
    handleRequest(message.id, message.method, paramsOf(message));
    return;
  }
  if (typeof message.id === "number" || typeof message.id === "string") {
    handleClientResponse(message.id, message);
    return;
  }
  sendError(null, -32_600);
});

lines.on("close", () => {
  if (scenario === "terminal-eof-partial-json") {
    process.stdout.write('{"method":');
  }
  if (scenario === "terminal-eof-complete-json") {
    process.stdout.write(JSON.stringify({ method: "fixture/unknown", params: null }));
  }
});

function handleRequest(id: RequestId, method: string, params: JsonRecord): void {
  if (method === "initialize") {
    if (initializeReceived || !validInitialize(params)) {
      sendError(id, -32_600);
      return;
    }
    initializeReceived = true;
    if (scenario === "early-exit") {
      process.exit(3);
    }
    if (scenario === "initialize-malformed") {
      send({ id, result: { platformFamily: "unix" } });
      return;
    }
    const response = {
      id: scenario === "wrong-response-id" ? "unexpected-live-id" : id,
      result: {
        userAgent: "ctc-live-mock/2.0.0",
        codexHome: "/private/mock-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    };
    send(response);
    if (scenario === "duplicate-response") {
      send(response);
    }
    return;
  }

  if (!initializedReceived) {
    sendError(id, -32_001);
    return;
  }

  if (method === "account/read") {
    if (accountReadReceived || params.refreshToken !== false) {
      sendError(id, -32_600);
      return;
    }
    accountReadReceived = true;
    if (scenario === "api-key") {
      send({ id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
      return;
    }
    if (scenario === "bedrock") {
      send({
        id,
        result: {
          account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
          requiresOpenaiAuth: false,
        },
      });
      return;
    }
    if (scenario === "account-null") {
      send({ id, result: { account: null, requiresOpenaiAuth: true } });
      return;
    }
    if (scenario === "malformed-account") {
      send({
        id,
        result: { account: { type: 17, email: "must-not-leak@example.invalid" } },
      });
      return;
    }
    if (scenario === "unknown-account") {
      send({
        id,
        result: {
          account: { type: "unknown-live-auth", accountId: "must-not-leak-account-id" },
          requiresOpenaiAuth: true,
        },
      });
      return;
    }
    send({
      id,
      result: {
        account: {
          type: "chatgpt",
          email: "must-not-leak@example.invalid",
          accountId: "must-not-leak-account-id",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      },
    });
    const accountUpdate = accountUpdateForScenario(scenario);
    if (accountUpdate !== null) {
      send({ method: "account/updated", params: accountUpdate });
    }
    return;
  }

  if (method === "thread/start") {
    if (!accountReadReceived || !validThreadStart(params)) {
      sendError(id, -32_600);
      return;
    }
    if (scenario === "terminal-before-turn-start") {
      sendTurnCompleted(THREAD_ID, TURN_ID, "completed");
      return;
    }
    threadStarted = true;
    const thread = fixtureThread();
    send({
      id,
      result: {
        thread,
        model: "fixture-live-model",
        modelProvider: "fixture",
        serviceTier: null,
        cwd: process.cwd(),
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: null,
      },
    });
    send({ method: "thread/started", params: { thread } });
    return;
  }

  if (method === "turn/start") {
    turnStartCount += 1;
    if (!threadStarted || turnStartCount !== 1 || !validTurnStart(params)) {
      sendError(id, -32_600);
      return;
    }
    activeTurn = true;
    const text = ((params.input as unknown[])[0] as JsonRecord).text as string;
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const agentText = `CTC_MOCK_LIVE_OK:${digest}`;
    if (scenario === "turn-response-timeout") {
      return;
    }
    if (scenario === "terminal-before-turn-identity") {
      sendTurnCompleted(THREAD_ID, TURN_ID, "completed");
      return;
    }
    send({ id, result: { turn: fixtureTurn("inProgress") } });
    send({
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: fixtureTurn("inProgress") },
    });

    if (scenario === "account-update-apikey-during-turn") {
      send({
        method: "account/updated",
        params: { authMode: "apikey", planType: null },
      });
      return;
    }
    if (scenario === "terminal-other-thread") {
      sendTurnCompleted("thread-live-other-1", TURN_ID, "completed");
      return;
    }
    if (scenario === "terminal-other-turn") {
      sendTurnCompleted(THREAD_ID, "turn-live-other-1", "completed");
      return;
    }
    if (scenario === "terminal-duplicate" || scenario === "terminal-conflicting") {
      sendTurnCompletedBatch([
        turnCompletedMessage(THREAD_ID, TURN_ID, "completed"),
        turnCompletedMessage(
          THREAD_ID,
          TURN_ID,
          scenario === "terminal-conflicting" ? "failed" : "completed",
        ),
      ]);
      return;
    }
    if (scenario === "terminal-duplicate-delayed") {
      sendTurnCompleted(THREAD_ID, TURN_ID, "completed");
      setTimeout(() => sendTurnCompleted(THREAD_ID, TURN_ID, "completed"), 5);
      return;
    }

    if (scenario === "disconnect") {
      process.exit(4);
    }
    if (scenario === "malformed-json") {
      process.stdout.write("{malformed-live-json\n");
      return;
    }
    if (scenario === "oversized-jsonl") {
      process.stdout.write(`${"x".repeat(32_768)}\n`);
      return;
    }
    if (scenario === "notification-overflow") {
      for (let index = 0; index < 8; index += 1) {
        send({ method: `fixture/unknown/${index}`, params: null });
      }
      return;
    }
    if (scenario === "command-approval") {
      send({
        id: "approval-command-live-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "command-live-1",
          startedAtMs: FIXED_SECONDS * 1_000,
          command: "echo forbidden",
        },
      });
      return;
    }
    if (scenario === "file-approval") {
      send({
        id: "approval-file-live-1",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "file-live-1",
          startedAtMs: FIXED_SECONDS * 1_000,
        },
      });
      return;
    }
    if (scenario === "unknown-request") {
      send({
        id: "unknown-live-1",
        method: "item/permissions/requestApproval",
        params: { threadId: THREAD_ID, turnId: TURN_ID },
      });
      return;
    }
    if (scenario === "tool-action") {
      send({
        method: "item/started",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          startedAtMs: FIXED_SECONDS * 1_000,
          item: { type: "commandExecution", id: "command-live-2" },
        },
      });
      return;
    }
    if (scenario === "timeout" || scenario === "interrupt-failure") {
      return;
    }
    if (scenario === "stderr-secret") {
      process.stderr.write("RAW_PROVIDER_SECRET_SENTINEL\n");
    }
    emitCompletedTurn(agentText, scenario === "turn-failed" ? "failed" : "completed");
    emitPostTerminalTurnEvent(scenario, agentText);
    if (
      scenario === "shutdown-hang" ||
      scenario === "shutdown-needs-kill" ||
      scenario === "shutdown-needs-term"
    ) {
      setInterval(() => undefined, 1_000);
    }
    return;
  }

  if (method === "turn/interrupt") {
    if (!activeTurn || params.threadId !== THREAD_ID || params.turnId !== TURN_ID) {
      sendError(id, -32_600);
      return;
    }
    if (scenario === "interrupt-failure") {
      sendError(id, -32_603);
      return;
    }
    activeTurn = false;
    send({ id, result: {} });
    send({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: fixtureTurn("interrupted") },
    });
    return;
  }

  sendError(id, -32_601);
}

function emitPostTerminalTurnEvent(value: Scenario, agentText: string): void {
  if (value === "terminal-post-agent-delta") {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: AGENT_ITEM_ID,
        delta: agentText,
      },
    });
  }
  if (value === "terminal-post-item-completed") {
    send({
      method: "item/completed",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        completedAtMs: FIXED_SECONDS * 1_000 + 2,
        item: {
          type: "agentMessage",
          id: AGENT_ITEM_ID,
          text: agentText,
          phase: null,
          memoryCitation: null,
        },
      },
    });
  }
  if (value === "terminal-post-usage") {
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          total: tokenUsage(),
          last: tokenUsage(),
          modelContextWindow: 200_000,
        },
      },
    });
  }
}

function handleClientResponse(id: RequestId, message: JsonRecord): void {
  if (
    id === "approval-command-live-1" ||
    id === "approval-file-live-1"
  ) {
    const result = isRecord(message.result) ? message.result : {};
    if (result.decision !== "decline") {
      process.exitCode = 7;
    }
    return;
  }
  if (id === "unknown-live-1" && !isRecord(message.error)) {
    process.exitCode = 8;
  }
}

function emitCompletedTurn(
  agentText: string,
  status: "completed" | "failed",
): void {
  const midpoint = Math.floor(agentText.length / 2);
  send({
    method: "item/started",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: FIXED_SECONDS * 1_000,
      item: {
        type: "agentMessage",
        id: AGENT_ITEM_ID,
        text: "",
        phase: null,
        memoryCitation: null,
      },
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: AGENT_ITEM_ID,
      delta: agentText.slice(0, midpoint),
    },
  });
  send({ method: "fixture/unknown", params: null });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: AGENT_ITEM_ID,
      delta: agentText.slice(midpoint),
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: FIXED_SECONDS * 1_000 + 1,
      item: {
        type: "agentMessage",
        id: AGENT_ITEM_ID,
        text: agentText,
        phase: null,
        memoryCitation: null,
      },
    },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: {
        total: tokenUsage(),
        last: tokenUsage(),
        modelContextWindow: 200_000,
      },
    },
  });
  activeTurn = false;
  send({
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: fixtureTurn(status) },
  });
}

function sendTurnCompleted(
  threadId: string,
  turnId: string,
  status: "completed" | "failed" | "interrupted",
): void {
  send(turnCompletedMessage(threadId, turnId, status));
}

function turnCompletedMessage(
  threadId: string,
  turnId: string,
  status: "completed" | "failed" | "interrupted",
): JsonRecord {
  const turn = fixtureTurn(status);
  turn.id = turnId;
  return { method: "turn/completed", params: { threadId, turn } };
}

function sendTurnCompletedBatch(messages: readonly JsonRecord[]): void {
  process.stdout.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

function accountUpdateForScenario(value: Scenario): JsonRecord | null {
  switch (value) {
    case "account-update-chatgpt-before-turn":
      return { authMode: "chatgpt", planType: "pro" };
    case "account-update-apikey-before-turn":
      return { authMode: "apikey", planType: null };
    case "account-update-bedrock-before-turn":
      return { authMode: "bedrockApiKey", planType: null };
    case "account-update-null-before-turn":
      return { authMode: null, planType: null };
    case "account-update-missing-before-turn":
      return { planType: "pro" };
    case "account-update-malformed-before-turn":
      return { authMode: 17, planType: "must-not-leak" };
    case "account-update-unknown-before-turn":
      return { authMode: "unknown-auth-mode", planType: "pro" };
    default:
      return null;
  }
}

function validInitialize(params: JsonRecord): boolean {
  const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
  return (
    clientInfo.name === "codex_task_console" &&
    clientInfo.title === "Codex Task Console" &&
    clientInfo.version === "0.1.0" &&
    params.capabilities === null &&
    !("experimentalApi" in params)
  );
}

function validThreadStart(params: JsonRecord): boolean {
  return (
    params.cwd === process.cwd() &&
    params.ephemeral === true &&
    params.approvalPolicy === "never" &&
    params.approvalsReviewer === "user" &&
    params.sandbox === "read-only" &&
    params.serviceName === "codex_task_console" &&
    !("model" in params) &&
    !("modelProvider" in params) &&
    !("baseInstructions" in params) &&
    !("developerInstructions" in params) &&
    !("config" in params)
  );
}

function validTurnStart(params: JsonRecord): boolean {
  if (
    params.threadId !== THREAD_ID ||
    params.cwd !== process.cwd() ||
    params.approvalPolicy !== "never" ||
    params.approvalsReviewer !== "user" ||
    "model" in params
  ) {
    return false;
  }
  const sandbox = isRecord(params.sandboxPolicy) ? params.sandboxPolicy : {};
  const input = Array.isArray(params.input) ? params.input : [];
  const item = isRecord(input[0]) ? input[0] : {};
  return (
    sandbox.type === "readOnly" &&
    sandbox.networkAccess === false &&
    input.length === 1 &&
    item.type === "text" &&
    typeof item.text === "string" &&
    Array.isArray(item.text_elements) &&
    item.text_elements.length === 0
  );
}

function fixtureThread(): JsonRecord {
  return {
    id: THREAD_ID,
    sessionId: THREAD_ID,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: true,
    section: null,
    sectionEnteredAt: null,
    modelProvider: "fixture",
    createdAt: FIXED_SECONDS,
    updatedAt: FIXED_SECONDS,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: process.cwd(),
    cliVersion: "0.148.0-alpha.9",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function fixtureTurn(status: "completed" | "failed" | "inProgress" | "interrupted"):
JsonRecord {
  return {
    id: TURN_ID,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "synthetic failure" } : null,
    startedAt: FIXED_SECONDS,
    completedAt: status === "inProgress" ? null : FIXED_SECONDS + 1,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function tokenUsage(): JsonRecord {
  return {
    totalTokens: 26,
    inputTokens: 21,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 1,
  };
}

function readScenario(): Scenario {
  const argument = process.argv.slice(2).find((value) => value.startsWith("--scenario="));
  const value = argument?.slice("--scenario=".length);
  const scenarios: readonly Scenario[] = [
    "account-null",
    "account-update-apikey-before-turn",
    "account-update-apikey-during-turn",
    "account-update-bedrock-before-turn",
    "account-update-chatgpt-before-turn",
    "account-update-malformed-before-turn",
    "account-update-missing-before-turn",
    "account-update-null-before-turn",
    "account-update-unknown-before-turn",
    "api-key",
    "bedrock",
    "command-approval",
    "disconnect",
    "duplicate-response",
    "early-exit",
    "file-approval",
    "initialize-malformed",
    "interrupt-failure",
    "malformed-account",
    "malformed-json",
    "notification-overflow",
    "oversized-jsonl",
    "shutdown-hang",
    "shutdown-needs-kill",
    "shutdown-needs-term",
    "stderr-secret",
    "success",
    "terminal-eof-complete-json",
    "terminal-eof-partial-json",
    "terminal-before-turn-identity",
    "terminal-before-turn-start",
    "terminal-conflicting",
    "terminal-duplicate",
    "terminal-duplicate-delayed",
    "terminal-other-thread",
    "terminal-other-turn",
    "terminal-post-agent-delta",
    "terminal-post-item-completed",
    "terminal-post-usage",
    "timeout",
    "tool-action",
    "turn-response-timeout",
    "turn-failed",
    "unknown-account",
    "unknown-request",
    "wrong-response-id",
  ];
  if (!scenarios.includes(value as Scenario)) {
    process.stderr.write("A valid live mock scenario is required.\n");
    process.exit(2);
  }
  return value as Scenario;
}

function paramsOf(record: JsonRecord): JsonRecord {
  return isRecord(record.params) ? record.params : {};
}

function send(value: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendError(id: RequestId | null, code: number): void {
  send({ id, error: { code, message: "Synthetic live mock error." } });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
