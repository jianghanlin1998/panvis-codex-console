import { describe, expect, it } from "vitest";

import { deriveInitialWorkflowStage } from "../src/index.js";

describe("workflow initialization semantics", () => {
  it.each([
    ["LOW", "EXECUTE"],
    ["STANDARD", "MATERIALIZE"],
    ["HIGH_RISK_FOUNDATION", "MATERIALIZE"],
  ] as const)("derives %s initialization at %s", (profile, expected) => {
    expect(deriveInitialWorkflowStage(profile)).toBe(expected);
  });

  it("fails closed for an unknown runtime profile", () => {
    expect(deriveInitialWorkflowStage("UNKNOWN" as never)).toBeNull();
  });
});
