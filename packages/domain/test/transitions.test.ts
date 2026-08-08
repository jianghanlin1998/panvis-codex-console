import { describe, expect, it } from "vitest";

import { validateSubtaskTransition } from "../src/index.js";
import type { SubtaskStatus, SubtaskTransitionContext } from "../src/index.js";

const startReady = {
  dependenciesReady: true,
  repositoryPreflightPassed: true,
  contextPreflightPassed: true,
  concurrencyAvailable: true,
} as const;

const qaDoneReady = {
  requiredTestsPassed: true,
  noUnresolvedBlockingIssue: true,
  handoffPresent: true,
  promotedContextDispositionRecorded: true,
} as const;

describe("Subtask transition state machine", () => {
  it.each<[SubtaskStatus, SubtaskStatus, SubtaskTransitionContext]>([
    ["TODO", "IN_PROGRESS", startReady],
    ["IN_PROGRESS", "QA_DEBUG", { implementationCheckpointPresent: true }],
    ["QA_DEBUG", "IN_PROGRESS", {}],
    ["QA_DEBUG", "DONE", qaDoneReady],
    ["TODO", "DROPPED", {}],
    ["IN_PROGRESS", "DROPPED", {}],
    ["QA_DEBUG", "DROPPED", {}],
    ["DONE", "ARCHIVED", {}],
    ["DROPPED", "ARCHIVED", {}],
  ])("allows %s -> %s when prerequisites are satisfied", (from, to, context) => {
    expect(validateSubtaskTransition(from, to, context)).toEqual({
      allowed: true,
      reasons: [],
      missingPrerequisites: [],
      errorCodes: [],
    });
  });

  it("returns stable missing reasons for TODO -> IN_PROGRESS", () => {
    const result = validateSubtaskTransition("TODO", "IN_PROGRESS");

    expect(result.allowed).toBe(false);
    expect(result.errorCodes).toEqual([
      "MISSING_DEPENDENCIES_READY",
      "MISSING_REPOSITORY_PREFLIGHT_PASSED",
      "MISSING_CONTEXT_PREFLIGHT_PASSED",
      "MISSING_CONCURRENCY_AVAILABLE",
    ]);
  });

  it("returns a stable missing reason for IN_PROGRESS -> QA_DEBUG", () => {
    expect(validateSubtaskTransition("IN_PROGRESS", "QA_DEBUG").errorCodes).toEqual([
      "MISSING_IMPLEMENTATION_CHECKPOINT_PRESENT",
    ]);
  });

  it("returns stable missing reasons for QA_DEBUG -> DONE", () => {
    expect(validateSubtaskTransition("QA_DEBUG", "DONE").errorCodes).toEqual([
      "MISSING_REQUIRED_TESTS_PASSED",
      "MISSING_NO_UNRESOLVED_BLOCKING_ISSUE",
      "MISSING_HANDOFF_PRESENT",
      "MISSING_PROMOTED_CONTEXT_DISPOSITION_RECORDED",
    ]);
  });

  it.each<[SubtaskStatus, SubtaskStatus]>([
    ["TODO", "QA_DEBUG"],
    ["IN_PROGRESS", "TODO"],
    ["QA_DEBUG", "ARCHIVED"],
    ["DONE", "IN_PROGRESS"],
    ["DROPPED", "IN_PROGRESS"],
    ["ARCHIVED", "IN_PROGRESS"],
  ])("rejects a representative illegal transition from %s", (from, to) => {
    expect(validateSubtaskTransition(from, to).errorCodes).toEqual(["UNSUPPORTED_TRANSITION"]);
  });

  it("rejects IN_PROGRESS -> DONE", () => {
    expect(validateSubtaskTransition("IN_PROGRESS", "DONE").allowed).toBe(false);
  });

  it("rejects TODO -> DONE", () => {
    expect(validateSubtaskTransition("TODO", "DONE").allowed).toBe(false);
  });

  it("keeps terminal and archived behavior deterministic", () => {
    expect(validateSubtaskTransition("DONE", "ARCHIVED").allowed).toBe(true);
    expect(validateSubtaskTransition("DROPPED", "ARCHIVED").allowed).toBe(true);
    expect(validateSubtaskTransition("ARCHIVED", "ARCHIVED").allowed).toBe(false);
  });
});
