import { request } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import type { SubtaskId } from "@codex-task-console/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_CONTROL_BODY_LIMIT_BYTES,
  LOCAL_CONTROL_HOST,
  LOCAL_CONTROL_MAX_HEADER_BYTES,
  LOCAL_CONTROL_HEADERS_TIMEOUT_MILLISECONDS,
  LOCAL_CONTROL_KEEP_ALIVE_TIMEOUT_MILLISECONDS,
  LOCAL_CONTROL_REQUEST_TIMEOUT_MILLISECONDS,
  LOCAL_CONTROL_RESPONSE_LIMIT_BYTES,
  LOCAL_CONTROL_ROUTE_LIMIT,
  createLocalControlHttpServer,
} from "../src/http-server.js";
import type { LocalControlHttpServer } from "../src/http-server.js";
import type { LocalControlService } from "../src/service.js";

const TOKEN = "d".repeat(64);
const SUBTASK_ID = "st_http_hardening" as SubtaskId;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

const serviceFixture = (): LocalControlService => ({
  inspectSubtask: vi.fn(async (subtaskId) => ({
    subtask: { id: subtaskId, status: "IN_PROGRESS", maturity: "IMPLEMENTED" },
    dependencyReadiness: {
      valid: true,
      ready: true,
      blockerCount: 0,
      errorCodes: [],
    },
    worktree: null,
    durableExecution: {
      chatThreadCount: 0,
      returnedChatThreadCount: 0,
      recentChatThreads: [],
    },
  })),
  provisionOwnedWorktree: vi.fn(async () => ({
    worktree: {
      id: "wt_11111111111111111111111111111111",
      status: "ACTIVE" as const,
      startingCommitSha: "1".repeat(40),
      releaseHeadSha: null,
    },
  })),
  runOwnedWorktreeExecution: vi.fn(async () => ({
    execution: {
      success: false,
      failureCode: "ACTIVE_WORKTREE_REQUIRED",
      chatThreadId: null,
      executionRunId: null,
      worktreeOwnershipId: null,
      providerId: "codex-app-server",
      providerThreadId: null,
      providerRunId: null,
      providerModelId: null,
      normalizedUsage: null,
      terminalTurnStatus: null,
      appServerChildCleaned: true,
      transientRuntimeCleaned: true,
    },
  })),
  releaseOwnedWorktree: vi.fn(async () => ({
    worktree: {
      id: "wt_11111111111111111111111111111111",
      status: "RELEASED" as const,
      startingCommitSha: "1".repeat(40),
      releaseHeadSha: "1".repeat(40),
    },
  })),
});

interface RunningServer {
  readonly http: LocalControlHttpServer;
  readonly service: LocalControlService;
  readonly port: number;
  readonly authority: string;
}

const startServer = async (
  service: LocalControlService = serviceFixture(),
): Promise<RunningServer> => {
  const http = createLocalControlHttpServer(service, TOKEN);
  servers.push(http.server);
  await new Promise<void>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, LOCAL_CONTROL_HOST, () => resolve());
  });
  const port = (http.server.address() as AddressInfo).port;
  const authority = `${LOCAL_CONTROL_HOST}:${port}`;
  http.setAuthority(authority);
  return { http, service, port, authority };
};

interface RawResponse {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

const parseRawResponse = (bytes: Buffer): RawResponse => {
  const text = bytes.toString("utf-8");
  const boundary = text.indexOf("\r\n\r\n");
  if (boundary < 0) {
    throw new Error("raw response had no header boundary");
  }
  const statusMatch = /^HTTP\/1\.1 ([0-9]{3}) /u.exec(text);
  if (statusMatch === null) {
    throw new Error("raw response had no status");
  }
  const bodyText = text.slice(boundary + 4);
  return {
    status: Number(statusMatch[1]),
    text,
    body: JSON.parse(bodyText),
  };
};

const rawExchange = async (
  port: number,
  bytes: string | Buffer,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: LOCAL_CONTROL_HOST, port }, () => {
      socket.end(bytes);
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error("raw exchange timed out"));
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(parseRawResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });

const rawGet = (
  server: RunningServer,
  path: string = "/v0/ping",
  extraHeaders: readonly string[] = [],
): string =>
  [
    `GET ${path} HTTP/1.1`,
    `Host: ${server.authority}`,
    `Authorization: Bearer ${TOKEN}`,
    ...extraHeaders,
    "Connection: close",
    "",
    "",
  ].join("\r\n");

const rawPost = (
  server: RunningServer,
  body: string,
  extraHeaders: readonly string[] = [],
  contentLength: string | null = String(Buffer.byteLength(body, "utf-8")),
): string =>
  [
    "POST /v0/worktrees/provision HTTP/1.1",
    `Host: ${server.authority}`,
    `Authorization: Bearer ${TOKEN}`,
    "Content-Type: application/json",
    "X-CTC-Request: 1",
    ...(contentLength === null ? [] : [`Content-Length: ${contentLength}`]),
    ...extraHeaders,
    "Connection: close",
    "",
    body,
  ].join("\r\n");

const highLevelGet = async (
  server: RunningServer,
  path: string = "/v0/ping",
): Promise<{ readonly status: number; readonly bytes: Buffer }> =>
  new Promise((resolve, reject) => {
    const outbound = request(
      {
        agent: false,
        host: LOCAL_CONTROL_HOST,
        port: server.port,
        path,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          connection: "close",
          host: server.authority,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    outbound.once("error", reject);
    outbound.end();
  });

describe("raw HTTP parser and authority-header hardening", () => {
  it.each([
    ["Host", (server: RunningServer) => server.authority],
    ["Authorization", () => `Bearer ${TOKEN}`],
    ["Origin", (server: RunningServer) => `http://${server.authority}`],
  ] as const)("rejects duplicate %s on GET", async (name, value) => {
    const server = await startServer();
    const duplicate = `${name}: ${value(server)}`;
    const result = await rawExchange(
      server.port,
      rawGet(
        server,
        "/v0/ping",
        name === "Origin" ? [duplicate, duplicate] : [duplicate],
      ),
    );
    expect(result.status).not.toBe(200);
    expect(result.body).toHaveProperty("error.code");
    expect(server.service.inspectSubtask).not.toHaveBeenCalled();
    expect(result.text).not.toContain(TOKEN);
  });

  it.each([
    "Content-Type: application/json",
    "X-CTC-Request: 1",
    `Authorization: Bearer ${TOKEN}`,
  ])("rejects a duplicate mutation authority header: %s", async (duplicate) => {
    const server = await startServer();
    const body = JSON.stringify({ subtaskId: SUBTASK_ID });
    const result = await rawExchange(
      server.port,
      rawPost(server, body, [duplicate]),
    );
    expect(result.status).not.toBe(200);
    expect(server.service.provisionOwnedWorktree).not.toHaveBeenCalled();
  });

  it("rejects duplicate Content-Length and Transfer-Encoding ambiguity before service authority", async () => {
    const server = await startServer();
    const body = JSON.stringify({ subtaskId: SUBTASK_ID });
    for (const requestText of [
      rawPost(server, body, [`Content-Length: ${Buffer.byteLength(body)}`]),
      rawPost(server, body, ["Transfer-Encoding: chunked"]),
      rawPost(
        server,
        `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
        ["Transfer-Encoding: chunked"],
        null,
      ),
    ]) {
      const result = await rawExchange(server.port, requestText);
      expect(result.status).not.toBe(200);
    }
    expect(server.service.provisionOwnedWorktree).not.toHaveBeenCalled();
  });

  it("enforces the exact 32-field header count without silent truncation", async () => {
    const server = await startServer();
    const acceptedFillers = Array.from(
      { length: 29 },
      (_, index) => `X-Fill-${index}: x`,
    );
    const accepted = await rawExchange(
      server.port,
      rawGet(server, "/v0/ping", acceptedFillers),
    );
    expect(accepted.status).toBe(200);
    const rejected = await rawExchange(
      server.port,
      rawGet(server, "/v0/ping", [...acceptedFillers, "X-Fill-29: x"]),
    );
    expect(rejected.status).toBe(400);
  });

  it("enforces the Node 24 max-header byte boundary at exactly the configured limit", async () => {
    const server = await startServer();
    const requestAtSize = (size: number): string => {
      const headerBlock = [
        `Host: ${server.authority}`,
        `Authorization: Bearer ${TOKEN}`,
        "Connection: close",
        "X-Fill: ",
        "",
        "",
      ].join("\r\n");
      const fillBytes = size - Buffer.byteLength(headerBlock, "utf-8");
      if (fillBytes < 0) {
        throw new Error("invalid header fixture size");
      }
      return `GET /v0/ping HTTP/1.1\r\n${headerBlock.replace(
        "X-Fill: ",
        `X-Fill: ${"x".repeat(fillBytes)}`,
      )}`;
    };
    expect(
      Buffer.byteLength(
        requestAtSize(LOCAL_CONTROL_MAX_HEADER_BYTES).split("\r\n").slice(1).join("\r\n"),
      ),
    ).toBe(
      LOCAL_CONTROL_MAX_HEADER_BYTES,
    );
    expect(
      (
        await rawExchange(
          server.port,
          requestAtSize(LOCAL_CONTROL_MAX_HEADER_BYTES),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await rawExchange(
          server.port,
          requestAtSize(LOCAL_CONTROL_MAX_HEADER_BYTES + 1),
        )
      ).status,
    ).toBe(400);
  });

  it.each([
    "BROKEN REQUEST\r\n\r\n",
    "GET /v0/ping HTTP/1.1\r\nBad Header: x\r\n\r\n",
    "GET /v0/ping HTTP/1.1\r\nHost: x\r\nX-Test: one\r\n continued\r\n\r\n",
  ])("returns bounded JSON for malformed raw syntax", async (requestText) => {
    const server = await startServer();
    const result = await rawExchange(server.port, requestText);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: { code: "INVALID_REQUEST" } });
    expect(result.text).not.toContain(TOKEN);
  });
});

describe("route, body, and authentication boundary matrices", () => {
  it.each([
    (server: RunningServer) => `Host: localhost:${server.port}`,
    (server: RunningServer) => `Host: [::1]:${server.port}`,
    (server: RunningServer) => `Host: 127.0.0.1:${server.port + 1}`,
    (server: RunningServer) => `Origin: HTTP://${server.authority}`,
    (server: RunningServer) => `Origin: http://${server.authority}/`,
    () => "Authorization: bearer invalid",
  ])("rejects an exact-boundary variant", async (variant) => {
    const server = await startServer();
    const line = variant(server);
    const requestText = line.startsWith("Host:")
      ? rawGet(server).replace(`Host: ${server.authority}`, line)
      : line.startsWith("Authorization:")
        ? rawGet(server).replace(`Authorization: Bearer ${TOKEN}`, line)
        : rawGet(server, "/v0/ping", [line]);
    expect((await rawExchange(server.port, requestText)).status).not.toBe(200);
  });

  it("rejects absolute-form, encoded-separator, query, fragment-like, and noncanonical routes", async () => {
    const server = await startServer();
    const paths = [
      `http://${server.authority}/v0/ping`,
      "/v0/subtasks/st_http%2Fescape",
      "/v0/ping?authority=1",
      "/v0/ping#fragment",
      "/v0/subtasks/%20st_http_hardening",
    ];
    const statuses = await Promise.all(
      paths.map(async (path) => ({
        path,
        status: (await rawExchange(server.port, rawGet(server, path))).status,
      })),
    );
    for (const { path, status } of statuses) {
      expect(status, path).not.toBe(200);
    }
    const exactlyBounded = `/${"x".repeat(LOCAL_CONTROL_ROUTE_LIMIT - 1)}`;
    expect(exactlyBounded).toHaveLength(LOCAL_CONTROL_ROUTE_LIMIT);
    expect((await rawExchange(server.port, rawGet(server, exactlyBounded))).status).toBe(
      404,
    );
    expect(
      (
        await rawExchange(
          server.port,
          rawGet(server, `${exactlyBounded}x`),
        )
      ).status,
    ).toBe(400);
  });

  it("rejects missing length, length mismatches, malformed UTF-8, and escaped duplicate JSON keys", async () => {
    const server = await startServer();
    const valid = JSON.stringify({ subtaskId: SUBTASK_ID });
    const malformedUtf8Head = rawPost(server, "", [], "2").replace(
      "\r\n\r\n",
      "\r\n\r\n",
    );
    const cases: Array<string | Buffer> = [
      rawPost(server, valid, [], null),
      rawPost(server, valid, [], "1"),
      rawPost(server, valid.slice(0, -1), [], String(Buffer.byteLength(valid))),
      Buffer.concat([
        Buffer.from(malformedUtf8Head, "utf-8"),
        Buffer.from([0xff, 0xfe]),
      ]),
      rawPost(
        server,
        `{"subtaskId":"${SUBTASK_ID}","\\u0073ubtaskId":"${SUBTASK_ID}"}`,
      ),
    ];
    for (const bytes of cases) {
      expect((await rawExchange(server.port, bytes)).status).not.toBe(200);
    }
    expect(server.service.provisionOwnedWorktree).not.toHaveBeenCalled();
  });

  it("distinguishes the exact 16 KiB body boundary from one byte over", async () => {
    const server = await startServer();
    const bodyAtLimit = `{"padding":"${"x".repeat(
      LOCAL_CONTROL_BODY_LIMIT_BYTES - Buffer.byteLength('{"padding":""}'),
    )}"}`;
    expect(Buffer.byteLength(bodyAtLimit)).toBe(LOCAL_CONTROL_BODY_LIMIT_BYTES);
    expect((await rawExchange(server.port, rawPost(server, bodyAtLimit))).status).toBe(
      400,
    );
    const bodyOver = `${bodyAtLimit}x`;
    expect(Buffer.byteLength(bodyOver)).toBe(LOCAL_CONTROL_BODY_LIMIT_BYTES + 1);
    expect((await rawExchange(server.port, rawPost(server, bodyOver))).status).toBe(
      413,
    );
  });
});

describe("HTTP resource bounds, serialization, and concurrency", () => {
  it("installs finite request, header, and keep-alive timeouts", async () => {
    const server = await startServer();
    expect(server.http.server.requestTimeout).toBe(
      LOCAL_CONTROL_REQUEST_TIMEOUT_MILLISECONDS,
    );
    expect(server.http.server.headersTimeout).toBe(
      LOCAL_CONTROL_HEADERS_TIMEOUT_MILLISECONDS,
    );
    expect(server.http.server.keepAliveTimeout).toBe(
      LOCAL_CONTROL_KEEP_ALIVE_TIMEOUT_MILLISECONDS,
    );
  });

  it("accepts a response exactly at 64 KiB and replaces one byte over with a stable error", async () => {
    for (const extra of [0, 1]) {
      const service = serviceFixture();
      const overhead = Buffer.byteLength('{"padding":""}', "utf-8");
      vi.mocked(service.inspectSubtask).mockResolvedValueOnce({
        padding: "x".repeat(
          LOCAL_CONTROL_RESPONSE_LIMIT_BYTES - overhead + extra,
        ),
      } as never);
      const server = await startServer(service);
      const result = await highLevelGet(
        server,
        `/v0/subtasks/${SUBTASK_ID}`,
      );
      if (extra === 0) {
        expect(result.status).toBe(200);
        expect(result.bytes.byteLength).toBe(LOCAL_CONTROL_RESPONSE_LIMIT_BYTES);
      } else {
        expect(result.status).toBe(500);
        expect(JSON.parse(result.bytes.toString("utf-8"))).toEqual({
          error: { code: "LOCAL_OPERATION_FAILED" },
        });
      }
    }
  });

  it("sanitizes response serialization failure", async () => {
    const service = serviceFixture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    vi.mocked(service.inspectSubtask).mockResolvedValueOnce(circular as never);
    const server = await startServer(service);
    const result = await highLevelGet(server, `/v0/subtasks/${SUBTASK_ID}`);
    expect(result.status).toBe(500);
    expect(JSON.parse(result.bytes.toString("utf-8"))).toEqual({
      error: { code: "LOCAL_OPERATION_FAILED" },
    });
  });

  it("admits 16 active operations, rejects the 17th, and does not add an authority mutex", async () => {
    const service = serviceFixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(service.inspectSubtask).mockImplementation(async (subtaskId) => {
      await gate;
      return {
        subtask: { id: subtaskId, status: "IN_PROGRESS", maturity: "IMPLEMENTED" },
        dependencyReadiness: {
          valid: true,
          ready: true,
          blockerCount: 0,
          errorCodes: [],
        },
        worktree: null,
        durableExecution: {
          chatThreadCount: 0,
          returnedChatThreadCount: 0,
          recentChatThreads: [],
        },
      };
    });
    const server = await startServer(service);
    const active = Array.from({ length: 16 }, (_, index) =>
      highLevelGet(server, `/v0/subtasks/st_active_${index}`),
    );
    await vi.waitFor(() =>
      expect(service.inspectSubtask).toHaveBeenCalledTimes(16),
    );
    const seventeenth = await highLevelGet(
      server,
      "/v0/subtasks/st_active_16",
    );
    expect(seventeenth.status).toBe(429);
    release?.();
    await expect(Promise.all(active)).resolves.toHaveLength(16);
  });
});
