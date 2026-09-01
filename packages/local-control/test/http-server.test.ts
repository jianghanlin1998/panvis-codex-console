import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import type { SubtaskId } from "@codex-task-console/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_CONTROL_BODY_LIMIT_BYTES,
  LOCAL_CONTROL_HOST,
  createLocalControlHttpServer,
} from "../src/http-server.js";
import {
  LocalControlServiceError,
} from "../src/service.js";
import type {
  ExecutionOperationResult,
  LocalControlService,
  SubtaskInspection,
  WorktreeOperationResult,
} from "../src/service.js";

const TOKEN = "a".repeat(64);
const SUBTASK_ID = "st_http_test" as SubtaskId;
const SECOND_SUBTASK_ID = "st_http_second" as SubtaskId;

interface TestServer {
  readonly authority: string;
  readonly port: number;
  readonly service: LocalControlService;
  close(): Promise<void>;
}

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readonly<Record<string, unknown>>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  for (const server of activeServers.splice(0)) {
    await server.close();
  }
});

const inspection = (subtaskId: SubtaskId): SubtaskInspection => ({
  subtask: { id: subtaskId, status: "IN_PROGRESS", maturity: "IMPLEMENTED" },
  dependencyReadiness: {
    valid: true,
    ready: true,
    blockerCount: 0,
    errorCodes: [],
  },
  worktree: {
    id: "wt_11111111111111111111111111111111",
    status: "ACTIVE",
    activeAuthorityVerified: true,
  },
  durableExecution: {
    chatThreadCount: 0,
    returnedChatThreadCount: 0,
    recentChatThreads: [],
  },
});

const worktreeResult = (status: "ACTIVE" | "RELEASED"): WorktreeOperationResult => ({
  worktree: {
    id: "wt_11111111111111111111111111111111",
    status,
    startingCommitSha: "1".repeat(40),
    releaseHeadSha: status === "RELEASED" ? "1".repeat(40) : null,
  },
});

const executionResult = (success: boolean): ExecutionOperationResult => ({
  execution: {
    success,
    failureCode: success ? null : "PRIMARY_EXECUTION_CONFLICT",
    chatThreadId: success ? "thr_http_test" : null,
    executionRunId: success ? "run_http_test" : null,
    worktreeOwnershipId: success
      ? "wt_11111111111111111111111111111111"
      : null,
    providerId: "codex-app-server",
    providerThreadId: null,
    providerRunId: null,
    providerModelId: null,
    normalizedUsage: null,
    terminalTurnStatus: success ? "completed" : null,
    appServerChildCleaned: true,
    transientRuntimeCleaned: true,
  },
});

const defaultService = (): LocalControlService => ({
  inspectSubtask: vi.fn(async (subtaskId) => inspection(subtaskId)),
  provisionOwnedWorktree: vi.fn(async () => worktreeResult("ACTIVE")),
  runOwnedWorktreeExecution: vi.fn(async () => executionResult(true)),
  releaseOwnedWorktree: vi.fn(async () => worktreeResult("RELEASED")),
});

const startServer = async (
  service: LocalControlService = defaultService(),
): Promise<TestServer> => {
  const http = createLocalControlHttpServer(service, TOKEN);
  await new Promise<void>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, LOCAL_CONTROL_HOST, () => resolve());
  });
  const address = http.server.address() as AddressInfo;
  const authority = `${LOCAL_CONTROL_HOST}:${address.port}`;
  http.setAuthority(authority);
  const result: TestServer = {
    authority,
    port: address.port,
    service,
    close: async () => {
      http.stopAcceptingNewWork();
      await new Promise<void>((resolve) => {
        http.server.close(() => resolve());
        http.server.closeIdleConnections();
      });
    },
  };
  activeServers.push(result);
  return result;
};

const call = async (
  server: TestServer,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly authenticated?: boolean;
  } = {},
): Promise<HttpResult> => {
  const headers: Record<string, string> = {
    host: server.authority,
    ...(options.authenticated === false
      ? {}
      : { authorization: `Bearer ${TOKEN}` }),
    ...options.headers,
  };
  if (
    options.body !== undefined &&
    headers["content-length"] === undefined
  ) {
    headers["content-length"] = String(
      Buffer.byteLength(options.body, "utf-8"),
    );
  }
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        host: LOCAL_CONTROL_HOST,
        port: server.port,
        method: options.method ?? "GET",
        path: options.path ?? "/v0/ping",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
              reject(new Error("response was not a JSON object"));
              return;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: body as Readonly<Record<string, unknown>>,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outbound.once("error", reject);
    if (options.body !== undefined) {
      outbound.write(options.body);
    }
    outbound.end();
  });
};

const post = async (
  server: TestServer,
  path: string,
  body: string = JSON.stringify({ subtaskId: SUBTASK_ID }),
  headers: Readonly<Record<string, string>> = {},
): Promise<HttpResult> =>
  call(server, {
    method: "POST",
    path,
    body,
    headers: {
      "content-type": "application/json",
      "x-ctc-request": "1",
      ...headers,
    },
  });

describe("local HTTP security boundary", () => {
  it("binds a test listener only to IPv4 loopback and accepts exact Host/auth", async () => {
    const server = await startServer();
    expect(server.authority).toMatch(/^127\.0\.0\.1:[0-9]+$/u);
    const result = await call(server);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, schemaVersion: 1 });
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects foreign Host, missing/wrong auth, and different token lengths without throwing", async () => {
    const server = await startServer();
    expect(
      (await call(server, { headers: { host: "localhost:1234" } })).status,
    ).toBe(403);
    expect((await call(server, { authenticated: false })).status).toBe(401);
    expect(
      (
        await call(server, {
          headers: { authorization: "Bearer short" },
        })
      ).status,
    ).toBe(401);
    expect((await call(server)).status).toBe(200);
  });

  it("allows absent or exact same Origin and rejects foreign Origin without CORS", async () => {
    const server = await startServer();
    expect((await call(server)).status).toBe(200);
    expect(
      (
        await call(server, {
          headers: { origin: `http://${server.authority}` },
        })
      ).status,
    ).toBe(200);
    const foreign = await call(server, {
      headers: { origin: "https://example.test" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("requires the anti-CSRF marker and does not grant OPTIONS preflight", async () => {
    const server = await startServer();
    const missingMarker = await call(server, {
      method: "POST",
      path: "/v0/worktrees/provision",
      body: JSON.stringify({ subtaskId: SUBTASK_ID }),
      headers: { "content-type": "application/json" },
    });
    expect(missingMarker.status).toBe(403);
    const options = await call(server, {
      method: "OPTIONS",
      path: "/v0/worktrees/provision",
      headers: { origin: `http://${server.authority}` },
    });
    expect(options.status).toBe(405);
    expect(options.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("enforces content type, body size, strict JSON shape, and canonical identifiers", async () => {
    const server = await startServer();
    expect(
      (
        await call(server, {
          method: "POST",
          path: "/v0/worktrees/provision",
          body: JSON.stringify({ subtaskId: SUBTASK_ID }),
          headers: {
            "content-type": "text/plain",
            "x-ctc-request": "1",
          },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await post(server, "/v0/worktrees/provision", "x".repeat(LOCAL_CONTROL_BODY_LIMIT_BYTES + 1), {
          "content-length": String(LOCAL_CONTROL_BODY_LIMIT_BYTES + 1),
        })
      ).status,
    ).toBe(413);
    expect((await post(server, "/v0/worktrees/provision", "{" )).status).toBe(400);
    expect(
      (
        await post(
          server,
          "/v0/worktrees/provision",
          `{"subtaskId":"${SUBTASK_ID}","subtaskId":"${SECOND_SUBTASK_ID}"}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          server,
          "/v0/worktrees/provision",
          JSON.stringify({ subtaskId: SUBTASK_ID, worktree: "/tmp/escape" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await post(server, "/v0/worktrees/provision", "[]")).status,
    ).toBe(400);
    expect(
      (
        await post(
          server,
          "/v0/worktrees/provision",
          JSON.stringify({ subtaskId: ` ${SUBTASK_ID}` }),
        )
      ).status,
    ).toBe(400);
  });

  it("returns stable bounded errors for unknown routes and methods", async () => {
    const server = await startServer();
    expect((await call(server, { path: "/v0/unknown" })).body).toEqual({
      error: { code: "ROUTE_NOT_FOUND" },
    });
    const wrongMethod = await call(server, {
      method: "GET",
      path: "/v0/worktrees/provision",
    });
    expect(wrongMethod.status).toBe(405);
    expect(JSON.stringify(wrongMethod.body)).not.toContain(TOKEN);
  });
});

describe("narrow API authority and concurrency continuity", () => {
  it("passes only the canonical Subtask ID to each trusted operation", async () => {
    const service = defaultService();
    const server = await startServer(service);
    expect((await call(server, { path: `/v0/subtasks/${SUBTASK_ID}` })).status).toBe(200);
    expect((await post(server, "/v0/worktrees/provision")).status).toBe(200);
    expect((await post(server, "/v0/executions/run")).status).toBe(200);
    expect((await post(server, "/v0/worktrees/release")).status).toBe(200);
    expect(service.inspectSubtask).toHaveBeenCalledExactlyOnceWith(SUBTASK_ID);
    expect(service.provisionOwnedWorktree).toHaveBeenCalledExactlyOnceWith(SUBTASK_ID);
    expect(service.runOwnedWorktreeExecution).toHaveBeenCalledExactlyOnceWith(SUBTASK_ID);
    expect(service.releaseOwnedWorktree).toHaveBeenCalledExactlyOnceWith(SUBTASK_ID);
  });

  it("rejects extra authority before any producer call and maps sanitized conflicts", async () => {
    const service = defaultService();
    vi.mocked(service.releaseOwnedWorktree).mockRejectedValueOnce(
      new LocalControlServiceError("OPERATION_CONFLICT", 409),
    );
    const server = await startServer(service);
    const extra = await post(
      server,
      "/v0/worktrees/provision",
      JSON.stringify({
        subtaskId: SUBTASK_ID,
        cwd: "/private/source",
        sandbox: "danger-full-access",
        network: true,
        runtime: "/tmp/codex",
        model: "caller-choice",
        force: true,
      }),
    );
    expect(extra.status).toBe(400);
    expect(service.provisionOwnedWorktree).not.toHaveBeenCalled();
    const release = await post(server, "/v0/worktrees/release");
    expect(release.status).toBe(409);
    expect(release.body).toEqual({ error: { code: "OPERATION_CONFLICT" } });
  });

  it("returns a sanitized Step 5 result without auto-provision or retry", async () => {
    const service = defaultService();
    vi.mocked(service.runOwnedWorktreeExecution).mockResolvedValueOnce(
      executionResult(false),
    );
    const server = await startServer(service);
    const result = await post(server, "/v0/executions/run");
    expect(result.status).toBe(200);
    expect(result.body).toEqual(executionResult(false));
    expect(service.runOwnedWorktreeExecution).toHaveBeenCalledTimes(1);
    expect(service.provisionOwnedWorktree).not.toHaveBeenCalled();
    expect(JSON.stringify(result.body)).not.toMatch(
      /cwd|sandbox|network|prompt|responseText|stderr|environment|worktreePath/u,
    );
  });

  it("lets the durable service gate allow at most one same-Subtask run", async () => {
    let active = false;
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const service = defaultService();
    vi.mocked(service.runOwnedWorktreeExecution).mockImplementation(async () => {
      if (active) {
        return executionResult(false);
      }
      active = true;
      await firstGate;
      active = false;
      return executionResult(true);
    });
    const server = await startServer(service);
    const first = post(server, "/v0/executions/run");
    await vi.waitFor(() =>
      expect(service.runOwnedWorktreeExecution).toHaveBeenCalledTimes(1),
    );
    const second = await post(server, "/v0/executions/run");
    expect(second.body).toEqual(executionResult(false));
    finishFirst?.();
    expect((await first).body).toEqual(executionResult(true));
    expect(service.runOwnedWorktreeExecution).toHaveBeenCalledTimes(2);
  });

  it("does not serialize different Subtasks and preserves run/release exclusion", async () => {
    let releaseRuns: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });
    let active = false;
    const service = defaultService();
    vi.mocked(service.runOwnedWorktreeExecution).mockImplementation(async () => {
      active = true;
      await runGate;
      active = false;
      return executionResult(true);
    });
    vi.mocked(service.releaseOwnedWorktree).mockImplementation(async () => {
      if (active) {
        throw new LocalControlServiceError("OPERATION_CONFLICT", 409);
      }
      return worktreeResult("RELEASED");
    });
    const server = await startServer(service);
    const firstRun = post(server, "/v0/executions/run");
    const secondRun = post(
      server,
      "/v0/executions/run",
      JSON.stringify({ subtaskId: SECOND_SUBTASK_ID }),
    );
    await vi.waitFor(() =>
      expect(service.runOwnedWorktreeExecution).toHaveBeenCalledTimes(2),
    );
    expect(
      (await post(server, "/v0/worktrees/release")).status,
    ).toBe(409);
    releaseRuns?.();
    await expect(Promise.all([firstRun, secondRun])).resolves.toHaveLength(2);
  });
});
