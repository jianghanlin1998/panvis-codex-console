import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject, MockAppServerHarness } from "../src/index.js";
import { initializeHarness, startHarness, startFixtureThread } from "./helpers.js";

let harness: MockAppServerHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function runStreamingTurn(input: JsonObject[] = [{ text: "Fixture input.", type: "text" }]): Promise<MockAppServerHarness> {
  const activeHarness = startHarness("stream");
  harness = activeHarness;
  await initializeHarness(activeHarness);
  await startFixtureThread(activeHarness);
  await activeHarness.request(3, "turn/start", {
    input,
    threadId: "thread-fixture-1",
  });
  await activeHarness.waitForMessage((message) => message.method === "turn/completed");
  return activeHarness;
}

describe("mock turn streaming", () => {
  it("emits the deterministic event order", async () => {
    const activeHarness = await runStreamingTurn();
    expect(activeHarness.messages.map((message) => message.method)).toEqual([
      "thread/started",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/completed",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]);
  });

  it("assembles deltas to the completed agent message", async () => {
    const activeHarness = await runStreamingTurn();
    const deltas = activeHarness.messages
      .filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => (message.params as JsonObject).delta)
      .join("");
    const completed = activeHarness.messages.find(
      (message) =>
        message.method === "item/completed" &&
        ((message.params as JsonObject).item as JsonObject).type === "agentMessage",
    );
    expect(deltas).toBe("Deterministic fixture response.");
    expect(completed).toMatchObject({
      params: { item: { text: deltas, type: "agentMessage" } },
    });
  });

  it("treats item/completed as the authoritative final item", async () => {
    const activeHarness = await runStreamingTurn();
    const started = activeHarness.messages.find((message) => message.method === "item/started");
    const completed = activeHarness.messages.find(
      (message) => message.method === "item/completed",
    );
    expect(started).toMatchObject({ params: { item: { text: "" } } });
    expect(completed).toMatchObject({
      params: { item: { text: "Deterministic fixture response." } },
    });
  });

  it("emits deterministic token usage for later aggregation", async () => {
    const activeHarness = await runStreamingTurn();
    expect(
      activeHarness.messages.find(
        (message) => message.method === "thread/tokenUsage/updated",
      ),
    ).toMatchObject({
      params: {
        tokenUsage: {
          last: {
            cachedInputTokens: 20,
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
          },
          total: { totalTokens: 140 },
        },
      },
    });
  });

  it("emits turn/completed exactly once", async () => {
    const activeHarness = await runStreamingTurn();
    expect(
      activeHarness.messages.filter((message) => message.method === "turn/completed"),
    ).toHaveLength(1);
  });

  it("accepts an explicit skill input item without a live model", async () => {
    const activeHarness = await runStreamingTurn([
      { text: "$task-execution Execute the supplied Task Contract.", type: "text" },
      {
        name: "task-execution",
        path: "/fixture/workspace/.agents/skills/task-execution/SKILL.md",
        type: "skill",
      },
    ]);
    expect(activeHarness.messages.at(-1)).toMatchObject({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
  });
});
