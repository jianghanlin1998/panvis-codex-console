import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject, MockAppServerHarness, MockScenario } from "../src/index.js";
import {
  MOCK_FIXTURE_PATH,
  initializeHarness,
  startFixtureThread,
  startHarness,
} from "./helpers.js";

let harness: MockAppServerHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function requestApproval(scenario: MockScenario): Promise<{
  readonly activeHarness: MockAppServerHarness;
  readonly request: JsonObject;
}> {
  const activeHarness = startHarness(scenario);
  harness = activeHarness;
  await initializeHarness(activeHarness);
  await startFixtureThread(activeHarness);
  await activeHarness.request(3, "turn/start", {
    input: [{ text: "Fixture approval.", type: "text" }],
    threadId: "thread-fixture-1",
  });
  const request = await activeHarness.waitForMessage(
    (message) => typeof message.method === "string" && message.method.endsWith("requestApproval"),
  );
  return { activeHarness, request };
}

describe("mock approval flows", () => {
  it("correlates command approval request, thread, turn, and item IDs", async () => {
    const { request } = await requestApproval("command-approval");
    expect(request).toMatchObject({
      id: "approval-command-fixture-1",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item-command-fixture-1",
        threadId: "thread-fixture-1",
        turnId: "turn-fixture-1",
      },
    });
  });

  it("completes an accepted command without executing it", async () => {
    const { activeHarness, request } = await requestApproval("command-approval");
    activeHarness.respond(request.id as string, { decision: "accept" });
    const completed = await activeHarness.waitForMessage(
      (message) =>
        message.method === "item/completed" &&
        ((message.params as JsonObject).item as JsonObject).type === "commandExecution",
    );
    expect(completed).toMatchObject({
      params: {
        item: {
          aggregatedOutput: null,
          command: "fixture-command --dry-run",
          exitCode: null,
          processId: null,
          status: "completed",
        },
      },
    });
  });

  it("completes a declined command as declined", async () => {
    const { activeHarness, request } = await requestApproval("command-approval");
    activeHarness.respond(request.id as string, { decision: "decline" });
    await expect(
      activeHarness.waitForMessage(
        (message) =>
          message.method === "item/completed" &&
          ((message.params as JsonObject).item as JsonObject).type === "commandExecution",
      ),
    ).resolves.toMatchObject({ params: { item: { status: "declined" } } });
  });

  it("emits serverRequest/resolved for the matching command approval", async () => {
    const { activeHarness, request } = await requestApproval("command-approval");
    activeHarness.respond(request.id as string, { decision: "accept" });
    await expect(
      activeHarness.waitForMessage(
        (message) => message.method === "serverRequest/resolved",
      ),
    ).resolves.toMatchObject({
      params: {
        requestId: "approval-command-fixture-1",
        threadId: "thread-fixture-1",
      },
    });
  });

  it("correlates the file-change approval flow", async () => {
    const { activeHarness, request } = await requestApproval("file-approval");
    expect(request).toMatchObject({
      id: "approval-file-fixture-1",
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "item-file-fixture-1",
        threadId: "thread-fixture-1",
        turnId: "turn-fixture-1",
      },
    });
    activeHarness.respond(request.id as string, { decision: "accept" });
    await expect(
      activeHarness.waitForMessage(
        (message) =>
          message.method === "item/completed" &&
          ((message.params as JsonObject).item as JsonObject).type === "fileChange",
      ),
    ).resolves.toMatchObject({ params: { item: { status: "completed" } } });
  });

  it("completes a declined file change as declined", async () => {
    const { activeHarness, request } = await requestApproval("file-approval");
    activeHarness.respond(request.id as string, { decision: "decline" });
    await expect(
      activeHarness.waitForMessage(
        (message) =>
          message.method === "item/completed" &&
          ((message.params as JsonObject).item as JsonObject).type === "fileChange",
      ),
    ).resolves.toMatchObject({ params: { item: { status: "declined" } } });
  });

  it("contains no file-writing or command-execution implementation", () => {
    const source = readFileSync(MOCK_FIXTURE_PATH, "utf8");
    expect(source).not.toMatch(/from ["']node:(?:child_process|net|http|https)["']/u);
    expect(source).not.toMatch(/\b(?:exec|execFile|spawn|writeFile|appendFile|createWriteStream)\s*\(/u);
  });
});
