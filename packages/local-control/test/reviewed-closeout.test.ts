import { expect, it } from "vitest";
import { BigTaskExecutionStatusSchema } from "@codex-task-console/domain";
import { BigTaskExecutionStore } from "../../storage/src/big-task-execution.js";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { localControlPathsForTesting, ensureProductionStateDirectories, writeSessionDescriptor } from "../src/state.js";

const forbidden = async (): Promise<never> => { throw new Error("No unrelated provider call"); };

it.each([false, true])("reviews ordinary tasks without a mandatory hardening role, bounded repairs=%s", async repair => {
  const f = makeExecutionFixture(undefined, (role, occurrence) => repair &&
    (role === "FRESH_QA" && occurrence === 1 || role === "FOCUSED_RE_QA" && occurrence === 1) ? "two-blockers" : undefined, "STANDARD");
  let observe = (): void => {};
  const execute: typeof f.execute = async (...args) => { try { return await f.execute(...args); } finally { observe(); } };
  const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, execute, forbidden, f.governed);
  const token = "f".repeat(64);
  const http = createLocalControlHttpServer(service, token);
  try {
    await service.approveExecution!({ ...f.approval, limits: { ...f.approval.limits, repairCycleLimit: 2 } });
    await expect(service.closeExecution!({ bigTaskId: f.approval.bigTaskId, headSha: f.approval.repositoryHeadSha, reason: "Not delivered yet" }))
      .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    const terminal = new Promise<Awaited<ReturnType<NonNullable<typeof service.inspectExecution>>>>((resolve, reject) => {
      observe = () => setImmediate(() => setImmediate(() => {
        void service.inspectExecution!(f.approval.bigTaskId).then(state => { if (state.phase !== "RUNNING") resolve(state); }, reject);
      }));
    });
    await service.startExecution!(f.approval.bigTaskId);
    observe();
    const state = await terminal;
    expect(state, JSON.stringify({ state, outcomes: f.outcomes, decisions: f.decisions })).toMatchObject({
      phase: "AWAITING_ACCEPTANCE", roleCalls: repair ? 8 : 4, activeRoleCount: 0, knownTokens: (repair ? 8 : 4) * 18,
    });
    expect(state.integratedSubtaskIds).toHaveLength(2);
    const roles = f.starts.map(id => f.governed.getRoleAuthorization(id)!);
    expect(roles.some(r => r.role === "HARDEN" || r.role === "VERIFY")).toBe(false);
    expect(roles.filter(r => r.role === "REPAIR").map(r => r.repairCyclesUsed)).toEqual(repair ? [1, 2] : []);
    expect(roles.filter(r => r.role === "FRESH_QA")).toHaveLength(2);
    const reason = "Owner waived browser recheck and closed the workflow; product direction remains a follow-up.";
    const request = { bigTaskId: state.bigTaskId, headSha: state.resultHeadSha, reason };
    await expect(service.closeExecution!({ ...request, headSha: f.approval.repositoryHeadSha })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port;
    http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator")); ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"f".repeat(32)}`, pid: 77, port,
      startedAt: "2026-09-01T00:00:00.000Z", sessionToken: token });
    const file = join(f.root, "closeout.json"); writeFileSync(file, JSON.stringify(request), "utf8");
    const response = await runOperatorCommandForTesting(parseOperatorCommand(["execution-close", file]), paths, 5_000);
    expect(response.succeeded).toBe(true);
    const closed = BigTaskExecutionStatusSchema.parse(response.body);
    expect(closed).toMatchObject({ phase: "CLOSED", closeout: { reason, productAccepted: false }, knownTokens: state.knownTokens, roleCalls: state.roleCalls });
    expect(BigTaskExecutionStatusSchema.safeParse(closed).success).toBe(true);
    expect(await service.closeExecution!(request)).toEqual(closed);
    await expect(service.closeExecution!({ ...request, reason: "Different disposition" })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await expect(service.acceptExecution!(state.bigTaskId, state.resultHeadSha)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await service.startExecution!(state.bigTaskId);
    expect(f.starts).toHaveLength(repair ? 8 : 4);
    await service.stopAndDrain!();
    f.reopen();
    expect(new BigTaskExecutionStore(f.storage).inspect(state.bigTaskId)).toEqual(closed);
  } finally {
    observe = () => {}; await service.stopAndDrain!();
    await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
    f.close();
  }
}, 60_000);
