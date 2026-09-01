import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import {
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OWNED_WORKTREE_CODEX_EXECUTION_FAILURE_CODES } from "@codex-task-console/codex-adapter";
import {
  SubtaskMaturitySchema,
  SubtaskStatusSchema,
} from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";
import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_CONTROL_HOST } from "../src/http-server.js";
import {
  parseOperatorCommand,
  runOperatorCommandForTesting,
} from "../src/operator.js";
import {
  ensureProductionStateDirectories,
  localControlPathsForTesting,
  writeSessionDescriptor,
} from "../src/state.js";
import type { LocalControlPaths } from "../src/state.js";

const TOKEN = "e".repeat(64);
const SUBTASK_ID = "st_operator_hardening" as SubtaskId;
const roots: string[] = [];
const httpServers: Server[] = [];
const netServers: Array<ReturnType<typeof createNetServer>> = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  for (const server of netServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createPaths = (): LocalControlPaths => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-operator-hardening-")),
  );
  roots.push(root);
  const paths = localControlPathsForTesting(join(root, "Codex Task Console"));
  ensureProductionStateDirectories(paths);
  return paths;
};

const installSession = (paths: LocalControlPaths, port: number): void => {
  writeSessionDescriptor(paths, {
    schemaVersion: 1,
    instanceId: "inst_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    pid: 88,
    port,
    startedAt: "2026-09-01T00:00:00.000Z",
    sessionToken: TOKEN,
  });
};

const respond = (
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string = "application/json; charset=utf-8",
): void => {
  const bytes = Buffer.from(body, "utf-8");
  response.writeHead(status, {
    "content-length": String(bytes.byteLength),
    "content-type": contentType,
  });
  response.end(bytes);
};

const startHttpServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> => {
  const server = createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCAL_CONTROL_HOST, () => resolve());
  });
  return (server.address() as AddressInfo).port;
};

const runResponse = async (
  arguments_: readonly string[],
  body: string,
) => {
  const port = await startHttpServer((_request, response) => {
    respond(response, 200, body);
  });
  const paths = createPaths();
  installSession(paths, port);
  return runOperatorCommandForTesting(
    parseOperatorCommand(arguments_),
    paths,
    1_000,
  );
};

const validInspection = (
  providerId: string = "synthetic-provider",
  options: {
    readonly status?: string;
    readonly maturity?: string;
    readonly errorCodes?: readonly string[];
    readonly runs?: readonly Readonly<Record<string, unknown>>[];
  } = {},
): Readonly<Record<string, unknown>> => ({
  subtask: {
    id: SUBTASK_ID,
    status: options.status ?? "IN_PROGRESS",
    maturity: options.maturity ?? "IMPLEMENTED",
  },
  dependencyReadiness: {
    valid: true,
    ready: true,
    blockerCount: 0,
    errorCodes: options.errorCodes ?? [],
  },
  worktree: null,
  durableExecution: {
    chatThreadCount: 1,
    returnedChatThreadCount: 1,
    recentChatThreads: [
      {
        id: "thr_operator_hardening",
        status: "OPEN",
        providerId,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        runs: options.runs ?? [],
      },
    ],
  },
});

const activeWorktree = (): Readonly<Record<string, unknown>> => ({
  worktree: {
    id: "wt_11111111111111111111111111111111",
    status: "ACTIVE",
    startingCommitSha: "1".repeat(40),
    releaseHeadSha: null,
  },
});

const releasedWorktree = (): Readonly<Record<string, unknown>> => ({
  worktree: {
    id: "wt_11111111111111111111111111111111",
    status: "RELEASED",
    startingCommitSha: "1".repeat(40),
    releaseHeadSha: "1".repeat(40),
  },
});

const failedExecution = (
  failureCode: string = "ACTIVE_WORKTREE_REQUIRED",
): Readonly<Record<string, unknown>> => ({
  execution: {
    success: false,
    failureCode,
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
});

const successfulExecution = (
  providerOverrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  execution: {
    success: true,
    failureCode: null,
    chatThreadId: "thr_operator_hardening",
    executionRunId: "run_operator_hardening",
    worktreeOwnershipId: "wt_11111111111111111111111111111111",
    providerId: "codex-app-server",
    providerThreadId: "provider-thread",
    providerRunId: "provider-run",
    providerModelId: "provider-model",
    normalizedUsage: null,
    terminalTurnStatus: "completed",
    appServerChildCleaned: true,
    transientRuntimeCleaned: true,
    ...providerOverrides,
  },
});

const validRunSummary = (
  providerOverrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  id: "run_operator_hardening",
  status: "FAILED",
  providerRunId: "provider-run",
  providerModelId: "provider-model",
  normalizedUsage: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...providerOverrides,
});

describe("operator route-specific response integrity", () => {
  it("validates all five fixed command results and preserves Step 5 success:false", async () => {
    const port = await startHttpServer((request, response) => {
      const body =
        request.url === "/v0/ping"
          ? { ok: true, schemaVersion: 1 }
          : request.url?.startsWith("/v0/subtasks/") === true
            ? validInspection()
            : request.url === "/v0/worktrees/provision"
              ? activeWorktree()
              : request.url === "/v0/executions/run"
                ? failedExecution()
                : releasedWorktree();
      respond(response, 200, JSON.stringify(body));
    });

    for (const [arguments_, succeeded] of [
      [["ping"], true],
      [["status", SUBTASK_ID], true],
      [["provision", SUBTASK_ID], true],
      [["run", SUBTASK_ID], false],
      [["release", SUBTASK_ID], true],
    ] as const) {
      const paths = createPaths();
      installSession(paths, port);
      const result = await runOperatorCommandForTesting(
        parseOperatorCommand(arguments_),
        paths,
        1_000,
      );
      expect(result.succeeded).toBe(succeeded);
    }
  });

  it.each([
    ["ping"],
    ["status", SUBTASK_ID],
    ["provision", SUBTASK_ID],
    ["run", SUBTASK_ID],
    ["release", SUBTASK_ID],
  ] as const)("rejects unrelated loopback JSON for %s", async (...arguments_) => {
    const port = await startHttpServer((_request, response) => {
      respond(response, 200, JSON.stringify({ unrelated: true }));
    });
    const paths = createPaths();
    installSession(paths, port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(arguments_),
        paths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it.each([
    ["duplicate root key", ["ping"], '{"ok":false,"ok":true,"schemaVersion":1}'],
    [
      "escaped root key equivalence",
      ["ping"],
      '{"ok":false,"\\u006fk":true,"schemaVersion":1}',
    ],
    [
      "duplicate nested Subtask status",
      ["status", SUBTASK_ID],
      JSON.stringify(validInspection()).replace(
        '"status":"IN_PROGRESS"',
        '"status":"TODO","status":"IN_PROGRESS"',
      ),
    ],
    [
      "duplicate nested Subtask maturity",
      ["status", SUBTASK_ID],
      JSON.stringify(validInspection()).replace(
        '"maturity":"IMPLEMENTED"',
        '"maturity":"NOT_STARTED","maturity":"IMPLEMENTED"',
      ),
    ],
    [
      "duplicate nested execution success",
      ["run", SUBTASK_ID],
      JSON.stringify(failedExecution()).replace(
        '"success":false',
        '"success":true,"success":false',
      ),
    ],
    [
      "duplicate nested execution failureCode",
      ["run", SUBTASK_ID],
      JSON.stringify(failedExecution()).replace(
        '"failureCode":"ACTIVE_WORKTREE_REQUIRED"',
        '"failureCode":"TURN_FAILED","failureCode":"ACTIVE_WORKTREE_REQUIRED"',
      ),
    ],
  ] as const)("rejects %s before JSON.parse normalization", async (_name, arguments_, body) => {
    await expect(runResponse(arguments_, body)).rejects.toMatchObject({
      code: "RESPONSE_MALFORMED",
    });
  });

  it("accepts unambiguous valid nested responses", async () => {
    await expect(
      runResponse(
        ["status", SUBTASK_ID],
        JSON.stringify(
          validInspection("synthetic-provider", { runs: [validRunSummary()] }),
        ),
      ),
    ).resolves.toMatchObject({ succeeded: true });
    await expect(
      runResponse(
        ["run", SUBTASK_ID],
        JSON.stringify(successfulExecution()),
      ),
    ).resolves.toMatchObject({ succeeded: true });
  });

  it.each(SubtaskStatusSchema.options)(
    "accepts canonical Subtask status %s",
    async (status) => {
      await expect(
        runResponse(
          ["status", SUBTASK_ID],
          JSON.stringify(validInspection("synthetic-provider", { status })),
        ),
      ).resolves.toMatchObject({ succeeded: true });
    },
  );

  it.each(SubtaskMaturitySchema.options)(
    "accepts canonical Subtask maturity %s",
    async (maturity) => {
      await expect(
        runResponse(
          ["status", SUBTASK_ID],
          JSON.stringify(validInspection("synthetic-provider", { maturity })),
        ),
      ).resolves.toMatchObject({ succeeded: true });
    },
  );

  it.each([
    ["status", { status: "IMPOSSIBLE_STATUS" }],
    ["maturity", { maturity: "IMPOSSIBLE_MATURITY" }],
  ] as const)("rejects impossible Subtask %s", async (_field, options) => {
    await expect(
      runResponse(
        ["status", SUBTASK_ID],
        JSON.stringify(validInspection("synthetic-provider", options)),
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it.each(OWNED_WORKTREE_CODEX_EXECUTION_FAILURE_CODES)(
    "accepts canonical Step 5B failure code %s",
    async (failureCode) => {
      await expect(
        runResponse(
          ["run", SUBTASK_ID],
          JSON.stringify(failedExecution(failureCode)),
        ),
      ).resolves.toMatchObject({ succeeded: false });
    },
  );

  it("rejects an unknown uppercase execution failure code", async () => {
    await expect(
      runResponse(
        ["run", SUBTASK_ID],
        JSON.stringify(failedExecution("UNKNOWN_STEP_5B_FAILURE")),
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it("rejects adjacent noncanonical response vocabulary", async () => {
    await expect(
      runResponse(
        ["status", SUBTASK_ID],
        JSON.stringify(
          validInspection("synthetic-provider", {
            errorCodes: ["UNKNOWN_DEPENDENCY_ERROR"],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });

    for (const field of ["providerRunId", "providerModelId"] as const) {
      await expect(
        runResponse(
          ["status", SUBTASK_ID],
          JSON.stringify(
            validInspection("synthetic-provider", {
              runs: [validRunSummary({ [field]: "provider-\ud800" })],
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    }

    for (const field of [
      "providerThreadId",
      "providerRunId",
      "providerModelId",
    ] as const) {
      await expect(
        runResponse(
          ["run", SUBTASK_ID],
          JSON.stringify(successfulExecution({ [field]: "provider-\ud800" })),
        ),
      ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    }
  });

  it("rejects Unicode-escaped token reflection after parsed-value transformation", async () => {
    const port = await startHttpServer((_request, response) => {
      const escapedToken = Array.from(TOKEN, () => "\\u0065").join("");
      const text = JSON.stringify(validInspection(TOKEN)).replace(
        TOKEN,
        escapedToken,
      );
      respond(response, 200, text);
    });
    const paths = createPaths();
    installSession(paths, port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["status", SUBTASK_ID]),
        paths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it.each([
    ["text/plain", JSON.stringify({ ok: true, schemaVersion: 1 })],
    ["application/json", "{not-json}"],
    ["application/json", "[]"],
    ["application/json", "1"],
  ])("rejects malformed content type/body combinations", async (contentType, body) => {
    const port = await startHttpServer((_request, response) => {
      respond(response, 200, body, contentType);
    });
    const paths = createPaths();
    installSession(paths, port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        paths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });
});

describe("operator transport bounds and session evidence", () => {
  it("uses an absolute deadline even when a responder keeps sending bytes", async () => {
    let interval: NodeJS.Timeout | undefined;
    const port = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,"schemaVersion":1');
      interval = setInterval(() => response.write(" "), 5);
      response.once("close", () => {
        if (interval !== undefined) {
          clearInterval(interval);
        }
      });
    });
    const paths = createPaths();
    installSession(paths, port);
    const startedAt = Date.now();
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        paths,
        30,
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("fails cleanly on a reset response and malformed HTTP status line", async () => {
    const resetPort = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
      response.destroy();
    });
    const resetPaths = createPaths();
    installSession(resetPaths, resetPort);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        resetPaths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_UNAVAILABLE" });

    const malformed = createNetServer((socket) => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 NOT_A_STATUS\r\nConnection: close\r\n\r\n");
      });
    });
    netServers.push(malformed);
    await new Promise<void>((resolve, reject) => {
      malformed.once("error", reject);
      malformed.listen(0, LOCAL_CONTROL_HOST, () => resolve());
    });
    const malformedPaths = createPaths();
    installSession(malformedPaths, (malformed.address() as AddressInfo).port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        malformedPaths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it("rejects a hardlinked session descriptor before making a request", async () => {
    const port = await startHttpServer((_request, response) => {
      respond(response, 200, JSON.stringify({ ok: true, schemaVersion: 1 }));
    });
    const paths = createPaths();
    const outside = join(paths.root, "outside-session");
    writeFileSync(
      outside,
      `${JSON.stringify({
        schemaVersion: 1,
        instanceId: "inst_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        pid: 88,
        port,
        startedAt: "2026-09-01T00:00:00.000Z",
        sessionToken: TOKEN,
      })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    linkSync(outside, paths.sessionPath);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        paths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE" });
  });
});
