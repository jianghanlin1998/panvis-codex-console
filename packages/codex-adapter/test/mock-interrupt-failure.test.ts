import { afterEach, describe, expect, it } from "vitest";

import type { MockAppServerHarness } from "../src/index.js";
import { initializeHarness, startFixtureThread, startHarness } from "./helpers.js";

let harness: MockAppServerHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("mock interruption and sanitized failure", () => {
  it("interrupts an active turn with an empty success result", async () => {
    harness = startHarness("interrupt");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    await harness.request(3, "turn/start", {
      input: [{ text: "Fixture interrupt.", type: "text" }],
      threadId: "thread-fixture-1",
    });
    await expect(
      harness.request(4, "turn/interrupt", {
        threadId: "thread-fixture-1",
        turnId: "turn-fixture-1",
      }),
    ).resolves.toEqual({ id: 4, result: {} });
  });

  it("completes the interrupted turn with interrupted status", async () => {
    harness = startHarness("interrupt");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    await harness.request(3, "turn/start", {
      input: [{ text: "Fixture interrupt.", type: "text" }],
      threadId: "thread-fixture-1",
    });
    await harness.request(4, "turn/interrupt", {
      threadId: "thread-fixture-1",
      turnId: "turn-fixture-1",
    });
    await expect(
      harness.waitForMessage((message) => message.method === "turn/completed"),
    ).resolves.toMatchObject({ params: { turn: { status: "interrupted" } } });
  });

  it("emits no agent delta after turn completion", async () => {
    harness = startHarness("interrupt");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    await harness.request(3, "turn/start", {
      input: [{ text: "Fixture interrupt.", type: "text" }],
      threadId: "thread-fixture-1",
    });
    await harness.request(4, "turn/interrupt", {
      threadId: "thread-fixture-1",
      turnId: "turn-fixture-1",
    });
    await harness.waitForMessage((message) => message.method === "turn/completed");
    const completionIndex = harness.messages.findIndex(
      (message) => message.method === "turn/completed",
    );
    expect(
      harness.messages
        .slice(completionIndex + 1)
        .some((message) => message.method === "item/agentMessage/delta"),
    ).toBe(false);
  });

  it("returns a sanitized deterministic protocol failure", async () => {
    harness = startHarness("failure");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    const response = await harness.request(3, "turn/start", {
      input: [{ text: "Fixture failure.", type: "text" }],
      threadId: "thread-fixture-1",
    });
    expect(response).toEqual({
      error: { code: -32_005, message: "Sanitized fixture protocol failure." },
      id: 3,
    });
    expect(JSON.stringify(response)).not.toMatch(/provider|token|authorization|stack/iu);
  });

  it("rejects interrupt when no matching turn is active", async () => {
    harness = startHarness("interrupt");
    await initializeHarness(harness);
    await startFixtureThread(harness);
    await expect(
      harness.request(3, "turn/interrupt", {
        threadId: "thread-fixture-1",
        turnId: "turn-fixture-1",
      }),
    ).resolves.toMatchObject({ error: { message: "No matching active fixture turn." } });
  });
});
