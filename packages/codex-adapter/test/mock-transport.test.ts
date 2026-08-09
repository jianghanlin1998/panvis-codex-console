import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { MockAppServerHarness } from "../src/index.js";
import {
  MOCK_FIXTURE_PATH,
  initializeHarness,
  startFixtureThread,
  startHarness,
} from "./helpers.js";

interface RawProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

let harness: MockAppServerHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function runRawProcess(input: string, scenario = "stream"): Promise<RawProcessResult> {
  return new Promise<RawProcessResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [MOCK_FIXTURE_PATH, `--scenario=${scenario}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectResult(new Error("Raw fixture process exceeded its bounded timeout."));
    }, 1_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

describe("mock JSONL transport failures", () => {
  it("handles malformed JSON deterministically", async () => {
    const result = await runRawProcess("{malformed\n");
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe(
      '{"error":{"code":-32700,"message":"Malformed JSON input."},"id":null}',
    );
  });

  it("rejects a missing request ID", async () => {
    const result = await runRawProcess('{"method":"initialize","params":{}}\n');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Request ID is required.");
  });

  it("rejects an unknown method with the correlated request ID", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await expect(harness.request(22, "unknown/method")).resolves.toEqual({
      error: { code: -32_601, message: "Unknown method." },
      id: 22,
    });
  });

  it("rejects an unexpected response ID", async () => {
    const result = await runRawProcess(
      [
        '{"id":1,"method":"initialize","params":{}}',
        '{"method":"initialized","params":{}}',
        '{"id":"unexpected","result":{"decision":"accept"}}',
        "",
      ].join("\n"),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Unexpected response ID.");
  });

  it("fails cleanly when the client disconnects with an approval pending", async () => {
    const result = await runRawProcess(
      [
        '{"id":1,"method":"initialize","params":{}}',
        '{"method":"initialized","params":{}}',
        '{"id":2,"method":"thread/start","params":{}}',
        '{"id":3,"method":"turn/start","params":{"threadId":"thread-fixture-1","input":[]}}',
        "",
      ].join("\n"),
      "command-approval",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("pending approval request");
    expect(result.stderr).not.toMatch(/provider|authorization|token/iu);
  });

  it("uses a bounded timeout instead of hanging", async () => {
    harness = startHarness("interrupt");
    await initializeHarness(harness);
    await expect(
      harness.waitForMessage((message) => message.method === "never/emitted", 10),
    ).rejects.toMatchObject({ code: "MOCK_PROTOCOL_TIMEOUT" });
  });

  it("cleans up the child after success", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await harness.stop();
    expect(harness.isRunning).toBe(false);
  });

  it("cleans up the child after a fatal transport failure", async () => {
    const result = await runRawProcess("not-json\n");
    expect(result.code).toBe(1);
  });

  it("keeps stdout as JSONL protocol and diagnostics on stderr", async () => {
    const result = await runRawProcess("not-json\n");
    for (const line of result.stdout.trim().split("\n")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(result.stdout).not.toContain("mock-app-server:");
    expect(result.stderr).toContain("mock-app-server:");
  });

  it("surfaces disconnect to a waiter as a sanitized error", async () => {
    harness = startHarness("command-approval");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    await harness.request(3, "turn/start", {
      input: [],
      threadId: "thread-fixture-1",
    });
    const completed = harness.waitForMessage((message) => message.method === "item/completed");
    harness.closeInput();
    await expect(completed).rejects.toMatchObject({
      code: "MOCK_PROCESS_DISCONNECTED",
      message: "Mock App Server disconnected before a pending request resolved.",
    });
    await expect(harness.waitForExit()).resolves.toBe(2);
  });
});
