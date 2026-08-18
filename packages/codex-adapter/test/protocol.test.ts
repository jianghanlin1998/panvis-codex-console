import { describe, expect, it } from "vitest";

import {
  EXCLUDED_EXPERIMENTAL_CAPABILITIES,
  S0C_PROTOCOL_COMPATIBILITY,
  SUPPORTED_CLIENT_REQUEST_METHODS,
  SUPPORTED_SERVER_NOTIFICATION_METHODS,
  SUPPORTED_SERVER_REQUEST_METHODS,
  TESTED_CODEX_VERSION,
  assessCodexCompatibility,
} from "../src/index.js";

describe("S0C protocol compatibility", () => {
  it("contains exactly the approved client request subset", () => {
    expect(SUPPORTED_CLIENT_REQUEST_METHODS).toEqual([
      "initialize",
      "thread/start",
      "thread/resume",
      "turn/start",
      "turn/interrupt",
      "thread/goal/set",
      "thread/goal/get",
      "skills/list",
    ]);
  });

  it("contains the approved lifecycle, usage, and approval surfaces", () => {
    expect(SUPPORTED_SERVER_NOTIFICATION_METHODS).toContain("item/agentMessage/delta");
    expect(SUPPORTED_SERVER_NOTIFICATION_METHODS).toContain("thread/tokenUsage/updated");
    expect(SUPPORTED_SERVER_REQUEST_METHODS).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]);
  });

  it("excludes experimental capabilities from the covered methods", () => {
    const covered = S0C_PROTOCOL_COMPATIBILITY.stableMethodsCovered.join(" ");
    for (const capability of EXCLUDED_EXPERIMENTAL_CAPABILITIES) {
      expect(covered).not.toContain(capability);
    }
    expect(covered).not.toContain("dynamicTools");
    expect(covered).not.toContain("process/spawn");
  });

  it("records only the installed Codex version validated by S0C", () => {
    expect(TESTED_CODEX_VERSION).toBe("codex-cli 0.148.0-alpha.9");
    expect(S0C_PROTOCOL_COMPATIBILITY).toMatchObject({
      checkedOn: "2026-08-18",
      codexVersion: TESTED_CODEX_VERSION,
      fixtureVersion: "1.1.0",
    });
  });

  it("accepts the exact tested version", () => {
    expect(assessCodexCompatibility(TESTED_CODEX_VERSION)).toEqual({
      compatible: true,
      requiresRevalidation: false,
      status: "tested",
    });
  });

  it.each([
    "codex-cli 0.147.0-alpha.6.5",
    "codex-cli 0.148.0-alpha.8",
    "codex-cli 0.148.0-alpha.9.1",
    "codex-cli 0.148.0",
  ])("fails closed for untested version %s", (version) => {
    expect(assessCodexCompatibility(version)).toEqual({
      compatible: false,
      requiresRevalidation: true,
      status: "unknown-incompatible",
    });
  });
});
