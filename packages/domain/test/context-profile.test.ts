import { describe, expect, it } from "vitest";

import {
  BoundedRetestTargetSchema,
  QaContextCandidateClassSchema,
  QaContextProfileCandidateSchema,
  QaContextProfileKindSchema,
  evaluateQaContextProfileCandidate,
  narrowContextCandidatesForQa,
} from "../src/index.js";
import type {
  QaContextCandidateClass,
  QaContextProfileCandidate,
  QaContextProfileDecisionReason,
  QaContextProfileKind,
} from "../src/index.js";

const repairedSha = "a".repeat(40);
const validRetestTarget = {
  findingId: "CTC-S2C1-QA-001",
  violatedInvariant: "Included candidates must remain a subset of ACL-allowed input.",
  affectedContract: "S2C1 QA clean-context profile",
  repairedSha,
} as const;

const candidate = (candidateClass: QaContextCandidateClass, sourceReference = "task://s2c1") =>
  QaContextProfileCandidateSchema.parse(
    candidateClass === "BOUNDED_RETEST_TARGET"
      ? { candidateClass, sourceReference, retestTarget: validRetestTarget }
      : { candidateClass, sourceReference },
  );

const matrix = [
  ["CANONICAL_PROJECT_RULE", true, "INCLUDED_CANONICAL_EVIDENCE"],
  ["TASK_CONTRACT", true, "INCLUDED_CANONICAL_EVIDENCE"],
  ["ACCEPTANCE_CRITERIA", true, "INCLUDED_CANONICAL_EVIDENCE"],
  ["LOCKED_INVARIANT", true, "INCLUDED_CANONICAL_EVIDENCE"],
  ["REPO_RUNTIME_EVIDENCE", true, "INCLUDED_CANONICAL_EVIDENCE"],
  ["QA_INSTRUCTION", true, "INCLUDED_QA_INSTRUCTION"],
  ["BOUNDED_RETEST_TARGET", true, "INCLUDED_BOUNDED_RETEST_TARGET"],
  ["ACTIVE_CONTEXT_ITEM", false, "EXCLUDED_GENERIC_ACTIVE_CONTEXT"],
  ["DIGEST", false, "EXCLUDED_DIGEST"],
  ["PROMOTED_CONTEXT", false, "EXCLUDED_PROMOTED_CONTEXT"],
  ["RAW_HISTORY", false, "EXCLUDED_RAW_HISTORY"],
  ["PRIOR_RAW_CHAT", false, "EXCLUDED_PRIOR_RAW_CHAT"],
  ["PRIOR_REASONING", false, "EXCLUDED_PRIOR_REASONING"],
  ["PRIOR_HANDOFF", false, "EXCLUDED_PRIOR_HANDOFF"],
  ["PRIOR_SELF_ASSESSMENT", false, "EXCLUDED_PRIOR_SELF_ASSESSMENT"],
] as const satisfies readonly (readonly [
  QaContextCandidateClass,
  boolean,
  QaContextProfileDecisionReason,
])[];

describe.each([
  "FRESH_INDEPENDENT_QA",
  "FOCUSED_RE_QA",
] as const)("%s exact profile matrix", (profile) => {
  it.each(matrix)("evaluates %s without a default-allow branch", (candidateClass, included, reason) => {
    expect(evaluateQaContextProfileCandidate(profile, candidate(candidateClass))).toEqual({
      includedByProfile: included,
      reason,
    });
  });
});

describe("QA context profile closed schemas and fail-closed evaluation", () => {
  it("supports exactly the two approved profile kinds", () => {
    expect(QaContextProfileKindSchema.options).toEqual([
      "FRESH_INDEPENDENT_QA",
      "FOCUSED_RE_QA",
    ]);
    expect(QaContextProfileKindSchema.safeParse("BUILDER").success).toBe(false);
  });

  it("supports exactly the approved candidate-class vocabulary", () => {
    expect(QaContextCandidateClassSchema.options).toEqual(matrix.map(([value]) => value));
    expect(QaContextCandidateClassSchema.safeParse("FUTURE_CONTEXT").success).toBe(false);
  });

  it("distinguishes invalid profiles and candidates without throwing", () => {
    expect(
      evaluateQaContextProfileCandidate(
        "BUILDER" as QaContextProfileKind,
        candidate("TASK_CONTRACT"),
      ),
    ).toEqual({ includedByProfile: false, reason: "INVALID_PROFILE" });
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", {
        candidateClass: "FUTURE_CONTEXT",
        sourceReference: "future://1",
      } as unknown as QaContextProfileCandidate),
    ).toEqual({ includedByProfile: false, reason: "INVALID_CANDIDATE" });
  });

  it("rejects extra content-bearing descriptor fields", () => {
    for (const extra of ["body", "rawChat", "fullHandoff", "implementationNotes"]) {
      expect(
        QaContextProfileCandidateSchema.safeParse({
          candidateClass: "TASK_CONTRACT",
          sourceReference: "task://s2c1",
          [extra]: "excluded content",
        }).success,
      ).toBe(false);
    }
  });

  it("trims source references and enforces their compact bound", () => {
    expect(
      QaContextProfileCandidateSchema.parse({
        candidateClass: "QA_INSTRUCTION",
        sourceReference: "  qa://instruction  ",
      }).sourceReference,
    ).toBe("qa://instruction");
    expect(
      QaContextProfileCandidateSchema.safeParse({
        candidateClass: "QA_INSTRUCTION",
        sourceReference: "x".repeat(2_048),
      }).success,
    ).toBe(true);
    for (const sourceReference of [" ", "x".repeat(2_049)]) {
      expect(
        QaContextProfileCandidateSchema.safeParse({
          candidateClass: "QA_INSTRUCTION",
          sourceReference,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects ordinary accessor descriptors instead of invoking them", () => {
    let getterCalls = 0;
    const accessorCandidate = { candidateClass: "TASK_CONTRACT" } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorCandidate, "sourceReference", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "task://s2c1";
      },
    });

    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        accessorCandidate as unknown as QaContextProfileCandidate,
      ),
    ).toEqual({ includedByProfile: false, reason: "INVALID_CANDIDATE" });
    expect(getterCalls).toBe(0);
  });
});

describe("AllowedContextSet ceiling and pure narrowing", () => {
  const allCandidates = matrix.map(([candidateClass], index) =>
    candidate(candidateClass, `candidate://${index}`),
  );
  const arrays = [
    [],
    [allCandidates[0]!],
    allCandidates,
    [allCandidates[0]!, allCandidates[0]!, allCandidates[7]!, allCandidates[0]!],
    [allCandidates[7]!, allCandidates[1]!, allCandidates[13]!, allCandidates[6]!],
    [...allCandidates].reverse(),
  ] as const;

  it.each(arrays.map((input) => [input] as const))(
    "returns an exact ordered subset for candidate array %#",
    (input) => {
      const inputCandidates: readonly QaContextProfileCandidate[] = input;
      const snapshot = [...input];
      const result = narrowContextCandidatesForQa(
        "FRESH_INDEPENDENT_QA",
        inputCandidates,
      );
      const expectedIncluded = inputCandidates.filter((item) =>
        evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", item)
          .includedByProfile,
      );

      expect(result.includedCandidates).toEqual(expectedIncluded);
      expect(
        result.includedCandidates.every((item) => inputCandidates.includes(item)),
      ).toBe(true);
      expect(result.decisions.map(({ candidate: item }) => item)).toEqual(input);
      expect(input).toEqual(snapshot);
    },
  );

  it("preserves duplicate identity and performs no sorting or deduplication", () => {
    const first = candidate("TASK_CONTRACT", "task://first");
    const second = candidate("QA_INSTRUCTION", "qa://second");
    const input = [second, first, second, first] as const;
    const result = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);

    expect(result.includedCandidates).toEqual(input);
    expect(result.includedCandidates[0]).toBe(second);
    expect(result.includedCandidates[2]).toBe(second);
    expect(result.includedCandidates[1]).toBe(first);
    expect(result.includedCandidates[3]).toBe(first);
  });

  it("exposes ordered included and excluded provenance decisions", () => {
    const input = [
      candidate("TASK_CONTRACT"),
      candidate("PRIOR_REASONING"),
      candidate("QA_INSTRUCTION"),
      candidate("DIGEST"),
    ] as const;
    const result = narrowContextCandidatesForQa("FOCUSED_RE_QA", input);

    expect(result.includedCandidates).toEqual([input[0], input[2]]);
    expect(result.excludedCandidates).toEqual([input[1], input[3]]);
    expect(result.decisions.map(({ reason }) => reason)).toEqual([
      "INCLUDED_CANONICAL_EVIDENCE",
      "EXCLUDED_PRIOR_REASONING",
      "INCLUDED_QA_INSTRUCTION",
      "EXCLUDED_DIGEST",
    ]);
  });

  it("is deterministic, does not mutate inputs, and returns immutable result arrays", () => {
    const mutableCandidate = {
      candidateClass: "TASK_CONTRACT",
      sourceReference: "  task://s2c1  ",
    } as QaContextProfileCandidate;
    const input = [mutableCandidate];
    const before = structuredClone(input);

    const first = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);
    const second = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);
    expect(first).toEqual(second);
    expect(input).toEqual(before);
    expect(mutableCandidate.sourceReference).toBe("  task://s2c1  ");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.includedCandidates)).toBe(true);
    expect(Object.isFrozen(first.decisions)).toBe(true);
  });

  it("fails closed for a malformed supplied candidate without affecting valid neighbors", () => {
    const valid = candidate("QA_INSTRUCTION");
    const invalid = {
      candidateClass: "TASK_CONTRACT",
      sourceReference: "task://s2c1",
      rawChat: "must not be exposed",
    } as unknown as QaContextProfileCandidate;
    const result = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", [valid, invalid]);

    expect(result.includedCandidates).toEqual([valid]);
    expect(result.excludedCandidates).toEqual([invalid]);
    expect(result.decisions[1]).toMatchObject({
      includedByProfile: false,
      reason: "INVALID_CANDIDATE",
    });
  });
});

describe("Fresh Independent QA bias controls", () => {
  it.each(["HUMAN", "ACCEPTED", "builder", "hardening", "important", "final", "PASS"])(
    "excludes generic ACTIVE_CONTEXT_ITEM even when source metadata says %s",
    (sourceReference) => {
      expect(
        evaluateQaContextProfileCandidate(
          "FRESH_INDEPENDENT_QA",
          candidate("ACTIVE_CONTEXT_ITEM", sourceReference),
        ),
      ).toEqual({
        includedByProfile: false,
        reason: "EXCLUDED_GENERIC_ACTIVE_CONTEXT",
      });
    },
  );

  it.each([
    "CANONICAL_PROJECT_RULE",
    "TASK_CONTRACT",
    "ACCEPTANCE_CRITERIA",
    "LOCKED_INVARIANT",
    "REPO_RUNTIME_EVIDENCE",
  ] as const)("includes canonical evidence class %s as profile eligibility only", (candidateClass) => {
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", candidate(candidateClass)),
    ).toEqual({ includedByProfile: true, reason: "INCLUDED_CANONICAL_EVIDENCE" });
  });

  it.each([
    ["QA_INSTRUCTION", "INCLUDED_QA_INSTRUCTION"],
    ["BOUNDED_RETEST_TARGET", "INCLUDED_BOUNDED_RETEST_TARGET"],
  ] as const)("includes %s with its stable reason", (candidateClass, reason) => {
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", candidate(candidateClass)),
    ).toEqual({ includedByProfile: true, reason });
  });
});

describe("bounded factual retest target", () => {
  it("accepts and trims only the four approved factual fields", () => {
    expect(
      BoundedRetestTargetSchema.parse({
        findingId: "  finding-1  ",
        violatedInvariant: "  subset invariant  ",
        affectedContract: "  S2C1  ",
        repairedSha,
      }),
    ).toEqual({
      findingId: "finding-1",
      violatedInvariant: "subset invariant",
      affectedContract: "S2C1",
      repairedSha,
    });
  });

  it("enforces exact compact field bounds without truncation", () => {
    expect(
      BoundedRetestTargetSchema.safeParse({
        findingId: "x".repeat(128),
        violatedInvariant: "x".repeat(1_000),
        affectedContract: "x".repeat(256),
        repairedSha,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { findingId: " " },
      { findingId: "x".repeat(129) },
      { violatedInvariant: "\t" },
      { violatedInvariant: "x".repeat(1_001) },
      { affectedContract: "\n" },
      { affectedContract: "x".repeat(257) },
    ]) {
      expect(
        BoundedRetestTargetSchema.safeParse({ ...validRetestTarget, ...invalid }).success,
      ).toBe(false);
    }
  });

  it.each([
    "reproductionStrategy",
    "repairReasoning",
    "priorPassJudgment",
    "fullHandoff",
    "rawChat",
    "chainOfThought",
    "implementationNotes",
  ])("rejects the extra field %s", (extraField) => {
    expect(
      BoundedRetestTargetSchema.safeParse({
        ...validRetestTarget,
        [extraField]: "excluded material",
      }).success,
    ).toBe(false);
  });

  it.each([
    "a".repeat(39),
    "a".repeat(41),
    "A".repeat(40),
    ` ${"a".repeat(40)}`,
    "not-a-sha",
  ])("rejects invalid repaired SHA %#", (invalidSha) => {
    expect(
      BoundedRetestTargetSchema.safeParse({
        ...validRetestTarget,
        repairedSha: invalidSha,
      }).success,
    ).toBe(false);
  });

  it("requires retest metadata only for BOUNDED_RETEST_TARGET", () => {
    expect(
      QaContextProfileCandidateSchema.safeParse({
        candidateClass: "BOUNDED_RETEST_TARGET",
        sourceReference: "finding://1",
      }).success,
    ).toBe(false);
    expect(
      QaContextProfileCandidateSchema.safeParse({
        candidateClass: "TASK_CONTRACT",
        sourceReference: "task://s2c1",
        retestTarget: validRetestTarget,
      }).success,
    ).toBe(false);
  });
});

describe("Focused re-QA clean repair boundary", () => {
  it("keeps the bounded factual target eligible", () => {
    expect(
      evaluateQaContextProfileCandidate("FOCUSED_RE_QA", candidate("BOUNDED_RETEST_TARGET")),
    ).toEqual({ includedByProfile: true, reason: "INCLUDED_BOUNDED_RETEST_TARGET" });
  });

  it.each([
    ["PRIOR_RAW_CHAT", "EXCLUDED_PRIOR_RAW_CHAT"],
    ["PRIOR_REASONING", "EXCLUDED_PRIOR_REASONING"],
    ["PRIOR_HANDOFF", "EXCLUDED_PRIOR_HANDOFF"],
    ["PRIOR_SELF_ASSESSMENT", "EXCLUDED_PRIOR_SELF_ASSESSMENT"],
  ] as const)("excludes repair material class %s", (candidateClass, reason) => {
    expect(
      evaluateQaContextProfileCandidate(
        "FOCUSED_RE_QA",
        candidate(candidateClass, "repair://important-pass"),
      ),
    ).toEqual({ includedByProfile: false, reason });
  });
});
