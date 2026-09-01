import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import { SubtaskIdSchema } from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";

import {
  LocalControlServiceError,
} from "./service.js";
import type { LocalControlService } from "./service.js";

export const LOCAL_CONTROL_HOST = "127.0.0.1";
export const LOCAL_CONTROL_BODY_LIMIT_BYTES = 16 * 1_024;
export const LOCAL_CONTROL_RESPONSE_LIMIT_BYTES = 64 * 1_024;
export const LOCAL_CONTROL_ROUTE_LIMIT = 256;
export const LOCAL_CONTROL_MAX_ACTIVE_REQUESTS = 16;
export const LOCAL_CONTROL_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const LOCAL_CONTROL_HEADERS_TIMEOUT_MILLISECONDS = 10_000;
export const LOCAL_CONTROL_KEEP_ALIVE_TIMEOUT_MILLISECONDS = 2_000;
export const LOCAL_CONTROL_MAX_HEADER_BYTES = 8 * 1_024;
export const LOCAL_CONTROL_MAX_HEADER_COUNT = 32;

type HttpErrorStatus = 400 | 401 | 403 | 404 | 405 | 413 | 415 | 429 | 500 | 503;

class HttpBoundaryError extends Error {
  readonly code: string;
  readonly status: HttpErrorStatus;

  constructor(code: string, status: HttpErrorStatus) {
    super(code);
    this.name = "HttpBoundaryError";
    this.code = code;
    this.status = status;
  }
}

export interface LocalControlHttpServer {
  readonly server: Server;
  setAuthority(authority: string): void;
  stopAcceptingNewWork(): void;
  inFlightRequests(): number;
  waitForInFlightRequests(): Promise<void>;
}

const writeJson = (
  response: ServerResponse,
  status: number,
  body: object,
): void => {
  let bytes = Buffer.from(JSON.stringify(body), "utf-8");
  let finalStatus = status;
  if (bytes.byteLength > LOCAL_CONTROL_RESPONSE_LIMIT_BYTES) {
    finalStatus = 500;
    bytes = Buffer.from(
      JSON.stringify({ error: { code: "LOCAL_OPERATION_FAILED" } }),
      "utf-8",
    );
  }
  response.writeHead(finalStatus, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
};

const writeError = (
  response: ServerResponse,
  status: number,
  code: string,
): void => writeJson(response, status, { error: { code } });

const safeTokenMatches = (provided: string, expected: string): boolean => {
  const providedDigest = createHash("sha256").update(provided, "utf-8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf-8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

const requireBoundary = (
  request: IncomingMessage,
  authority: string,
  sessionToken: string,
): void => {
  if (request.headers.host !== authority) {
    throw new HttpBoundaryError("REQUEST_BOUNDARY_FAILED", 403);
  }
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    (Array.isArray(origin) || origin !== `http://${authority}`)
  ) {
    throw new HttpBoundaryError("REQUEST_BOUNDARY_FAILED", 403);
  }
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    !safeTokenMatches(authorization.slice("Bearer ".length), sessionToken)
  ) {
    throw new HttpBoundaryError("SESSION_AUTH_FAILED", 401);
  }
};

const readBoundedBody = async (request: IncomingMessage): Promise<string> => {
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    (/^(?:0|[1-9][0-9]*)$/.test(declaredLength) === false ||
      Number(declaredLength) > LOCAL_CONTROL_BODY_LIMIT_BYTES)
  ) {
    throw new HttpBoundaryError("REQUEST_TOO_LARGE", 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > LOCAL_CONTROL_BODY_LIMIT_BYTES) {
      request.resume();
      throw new HttpBoundaryError("REQUEST_TOO_LARGE", 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf-8");
};

const skipWhitespace = (text: string, start: number): number => {
  let cursor = start;
  while (/\s/u.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
};

const scanJsonString = (text: string, start: number): number => {
  if (text[start] !== '"') {
    return -1;
  }
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return -1;
};

const scanJsonValue = (text: string, start: number): number => {
  if (text[start] === '"') {
    return scanJsonString(text, start);
  }
  if (text[start] === "{" || text[start] === "[") {
    const openings: string[] = [text[start] ?? ""];
    let cursor = start + 1;
    while (cursor < text.length && openings.length > 0) {
      if (text[cursor] === '"') {
        cursor = scanJsonString(text, cursor);
        if (cursor < 0) {
          return -1;
        }
        continue;
      }
      const character = text[cursor];
      if (character === "{" || character === "[") {
        openings.push(character);
      } else if (character === "}" || character === "]") {
        const opening = openings.pop();
        if (
          (opening === "{" && character !== "}") ||
          (opening === "[" && character !== "]")
        ) {
          return -1;
        }
      }
      cursor += 1;
    }
    return openings.length === 0 ? cursor : -1;
  }
  let cursor = start;
  while (cursor < text.length && text[cursor] !== "," && text[cursor] !== "}") {
    cursor += 1;
  }
  return cursor;
};

const topLevelObjectKeys = (text: string): readonly string[] | null => {
  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") {
    return null;
  }
  cursor = skipWhitespace(text, cursor + 1);
  const keys: string[] = [];
  if (text[cursor] === "}") {
    return skipWhitespace(text, cursor + 1) === text.length ? keys : null;
  }
  while (cursor < text.length) {
    const keyEnd = scanJsonString(text, cursor);
    if (keyEnd < 0) {
      return null;
    }
    let key: unknown;
    try {
      key = JSON.parse(text.slice(cursor, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== "string") {
      return null;
    }
    keys.push(key);
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor] !== ":") {
      return null;
    }
    cursor = skipWhitespace(text, cursor + 1);
    cursor = scanJsonValue(text, cursor);
    if (cursor < 0) {
      return null;
    }
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === "}") {
      return skipWhitespace(text, cursor + 1) === text.length ? keys : null;
    }
    if (text[cursor] !== ",") {
      return null;
    }
    cursor = skipWhitespace(text, cursor + 1);
  }
  return null;
};

const parseCanonicalSubtaskId = (value: unknown): SubtaskId => {
  const parsed = SubtaskIdSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    throw new HttpBoundaryError("INVALID_REQUEST", 400);
  }
  return parsed.data;
};

const parseSubtaskBody = (text: string): SubtaskId => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpBoundaryError("INVALID_REQUEST", 400);
  }
  const keys = topLevelObjectKeys(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    keys === null ||
    keys.length !== 1 ||
    keys[0] !== "subtaskId" ||
    Object.keys(value).length !== 1
  ) {
    throw new HttpBoundaryError("INVALID_REQUEST", 400);
  }
  return parseCanonicalSubtaskId(
    (value as Readonly<Record<string, unknown>>).subtaskId,
  );
};

const requireMutationHeaders = (request: IncomingMessage): void => {
  if (request.headers["x-ctc-request"] !== "1") {
    throw new HttpBoundaryError("REQUEST_BOUNDARY_FAILED", 403);
  }
  if (request.headers["content-type"] !== "application/json") {
    throw new HttpBoundaryError("CONTENT_TYPE_REQUIRED", 415);
  }
};

const routeRequest = async (
  request: IncomingMessage,
  service: LocalControlService,
): Promise<object> => {
  const method = request.method ?? "";
  const url = request.url ?? "";
  if (method === "GET" && url === "/v0/ping") {
    return Object.freeze({ ok: true, schemaVersion: 1 });
  }
  if (method === "GET") {
    const match = /^\/v0\/subtasks\/([^/]+)$/u.exec(url);
    if (match !== null) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(match[1] ?? "");
      } catch {
        throw new HttpBoundaryError("INVALID_REQUEST", 400);
      }
      return service.inspectSubtask(parseCanonicalSubtaskId(decoded));
    }
  }
  const postRoutes = new Map<
    string,
    (subtaskId: SubtaskId) => Promise<object>
  >([
    [
      "/v0/worktrees/provision",
      async (subtaskId) => service.provisionOwnedWorktree(subtaskId),
    ],
    [
      "/v0/executions/run",
      async (subtaskId) => service.runOwnedWorktreeExecution(subtaskId),
    ],
    [
      "/v0/worktrees/release",
      async (subtaskId) => service.releaseOwnedWorktree(subtaskId),
    ],
  ]);
  const postRoute = postRoutes.get(url);
  if (postRoute !== undefined) {
    if (method !== "POST") {
      throw new HttpBoundaryError("METHOD_NOT_ALLOWED", 405);
    }
    requireMutationHeaders(request);
    return postRoute(parseSubtaskBody(await readBoundedBody(request)));
  }
  if (method === "OPTIONS") {
    throw new HttpBoundaryError("METHOD_NOT_ALLOWED", 405);
  }
  throw new HttpBoundaryError("ROUTE_NOT_FOUND", 404);
};

export const createLocalControlHttpServer = (
  service: LocalControlService,
  sessionToken: string,
): LocalControlHttpServer => {
  let authority = "";
  let acceptingNewWork = true;
  let inFlight = 0;
  const idleWaiters = new Set<() => void>();

  const notifyIdle = (): void => {
    if (inFlight !== 0) {
      return;
    }
    for (const waiter of idleWaiters) {
      waiter();
    }
    idleWaiters.clear();
  };

  const server = createServer(
    {
      maxHeaderSize: LOCAL_CONTROL_MAX_HEADER_BYTES,
      requireHostHeader: true,
    },
    (request, response) => {
      if (!acceptingNewWork) {
        writeError(response, 503, "DAEMON_SHUTTING_DOWN");
        return;
      }
      if (inFlight >= LOCAL_CONTROL_MAX_ACTIVE_REQUESTS) {
        writeError(response, 429, "CONCURRENCY_LIMIT");
        return;
      }
      inFlight += 1;
      void (async () => {
        try {
          const url = request.url ?? "";
          if (url.length === 0 || url.length > LOCAL_CONTROL_ROUTE_LIMIT) {
            throw new HttpBoundaryError("INVALID_REQUEST", 400);
          }
          if (authority.length === 0) {
            throw new HttpBoundaryError("DAEMON_NOT_READY", 503);
          }
          requireBoundary(request, authority, sessionToken);
          writeJson(response, 200, await routeRequest(request, service));
        } catch (error) {
          if (response.headersSent) {
            response.destroy();
          } else if (error instanceof HttpBoundaryError) {
            writeError(response, error.status, error.code);
          } else if (error instanceof LocalControlServiceError) {
            writeError(response, error.httpStatus, error.code);
          } else {
            writeError(response, 500, "LOCAL_OPERATION_FAILED");
          }
        } finally {
          inFlight -= 1;
          notifyIdle();
        }
      })();
    },
  );
  server.maxHeadersCount = LOCAL_CONTROL_MAX_HEADER_COUNT;
  server.requestTimeout = LOCAL_CONTROL_REQUEST_TIMEOUT_MILLISECONDS;
  server.headersTimeout = LOCAL_CONTROL_HEADERS_TIMEOUT_MILLISECONDS;
  server.keepAliveTimeout = LOCAL_CONTROL_KEEP_ALIVE_TIMEOUT_MILLISECONDS;

  return Object.freeze({
    server,
    setAuthority(nextAuthority: string): void {
      authority = nextAuthority;
    },
    stopAcceptingNewWork(): void {
      acceptingNewWork = false;
    },
    inFlightRequests(): number {
      return inFlight;
    },
    waitForInFlightRequests(): Promise<void> {
      if (inFlight === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        idleWaiters.add(resolve);
      });
    },
  });
};
