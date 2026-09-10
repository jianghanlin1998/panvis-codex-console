import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import type { executeBigTaskPlanningCodexForTest } from "../src/live-execution.js";
import { TESTED_CODEX_VERSION } from "../src/compatibility.js";

type Dependencies = Parameters<typeof executeBigTaskPlanningCodexForTest>[2];
export interface PlanningMockPacket {
  role: "PLANNER" | "REVIEWER";
  instruction: string;
  proposal: { candidateBinding: string; candidate: { revision: number } } | null;
  revisionRequirements?: string[];
}

/** In-memory JSONL peer: no provider process, network, real-time waits or shared fixtures. */
export function planningProviderFixture(
  answer: (packet: PlanningMockPacket, sequence: number) => unknown,
  options: {
    omitUsage?: boolean; tokens?: number; apiKey?: boolean; toolAttempt?: boolean; researchTools?: boolean; duplicateThread?: boolean;
    modelsResult?: (cursor: unknown) => unknown; configReadResult?: unknown; extraNotifications?: number; silentTurn?: boolean; failedCodexErrorInfo?: unknown;
    delayedReply?: { method: string; milliseconds: number };
    streamResponse?: boolean; agentChunks?: readonly string[]; deltaThreadId?: string;
    governed?: boolean; onTurnStarted?: () => void; researchCall?: object; onResearchResult?: (result: unknown) => void;
  } = {},
) {
  const packets: PlanningMockPacket[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const launches: Array<{ args: readonly string[]; options: Parameters<Dependencies["spawnAppServer"]>[2] }> = [];
  const workspaces: string[] = [];
  const peers: Array<{ send: (message: unknown) => void; threadId: string; turnId: string }> = [];
  const dependencies: Dependencies = {
    resolveRuntime: () => ({
      canonicalExecutablePath: "/owned/codex/0.153.3-aarch64-apple-darwin/bin/codex",
      exactVersionOutput: TESTED_CODEX_VERSION, executable: true, readable: true,
      releaseVersion: "0.153.3", source: "OWNED_RELEASE", target: "aarch64-apple-darwin",
    }) as ReturnType<Dependencies["resolveRuntime"]>,
    sourceEnvironment: {}, normalHomeDirectory: "/private/mock-home",
    createWorkspace: () => {
      const workspace = mkdtempSync(join(realpathSync(tmpdir()), "ctc-live-codex-"));
      chmodSync(workspace, 0o700); workspaces.push(workspace); return workspace;
    },
    removeWorkspace: (workspace) => rmSync(workspace, { recursive: true, force: true }),
    limits: {
      startupTimeoutMs: 2_000, requestTimeoutMs: 2_000, turnIdleTimeoutMs: 2_000,
      turnAbsoluteTimeoutMs: 5_000, interruptTimeoutMs: 500, shutdownGraceMs: 500,
      terminateGraceMs: 500, maxJsonlLineBytes: 1_048_576, maxPendingRequests: 8,
      maxNotifications: 64, maxAgentResponseBytes: 16_384, maxStderrBytes: 128,
    },
    spawnAppServer: (_executable, args, spawnOptions) => {
      launches.push({ args, options: spawnOptions });
      const sequence = launches.length;
      const threadId = `planning-thread-${options.duplicateThread ? 1 : sequence}`;
      const turnId = `planning-turn-${sequence}`;
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { pid: sequence, exitCode: null, signalCode: null, stdout, stderr });
      const send = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`, "utf8");
      peers.push({ send, threadId, turnId });
      let researchFinished = false;
      let finishAfterResearch: (() => void) | undefined;
      child.stdin = new Writable({
        write(chunk: Buffer, _encoding, done) {
          const message = JSON.parse(chunk.toString("utf8")) as { id?: number; method: string; params: Record<string, unknown> };
          if (!message.method && message.id === 910) {
            options.onResearchResult?.((message as unknown as { result: unknown }).result);
            researchFinished = true; queueMicrotask(() => finishAfterResearch?.()); done(); return;
          }
          requests.push({ method: message.method, params: message.params });
          queueMicrotask(() => {
            const reply = (result: unknown) => {
              if (options.delayedReply?.method === message.method) {
                setTimeout(() => { if (child.exitCode === null) send({ id: message.id, result }); }, options.delayedReply.milliseconds);
              } else send({ id: message.id, result });
            };
            if (message.method === "initialize") reply({ userAgent: "fixture", codexHome: "/private/mock-home", platformFamily: "unix", platformOs: "macos" });
            if (message.method === "account/read") reply({ account: options.apiKey ? { type: "apiKey" } : { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" }, requiresOpenaiAuth: true });
            if (message.method === "model/list") reply(options.modelsResult?.(message.params.cursor) ?? { data: [], nextCursor: null });
            if (message.method === "config/read") reply(options.configReadResult === undefined ? { config: { mcp_servers: {} }, origins: {} } : options.configReadResult);
            if (message.method === "thread/start") reply({
              thread: { id: threadId, ephemeral: true, cwd: spawnOptions.cwd }, cwd: spawnOptions.cwd,
              model: message.params.model ?? "fixture-model", approvalPolicy: "never", approvalsReviewer: "user",
              sandbox: options.governed && message.params.sandbox === "workspace-write"
                ? { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false }
                : { type: "readOnly", networkAccess: false },
            });
            if (message.method === "turn/start") {
              const input = message.params.input as Array<{ text: string }>;
              const packet = JSON.parse(options.governed ? input[0]!.text.slice("CODEX_TASK_CONSOLE_GOVERNED_ROLE_V0\n".length) : input[0]!.text) as PlanningMockPacket;
              packets.push(packet);
              reply({ turn: { id: turnId, status: "inProgress" } });
              const finish = () => {
                if (options.researchCall && !researchFinished) {
                  finishAfterResearch = finish;
                  send({ method: "item/started", params: { threadId, turnId, item: { id: "research", type: "dynamicToolCall", status: "inProgress" } } });
                  send({ id: 910, method: "item/tool/call", params: { threadId, turnId, callId: "research", namespace: null, tool: "console_read", arguments: options.researchCall } });
                  return;
                }
                if (options.researchCall) send({ method: "item/completed", params: { threadId, turnId, item: { id: "research", type: "dynamicToolCall", status: "completed" } } });
                options.onTurnStarted?.();
                if (options.silentTurn) return;
                if (options.failedCodexErrorInfo !== undefined) {
                  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", items: [],
                    error: { message: "private-provider-canary", additionalDetails: "private-provider-canary", codexErrorInfo: options.failedCodexErrorInfo } } } });
                  return;
                }
                for (let i = 0; i < (options.extraNotifications ?? 0); i += 1) {
                  send({ method: "fixture/unknown", params: { message: "private-provider-canary" } });
                }
                if (!options.omitUsage) {
                  const totalTokens = options.tokens ?? 100;
                  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: {
                    totalTokens, inputTokens: totalTokens - 1, outputTokens: 1,
                    cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0,
                  } } } });
                }
                if (options.researchTools) {
                  for (const type of ["webSearch", "imageView"]) {
                    send({ method: "item/started", params: { threadId, turnId, item: { id: type, type, status: "inProgress" } } });
                    send({ method: "item/completed", params: { threadId, turnId, item: { id: type, type, status: "completed" } } });
                  }
                  const item = { id: "read-command", type: "commandExecution", command: "git status --short", cwd: spawnOptions.cwd, commandActions: [] };
                  send({ method: "item/started", params: { threadId, turnId, item: { ...item, status: "inProgress" } } });
                  send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: item.id, delta: "fixture" } });
                  send({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed" } } });
                }
                if (options.toolAttempt) {
                  send({ method: "item/started", params: { threadId, turnId, item: { id: "command", type: "commandExecution", status: "inProgress" } } });
                } else {
                  const text = JSON.stringify(answer(packet, sequence));
                  const chunks = options.agentChunks ?? (options.streamResponse ? Array.from(text) : []);
                  for (const delta of chunks) {
                    send({ method: "item/agentMessage/delta", params: { threadId: options.deltaThreadId ?? threadId, turnId, itemId: "answer", delta } });
                  }
                  send({ method: "item/completed", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text } } });
                }
                send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
              };
              queueMicrotask(finish);
            }
            if (message.method === "turn/interrupt") reply({});
          });
          done();
        },
        final(done) {
          queueMicrotask(() => { stdout.end(); stderr.end(); Object.assign(child, { exitCode: 0 }); child.emit("close", 0, null); });
          done();
        },
      });
      child.kill = () => { Object.assign(child, { exitCode: 0 }); child.emit("close", 0, null); return true; };
      return child;
    },
  };
  return { dependencies, packets, requests, launches, workspaces, peers };
}
