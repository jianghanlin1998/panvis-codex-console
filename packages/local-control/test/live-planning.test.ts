import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";

import { describe, expect, it } from "vitest";

import { createWorktreeOwnershipManager } from "@codex-task-console/storage";
import { executeBigTaskPlanningCodexForTest } from "../../codex-adapter/src/live-execution.js";
import { planningProviderFixture } from "../../codex-adapter/test/planning-provider-fixture.js";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

describe("Big Task planning local control", () => {
  it.each([[true, false], [false, false], [true, true], [false, true]])("runs the bounded live planning loop with independent reviews (approval=%s, exception=%s)", async (approve, exception) => {
    const f = makePlanningFixture(() => new Date("2026-09-07T06:00:00.000Z"));
    try {
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
        outcome: approve && packet.proposal!.candidate.revision === 3 ? "APPROVE" : "REJECT",
        planRevision: packet.proposal!.candidate.revision, candidateBinding: packet.proposal!.candidateBinding,
        revisionRequirements: approve && packet.proposal!.candidate.revision === 3 ? [] : ["Test empty and unavailable news sources."], questions: [],
      }, { tokens: exception ? 150_000 : 100 });
      const forbidden = async (): Promise<never> => { throw new Error("Execution is outside planning."); };
      const service = createLocalControlServiceForTesting(f.storage, createWorktreeOwnershipManager(f.storage), forbidden, forbidden,
        (storage, id) => executeBigTaskPlanningCodexForTest(storage, id, provider.dependencies));
      await service.acceptPlanningIntake!({ ...f.intake, ...(exception ? { budgetException: {
        approved: true, mode: "MEASURE_ONLY", reason: "One measured trial", expiresAt: "2026-09-07T08:00:00.000Z",
      } } : {}) });
      const result = await service.runPlanning!(f.intake.bigTask.id);
      expect(result.phase).toBe(approve ? "APPROVED" : "HUMAN_REQUIRED");
      expect(result.automaticRevisionsUsed).toBe(2);
      expect(result.totalTokens).toBe(exception ? 900_000 : 600);
      expect(provider.launches).toHaveLength(6);
      expect(provider.packets.map((packet) => packet.role)).toEqual(["PLANNER", "REVIEWER", "PLANNER", "REVIEWER", "PLANNER", "REVIEWER"]);
      expect(provider.packets[2]?.revisionRequirements).toEqual(["Test empty and unavailable news sources."]);
      await service.runPlanning!(f.intake.bigTask.id);
      expect(provider.launches).toHaveLength(6);
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
      if (approve) {
        // Existing accepted authority consumes the generated bundle without manual task seeding.
        f.storage.materializeDurablePlan(f.intake.bigTask.id);
        f.storage.materializeApprovedCanonicalTasks(f.intake.bigTask.id);
        expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toHaveLength(2);
      }
    } finally { f.close(); }
  });

  it("rejects a duplicate run request while a provider invocation is active", async () => {
    const f = makePlanningFixture();
    try {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      const forbidden = async (): Promise<never> => { throw new Error("Out of scope"); };
      const service = createLocalControlServiceForTesting(f.storage, createWorktreeOwnershipManager(f.storage), forbidden, forbidden, async (_storage, id) => {
        calls += 1;
        const claim = f.planning.claim(id);
        await pending;
        return f.planning.finish(id, claim.sequence, false, null);
      });
      await service.acceptPlanningIntake!(f.intake);
      const first = service.runPlanning!(f.intake.bigTask.id);
      await expect(service.runPlanning!(f.intake.bigTask.id)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
      release();
      expect((await first).phase).toBe("HUMAN_REQUIRED");
      expect(calls).toBe(1);
    } finally { f.close(); }
  });

  it.each([false, true])("connects intake/status/run CLI commands through authenticated localhost (exception=%s)", async (exception) => {
    const f = makePlanningFixture(() => new Date("2026-09-07T06:00:00.000Z"));
    const token = "e".repeat(64);
    const forbidden = async (): Promise<never> => { throw new Error("Out of scope"); };
    const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
      outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
      candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
    }, { tokens: exception ? 150_000 : 100 });
    const service = createLocalControlServiceForTesting(f.storage, createWorktreeOwnershipManager(f.storage), forbidden, forbidden,
      (storage, id) => executeBigTaskPlanningCodexForTest(storage, id, provider.dependencies));
    const http = createLocalControlHttpServer(service, token);
    try {
      await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
      const port = (http.server.address() as AddressInfo).port;
      http.setAuthority(`127.0.0.1:${port}`);
      const paths = localControlPathsForTesting(join(f.root, "operator"));
      ensureProductionStateDirectories(paths);
      writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"e".repeat(32)}`, pid: 77, port,
        startedAt: "2026-09-01T00:00:00.000Z", sessionToken: token });
      const file = join(f.root, "intake.json");
      writeFileSync(file, JSON.stringify({ ...f.intake, ...(exception ? { budgetException: {
        approved: true, mode: "MEASURE_ONLY", reason: "One measured trial", expiresAt: "2026-09-07T08:00:00.000Z",
      } } : {}) }), "utf8");
      for (const args of [["planning-intake", file], ["planning-status", f.intake.bigTask.id], ["planning-run", f.intake.bigTask.id]]) {
        const result = await runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5_000);
        expect(result.succeeded).toBe(true);
      }
      expect((await service.inspectPlanning!(f.intake.bigTask.id)).phase).toBe("APPROVED");
      const malformed = JSON.stringify(f.intake).replace('"approved":true', '"approved":false,"approved":true');
      const status = await new Promise<number>((resolve, reject) => {
        const call = request({ hostname: "127.0.0.1", port, method: "POST", path: "/v0/planning/intake",
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "x-ctc-request": "1", "content-type": "application/json", "content-length": Buffer.byteLength(malformed) },
        }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
        call.once("error", reject); call.end(malformed);
      });
      expect(status).toBe(400);
      expect(provider.launches).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
      f.close();
    }
  });
});
