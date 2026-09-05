import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const role = process.argv.find((value) => value.startsWith("--role="))?.slice(7);
const malformed = process.argv.includes("--malformed");
const scenario = process.argv.find(value => value.startsWith("--scenario="))?.slice(11);
const writeEnabled = scenario !== "read-only" && (role === "EXECUTE" || role === "HARDEN" || role === "REPAIR");
const occurrence = process.argv.find(value => value.startsWith("--occurrence="))?.slice(13);
const identity = `${role ?? "unknown"}${occurrence === undefined ? "" : `-${occurrence}`}`;
const threadId = `thread-governed-${identity}`;
const turnId = `turn-governed-${identity}`;
let initialized = false;
let accountRead = false;
let threadStarted = false;

const send = (value: JsonRecord): void => {
  if (scenario === "missing-usage" && value.method === "thread/tokenUsage/updated") return;
  if (scenario === "malformed-initialization" && value.id === 1) value.result = {};
  if (value.id === 3) {
    const result = record(value.result);
    if (scenario === "wrong-cwd") result.cwd = "/unrelated";
    if (scenario === "wrong-sandbox") result.sandbox = { type: "dangerFullAccess" };
  }
  if (value.method === "turn/completed") {
    const params = record(value.params);
    if (scenario === "wrong-thread") params.threadId = "unrelated-thread";
    if (scenario === "wrong-turn") record(params.turn).id = "unrelated-turn";
  }
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
        "schemaVersion,outcome,summary,findings,promotionCandidate" ||
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
    const pausePath = process.argv.find(value => value.startsWith("--pause-after-start="))?.slice(20);
    if (pausePath !== undefined) {
      for (let count = 0; count < 1000 && !existsSync(pausePath); count++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      if (!existsSync(pausePath)) process.exit(1);
    }
    if (scenario === "timeout") return;
    if (scenario === "process-exit") { process.exit(1); }
    if (process.argv.includes("--commit-candidate") && role !== "EXECUTE") {
      const prior = role === "HARDEN" || role === "VERIFY" ? "EXECUTE" : role === "FOCUSED_RE_QA" ? "REPAIR" : "HARDEN";
      if (readFileSync(`synthetic-${prior}.txt`, { encoding: "utf8" }) !== `${prior} deterministic candidate\n`) process.exit(1);
    }
    // Opt-in integration fixture: only the authorized write role changes its
    // disposable candidate. Existing protocol scenarios remain unchanged.
    if (process.argv.includes("--commit-candidate") && writeEnabled) {
      const filename = `synthetic-${role}.txt`;
      writeFileSync(filename, `${role} deterministic candidate\n`, { encoding: "utf8" });
      const env = {
        PATH: process.env.PATH,
        GIT_AUTHOR_NAME: "Synthetic Orchestration",
        GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
        GIT_COMMITTER_NAME: "Synthetic Orchestration",
        GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
        GIT_AUTHOR_DATE: "2026-09-05T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-09-05T00:00:00Z",
      };
      execFileSync("git", ["add", "--", filename], { env, stdio: "pipe" });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--message", `Synthetic ${role}`], { env, stdio: "pipe" });
    }
    if (scenario === "approval-request") send({id: "approval", method: "item/commandExecution/requestApproval", params: {threadId, turnId}});
    if (scenario === "read-write-tool") send({method: "item/started", params: {threadId, turnId,
      item: {id: "write-tool", type: "fileChange", status: "inProgress", changes: [{path: "AGENTS.md", kind: {type: "update"}, diff: "+changed"}]}}});
    const finding = (id: string, blocking = true) => ({findingId: id, blocking,
      violatedInvariant: `Invariant ${id}.`, affectedContract: "contract/governed-adapter", reproduction: `Retest ${id}.`});
    const result = {
      schemaVersion: 1,
      promotionCandidate: null,
      outcome: role === "EXECUTE" || role === "REPAIR" ? "READY" : "PASS",
      summary: process.argv.includes("--canary") ? `${role} completed. ${role}_REASONING_CANARY` : `${role} completed.`,
      findings: [] as ReturnType<typeof finding>[],
    };
    if (scenario === "two-blockers" || scenario === "remaining-new") {
      result.outcome = "BLOCKING_FAIL";
      result.findings = scenario === "two-blockers" ? [finding("A"), finding("B"), finding("defer", false)] : [finding("A"), finding("NEW")];
    }
    if (scenario === "wrong-outcome") result.outcome = "ACCEPTED";
    if (scenario === "nonblocking") result.findings = [finding("defer", false)];
    let resultText = JSON.stringify(result);
    if (scenario === "duplicate-key") resultText = resultText.replace('"outcome":', '"outcome":"PASS","outcome":');
    if (scenario === "wrong-fields") resultText = resultText.replace('"schemaVersion":1', '"unexpected":true,"schemaVersion":1');
    if (scenario === "oversized") resultText = "x".repeat(17 * 1024);
    if (scenario === "malformed-unicode") resultText = resultText.replace(`${role} completed.`, "\\ud800");
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "governed-agent-message",
          type: "agentMessage",
          status: "completed",
          text: malformed ? "not-json" : resultText,
        },
      },
    });
    if (scenario === "duplicate-item") send({method: "item/completed", params: {threadId, turnId,
      item: {id: "governed-agent-message", type: "agentMessage", status: "completed", text: resultText}}});
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: {
            totalTokens: Number(process.argv.find(value => value.startsWith("--tokens="))?.slice(9) ?? 18),
            inputTokens: Number(process.argv.find(value => value.startsWith("--tokens="))?.slice(9) ?? 18) - 6,
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
    if (scenario === "post-terminal") send({method: "item/started", params: {threadId, turnId, item: {id:"late",type:"reasoning"}}});
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id, result: {} });
    return;
  }
  error(id);
});
