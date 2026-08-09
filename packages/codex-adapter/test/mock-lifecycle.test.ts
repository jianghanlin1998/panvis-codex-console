import { afterEach, describe, expect, it } from "vitest";

import type { MockAppServerHarness } from "../src/index.js";
import { initializeHarness, startHarness, startFixtureThread } from "./helpers.js";

let harness: MockAppServerHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("mock initialization and thread lifecycle", () => {
  it("completes initialize and accepts initialized", async () => {
    harness = startHarness("stream");
    const response = await harness.request(1, "initialize", {
      clientInfo: { name: "test", title: "Test", version: "1.0.0" },
    });
    expect(response).toMatchObject({
      id: 1,
      result: { platformFamily: "unix", userAgent: "codex-task-console-mock/1.0.0" },
    });
    harness.notify("initialized");
    const thread = await harness.request(2, "thread/start");
    expect(thread).toHaveProperty("result");
  });

  it("rejects a request before initialization", async () => {
    harness = startHarness("stream");
    await expect(harness.request(1, "thread/start")).resolves.toEqual({
      error: { code: -32_001, message: "Not initialized." },
      id: 1,
    });
  });

  it("rejects repeated initialize", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await expect(harness.request(2, "initialize")).resolves.toEqual({
      error: { code: -32_002, message: "Already initialized." },
      id: 2,
    });
  });

  it("starts a deterministic thread", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    const response = await harness.request(2, "thread/start");
    expect(response).toMatchObject({
      id: 2,
      result: { thread: { id: "thread-fixture-1", sessionId: "thread-fixture-1" } },
    });
  });

  it("emits thread/started after thread/start", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    await expect(
      harness.waitForMessage((message) => message.method === "thread/started"),
    ).resolves.toMatchObject({
      method: "thread/started",
      params: { thread: { id: "thread-fixture-1" } },
    });
  });

  it("resumes the known fixture thread", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await expect(
      harness.request(2, "thread/resume", { threadId: "thread-fixture-known" }),
    ).resolves.toMatchObject({
      id: 2,
      result: { thread: { id: "thread-fixture-known" } },
    });
  });

  it("rejects an unknown thread resume", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await expect(
      harness.request(2, "thread/resume", { threadId: "thread-unknown" }),
    ).resolves.toEqual({
      error: { code: -32_004, message: "Unknown fixture thread." },
      id: 2,
    });
  });

  it("sets and gets deterministic goal usage fields", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    const setResponse = await harness.request(3, "thread/goal/set", {
      objective: "Keep fixture tests green",
      threadId: "thread-fixture-1",
      tokenBudget: 40_000,
    });
    expect(setResponse).toMatchObject({
      result: {
        goal: {
          objective: "Keep fixture tests green",
          timeUsedSeconds: 0,
          tokenBudget: 40_000,
          tokensUsed: 0,
        },
      },
    });
    await expect(
      harness.request(4, "thread/goal/get", { threadId: "thread-fixture-1" }),
    ).resolves.toMatchObject({
      id: 4,
      result: {
        goal: {
          objective: "Keep fixture tests green",
          threadId: "thread-fixture-1",
          tokenBudget: 40_000,
        },
      },
    });
  });

  it("lists the repository-scoped task skill without reading ambient roots", async () => {
    harness = startHarness("stream");
    await initializeHarness(harness);
    await expect(
      harness.request(2, "skills/list", { cwds: ["/fixture/workspace"] }),
    ).resolves.toMatchObject({
      result: {
        data: [
          {
            cwd: "/fixture/workspace",
            skills: [
              {
                name: "task-execution",
                path: "/fixture/workspace/.agents/skills/task-execution/SKILL.md",
              },
            ],
          },
        ],
      },
    });
  });
});
