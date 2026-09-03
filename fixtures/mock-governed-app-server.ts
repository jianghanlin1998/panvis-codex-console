import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;

const role = process.argv.find((value) => value.startsWith("--role="))?.slice(7);
const malformed = process.argv.includes("--malformed");
const writeEnabled = role === "EXECUTE" || role === "HARDEN" || role === "REPAIR";
const threadId = `thread-governed-${role ?? "unknown"}`;
const turnId = `turn-governed-${role ?? "unknown"}`;
let initialized = false;
let accountRead = false;
let threadStarted = false;

const send = (value: JsonRecord): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const record = (value: unknown): JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const error = (id: number | string): void => {
  send({ id, error: { code: -32602, message: "invalid" } });
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = record(JSON.parse(line) as unknown);
  if (message.method === "initialized" && !("id" in message)) {
    initialized = true;
    return;
  }
  if (
    (typeof message.id !== "number" && typeof message.id !== "string") ||
    typeof message.method !== "string"
  ) {
    return;
  }
  const id = message.id;
  const params = record(message.params);
  if (message.method === "initialize") {
    send({
      id,
      result: {
        userAgent: "ctc-governed-mock/1",
        codexHome: "/private/mock",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (!initialized) {
    error(id);
    return;
  }
  if (message.method === "account/read") {
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
  if (message.method === "thread/start") {
    if (
      !accountRead ||
      params.cwd !== process.cwd() ||
      params.ephemeral !== true ||
      params.approvalPolicy !== "never" ||
      params.approvalsReviewer !== "user" ||
      params.sandbox !== (writeEnabled ? "workspace-write" : "read-only")
    ) {
      error(id);
      return;
    }
    threadStarted = true;
    const thread = { id: threadId, ephemeral: true, cwd: process.cwd() };
    send({
      id,
      result: {
        thread,
        model: "fixture-governed-model",
        modelProvider: "fixture",
        cwd: process.cwd(),
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: writeEnabled
          ? {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: false,
              excludeSlashTmp: false,
              excludeTmpdirEnvVar: false,
            }
          : { type: "readOnly", networkAccess: false },
      },
    });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "turn/start") {
    const sandbox = record(params.sandboxPolicy);
    const input = Array.isArray(params.input) ? params.input : [];
    const item = record(input[0]);
    const text = typeof item.text === "string" ? item.text : "";
    let governedInput: JsonRecord = {};
    try {
      governedInput = record(
        JSON.parse(
          text.slice("CODEX_TASK_CONSOLE_GOVERNED_ROLE_V0\n".length),
        ) as unknown,
      );
    } catch {
      governedInput = {};
    }
    const resultContract = record(governedInput.resultContract);
    const validSandbox = writeEnabled
      ? sandbox.type === "workspaceWrite" &&
        sandbox.networkAccess === false &&
        sandbox.excludeSlashTmp === true &&
        sandbox.excludeTmpdirEnvVar === false &&
        Array.isArray(sandbox.writableRoots) &&
        sandbox.writableRoots.length === 1 &&
        sandbox.writableRoots[0] === process.cwd()
      : sandbox.type === "readOnly" && sandbox.networkAccess === false;
    if (
      !threadStarted ||
      params.threadId !== threadId ||
      params.cwd !== process.cwd() ||
      params.approvalPolicy !== "never" ||
      params.approvalsReviewer !== "user" ||
      input.length !== 1 ||
      item.type !== "text" ||
      !text.startsWith("CODEX_TASK_CONSOLE_GOVERNED_ROLE_V0\n") ||
      governedInput.role !== role ||
      typeof governedInput.canonicalContext !== "string" ||
      resultContract.schemaVersion !== 1 ||
      !Array.isArray(resultContract.exactKeys) ||
      resultContract.exactKeys.join(",") !==
        "schemaVersion,outcome,summary,findings" ||
      !validSandbox
    ) {
      error(id);
      return;
    }
    send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "governed-agent-message",
          type: "agentMessage",
          status: "completed",
          text: malformed
            ? "not-json"
            : JSON.stringify({
                schemaVersion: 1,
                outcome:
                  role === "EXECUTE" || role === "REPAIR" ? "READY" : "PASS",
                summary: `${role} completed.`,
                findings: [],
              }),
        },
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: {
            totalTokens: 18,
            inputTokens: 12,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 0,
            outputTokens: 6,
            reasoningOutputTokens: 1,
          },
          last: {},
          modelContextWindow: 200_000,
        },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id, result: {} });
    return;
  }
  error(id);
});
