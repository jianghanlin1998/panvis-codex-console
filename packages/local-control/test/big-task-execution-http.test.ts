import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { parseOperatorCommand, runOperatorCommandForTesting } from "../src/operator.js";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../src/state.js";

const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider call"); };

describe("human execution CLI and HTTP", () => {
  it("reviews and approves the exact plan, starts asynchronously and pauses through authenticated localhost", async () => {
    const f = makeExecutionFixture();
    const token = "a".repeat(64);
    let calls = 0;
    const hold: typeof f.execute = async (_handle, _id, signal) => {
      calls += 1;
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      throw new Error("Synthetic paused invocation");
    };
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, hold, forbidden, f.governed);
    const http = createLocalControlHttpServer(service, token);
    try {
      await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
      const port = (http.server.address() as AddressInfo).port;
      http.setAuthority(`127.0.0.1:${port}`);
      const paths = localControlPathsForTesting(join(f.root, "operator"));
      ensureProductionStateDirectories(paths);
      writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"a".repeat(32)}`, pid: 77, port,
        startedAt: "2026-09-01T00:00:00.000Z", sessionToken: token });
      const file = join(f.root, "approval.json");
      writeFileSync(file, JSON.stringify(f.approval), "utf8");
      for (const args of [["execution-review", f.approval.bigTaskId], ["execution-approve", file],
        ["execution-status", f.approval.bigTaskId], ["execution-start", f.approval.bigTaskId], ["execution-start", f.approval.bigTaskId]]) {
        expect(await runOperatorCommandForTesting(parseOperatorCommand(args), paths, 5_000)).toMatchObject({ succeeded: true });
      }
      expect(calls).toBe(1);
      const post = (body: string, auth = token) => new Promise<number>((resolve, reject) => {
        const call = request({ hostname: "127.0.0.1", port, method: "POST", path: "/v0/execution/approve",
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${auth}`, "x-ctc-request": "1", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
        call.once("error", reject); call.end(body);
      });
      expect(await post(JSON.stringify(f.approval), "b".repeat(64))).toBe(401);
      expect(await post(JSON.stringify(f.approval).replace('"roleCallLimit":16', '"roleCallLimit":1,"roleCallLimit":16'))).toBe(400);
      expect(await runOperatorCommandForTesting(parseOperatorCommand(["execution-pause", f.approval.bigTaskId]), paths, 5_000)).toMatchObject({ succeeded: true });
      expect((await service.inspectExecution!(f.approval.bigTaskId)).phase).toBe("PAUSED");
      expect(calls).toBe(1);
    } finally {
      await service.stopAndDrain!();
      await new Promise<void>(resolve => { http.server.close(() => resolve()); http.server.closeAllConnections(); });
      f.close();
    }
  }, 20_000);
});
