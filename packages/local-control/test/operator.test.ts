import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubtaskId } from "@codex-task-console/domain";
import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_CONTROL_HOST } from "../src/http-server.js";
import {
  LocalOperatorError,
  parseOperatorCommand,
  runOperatorCommandForTesting,
} from "../src/operator.js";
import {
  ensureProductionStateDirectories,
  localControlPathsForTesting,
  writeSessionDescriptor,
} from "../src/state.js";
import type { LocalControlPaths } from "../src/state.js";

const TOKEN = "c".repeat(64);
const SUBTASK_ID = "st_operator_test" as SubtaskId;
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createPaths = (): LocalControlPaths => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-operator-test-")),
  );
  roots.push(root);
  const paths = localControlPathsForTesting(join(root, "Codex Task Console"));
  ensureProductionStateDirectories(paths);
  return paths;
};

const startResponder = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly server: Server; readonly port: number }> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCAL_CONTROL_HOST, () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
  };
};

const installSession = (paths: LocalControlPaths, port: number): void => {
  writeSessionDescriptor(paths, {
    schemaVersion: 1,
    instanceId: "inst_cccccccccccccccccccccccccccccccc",
    pid: 77,
    port,
    startedAt: "2026-09-01T00:00:00.000Z",
    sessionToken: TOKEN,
  });
};

const respondJson = (
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void => {
  const bytes = Buffer.from(JSON.stringify(body), "utf-8");
  response.writeHead(status, {
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(bytes);
};

const validInspection = (): Readonly<Record<string, unknown>> => ({
  subtask: {
    id: SUBTASK_ID,
    status: "IN_PROGRESS",
    maturity: "IMPLEMENTED",
  },
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
});

describe("thin operator command boundary", () => {
  it("accepts only the five fixed commands and canonical Subtask IDs", () => {
    expect(parseOperatorCommand(["ping"])).toEqual({ name: "ping" });
    expect(parseOperatorCommand(["status", SUBTASK_ID])).toEqual({
      name: "status",
      subtaskId: SUBTASK_ID,
    });
    expect(parseOperatorCommand(["provision", SUBTASK_ID]).name).toBe(
      "provision",
    );
    expect(parseOperatorCommand(["run", SUBTASK_ID]).name).toBe("run");
    expect(parseOperatorCommand(["release", SUBTASK_ID]).name).toBe("release");
    for (const arguments_ of [
      [],
      ["unknown"],
      ["status"],
      ["status", ` ${SUBTASK_ID}`],
      ["status", SUBTASK_ID, "--url=http://example.test"],
      ["run", SUBTASK_ID, "--token=secret"],
      ["http://127.0.0.1:9999/v0/ping"],
    ]) {
      expect(() => parseOperatorCommand(arguments_)).toThrowError(
        LocalOperatorError,
      );
    }
  });

  it("discovers the session locally and sends exact Host/auth/request headers", async () => {
    const observed: {
      method: string | undefined;
      path: string | undefined;
      host: string | undefined;
      authorization: string | undefined;
      marker: string | undefined;
      body: string | undefined;
    } = {
      method: undefined,
      path: undefined,
      host: undefined,
      authorization: undefined,
      marker: undefined,
      body: undefined,
    };
    const responder = await startResponder((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        observed.method = request.method;
        observed.path = request.url;
        observed.host = request.headers.host;
        observed.authorization = request.headers.authorization;
        observed.marker = request.headers["x-ctc-request"] as string | undefined;
        observed.body = Buffer.concat(chunks).toString("utf-8");
        respondJson(response, 200, {
          worktree: {
            id: "wt_11111111111111111111111111111111",
            status: "ACTIVE",
            startingCommitSha: "1".repeat(40),
            releaseHeadSha: null,
          },
        });
      });
    });
    const paths = createPaths();
    installSession(paths, responder.port);
    const result = await runOperatorCommandForTesting(
      parseOperatorCommand(["provision", SUBTASK_ID]),
      paths,
      1_000,
    );
    expect(result.succeeded).toBe(true);
    expect(observed).toEqual({
      method: "POST",
      path: "/v0/worktrees/provision",
      host: `${LOCAL_CONTROL_HOST}:${responder.port}`,
      authorization: `Bearer ${TOKEN}`,
      marker: "1",
      body: JSON.stringify({ subtaskId: SUBTASK_ID }),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("uses fixed status paths and no anti-CSRF header for GET", async () => {
    let observedPath = "";
    let marker: string | string[] | undefined;
    const responder = await startResponder((request, response) => {
      observedPath = request.url ?? "";
      marker = request.headers["x-ctc-request"];
      respondJson(response, 200, validInspection());
    });
    const paths = createPaths();
    installSession(paths, responder.port);
    await runOperatorCommandForTesting(
      parseOperatorCommand(["status", SUBTASK_ID]),
      paths,
      1_000,
    );
    expect(observedPath).toBe(`/v0/subtasks/${SUBTASK_ID}`);
    expect(marker).toBeUndefined();
  });

  it("preserves a bounded sanitized server error and returns non-success", async () => {
    const responder = await startResponder((_request, response) => {
      respondJson(response, 409, { error: { code: "OPERATION_CONFLICT" } });
    });
    const paths = createPaths();
    installSession(paths, responder.port);
    const result = await runOperatorCommandForTesting(
      parseOperatorCommand(["release", SUBTASK_ID]),
      paths,
      1_000,
    );
    expect(result).toEqual({
      httpStatus: 409,
      body: { error: { code: "OPERATION_CONFLICT" } },
      succeeded: false,
    });
  });

  it("rejects response token reflection and oversized responses", async () => {
    const reflection = await startResponder((_request, response) => {
      respondJson(response, 200, { token: TOKEN });
    });
    const reflectionPaths = createPaths();
    installSession(reflectionPaths, reflection.port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        reflectionPaths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });

    const oversized = await startResponder((_request, response) => {
      respondJson(response, 200, { data: "x".repeat(70 * 1_024) });
    });
    const oversizedPaths = createPaths();
    installSession(oversizedPaths, oversized.port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        oversizedPaths,
        1_000,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("fails cleanly when the daemon is unavailable or exceeds the bounded timeout", async () => {
    const unavailable = await startResponder((_request, response) => {
      respondJson(response, 200, { ok: true });
    });
    const unavailablePaths = createPaths();
    installSession(unavailablePaths, unavailable.port);
    await new Promise<void>((resolve) => unavailable.server.close(() => resolve()));
    servers.splice(servers.indexOf(unavailable.server), 1);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        unavailablePaths,
        100,
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_UNAVAILABLE" });

    const hanging = await startResponder((request) => {
      request.resume();
    });
    const hangingPaths = createPaths();
    installSession(hangingPaths, hanging.port);
    await expect(
      runOperatorCommandForTesting(
        parseOperatorCommand(["ping"]),
        hangingPaths,
        25,
      ),
    ).rejects.toMatchObject({ code: "OPERATOR_TIMEOUT" });
  });
});
