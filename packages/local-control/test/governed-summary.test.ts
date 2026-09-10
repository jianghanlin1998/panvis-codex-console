import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { BIG_TASK_ID, SUBTASK_IDS, IntegratedOrchestrationFixture } from "./integrated-orchestration-fixture.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import type { LocalControlService } from "../src/service.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { localControlPathsForTesting, ensureProductionStateDirectories, writeSessionDescriptor } from "../src/state.js";

it("returns bounded status and complete paged history even when full bindings exceed the HTTP envelope", async () => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["STANDARD"], manual: true });
  f.governed.prepareNextRole(BIG_TASK_ID);
  f.governed.authorizeManualStart(SUBTASK_IDS[0]!);
  f.governed.prepareNextRole(BIG_TASK_ID);
  const original = f.governed.inspectBigTask(BIG_TASK_ID);
  const binding = "large-synthetic-canonical-binding".repeat(40_000);
  const status = { ...original, candidateBinding: binding,
    workflows: original.workflows.map(w => ({ ...w, candidateBinding: binding,
      transitions: w.transitions.map(t => ({ ...t, candidateBinding: binding })) })) };
  expect(Buffer.byteLength(JSON.stringify(status), "utf8")).toBeGreaterThan(1024 * 1024);
  const token = "e".repeat(64);
  const unicodeId = "bt_中文看板🚀";
  const inspected: string[] = [];
  const http = createLocalControlHttpServer({ inspectGovernedBigTask: async (id: string) => {
    inspected.push(id);
    return id === unicodeId ? { bigTaskId: id, status: "IN_PROGRESS", candidateBinding: null, workflows: [], budgets: [], dispatchReceipts: [] } : status;
  } } as unknown as LocalControlService, token);
  try {
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port;
    http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.directory, "operator"));
    ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"e".repeat(32)}`, pid: 77, port,
      startedAt: "2026-09-01T00:00:00.000Z", sessionToken: token });
    const call = (args: string[]) => runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5_000);
    const summary = await call(["governed-status", BIG_TASK_ID]);
    expect(summary).toMatchObject({ succeeded: true, body: { format: "CTC_GOVERNED_STATUS_V1", bigTaskId: BIG_TASK_ID } });
    expect(JSON.stringify(summary.body)).not.toContain(binding);
    expect(Buffer.byteLength(JSON.stringify(summary.body), "utf8")).toBeLessThan(10_000);
    expect(await call(["governed-status", unicodeId])).toMatchObject({ succeeded: true, body: { bigTaskId: unicodeId } });
    expect(inspected.at(-1)).toBe(unicodeId);
    const file = join(f.directory, "history.json");
    const sequences: number[] = [];
    let afterSequence = 0;
    do {
      writeFileSync(file, JSON.stringify({ bigTaskId: BIG_TASK_ID, subtaskId: SUBTASK_IDS[0], afterSequence, limit: 1 }), "utf8");
      const page = await call(["governed-history", file]);
      expect(page.succeeded).toBe(true);
      expect(page.body.candidateDigest).toBe(summary.body.candidateDigest);
      const rows = page.body.transitions as Array<{ sequence: number }>;
      expect(rows).toHaveLength(1);
      sequences.push(rows[0]!.sequence);
      afterSequence = Number(page.body.nextAfterSequence ?? 0);
    } while (afterSequence > 0);
    expect(sequences).toEqual(original.workflows[0]!.transitions.map(t => t.sequence));
    writeFileSync(file, JSON.stringify({ bigTaskId: BIG_TASK_ID, subtaskId: "st_absent", afterSequence: 0, limit: 1 }), "utf8");
    expect(await call(["governed-history", file])).toMatchObject({ succeeded: false, httpStatus: 404 });
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: `/v0/governed/big-tasks/${BIG_TASK_ID}`,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", text => { body += text; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }); req.on("error", reject); req.end();
    });
    expect(raw).toEqual({ status: 500, body: JSON.stringify({ error: { code: "RESPONSE_TOO_LARGE" } }) });
    expect(f.counts().execution_runs).toBe(0);
  } finally {
    await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
    f.close();
  }
});
