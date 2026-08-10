import { describe, expect, it } from "vitest";

import {
  validateSubtaskMaturityTransition,
} from "../src/index.js";
import type { SubtaskMaturity } from "../src/index.js";

describe("Subtask maturity transitions", () => {
  it.each<[SubtaskMaturity, SubtaskMaturity]>([
    ["NOT_STARTED", "IMPLEMENTED"],
    ["IMPLEMENTED", "HARDENED"],
    ["HARDENED", "ACCEPTED"],
  ])("allows adjacent forward transition %s -> %s", (from, to) => {
    expect(validateSubtaskMaturityTransition(from, to)).toEqual({
      allowed: true,
      errorCodes: [],
    });
  });

  it.each<[SubtaskMaturity, SubtaskMaturity]>([
    ["NOT_STARTED", "HARDENED"],
    ["NOT_STARTED", "ACCEPTED"],
    ["IMPLEMENTED", "ACCEPTED"],
    ["IMPLEMENTED", "NOT_STARTED"],
    ["HARDENED", "IMPLEMENTED"],
    ["ACCEPTED", "HARDENED"],
  ])("rejects skipped or demoting transition %s -> %s", (from, to) => {
    expect(validateSubtaskMaturityTransition(from, to)).toEqual({
      allowed: false,
      errorCodes: ["UNSUPPORTED_MATURITY_TRANSITION"],
    });
  });

  it.each<SubtaskMaturity>([
    "NOT_STARTED",
    "IMPLEMENTED",
    "HARDENED",
    "ACCEPTED",
  ])("rejects same-state transition from %s", (maturity) => {
    expect(validateSubtaskMaturityTransition(maturity, maturity).allowed).toBe(false);
  });

  it("keeps ACCEPTED terminal", () => {
    for (const maturity of [
      "NOT_STARTED",
      "IMPLEMENTED",
      "HARDENED",
      "ACCEPTED",
    ] as const) {
      expect(validateSubtaskMaturityTransition("ACCEPTED", maturity).allowed).toBe(false);
    }
  });
});
