import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { BigTaskExecutionRecoveryReviewSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

it("reviews, binds and resumes Sol through the authenticated operator to integrated delivery", async () => {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(instant++), (role, n) => role === "EXECUTE" && n === 1 ? "budget-exceeded" : undefined);
  f.approval.limits.totalTokenLimit = 480000;
  const forbidden = async (): Promise<never> => { throw new Error("No other provider path"); };
  let report = () => {}, observing = true;
  const execute = async (...args: Parameters<typeof f.execute>) => { try { return await f.execute(...args); } finally { report(); } };
  const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, execute, forbidden, f.governed);
  const token = "e".repeat(64), http = createLocalControlHttpServer(service, token);
  try {
    f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, repairCycleLimit: 2 } }); const original = f.execution.start(f.approval.bigTaskId).status;
    const first = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (first.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
    await f.execute(f.governed, first.authorization.authorizationId);
    f.execution.stop(f.approval.bigTaskId, "GOVERNED_BLOCKED");
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port; http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator")); ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"e".repeat(32)}`, pid: 77, port,
      startedAt: "2026-09-07T00:00:00.000Z", sessionToken: token });
    const call = (args: string[]) => runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5000);
    const view = await call(["execution-recovery-review", f.approval.bigTaskId]);
    expect(view.succeeded).toBe(true);
    const review = BigTaskExecutionRecoveryReviewSchema.parse(view.body);
    const file = join(f.root, "recovery.json"); writeFileSync(file, JSON.stringify(review.request), "utf8");
    const recovered = await call(["execution-recover", file]);
    expect(recovered.succeeded).toBe(true);
    expect(recovered.body).toMatchObject({ phase: "PAUSED", knownTokens: 143674, expiresAt: original.expiresAt });
    instant = Date.parse(original.expiresAt!) + 1;
    const renewal = { bigTaskId: f.approval.bigTaskId, planDigest: f.approval.planDigest,
      previousExpiresAt: original.expiresAt, durationMilliseconds: 10_800_000 };
    const renewalFile = join(f.root, "renewal.json"); writeFileSync(renewalFile, JSON.stringify(renewal), "utf8");
    expect((await call(["execution-start", f.approval.bigTaskId])).succeeded).toBe(false);
    const renewed = await call(["execution-renew-window", renewalFile]);
    expect(renewed.succeeded).toBe(true);
    expect(renewed.body).toMatchObject({ phase: "PAUSED", startedAt: original.startedAt, knownTokens: 143674,
      windowRenewal: { previousExpiresAt: original.expiresAt, durationMilliseconds: 10_800_000 } });
    expect((await call(["execution-renew-window", renewalFile])).body).toEqual(renewed.body);
    expect((await call(["governed-status", f.approval.bigTaskId])).body.budgets).toContainEqual({
      scope: "BIG_TASK", status: "AVAILABLE_WARNING", allowed: true, totalTokens: 143674, subtaskKnownTokens: 143674, warning: true, extensionApplied: false, effectiveLimitTokens: 480000 });
    const done = new Promise<Awaited<ReturnType<NonNullable<typeof service.inspectExecution>>>>((resolve, reject) => {
      report = () => setImmediate(() => setImmediate(() => {
        if (!observing) return;
        void service.inspectExecution!(f.approval.bigTaskId).then(state => { if (state.phase !== "RUNNING") { observing = false; resolve(state); } }, reject);
      }));
    });
    expect((await call(["execution-start", f.approval.bigTaskId])).body.phase).toBe("RUNNING");
    report();
    const delivered = await done;
    expect(delivered, JSON.stringify({ delivered, outcomes: f.outcomes, decisions: f.decisions })).toMatchObject({
      phase: "AWAITING_ACCEPTANCE", knownTokens: 143782, roleCalls: 7, usageComplete: true, expiresAt: renewed.body.expiresAt, recovery: { model: "gpt-5.6-sol" } });
    expect(delivered.integratedSubtaskIds).toHaveLength(2);
    expect(new Set(f.starts).size).toBe(7);
    expect(f.git(["rev-parse", "HEAD"]).toString().trim()).toBe(f.approval.repositoryHeadSha);
    expect((await call(["execution-status", f.approval.bigTaskId])).succeeded).toBe(true);
    expect((await call(["execution-recover", file])).succeeded).toBe(true);
    expect(f.starts).toHaveLength(7);
  } finally {
    observing = false; await service.stopAndDrain!();
    await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
    f.close();
  }
}, 60_000);
