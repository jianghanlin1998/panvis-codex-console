import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubtaskId } from "@codex-task-console/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

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

it.each(["running", "completed", "unavailable"] as const)("planning client wait expiry queries saved status without resubmitting (%s)", async scenario => {
  const f = makePlanningFixture();
  f.planning.accept(f.intake);
  let received!: () => void;
  const originalReceived = new Promise<void>(resolve => { received = resolve; });
  let originalResponse: ServerResponse | undefined;
  const calls: string[] = [];
  const responder = await startResponder((request, response) => {
    request.resume();
    request.once("end", () => {
      calls.push(request.url!);
      if (request.url === "/v0/planning/run") {
        f.planning.claim(f.intake.bigTask.id);
        originalResponse = response;
        if (scenario === "completed") f.planning.finish(f.intake.bigTask.id, 1, false, "");
        received();
      } else if (scenario === "unavailable") respondJson(response, 500, { error: { code: "LOCAL_OPERATION_FAILED" } });
      else respondJson(response, 200, { ...f.planning.inspect(f.intake.bigTask.id) });
    });
  });
  try {
    const paths = createPaths(); installSession(paths, responder.port);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = runOperatorCommandForTesting(parseOperatorCommand(["planning-run", f.intake.bigTask.id]), paths, 100);
    await originalReceived;
    await vi.advanceTimersByTimeAsync(100);
    const result = await running;
    expect(result).toMatchObject({ succeeded: true, body: { phase: scenario === "running" ? "RUNNING" : scenario === "completed" ? "HUMAN_REQUIRED" : "STATUS_UNAVAILABLE",
      operatorNotice: { code: "WAIT_ENDED", statusCommand: ["planning-status", f.intake.bigTask.id] } } });
    expect(calls).toEqual(["/v0/planning/run", "/v0/planning/status"]);
    expect(f.planning.inspect(f.intake.bigTask.id).runs).toHaveLength(1);
    // The original server work may finish after the command has stopped waiting.
    if (scenario !== "completed") f.planning.finish(f.intake.bigTask.id, 1, false, "");
    expect(f.planning.inspect(f.intake.bigTask.id).runs[0]!.status).toBe("HUMAN_REQUIRED");
    originalResponse?.end();
  } finally { vi.useRealTimers(); f.close(); }
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


const governedWire = (role = "EXECUTE") => {
  const owner = { projectId: "prj_operator", bigTaskId: "bt_operator", subtaskId: SUBTASK_ID,
    planRevision: 1, candidateBinding: "exact-candidate" };
  const stamp = "2026-09-06T00:00:00.000Z";
  const receipt = { ...owner, receiptId: "gdr_operator", operationId: "op_operator", workflowSequence: 2,
    profile: "HIGH_RISK_FOUNDATION", writeEnabled: true, startPolicy: "WHEN_READY", manualStartAuthorityId: null,
    worktreeOwnershipId: "wt_" + "a".repeat(32), gateEvidenceReferences: ["gate_operator"], status: "ACTIVE",
    reservedAt: stamp, updatedAt: stamp, terminalAt: null };
  const authorization = { ...owner, authorizationId: "gra_operator", dispatchReceiptId: receipt.receiptId,
    workflowSequence: role === "EXECUTE" ? 2 : 3, workflowStage: role, repairCyclesUsed: 0, role,
    contextProfile: role === "FRESH_QA" ? "FRESH_INDEPENDENT_QA" : role === "FOCUSED_RE_QA" ? "FOCUSED_RE_QA" : "STANDARD_SUBTASK_EXECUTION",
    writeEnabled: ["EXECUTE", "HARDEN", "REPAIR"].includes(role), worktreeOwnershipId: receipt.worktreeOwnershipId,
    candidateSha: "a".repeat(40), authorizedAt: stamp };
  const budget = { status: "AVAILABLE", allowed: true, totalTokens: 0, warning: false,
    extensionApplied: false, effectiveLimitTokens: 120_000 };
  return { owner, stamp, receipt, authorization, budget,
    response: { prepared: { kind: "ROLE_AUTHORIZED", authorization, receipt, budget },
      execution: { success: true, failureCode: null, authorizationId: authorization.authorizationId, role,
        executionRunId: "run_operator", outcome: role === "EXECUTE" || role === "REPAIR" ? "READY" : "PASS",
        reconciliationKind: "TRANSITION_RECORDED" } } };
};

const governedExchange = async (args: readonly string[], body: Readonly<Record<string, unknown>>, status = 200) => {
  const observed: { method: string | undefined; path: string | undefined; body: string }[] = [];
  const responder = await startResponder((request, response) => {
    const chunks: Buffer[] = [];
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST") expect(request.headers["x-ctc-request"]).toBe("1");
      observed.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf-8") });
      respondJson(response, status, body);
    });
  });
  const paths = createPaths();
  installSession(paths, responder.port);
  const result = await runOperatorCommandForTesting(parseOperatorCommand(args), paths, 1_000);
  expect(observed).toHaveLength(1);
  return { result, request: observed[0] };
};

describe("governed operator commands", () => {
  it("maps only canonical fixed commands to the existing four routes", async () => {
    const { owner, stamp } = governedWire();
    const manual = { ...owner, authorityId: "manual_operator", workflowSequence: 0, authorizedAt: stamp };
    const extension = { ...owner, authorityId: "extension_operator", grantedTokens: 40_000, authorizedAt: stamp };
    const cases = [
      { args: ["governed-status", owner.bigTaskId], path: `/v0/governed/big-tasks/${owner.bigTaskId}/summary`, method: "GET", body: "",
        response: { bigTaskId: owner.bigTaskId, status: "IN_PROGRESS", candidateBinding: null, workflows: [], budgets: [], dispatchReceipts: [] } },
      { args: ["governed-advance", owner.bigTaskId], path: "/v0/governed/advance", method: "POST", body: JSON.stringify({ bigTaskId: owner.bigTaskId }),
        response: { prepared: { kind: "BIG_TASK_COMPLETE", bigTaskId: owner.bigTaskId, completionReceiptId: "complete_operator" }, execution: null } },
      { args: ["governed-manual-start", SUBTASK_ID], path: "/v0/governed/manual-start", method: "POST", body: JSON.stringify({ subtaskId: SUBTASK_ID }), response: manual },
      { args: ["governed-budget-extension", SUBTASK_ID], path: "/v0/governed/budget-extension", method: "POST", body: JSON.stringify({ subtaskId: SUBTASK_ID }), response: extension },
    ];
    for (const item of cases) {
      const result = await governedExchange(item.args, item.response);
      expect(result.request).toEqual({ method: item.method, path: item.path, body: item.body });
      expect(result.result).toEqual({ httpStatus: 200, body: item.response, succeeded: true });
      for (const args of [[item.args[0]!], [...item.args, "extra"], [item.args[0]!, ` ${item.args[1]}`],
        [item.args[0]!, ""], [item.args[0]!, "\ud800"], [item.args[0]!, item.args[1]!, "--token=synthetic"], ["--", ...item.args]]) {
        expect(() => parseOperatorCommand(args)).toThrowError(LocalOperatorError);
      }
    }
  });

  it.each(["EXECUTE", "VERIFY", "HARDEN", "FRESH_QA", "REPAIR", "FOCUSED_RE_QA"])(
    "accepts the %s result without equating dispatch and role write authority or sequence", async role => {
      const { response, owner } = governedWire(role);
      const { result } = await governedExchange(["governed-advance", owner.bigTaskId], response);
      expect(result.succeeded).toBe(true);
      expect(result.body).toEqual(response);
    });

  it.each([
    ["BLOCKED", "PLANNING_AUTHORITY_NOT_READY"], ["BLOCKED", "DEPENDENCY_BLOCKED"],
    ["BLOCKED", "REPOSITORY_PREFLIGHT_BLOCKED"], ["BLOCKED", "CONTEXT_PREFLIGHT_BLOCKED"],
    ["BLOCKED", "BUDGET_BLOCKED"], ["BLOCKED", "CONCURRENCY_BLOCKED"], ["BLOCKED", "WORKTREE_BLOCKED"],
    ["BLOCKED", "PROVIDER_ROLE_FAILED"], ["BLOCKED", "ROLE_RESULT_BLOCKED"], ["BLOCKED", "NO_ELIGIBLE_ACTION"],
    ["HUMAN_REQUIRED", "MANUAL_START_REQUIRED"], ["HUMAN_REQUIRED", "BUDGET_EXTENSION_REQUIRED"],
    ["HUMAN_REQUIRED", "REPAIR_REQA_EXHAUSTED"], ["HUMAN_REQUIRED", "AUTHORITY_BLOCKED"], ["HUMAN_REQUIRED", "REPLAN_REQUIRED"],
  ])("preserves %s / %s without retrying or granting authority", async (kind, reason) => {
    const body = { prepared: { kind, reason, subtaskId: null }, execution: null };
    const { result } = await governedExchange(["governed-advance", "bt_operator"], body);
    expect(result).toEqual({ httpStatus: 200, body, succeeded: false });
  });

  it("distinguishes an active role and unsuccessful reconciliation from successful progression", async () => {
    const { response, authorization, receipt } = governedWire();
    const assessment = governedWire("FOCUSED_RE_QA").response;
    for (const body of [
      { prepared: { kind: "ROLE_IN_PROGRESS", authorization, receipt, executionRunId: "run_operator", runStatus: "RUNNING" }, execution: null },
      { ...response, execution: { ...response.execution, success: false, failureCode: "APP_SERVER_TIMEOUT", outcome: null, reconciliationKind: null } },
      { ...assessment, execution: { ...assessment.execution, success: true, outcome: "BLOCKING_FAIL", reconciliationKind: "HUMAN_REQUIRED" } },
      { ...response, execution: { ...response.execution, success: true, outcome: "BLOCKED", reconciliationKind: "ROLE_RESULT_BLOCKED" } },
      { ...response, execution: { success: false, failureCode: "GOVERNED_AUTHORITY_REQUIRED", authorizationId: null, role: null, executionRunId: null, outcome: null, reconciliationKind: null } },
    ]) {
      const { result } = await governedExchange(["governed-advance", "bt_operator"], body);
      expect(result.succeeded).toBe(false);
      expect(result.body).toEqual(body);
    }
    const { result } = await governedExchange(["governed-advance", "bt_operator"], { error: { code: "OPERATION_CONFLICT" } }, 409);
    expect(result.succeeded).toBe(false);
  });

  it("rejects malformed nested results and wrong task/role/source bindings", async () => {
    const { response } = governedWire();
    const { prepared, execution } = response;
    const bad = [
      { ...response, extra: true }, { ...response, execution: null },
      { ...response, prepared: { ...prepared, kind: "AUTO_RETRY" } },
      { ...response, prepared: { ...prepared, budget: { ...prepared.budget, totalTokens: -1 } } },
      { ...response, prepared: { ...prepared, budget: { ...prepared.budget, effectiveLimitTokens: 200_000 } } },
      { ...response, prepared: { ...prepared, authorization: { ...prepared.authorization, bigTaskId: "bt_other" } } },
      { ...response, prepared: { ...prepared, receipt: { ...prepared.receipt, subtaskId: "st_other" } } },
      { ...response, prepared: { ...prepared, receipt: { ...prepared.receipt, rawPrompt: "unexpected" } } },
      { ...response, prepared: { ...prepared, authorization: { ...prepared.authorization, candidateSha: "invalid" } } },
      { ...response, execution: { ...execution, role: "VERIFY" } },
      { ...response, execution: { ...execution, authorizationId: "gra_other" } },
      { ...response, execution: { ...execution, executionRunId: null } },
      { ...response, execution: { ...execution, success: false, failureCode: "UNTRUSTED_ERROR" } },
      { prepared: { kind: "BIG_TASK_COMPLETE", bigTaskId: "bt_other", completionReceiptId: "completion" }, execution: null },
      { prepared: { kind: "BLOCKED", reason: "MANUAL_START_REQUIRED", subtaskId: null }, execution: null },
    ];
    for (const body of bad) {
      await expect(governedExchange(["governed-advance", "bt_operator"], body)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    }
  });

  it("validates actual durable workflow, manual authority and dispatch shapes without a provider turn", async () => {
    const fixture = new IntegratedOrchestrationFixture({ profiles: ["STANDARD"], manual: true });
    try {
      const snapshot = fixture.governed.inspectBigTask(BIG_TASK_ID);
      expect((await governedExchange(["governed-status", BIG_TASK_ID], snapshot)).result.succeeded).toBe(true);
      const blocked = { prepared: fixture.governed.prepareNextRole(BIG_TASK_ID), execution: null };
      expect(blocked.prepared.kind).toBe("HUMAN_REQUIRED");
      expect((await governedExchange(["governed-advance", BIG_TASK_ID], blocked)).result.succeeded).toBe(false);
      const manual = fixture.governed.authorizeManualStart(SUBTASK_IDS[0]!);
      expect((await governedExchange(["governed-manual-start", SUBTASK_IDS[0]!], { ...manual })).result.succeeded).toBe(true);
      const prepared = fixture.governed.prepareNextRole(BIG_TASK_ID);
      expect(prepared.kind).toBe("ROLE_AUTHORIZED");
      const current = fixture.governed.inspectBigTask(BIG_TASK_ID);
      expect(current.workflows[0]!.transitions.length).toBeGreaterThan(0);
      expect((await governedExchange(["governed-status", BIG_TASK_ID], current)).result.succeeded).toBe(true);
      const failure = { prepared, execution: { success: false, failureCode: "GOVERNED_AUTHORITY_REQUIRED",
        authorizationId: null, role: null, executionRunId: null, outcome: null, reconciliationKind: null } };
      expect((await governedExchange(["governed-advance", BIG_TASK_ID], failure)).result.succeeded).toBe(false);
      expect(fixture.counts().execution_runs).toBe(0);
      for (const body of [
        { ...current, workflows: [...current.workflows, current.workflows[0]] },
        { ...current, budgets: [] },
        { ...current, candidateBinding: "other" },
        { ...current, dispatchReceipts: current.dispatchReceipts.map(receipt => ({ ...receipt, subtaskId: "st_other" })) },
        { ...current, workflows: current.workflows.map(workflow => ({ ...workflow, transitions: workflow.transitions.map(transition => ({ ...transition, bigTaskId: "bt_other" })) })) },
      ]) await expect(governedExchange(["governed-status", BIG_TASK_ID], body)).rejects.toMatchObject({ code: "RESPONSE_MALFORMED" });
    } finally { fixture.close(); }
  });
});
