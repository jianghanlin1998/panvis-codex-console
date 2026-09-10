import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { TaskContractV0Schema } from "@codex-task-console/domain";
import { createWorktreeOwnershipManager } from "@codex-task-console/storage";
import { executeBigTaskPlanningCodexForTest } from "../../codex-adapter/src/live-execution.js";
import { planningProviderFixture } from "../../codex-adapter/test/planning-provider-fixture.js";
import { makePlanningFixture, sizedPlanningProposal } from "../../storage/test/live-planning-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import type { LocalControlService } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

const token = "d".repeat(64);
const forbidden = async (): Promise<never> => { throw new Error("No target execution during planning."); };

it("carries a complete 100 KiB plan through revision, fresh review, CLI display and exact human approval", async () => {
  const f = makePlanningFixture();
  const proposal = sizedPlanningProposal(102_400);
  const provider = planningProviderFixture(packet => packet.role === "PLANNER" ? proposal : {
    outcome: packet.proposal!.candidate.revision === 1 ? "REJECT" : "APPROVE",
    planRevision: packet.proposal!.candidate.revision, candidateBinding: packet.proposal!.candidateBinding,
    revisionRequirements: packet.proposal!.candidate.revision === 1 ? ["Include source failure verification."] : [], questions: [],
  });
  const service = createLocalControlServiceForTesting(f.storage, createWorktreeOwnershipManager(f.storage), forbidden, forbidden,
    (storage, id) => executeBigTaskPlanningCodexForTest(storage, id, provider.dependencies));
  const http = createLocalControlHttpServer(service, token);
  try {
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port;
    http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator"));
    ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"d".repeat(32)}`, pid: 77, port,
      startedAt: "2026-09-01T00:00:00.000Z", sessionToken: token });
    const call = (args: string[]) => runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5_000);
    const file = join(f.root, "intake.json");
    writeFileSync(file, JSON.stringify(f.intake), "utf8");
    expect((await call(["planning-intake", file])).succeeded).toBe(true);
    expect((await call(["planning-run", f.intake.bigTask.id])).body).toMatchObject({ phase: "APPROVED", totalTokens: 400, usageComplete: true });
    expect(provider.launches).toHaveLength(4);
    expect(provider.packets.map(packet => packet.role)).toEqual(["PLANNER", "REVIEWER", "PLANNER", "REVIEWER"]);
    for (const packet of provider.packets.slice(1)) {
      const bytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
      expect(bytes).toBeGreaterThan(64_000);
      expect(bytes).toBeLessThanOrEqual(4_194_304);
    }
    const view = await call(["execution-review", f.intake.bigTask.id]);
    expect(view.succeeded).toBe(true);
    expect(view.body.executionIssues).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(view.body), "utf8")).toBeGreaterThan(65_536);
    const contracts = TaskContractV0Schema.array().parse(view.body.taskContracts);
    expect(contracts.map(contract => contract.scopeIn)).toEqual(proposal.tasks.map(task => task.scopeIn));
    expect(view.body.confirmation).toBe("HANLIN_EXECUTION_APPROVAL_REQUIRED");
    const approval = { bigTaskId: f.intake.bigTask.id, planDigest: view.body.planDigest, repositoryHeadSha: view.body.repositoryHeadSha,
      limits: { durationMilliseconds: 60_000, totalTokenLimit: 480_000, roleCallLimit: 28, repairCycleLimit: 2 } };
    writeFileSync(file, JSON.stringify(approval), "utf8");
    expect((await call(["execution-approve", file])).body.phase).toBe("APPROVED");
    expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
    f.reopen();
    expect(f.planning.inspect(f.intake.bigTask.id)).toMatchObject({ phase: "APPROVED", totalTokens: 400, usageComplete: true });
    expect(f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!.taskContracts.map(contract => contract.scopeIn))
      .toEqual(proposal.tasks.map(task => task.scopeIn));
    expect(provider.launches).toHaveLength(4);
  } finally {
    await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
    f.close();
  }
});

it("returns large bounded product questions through both planning-run and planning-status", async () => {
  const f = makePlanningFixture();
  const questions = Array.from({ length: 24 }, (_, index) => `${index}:` + "问".repeat(990));
  const provider = planningProviderFixture(() => ({ outcome: "HUMAN_REQUIRED", questions, tasks: [], dependencies: [] }));
  const service = createLocalControlServiceForTesting(f.storage, createWorktreeOwnershipManager(f.storage), forbidden, forbidden,
    (storage, id) => executeBigTaskPlanningCodexForTest(storage, id, provider.dependencies));
  const http = createLocalControlHttpServer(service, token);
  try {
    f.planning.accept(f.intake);
    await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
    const port = (http.server.address() as AddressInfo).port;
    http.setAuthority(`127.0.0.1:${port}`);
    const paths = localControlPathsForTesting(join(f.root, "operator"));
    ensureProductionStateDirectories(paths);
    writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"d".repeat(32)}`, pid: 77, port,
      startedAt: "2026-09-01T00:00:00.000Z", sessionToken: token });
    for (const name of ["planning-run", "planning-status"]) {
      const result = await runOperatorCommandForTesting(parseOperatorCommand([name, f.intake.bigTask.id]), paths, 5_000);
      expect(result.body).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PRODUCT_QUESTION", questions, totalTokens: 100 });
      expect(Buffer.byteLength(JSON.stringify(result.body), "utf8")).toBeGreaterThan(65_536);
    }
    expect(provider.launches).toHaveLength(1);
    expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
  } finally {
    await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
    f.close();
  }
});

describe("bounded planning HTTP envelope", () => {
  it.each([4_194_303, 4_194_304, 4_194_305])("caps the server response at 4 MiB envelope (%i bytes)", async bytes => {
    const body = { padding: "x".repeat(bytes - Buffer.byteLength(JSON.stringify({ padding: "" }), "utf8")) };
    const http = createLocalControlHttpServer({ inspectPlanning: async () => body } as unknown as LocalControlService, token);
    try {
      await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
      const port = (http.server.address() as AddressInfo).port;
      http.setAuthority(`127.0.0.1:${port}`);
      const input = JSON.stringify({ bigTaskId: "bt_capacity" });
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const call = request({ hostname: "127.0.0.1", port, method: "POST", path: "/v0/planning/status",
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "x-ctc-request": "1", "content-type": "application/json", "content-length": Buffer.byteLength(input) },
        }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.on("error", reject);
          response.once("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
        });
        call.once("error", reject); call.end(input);
      });
      expect(result.status).toBe(bytes <= 4_194_304 ? 200 : 500);
      expect(result.body).toBe(bytes <= 4_194_304 ? JSON.stringify(body) : JSON.stringify({ error: { code: "RESPONSE_TOO_LARGE" } }));
    } finally {
      await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
    }
  });
});
