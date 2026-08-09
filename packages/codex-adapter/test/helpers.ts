import { fileURLToPath } from "node:url";

import { MockAppServerHarness, type MockScenario } from "../src/index.js";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MOCK_FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/mock-app-server/mock-app-server.ts", import.meta.url),
);

export function startHarness(scenario: MockScenario, timeoutMs = 1_000): MockAppServerHarness {
  return MockAppServerHarness.start({
    fixturePath: MOCK_FIXTURE_PATH,
    scenario,
    timeoutMs,
  });
}

export async function initializeHarness(harness: MockAppServerHarness): Promise<void> {
  const response = await harness.request(1, "initialize", {
    clientInfo: { name: "fixture-client", title: "Fixture Client", version: "1.0.0" },
  });
  if (!("result" in response)) {
    throw new Error("Fixture initialization failed.");
  }
  harness.notify("initialized");
}

export async function startFixtureThread(harness: MockAppServerHarness): Promise<void> {
  const response = await harness.request(2, "thread/start");
  if (!("result" in response)) {
    throw new Error("Fixture thread start failed.");
  }
}
