import { ClientRequest, createServer } from "node:http";
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
import * as storageApi from "@codex-task-console/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createLocalControlServiceForTesting } from "../src/service.js";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

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
  body: string | Buffer,
  contentType: string = "application/json; charset=utf-8",
): void => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
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
  body: string | Buffer,
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

const replaceUtf8Segment = (
  text: string,
  target: string,
  replacement: Buffer,
): Buffer => {
  const bytes = Buffer.from(text, "utf-8");
  const targetBytes = Buffer.from(target, "utf-8");
  const start = bytes.indexOf(targetBytes);
  if (start < 0) {
    throw new Error("UTF-8 response fixture target was not found");
  }
  return Buffer.concat([
    bytes.subarray(0, start),
    replacement,
    bytes.subarray(start + targetBytes.byteLength),
  ]);
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

  it.each([
    [
      "invalid UTF-8 in providerThreadId",
      "provider-thread",
      Buffer.concat([
        Buffer.from("provider-", "utf-8"),
        Buffer.from([0xc3, 0x28]),
      ]),
    ],
    [
      "invalid UTF-8 in providerModelId",
      "provider-model",
      Buffer.concat([
        Buffer.from("provider-", "utf-8"),
        Buffer.from([0xe2, 0x28, 0xa1]),
      ]),
    ],
    [
      "truncated multibyte providerRunId",
      "provider-run",
      Buffer.concat([
        Buffer.from("provider-", "utf-8"),
        Buffer.from([0xe2, 0x82]),
      ]),
    ],
  ] as const)("rejects a response with %s", async (_name, target, replacement) => {
    const body = replaceUtf8Segment(
      JSON.stringify(successfulExecution()),
      target,
      replacement,
    );
    await expect(runResponse(["run", SUBTASK_ID], body)).rejects.toMatchObject({
      code: "RESPONSE_MALFORMED",
    });
  });

  it("preserves valid non-ASCII provider-owned identifiers exactly", async () => {
    const identifiers = {
      providerThreadId: "thread-e\u0301-\u{1f600}",
      providerRunId: "\u8fd0\u884c-\u{1f680}",
      providerModelId: "\u6a21\u578b-e\u0301",
    };
    const result = await runResponse(
      ["run", SUBTASK_ID],
      JSON.stringify(successfulExecution(identifiers)),
    );

    expect(result.body.execution).toMatchObject(identifiers);
  });

  it("accepts a legitimately encoded replacement character", async () => {
    const providerThreadId = "provider-\ufffd-thread";
    const result = await runResponse(
      ["run", SUBTASK_ID],
      JSON.stringify(successfulExecution({ providerThreadId })),
    );

    expect(result.body.execution).toMatchObject({ providerThreadId });
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


describe("governed operator response boundaries", () => {
  const manual = () => ({ authorityId: "gma_operator", projectId: "prj_operator", bigTaskId: "bt_operator",
    subtaskId: SUBTASK_ID, planRevision: 1, candidateBinding: "bound-candidate", workflowSequence: 0,
    authorizedAt: "2026-09-06T00:00:00.000Z" });

  it("rejects token reflection, duplicate keys, invalid UTF-8 and oversized governed responses", async () => {
    const clean = JSON.stringify(manual());
    const escapedToken = Array.from(TOKEN, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    for (const body of [
      JSON.stringify({ ...manual(), authorityId: TOKEN }),
      clean.replace("gma_operator", escapedToken),
      clean.replace('"workflowSequence":0', '"workflowSequence":0,"workflowSequence":1'),
      replaceUtf8Segment(clean, "gma_operator", Buffer.from([0xff])),
      JSON.stringify({ ...manual(), rawTranscript: "unexpected" }),
    ]) {
      await expect(runResponse(["governed-manual-start", SUBTASK_ID], body)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    }
    await expect(runResponse(["governed-manual-start", SUBTASK_ID], JSON.stringify({
      ...manual(), authorityId: "x".repeat(65_536),
    }))).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects substituted manual/budget grants and never treats arbitrary grants as canonical", async () => {
    const base: Record<string, unknown> = { ...manual() };
    delete base.workflowSequence;
    const grant = { ...base, grantedTokens: 40_000 };
    expect((await runResponse(["governed-budget-extension", SUBTASK_ID], JSON.stringify(grant))).succeeded).toBe(true);
    for (const body of [
      { ...grant, subtaskId: "st_other" }, { ...grant, grantedTokens: 80_000 },
      { ...grant, grantedTokens: "40000" }, { ...grant, authorizedAt: "tomorrow" },
      { ...grant, planRevision: 0 }, { ...grant, extensionApplied: true },
    ]) await expect(runResponse(["governed-budget-extension", SUBTASK_ID], JSON.stringify(body))).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    await expect(runResponse(["governed-manual-start", SUBTASK_ID], JSON.stringify({ ...manual(), subtaskId: "st_other" }))).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it("uses the existing absolute deadline and never repeats an indeterminate advance", async () => {
    let requests = 0;
    let observed!: () => void;
    const received = new Promise<void>(resolve => { observed = resolve; });
    const port = await startHttpServer(request => {
      requests++;
      expect(request.url).toBe("/v0/governed/advance");
      request.resume();
      observed();
    });
    const paths = createPaths();
    installSession(paths, port);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const attempt = runOperatorCommandForTesting(parseOperatorCommand(["governed-advance", "bt_operator"]), paths, 1_000);
      const assertion = expect(attempt).rejects.toMatchObject({ code: "OPERATOR_TIMEOUT" });
      await received;
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requests).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});


// Independent wire fixtures use the published response contracts, not the
// operator's validators or the implementation test's response builder.
const hardeningAdvance = (role = "VERIFY") => {
  const owner = { projectId: "prj_operator_hard", bigTaskId: "bt_operator_hard", subtaskId: SUBTASK_ID,
    candidateBinding: "reviewed-candidate", planRevision: 1 };
  const timestamp = "2026-09-07T00:00:00.000Z";
  const receipt = { ...owner, receiptId: "gdr_hard", operationId: "op_hard", workflowSequence: 2,
    profile: "STANDARD", writeEnabled: true, startPolicy: "WHEN_READY", manualStartAuthorityId: null,
    worktreeOwnershipId: `wt_${"a".repeat(32)}`, gateEvidenceReferences: ["gate_hard"],
    status: "ACTIVE", reservedAt: timestamp, updatedAt: timestamp, terminalAt: null };
  const authorization = { ...owner, authorizationId: "gra_hard", dispatchReceiptId: receipt.receiptId,
    workflowSequence: 3, workflowStage: role, repairCyclesUsed: 0, role,
    contextProfile: role === "FRESH_QA" ? "FRESH_INDEPENDENT_QA" : role === "FOCUSED_RE_QA" ? "FOCUSED_RE_QA" : "STANDARD_SUBTASK_EXECUTION",
    writeEnabled: ["EXECUTE", "HARDEN", "REPAIR"].includes(role), worktreeOwnershipId: receipt.worktreeOwnershipId,
    candidateSha: "b".repeat(40), authorizedAt: timestamp };
  const budget = { status: "AVAILABLE", allowed: true, totalTokens: 1_000, warning: false, extensionApplied: false,
    effectiveLimitTokens: 120_000 };
  return { prepared: { kind: "ROLE_AUTHORIZED", authorization, receipt, budget },
    execution: { success: true, failureCode: null, authorizationId: authorization.authorizationId, role,
      executionRunId: "run_hard", outcome: role === "EXECUTE" || role === "REPAIR" ? "READY" : "PASS",
      reconciliationKind: "TRANSITION_RECORDED" } };
};
const hardeningStatus = () => {
  const { prepared: { authorization, budget } } = hardeningAdvance();
  const { projectId, bigTaskId, subtaskId, planRevision, candidateBinding } = authorization;
  return { bigTaskId, status: "IN_PROGRESS", candidateBinding,
    workflows: [{ projectId, bigTaskId, subtaskId, planRevision, candidateBinding, profile: "STANDARD",
      writeEnabled: true, initialStage: "MATERIALIZE", initializedAt: authorization.authorizedAt,
      currentStage: "MATERIALIZE", initialRepairCyclesUsed: 0, repairCyclesUsed: 0,
      boardStatus: "TODO", deliveryMaturity: "NOT_STARTED", transitionCount: 0, transitions: [], unresolvedHumanRequired: null }],
    budgets: [budget], dispatchReceipts: [] as ReturnType<typeof hardeningAdvance>["prepared"]["receipt"][] };
};

describe("Step 9A comprehensive contradiction and cleanup regressions", () => {
  it.each(["EXECUTE", "REPAIR", "VERIFY", "HARDEN", "FRESH_QA", "FOCUSED_RE_QA"])(
    "rejects an outcome belonging to a different role family: %s", async role => {
      const body = hardeningAdvance(role);
      expect((await runResponse(["governed-advance", "bt_operator_hard"], JSON.stringify(body))).succeeded).toBe(true);
      body.execution.outcome = role === "EXECUTE" || role === "REPAIR" ? "PASS" : "READY";
      await expect(runResponse(["governed-advance", "bt_operator_hard"], JSON.stringify(body)))
        .rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    });

  it.each(["write policy", "context profile", "partial provider identity", "result without run", "reconciliation without result"])(
    "rejects contradictory governed execution metadata: %s", async variant => {
      const body = hardeningAdvance();
      const execution: Record<string, unknown> = { ...body.execution };
      if (variant === "write policy") body.prepared.authorization.writeEnabled = true;
      if (variant === "context profile") body.prepared.authorization.contextProfile = "FOCUSED_RE_QA";
      if (variant === "partial provider identity") Object.assign(execution, { success: false, failureCode: "APP_SERVER_TIMEOUT", authorizationId: null });
      if (variant === "result without run") Object.assign(execution, { success: false, failureCode: "GOVERNED_AUTHORITY_REQUIRED", executionRunId: null });
      if (variant === "reconciliation without result") Object.assign(execution, { success: false, failureCode: "GOVERNED_AUTHORITY_REQUIRED", outcome: null });
      await expect(runResponse(["governed-advance", "bt_operator_hard"], JSON.stringify({ ...body, execution })))
        .rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    });

  it.each(["allowed", "status", "warning", "extension", "unknown"])("rejects contradictory budget %s", async variant => {
    const body = hardeningStatus();
    const budget: Record<string, unknown> = { ...body.budgets[0] };
    if (variant === "allowed") budget.allowed = false;
    if (variant === "status") budget.status = "HARD_PAUSE";
    if (variant === "warning") budget.warning = true;
    if (variant === "extension") budget.extensionApplied = true;
    if (variant === "unknown") budget.totalTokens = null;
    await expect(runResponse(["governed-status", "bt_operator_hard"], JSON.stringify({ ...body, budgets: [budget] })))
      .rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it.each(["unfinished", "no graph", "no receipt", "duplicate receipt", "foreign project"])(
    "rejects contradictory inspection/completion evidence: %s", async variant => {
      const body = hardeningStatus();
      if (variant === "unfinished") body.status = "DONE";
      if (variant === "no graph") Object.assign(body, { candidateBinding: null, workflows: [], budgets: [], status: "DONE" });
      if (variant === "no receipt") {
        body.status = "DONE";
        Object.assign(body.workflows[0]!, { currentStage: "COMPLETE", boardStatus: "DONE", deliveryMaturity: "ACCEPTED" });
      }
      if (variant === "duplicate receipt") {
        const receipt = hardeningAdvance().prepared.receipt;
        body.dispatchReceipts = [receipt, receipt];
      }
      if (variant === "foreign project") body.workflows.push({ ...body.workflows[0]!, projectId: "prj_foreign", subtaskId: "st_foreign" as SubtaskId });
      if (variant === "foreign project") body.budgets.push({ ...body.budgets[0]! });
      await expect(runResponse(["governed-status", "bt_operator_hard"], JSON.stringify(body)))
        .rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    });

  it.each([" ", "\ud800", "\udfff"])("rejects malformed opaque evidence text %j", async text => {
    const body = { prepared: { kind: "BIG_TASK_COMPLETE", bigTaskId: "bt_operator_hard", completionReceiptId: text }, execution: null };
    await expect(runResponse(["governed-advance", "bt_operator_hard"], JSON.stringify(body)))
      .rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
  });

  it.each(["content-type", "content-length"])("closes a stalled response after invalid %s headers", async variant => {
    let requests = 0;
    const port = await startHttpServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, variant === "content-type"
        ? { "content-type": "text/plain" }
        : { "content-type": "application/json", "content-length": "65537" });
      response.flushHeaders(); // deliberately never ends; the client must close it
    });
    const paths = createPaths(); installSession(paths, port);
    const destroy = vi.spyOn(ClientRequest.prototype, "destroy");
    try {
      await expect(runOperatorCommandForTesting(parseOperatorCommand(["governed-advance", "bt_operator_hard"]), paths, 1_000))
        .rejects.toMatchObject({ code: variant === "content-type" ? "RESPONSE_MALFORMED" : "RESPONSE_TOO_LARGE" });
      expect(requests).toBe(1);
      expect(destroy).toHaveBeenCalled();
    } finally { destroy.mockRestore(); }
  });

  it.each(["planning-status", "execution-review"])("bounds declared and streamed %s responses at 256 KiB", async command => {
    for (const declared of [false, true]) {
      for (const bytes of [262_143, 262_144, 262_145]) {
        const error = JSON.stringify({ error: { code: "LOCAL_OPERATION_FAILED" } });
        const body = error + " ".repeat(bytes - Buffer.byteLength(error, "utf8"));
        let calls = 0;
        const port = await startHttpServer((request, response) => {
          calls += 1; request.resume();
          response.writeHead(503, { "content-type": "application/json", ...(declared ? { "content-length": String(bytes) } : {}) });
          response.end(body);
        });
        const paths = createPaths(); installSession(paths, port);
        const result = runOperatorCommandForTesting(parseOperatorCommand([command, "bt_capacity"]), paths, 1_000);
        if (bytes > 262_144) await expect(result).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
        else expect(await result).toMatchObject({ httpStatus: 503, succeeded: false, body: { error: { code: "LOCAL_OPERATION_FAILED" } } });
        expect(calls).toBe(1);
      }
    }
  });
});

// Real storage + adapter fixtures are the positive oracle. Only the App Server
// is synthetic; the service produces the wire response with its own serializer.
type FixtureRole = Parameters<IntegratedOrchestrationFixture["runRole"]>[1];
const actualService = (fixture: IntegratedOrchestrationFixture, role: FixtureRole,
  options: Parameters<IntegratedOrchestrationFixture["runRole"]>[2] = {}) => {
  // The service normally creates its own worktree manager. Bind its constructor
  // to this real governed store so all clocks and filesystem roots stay inside
  // the disposable fixture. No governed methods or response values are mocked.
  const factory = vi.spyOn(storageApi, "createGovernedExecutionStore").mockImplementation(storage => {
    expect(storage).toBe(fixture.storage);
    return fixture.governed;
  });
  try { return createLocalControlServiceForTesting(fixture.storage, fixture.worktrees,
    () => { throw new Error("The legacy execution route must not be called."); },
    async (governed, authorizationId) => {
      const prepared = governed.prepareNextRole(BIG_TASK_ID);
      expect(prepared).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { authorizationId, role } });
      return fixture.runRole(SUBTASK_IDS[0]!, role, options);
    }); } finally { factory.mockRestore(); }
};
const roundTrip = async (command: string, id: string, body: object, succeeded: boolean) => {
  const result = await runResponse([command, id], JSON.stringify(body));
  expect(result).toEqual({ body, httpStatus: 200, succeeded });
};

const actualCases: readonly {
  label: string; profile: "LOW" | "STANDARD" | "HIGH_RISK_FOUNDATION";
  before: readonly FixtureRole[]; role: FixtureRole; scenario?: string; fails?: boolean; complete?: boolean;
}[] = [
  { label: "LOW completion", profile: "LOW", before: ["EXECUTE"], role: "VERIFY", complete: true },
  { label: "STANDARD completion", profile: "STANDARD", before: ["EXECUTE"], role: "VERIFY", complete: true },
  { label: "execution with active observation", profile: "HIGH_RISK_FOUNDATION", before: [], role: "EXECUTE" },
  { label: "hardening", profile: "HIGH_RISK_FOUNDATION", before: ["EXECUTE"], role: "HARDEN" },
  { label: "fresh QA completion", profile: "HIGH_RISK_FOUNDATION", before: ["EXECUTE", "HARDEN"], role: "FRESH_QA", complete: true },
  { label: "fresh QA requests repair", profile: "HIGH_RISK_FOUNDATION", before: ["EXECUTE", "HARDEN"], role: "FRESH_QA", scenario: "two-blockers" },
  { label: "repair", profile: "HIGH_RISK_FOUNDATION", before: ["EXECUTE", "HARDEN", "FRESH_QA"], role: "REPAIR" },
  { label: "focused QA completion", profile: "HIGH_RISK_FOUNDATION", before: ["EXECUTE", "HARDEN", "FRESH_QA", "REPAIR"], role: "FOCUSED_RE_QA", complete: true },
  { label: "focused QA requires human", profile: "HIGH_RISK_FOUNDATION", before: ["EXECUTE", "HARDEN", "FRESH_QA", "REPAIR"], role: "FOCUSED_RE_QA", scenario: "two-blockers" },
  { label: "provider failure", profile: "HIGH_RISK_FOUNDATION", before: [], role: "EXECUTE", scenario: "process-exit", fails: true },
];
for (const item of actualCases) describe(`Step 9A backend oracle: ${item.label}`, () => {
  let fixture: IntegratedOrchestrationFixture;
  beforeEach(() => { fixture = new IntegratedOrchestrationFixture({ profiles: [item.profile] }); });
  // Each setup phase keeps the ordinary hook timeout, independent of the number
  // of historical roles needed to reach the response being tested.
  for (const role of item.before) beforeEach(async () => {
    await fixture.runRole(SUBTASK_IDS[0]!, role, role === "FRESH_QA" ? { scenario: "two-blockers" } : {});
    fixture.reopen();
  });
  afterEach(() => { fixture?.close(); });
  it("preserves actual service output, durable ownership and restart state", async () => {
    const active: object[] = [];
    const service = actualService(fixture, item.role, {
      ...(item.scenario === undefined ? {} : { scenario: item.scenario }),
      ...(item.fails ? { success: false } : {}),
      ...(item.label !== "execution with active observation" ? {} : { onTurn: () => {
        active.push({ prepared: fixture.governed.prepareNextRole(BIG_TASK_ID), execution: null });
        active.push(fixture.governed.inspectBigTask(BIG_TASK_ID));
      } }),
    });
    const before = fixture.counts();
    const response = await service.advanceGovernedBigTask!(BIG_TASK_ID);
    await roundTrip("governed-advance", BIG_TASK_ID, response, !item.fails && item.scenario !== "two-blockers");
    expect(fixture.counts().execution_runs).toBe(before.execution_runs! + 1);
    if (active.length !== 0) {
      // With no terminal usage yet, the source's budget guard takes precedence
      // over its ROLE_IN_PROGRESS response. Preserve that conservative result.
      expect(active[0]).toMatchObject({ prepared: { kind: "BLOCKED", reason: "BUDGET_BLOCKED" }, execution: null });
      expect(active[1]).toMatchObject({ budgets: [{ status: "UNKNOWN_USAGE", allowed: false }] });
      await roundTrip("governed-advance", BIG_TASK_ID, active[0]!, false);
      await roundTrip("governed-status", BIG_TASK_ID, active[1]!, true);
    }
    const snapshot = fixture.governed.inspectBigTask(BIG_TASK_ID);
    await roundTrip("governed-status", BIG_TASK_ID, snapshot, true);
    const counts = fixture.counts();
    fixture.reopen();
    expect(fixture.governed.inspectBigTask(BIG_TASK_ID)).toEqual(snapshot);
    await roundTrip("governed-status", BIG_TASK_ID, fixture.governed.inspectBigTask(BIG_TASK_ID), true);
    expect(fixture.counts()).toEqual(counts);
    if (item.complete) {
      // Inspection cannot itself finalize an otherwise complete graph.
      expect(snapshot.status).toBe("IN_PROGRESS");
      const prepared = fixture.governed.prepareNextRole(BIG_TASK_ID);
      expect(prepared.kind).toBe("BIG_TASK_COMPLETE");
      await roundTrip("governed-advance", BIG_TASK_ID, { prepared, execution: null }, true);
      fixture.reopen();
      const done = fixture.governed.inspectBigTask(BIG_TASK_ID);
      expect(done.status).toBe("DONE");
      await roundTrip("governed-status", BIG_TASK_ID, done, true);
    }
    if (item.fails || (item.role === "FOCUSED_RE_QA" && item.scenario)) {
      const prepared = fixture.governed.prepareNextRole(BIG_TASK_ID);
      expect(prepared).toMatchObject(item.fails
        ? { kind: "BLOCKED", reason: "PROVIDER_ROLE_FAILED" }
        : { kind: "HUMAN_REQUIRED", reason: "REPAIR_REQA_EXHAUSTED" });
      await roundTrip("governed-advance", BIG_TASK_ID, { prepared, execution: null }, false);
      expect(fixture.counts()).toEqual(counts);
    }
  });
});

describe("Step 9A actual budget extension oracle", () => {
  let fixture: IntegratedOrchestrationFixture;
  beforeEach(() => { fixture = new IntegratedOrchestrationFixture({ profiles: ["HIGH_RISK_FOUNDATION"] }); });
  beforeEach(async () => { await fixture.runRole(SUBTASK_IDS[0]!, "EXECUTE", { tokens: 120_000 }); fixture.reopen(); });
  afterEach(() => { fixture?.close(); });
  it("preserves pause, one replayable 40K grant and the absolute ceiling without extra execution", async () => {
    const id = SUBTASK_IDS[0]!;
    const paused = fixture.governed.inspectBigTask(BIG_TASK_ID);
    expect(paused.budgets[0]).toMatchObject({ status: "HARD_PAUSE", allowed: false, totalTokens: 120_000 });
    await roundTrip("governed-status", BIG_TASK_ID, paused, true);
    const blocked = await actualService(fixture, "HARDEN").advanceGovernedBigTask!(BIG_TASK_ID);
    expect(blocked).toMatchObject({ prepared: { reason: "BUDGET_EXTENSION_REQUIRED" }, execution: null });
    await roundTrip("governed-advance", BIG_TASK_ID, blocked, false);
    const grant = await actualService(fixture, "HARDEN").authorizeGovernedBudgetExtension!(id);
    expect(grant).toMatchObject({ grantedTokens: 40_000 });
    await roundTrip("governed-budget-extension", id, grant, true);
    fixture.reopen();
    const extended = fixture.governed.inspectBigTask(BIG_TASK_ID);
    expect(extended.budgets[0]).toMatchObject({ status: "AVAILABLE_WARNING", allowed: true, effectiveLimitTokens: 160_000 });
    await roundTrip("governed-status", BIG_TASK_ID, extended, true);
    const response = await actualService(fixture, "HARDEN", { tokens: 40_000 }).advanceGovernedBigTask!(BIG_TASK_ID);
    await roundTrip("governed-advance", BIG_TASK_ID, response, true);
    fixture.reopen();
    const ceiling = fixture.governed.inspectBigTask(BIG_TASK_ID);
    expect(ceiling.budgets[0]).toMatchObject({ status: "ABSOLUTE_CEILING", totalTokens: 160_000, allowed: false });
    await roundTrip("governed-status", BIG_TASK_ID, ceiling, true);
    const before = fixture.counts();
    const replay = await actualService(fixture, "FRESH_QA").authorizeGovernedBudgetExtension!(id);
    expect(replay).toEqual(grant);
    await roundTrip("governed-budget-extension", id, replay, true);
    const terminal = await actualService(fixture, "FRESH_QA").advanceGovernedBigTask!(BIG_TASK_ID);
    expect(terminal).toMatchObject({ prepared: { kind: "BLOCKED", reason: "BUDGET_BLOCKED" }, execution: null });
    await roundTrip("governed-advance", BIG_TASK_ID, terminal, false);
    expect(fixture.counts()).toEqual(before);
    expect(before.execution_runs).toBe(2);
  });
});

describe("Step 9A preserved boundary states", () => {
  it.each([
    [0, false, "AVAILABLE", true, false, 120_000],
    [79_999, false, "AVAILABLE", true, false, 120_000],
    [80_000, false, "AVAILABLE_WARNING", true, true, 120_000],
    [119_999, false, "AVAILABLE_WARNING", true, true, 120_000],
    [120_000, false, "HARD_PAUSE", false, true, 120_000],
    [120_000, true, "AVAILABLE_WARNING", true, true, 160_000],
    [159_999, true, "AVAILABLE_WARNING", true, true, 160_000],
    [160_000, true, "ABSOLUTE_CEILING", false, true, 160_000],
    [160_001, false, "ABSOLUTE_CEILING", false, true, 120_000],
    [null, false, "UNKNOWN_USAGE", false, false, 120_000],
  ])("preserves the explicit budget boundary %j / extension %j", async (totalTokens, extensionApplied, status, allowed, warning, effectiveLimitTokens) => {
    const body = { ...hardeningStatus(), budgets: [{ totalTokens, extensionApplied, status, allowed, warning, effectiveLimitTokens }] };
    await roundTrip("governed-status", "bt_operator_hard", body, true);
  });

  it.each(["before claim", "during provider", "after result", "after reconciliation"])(
    "preserves a legitimate failure %s without inventing successful progression", async phase => {
      const body = hardeningAdvance();
      const execution: Record<string, unknown> = { ...body.execution, success: false, failureCode: "GOVERNED_AUTHORITY_REQUIRED" };
      if (phase === "before claim") Object.assign(execution, { authorizationId: null, role: null, executionRunId: null });
      if (phase === "before claim" || phase === "during provider") execution.outcome = null;
      if (phase !== "after reconciliation") execution.reconciliationKind = null;
      await roundTrip("governed-advance", "bt_operator_hard", { ...body, execution }, false);
    });

  it("preserves valid Unicode command IDs and text without path substitution", async () => {
    const id = "bt_看板 /?#🚀";
    let requests = 0;
    const body = { bigTaskId: id, status: "IN_PROGRESS", candidateBinding: null, workflows: [], budgets: [], dispatchReceipts: [] };
    const port = await startHttpServer((request, response) => {
      requests++;
      expect(request.url).toBe(`/v0/governed/big-tasks/${encodeURIComponent(id)}/summary`);
      expect(request.method).toBe("GET");
      respond(response, 200, JSON.stringify(body));
    });
    const paths = createPaths();
    installSession(paths, port);
    const result = await runOperatorCommandForTesting(parseOperatorCommand(["governed-status", id]), paths, 1_000);
    expect(result).toEqual({ body, httpStatus: 200, succeeded: true });
    expect(requests).toBe(1);
    const completion = { prepared: { kind: "BIG_TASK_COMPLETE", bigTaskId: id, completionReceiptId: "receipt-\ufffd-🚀" }, execution: null };
    await roundTrip("governed-advance", id, completion, true);
  });
});
