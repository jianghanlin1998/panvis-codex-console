import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalControlHttpServer } from "../src/http-server.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import type { LocalControlService } from "../src/service.js";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";

const token = "a".repeat(64);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function server(service: LocalControlService) {
  const http = createLocalControlHttpServer(service, token);
  await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(0, "127.0.0.1", resolve); });
  const port = (http.server.address() as AddressInfo).port; const authority = `127.0.0.1:${port}`;
  http.setAuthority(authority);
  cleanup.push(async () => { await service.stopAndDrain?.(); await new Promise<void>(resolve => http.server.close(() => resolve())); });
  const send = (path: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)), "content-type": "application/json", "x-ctc-request": "1" }), ...headers } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, body: text, ...(response.headers["set-cookie"]?.[0] ? { cookie: response.headers["set-cookie"][0] } : {}) }));
    }); req.on("error", reject); req.end(body);
  });
  const login = async () => {
    const ticket = await send("/v0/browser/launch", "{}", { authorization: `Bearer ${token}` });
    expect(ticket.status).toBe(200);
    const result = await send("/ui/session", ticket.body, { origin: `http://${authority}` });
    expect(result.status).toBe(200); return result.cookie!.split(";")[0]!;
  };
  return { send, login, authority };
}
const unavailable = async (): Promise<never> => { throw new Error("Unexpected operation"); };
const stub = (): LocalControlService => ({ inspectSubtask: unavailable, provisionOwnedWorktree: unavailable, runOwnedWorktreeExecution: unavailable, releaseOwnedWorktree: unavailable, consoleRequest: vi.fn(async () => ({ projects: [] })) });

describe("full browser control-plane boundary", () => {
  it("serves an inert shell, keeps CLI credentials out of browser content, and isolates browser authentication", async () => {
    const service = stub(); const f = await server(service);
    const shell = await f.send("/"); expect(shell.status).toBe(200); expect(shell.body).toContain("Codex Task Console"); expect(shell.body).not.toContain(token);
    const code = await f.send("/ui/app.js"); expect(code.status).toBe(200); expect(code.body).not.toContain(token);
    expect((await f.send("/v0/ping")).status).toBe(401);
    expect((await f.send("/v0/ping", undefined, { authorization: `Bearer ${token}` })).status).toBe(200);
    const envelope = JSON.stringify({ action: "workspace", input: {} });
    expect((await f.send("/ui/api", envelope, { origin: `http://${f.authority}`, authorization: `Bearer ${token}` })).status).toBe(401);
    const cookie = await f.login();
    expect((await f.send("/ui/api", envelope, { origin: `http://${f.authority}`, cookie })).status).toBe(200);
    expect(service.consoleRequest).toHaveBeenCalledExactlyOnceWith("workspace", {});
  });
  it("rejects foreign origins, missing mutation headers, duplicate JSON and invalid envelopes before dispatch", async () => {
    const service = stub(); const f = await server(service); const cookie = await f.login();
    const body = JSON.stringify({ action: "workspace", input: {} });
    const own = { origin: `http://${f.authority}`, cookie };
    for (const change of [{ origin: "https://foreign.invalid" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "x-ctc-request": "0" }, { host: "foreign.invalid" }]) expect((await f.send("/ui/api", body, { ...own, ...change })).status).toBe(403);
    expect((await f.send("/ui/api", body, { cookie })).status).toBe(403);
    for (const malformed of ['{"action":"workspace","action":"project","input":{}}', '{"action":"workspace","input":{"x":1,"x":2}}', '{"action":"workspace","input":{},"extra":true}', '{"action":12,"input":{}}']) expect((await f.send("/ui/api", malformed, own)).status).toBe(400);
    expect(service.consoleRequest).not.toHaveBeenCalled();
  });
  it("does not consume a launch ticket on a foreign-origin exchange", async () => {
    const f = await server(stub());
    const ticket = await f.send("/v0/browser/launch", "{}", { authorization: `Bearer ${token}` });
    expect((await f.send("/ui/session", ticket.body, { origin: "https://foreign.invalid" })).status).toBe(403);
    expect((await f.send("/ui/session", ticket.body, { origin: `http://${f.authority}` })).status).toBe(200);
    expect((await f.send("/ui/session", ticket.body, { origin: `http://${f.authority}` })).status).toBe(401);
  });
  it("executes a reviewed plan through browser operations and keeps final product acceptance human-owned", async () => {
    const fixture = makeExecutionFixture(undefined, undefined, "STANDARD");
    let progress = (): void => {};
    const execute: typeof fixture.execute = async (...args) => { try { return await fixture.execute(...args); } finally { progress(); } };
    const service = createLocalControlServiceForTesting(fixture.storage, fixture.manager, unavailable, execute, unavailable, fixture.governed);
    const f = await server(service); const cookie = await f.login();
    const call = async (action: string, input: object) => { const response = await f.send("/ui/api", JSON.stringify({ action, input }), { origin: `http://${f.authority}`, cookie }); return { status: response.status, data: JSON.parse(response.body) }; };
    let observing = true;
    try {
      const id = fixture.approval.bigTaskId;
      const pending = await call("task", { bigTaskId: id }); expect(pending.data.execution).toBeNull();
      expect((await call("execution-start", { bigTaskId: id })).status).toBe(409);
      expect((await call("execution-approve", fixture.approval)).data.phase).toBe("APPROVED");
      const observed = new Promise<void>(resolve => {
        progress = () => { setImmediate(() => setImmediate(() => { if (observing && fixture.execution.inspect(id).phase !== "RUNNING") { observing = false; resolve(); } })); };
      });
      expect((await call("execution-start", { bigTaskId: id })).data.phase).toBe("RUNNING");
      progress();
      await observed;
      // Drain through the coordinator's saved final state, without starting another operation.
      await service.stopAndDrain!();
      const delivered = await call("task", { bigTaskId: id });
      expect(delivered.data.execution.phase).toBe("AWAITING_ACCEPTANCE");
      expect(delivered.data.subtasks.every((task: { maturity: string }) => task.maturity === "ACCEPTED")).toBe(true);
      const result = await call("delivery", { bigTaskId: id }); expect(result.status).toBe(200); expect(result.data.headSha).toBe(delivered.data.execution.resultHeadSha);
      expect((await call("execution-accept", { bigTaskId: id, headSha: "f".repeat(40) })).status).toBe(409);
      expect((await call("execution-accept", { bigTaskId: id, headSha: result.data.headSha })).data.phase).toBe("ACCEPTED");
      expect(fixture.starts).toHaveLength(4);
    } finally { observing = false; await service.stopAndDrain!(); cleanup.push(async () => { fixture.close(); }); }
  }, 60_000);
});
