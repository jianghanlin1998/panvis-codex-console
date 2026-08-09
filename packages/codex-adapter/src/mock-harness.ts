import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CodexAdapterError } from "./errors.js";
import {
  isProtocolMessage,
  isProtocolResponse,
  type JsonObject,
  type JsonValue,
  type ProtocolResponse,
} from "./protocol.js";

export type MockScenario =
  | "command-approval"
  | "failure"
  | "file-approval"
  | "interrupt"
  | "stream";

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (response: ProtocolResponse) => void;
  readonly timeout: NodeJS.Timeout;
}

interface MessageWaiter {
  readonly predicate: (message: JsonObject) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (message: JsonObject) => void;
  readonly timeout: NodeJS.Timeout;
}

export class MockAppServerHarness {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #defaultTimeoutMs: number;
  readonly #messages: JsonObject[] = [];
  readonly #pendingRequests = new Map<number | string, PendingRequest>();
  readonly #waiters = new Set<MessageWaiter>();
  #stdoutBuffer = "";

  private constructor(child: ChildProcessWithoutNullStreams, defaultTimeoutMs: number) {
    this.#child = child;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#receiveStdout(chunk);
    });
    child.stderr.on("data", () => {
      // Diagnostics intentionally stay separate from protocol parsing.
    });
    child.once("close", () => {
      this.#rejectOutstanding(new CodexAdapterError("MOCK_PROCESS_DISCONNECTED"));
    });
    child.once("error", () => {
      this.#rejectOutstanding(new CodexAdapterError("MOCK_PROCESS_DISCONNECTED"));
    });
  }

  public static start(options: {
    readonly fixturePath: string;
    readonly scenario: MockScenario;
    readonly timeoutMs?: number;
  }): MockAppServerHarness {
    const child = spawn(
      process.execPath,
      [options.fixturePath, `--scenario=${options.scenario}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return new MockAppServerHarness(child, options.timeoutMs ?? 1_000);
  }

  public get isRunning(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  public get messages(): readonly JsonObject[] {
    return [...this.#messages];
  }

  public notify(method: string, params: JsonObject = {}): void {
    this.#send({ method, params });
  }

  public request(
    id: number | string,
    method: string,
    params: JsonObject = {},
    timeoutMs = this.#defaultTimeoutMs,
  ): Promise<ProtocolResponse> {
    if (this.#pendingRequests.has(id)) {
      return Promise.reject(new CodexAdapterError("MOCK_PROTOCOL_ERROR"));
    }

    const response = new Promise<ProtocolResponse>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(id);
        rejectResponse(new CodexAdapterError("MOCK_PROTOCOL_TIMEOUT"));
      }, timeoutMs);
      this.#pendingRequests.set(id, {
        reject: rejectResponse,
        resolve: resolveResponse,
        timeout,
      });
    });
    this.#send({ id, method, params });
    return response;
  }

  public respond(id: number | string, result: JsonValue): void {
    this.#send({ id, result });
  }

  public closeInput(): void {
    this.#child.stdin.end();
  }

  public waitForExit(timeoutMs = this.#defaultTimeoutMs): Promise<number | null> {
    if (!this.isRunning) {
      return Promise.resolve(this.#child.exitCode);
    }

    return new Promise<number | null>((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        rejectExit(new CodexAdapterError("MOCK_PROTOCOL_TIMEOUT"));
      }, timeoutMs);
      this.#child.once("close", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });
  }

  public waitForMessage(
    predicate: (message: JsonObject) => boolean,
    timeoutMs = this.#defaultTimeoutMs,
  ): Promise<JsonObject> {
    const existing = this.#messages.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<JsonObject>((resolveMessage, rejectMessage) => {
      const waiter: MessageWaiter = {
        predicate,
        reject: rejectMessage,
        resolve: resolveMessage,
        timeout: setTimeout(() => {
          this.#waiters.delete(waiter);
          rejectMessage(new CodexAdapterError("MOCK_PROTOCOL_TIMEOUT"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const closed = new Promise<void>((resolveClose) => {
      this.#child.once("close", () => {
        resolveClose();
      });
    });
    this.#child.kill("SIGTERM");
    await closed;
  }

  #receiveStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    const lines = this.#stdoutBuffer.split("\n");
    this.#stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.#rejectOutstanding(new CodexAdapterError("MOCK_PROTOCOL_ERROR"));
        continue;
      }
      if (!isProtocolMessage(parsed)) {
        this.#rejectOutstanding(new CodexAdapterError("MOCK_PROTOCOL_ERROR"));
        continue;
      }
      if (isProtocolResponse(parsed)) {
        const pending = parsed.id === null ? undefined : this.#pendingRequests.get(parsed.id);
        if (pending !== undefined && parsed.id !== null) {
          clearTimeout(pending.timeout);
          this.#pendingRequests.delete(parsed.id);
          pending.resolve(parsed);
          continue;
        }
      }

      this.#messages.push(parsed);
      for (const waiter of this.#waiters) {
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timeout);
          this.#waiters.delete(waiter);
          waiter.resolve(parsed);
        }
      }
    }
  }

  #rejectOutstanding(error: Error): void {
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  #send(message: JsonObject): void {
    if (!this.isRunning) {
      throw new CodexAdapterError("MOCK_PROCESS_DISCONNECTED");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
