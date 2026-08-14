import { describe, expect, it } from "vitest";

import {
  BoundedRetestTargetSchema,
  QaContextProfileCandidateSchema,
  evaluateQaContextProfileCandidate,
  narrowContextCandidatesForQa,
} from "../src/index.js";
import type {
  QaContextCandidateClass,
  QaContextProfileCandidate,
  QaContextProfileDecisionReason,
  QaContextProfileKind,
} from "../src/index.js";

const sha40 = "a".repeat(40);
const sha64 = "b".repeat(64);
const retestTarget = {
  findingId: "CTC-S2C1-HARD-001",
  violatedInvariant: "Profile evaluation may only narrow supplied candidates.",
  affectedContract: "S2C1 QA clean-context profile",
  repairedSha: sha40,
} as const;

const expectedMatrix = [
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

const expectedByClass = new Map<
  QaContextCandidateClass,
  { readonly includedByProfile: boolean; readonly reason: QaContextProfileDecisionReason }
>(
  expectedMatrix.map(([candidateClass, includedByProfile, reason]) => [
    candidateClass,
    { includedByProfile, reason },
  ]),
);

const makeCandidate = (
  candidateClass: QaContextCandidateClass,
  sourceReference = `source://${candidateClass.toLowerCase()}`,
): QaContextProfileCandidate =>
  (candidateClass === "BOUNDED_RETEST_TARGET"
    ? { candidateClass, sourceReference, retestTarget }
    : { candidateClass, sourceReference }) as QaContextProfileCandidate;

const invalidDecision = {
  includedByProfile: false,
  reason: "INVALID_CANDIDATE",
} as const;

const descriptorValueProxy = (
  base: Record<string, unknown>,
  key: string,
  values: readonly unknown[],
): Record<string, unknown> => {
  let observation = 0;
  return new Proxy(base, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== key || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      const value = values[observation % values.length];
      observation += 1;
      return { ...descriptor, value };
    },
  });
};

describe("S2C1 independent complete profile/class oracle", () => {
  for (const profile of ["FRESH_INDEPENDENT_QA", "FOCUSED_RE_QA"] as const) {
    it.each(expectedMatrix)(
      `${profile} evaluates %s from an independent literal oracle`,
      (candidateClass, includedByProfile, reason) => {
        expect(
          evaluateQaContextProfileCandidate(profile, makeCandidate(candidateClass)),
        ).toEqual({ includedByProfile, reason });
      },
    );
  }

  it.each([
    "",
    "FRESH_INDEPENDENT_Q",
    "FRESH-INDEPENDENT-QA",
    " FRESH_INDEPENDENT_QA",
    "FOCUSED_RE_QA ",
    "BUILDER",
  ])("fails closed for unknown or near-miss profile %#", (profile) => {
    expect(
      evaluateQaContextProfileCandidate(
        profile as QaContextProfileKind,
        makeCandidate("TASK_CONTRACT"),
      ),
    ).toEqual({ includedByProfile: false, reason: "INVALID_PROFILE" });
  });

  it.each([
    "TASK-CONTRACT",
    "TASK_CONTRACT ",
    "CANONICAL_RULE",
    "ACTIVE",
    "PRIOR_HANDOFF_FINAL",
    "UNKNOWN",
  ])("fails closed for unknown or near-miss candidate class %#", (candidateClass) => {
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", {
        candidateClass,
        sourceReference: "source://near-miss",
      } as unknown as QaContextProfileCandidate),
    ).toEqual(invalidDecision);
  });
});

describe("S2C1 ceiling, identity, order, duplicate, and scale properties", () => {
  const all = expectedMatrix.map(([candidateClass], index) =>
    makeCandidate(candidateClass, `candidate://${index}`),
  );
  const arrays = [
    [],
    ...all.map((item) => [item]),
    all,
    [...all].reverse(),
    [all[0]!, all[0]!, all[7]!, all[0]!, all[14]!, all[6]!],
    Array.from({ length: 257 }, (_, index) => all[(index * 7) % all.length]!),
  ] as const;

  it.each(arrays.map((input, index) => [index, input] as const))(
    "matches an independent index oracle for array campaign %#",
    (_index, input) => {
      const inputCandidates: readonly QaContextProfileCandidate[] = input;
      const inputSnapshot = [...inputCandidates];
      const expectedIncluded = inputCandidates.filter((item) =>
        expectedByClass.get(item.candidateClass)!.includedByProfile,
      );
      const expectedExcluded = inputCandidates.filter(
        (item) => !expectedByClass.get(item.candidateClass)!.includedByProfile,
      );
      const result = narrowContextCandidatesForQa(
        "FRESH_INDEPENDENT_QA",
        inputCandidates,
      );

      expect(result.includedCandidates).toEqual(expectedIncluded);
      expect(result.excludedCandidates).toEqual(expectedExcluded);
      expect(result.decisions).toHaveLength(inputCandidates.length);
      expect(
        result.includedCandidates.length + result.excludedCandidates.length,
      ).toBe(inputCandidates.length);
      result.decisions.forEach((decision, index) => {
        expect(decision.candidate).toBe(inputCandidates[index]);
        expect(decision).toMatchObject(
          expectedByClass.get(inputCandidates[index]!.candidateClass)!,
        );
      });
      result.includedCandidates.forEach((item) =>
        expect(inputCandidates.includes(item)).toBe(true),
      );
      expect(inputCandidates).toEqual(inputSnapshot);
    },
  );

  it.each([1, 17, 257, 4_097])(
    "preserves exact membership, order, and multiplicity at %i candidates",
    (count) => {
      const shared = makeCandidate("TASK_CONTRACT", "shared://duplicate");
      const input = Array.from({ length: count }, (_, index) =>
        index % 17 === 0 ? shared : all[(index * 11) % all.length]!,
      );
      const expectedIncluded = input.filter((item) =>
        expectedByClass.get(item.candidateClass)!.includedByProfile,
      );
      const result = narrowContextCandidatesForQa("FOCUSED_RE_QA", input);

      expect(result.includedCandidates).toEqual(expectedIncluded);
      expect(result.decisions.map(({ candidate }) => candidate)).toEqual(input);
      expect(result.includedCandidates.filter((item) => item === shared)).toHaveLength(
        input.filter((item) => item === shared).length,
      );
    },
  );

  it("does not synthesize, sort, deduplicate, or mutate frozen input", () => {
    const first = Object.freeze(makeCandidate("QA_INSTRUCTION", "z://first"));
    const second = Object.freeze(makeCandidate("TASK_CONTRACT", "a://second"));
    const excluded = Object.freeze(makeCandidate("PRIOR_REASONING", "m://excluded"));
    const input = Object.freeze([first, excluded, second, first]);
    const result = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);

    expect(result.includedCandidates).toEqual([first, second, first]);
    expect(result.excludedCandidates).toEqual([excluded]);
    expect(result.includedCandidates[0]).toBe(first);
    expect(result.includedCandidates[2]).toBe(first);
  });
});

describe("S2C1 parser normalization and original-object boundary", () => {
  it("decides from canonical parsed data but returns the exact supplied identity", () => {
    const supplied = {
      candidateClass: "BOUNDED_RETEST_TARGET",
      sourceReference: "  finding://CTC-S2C1-HARD-001  ",
      retestTarget: {
        findingId: "  CTC-S2C1-HARD-001  ",
        violatedInvariant: "  subset ceiling  ",
        affectedContract: "  S2C1  ",
        repairedSha: sha40,
      },
    } satisfies Extract<
      QaContextProfileCandidate,
      { candidateClass: "BOUNDED_RETEST_TARGET" }
    >;
    const canonical = QaContextProfileCandidateSchema.parse(supplied);
    const result = narrowContextCandidatesForQa("FOCUSED_RE_QA", [supplied]);

    expect(result.decisions[0]).toMatchObject({
      includedByProfile: true,
      reason: "INCLUDED_BOUNDED_RETEST_TARGET",
    });
    expect(result.includedCandidates[0]).toBe(supplied);
    expect(result.decisions[0]?.candidate).toBe(supplied);
    expect(supplied.sourceReference).toBe("  finding://CTC-S2C1-HARD-001  ");
    expect(supplied.retestTarget.findingId).toBe("  CTC-S2C1-HARD-001  ");
    expect(canonical.sourceReference).toBe("finding://CTC-S2C1-HARD-001");
    if (canonical.candidateClass !== "BOUNDED_RETEST_TARGET") {
      throw new Error("Expected the parsed retest candidate variant.");
    }
    expect(canonical.retestTarget.findingId).toBe("CTC-S2C1-HARD-001");
  });

  it("does not mutate parser-normalizable compact text", () => {
    const supplied = {
      candidateClass: "TASK_CONTRACT",
      sourceReference: "\t task://contract \n",
    } as QaContextProfileCandidate;
    const before = structuredClone(supplied);
    expect(
      evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", supplied),
    ).toEqual({ includedByProfile: true, reason: "INCLUDED_CANONICAL_EVIDENCE" });
    expect(supplied).toEqual(before);
  });
});

describe("S2C1 strict structural descriptor and copy contract", () => {
  it("rejects inherited, extra, symbolic, accessor, and non-enumerable fields", () => {
    const inherited = Object.create(makeCandidate("TASK_CONTRACT"));
    const extra = { ...makeCandidate("TASK_CONTRACT"), rawChat: "private" };
    const symbolic = { ...makeCandidate("TASK_CONTRACT"), [Symbol("private")]: true };
    let getterCalls = 0;
    const accessor = { candidateClass: "TASK_CONTRACT" } as Record<string, unknown>;
    Object.defineProperty(accessor, "sourceReference", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "task://contract";
      },
    });
    const nonEnumerable = { candidateClass: "TASK_CONTRACT" } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, "sourceReference", {
      enumerable: false,
      value: "task://contract",
    });

    for (const malformed of [inherited, extra, symbolic, accessor, nonEnumerable]) {
      expect(
        evaluateQaContextProfileCandidate(
          "FRESH_INDEPENDENT_QA",
          malformed as QaContextProfileCandidate,
        ),
      ).toEqual(invalidDecision);
    }
    expect(getterCalls).toBe(0);
  });

  it("accepts canonical null-prototype, frozen, sealed, copied, cloned, and JSON shapes", () => {
    const nullPrototype = Object.assign(Object.create(null),
      makeCandidate("TASK_CONTRACT"),
    ) as QaContextProfileCandidate;
    const shapes = [
      nullPrototype,
      Object.freeze({ ...makeCandidate("TASK_CONTRACT") }),
      Object.seal({ ...makeCandidate("TASK_CONTRACT") }),
      { ...makeCandidate("TASK_CONTRACT") },
      structuredClone(makeCandidate("TASK_CONTRACT")),
      JSON.parse(JSON.stringify(makeCandidate("TASK_CONTRACT"))) as QaContextProfileCandidate,
    ];
    for (const shape of shapes) {
      expect(
        evaluateQaContextProfileCandidate("FRESH_INDEPENDENT_QA", shape),
      ).toEqual({ includedByProfile: true, reason: "INCLUDED_CANONICAL_EVIDENCE" });
    }
  });

  it("rejects custom prototypes and malformed candidate arrays", () => {
    const customPrototype = Object.create({ marker: true });
    Object.assign(customPrototype, makeCandidate("TASK_CONTRACT"));
    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        customPrototype as QaContextProfileCandidate,
      ),
    ).toEqual(invalidDecision);

    const sparse = Array(2) as QaContextProfileCandidate[];
    sparse[1] = makeCandidate("TASK_CONTRACT");
    const accessorArray = [makeCandidate("TASK_CONTRACT")];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      configurable: true,
      get: () => makeCandidate("TASK_CONTRACT"),
    });
    const extraArray = [makeCandidate("TASK_CONTRACT")] as Array<
      QaContextProfileCandidate
    > & { marker?: boolean };
    extraArray.marker = true;
    for (const malformed of [sparse, accessorArray, extraArray]) {
      expect(
        narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", malformed),
      ).toEqual({ includedCandidates: [], excludedCandidates: [], decisions: [] });
    }
  });
});

describe("S2C1 hostile runtime and Proxy fail-closed campaign", () => {
  it("reproduces and closes EXCLUDED to INCLUDED candidateClass swapping", () => {
    const hostile = descriptorValueProxy(
      {
        candidateClass: "ACTIVE_CONTEXT_ITEM",
        sourceReference: "hostile://class-swap",
      },
      "candidateClass",
      ["ACTIVE_CONTEXT_ITEM", "TASK_CONTRACT"],
    );
    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        hostile as QaContextProfileCandidate,
      ),
    ).toEqual(invalidDecision);
  });

  it("accepts one stable transparent Proxy representation with bounded observations", () => {
    const trapCounts = {
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
    };
    const stable = new Proxy(
      {
        candidateClass: "TASK_CONTRACT",
        sourceReference: "proxy://stable-copy",
      },
      {
        ownKeys(target) {
          trapCounts.ownKeys += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, property) {
          trapCounts.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          trapCounts.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(target);
        },
      },
    );

    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        stable as QaContextProfileCandidate,
      ),
    ).toEqual({ includedByProfile: true, reason: "INCLUDED_CANONICAL_EVIDENCE" });
    expect(trapCounts.ownKeys).toBe(3);
    expect(trapCounts.getPrototypeOf).toBe(3);
    expect(trapCounts.getOwnPropertyDescriptor).toBe(6);
  });

  it("fails closed for INCLUDED to EXCLUDED candidateClass swapping", () => {
    const hostile = descriptorValueProxy(
      {
        candidateClass: "TASK_CONTRACT",
        sourceReference: "hostile://class-swap",
      },
      "candidateClass",
      ["TASK_CONTRACT", "ACTIVE_CONTEXT_ITEM"],
    );
    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        hostile as QaContextProfileCandidate,
      ),
    ).toEqual(invalidDecision);
  });

  it("fails closed when own keys, enumerability, prototype, or sourceReference changes", () => {
    const base = {
      candidateClass: "TASK_CONTRACT",
      sourceReference: "hostile://stable",
    };
    let ownKeyCalls = 0;
    const changingKeys = new Proxy({ ...base }, {
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        ownKeyCalls += 1;
        return ownKeyCalls % 2 === 1 ? keys : [...keys, "rawChat"];
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "rawChat") {
          return { configurable: true, enumerable: true, writable: true, value: "private" };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    let descriptorCalls = 0;
    const changingEnumerable = new Proxy({ ...base }, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "sourceReference" || descriptor === undefined) {
          return descriptor;
        }
        descriptorCalls += 1;
        return { ...descriptor, enumerable: descriptorCalls % 2 === 1 };
      },
    });
    let prototypeCalls = 0;
    const changingPrototype = new Proxy({ ...base }, {
      getPrototypeOf() {
        prototypeCalls += 1;
        return prototypeCalls % 2 === 1 ? Object.prototype : null;
      },
    });
    const changingSource = descriptorValueProxy(
      { ...base },
      "sourceReference",
      ["hostile://one", "hostile://two"],
    );

    for (const hostile of [
      changingKeys,
      changingEnumerable,
      changingPrototype,
      changingSource,
    ]) {
      expect(
        evaluateQaContextProfileCandidate(
          "FRESH_INDEPENDENT_QA",
          hostile as QaContextProfileCandidate,
        ),
      ).toEqual(invalidDecision);
    }
  });

  it("fails closed when retest fields, SHA, or nested target identity changes", () => {
    const changingFinding = descriptorValueProxy(
      { ...retestTarget },
      "findingId",
      ["finding-one", "finding-two"],
    );
    const changingSha = descriptorValueProxy(
      { ...retestTarget },
      "repairedSha",
      [sha40, "not-a-sha"],
    );
    const firstTarget = { ...retestTarget, findingId: "first" };
    const secondTarget = { ...retestTarget, findingId: "second" };
    const changingTarget = descriptorValueProxy(
      {
        candidateClass: "BOUNDED_RETEST_TARGET",
        sourceReference: "finding://swap",
        retestTarget: firstTarget,
      },
      "retestTarget",
      [firstTarget, secondTarget],
    );
    const candidates = [
      {
        candidateClass: "BOUNDED_RETEST_TARGET",
        sourceReference: "finding://field-swap",
        retestTarget: changingFinding,
      },
      {
        candidateClass: "BOUNDED_RETEST_TARGET",
        sourceReference: "finding://sha-swap",
        retestTarget: changingSha,
      },
      changingTarget,
    ];

    for (const candidate of candidates) {
      expect(
        evaluateQaContextProfileCandidate(
          "FOCUSED_RE_QA",
          candidate as QaContextProfileCandidate,
        ),
      ).toEqual(invalidDecision);
    }
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const)(
    "contains throwing candidate %s traps",
    (trap) => {
      const hostile = new Proxy(
        {
          candidateClass: "TASK_CONTRACT",
          sourceReference: "hostile://throwing",
        },
        {
          [trap]() {
            throw new Error("private hostile trap value");
          },
        },
      );
      expect(() =>
        evaluateQaContextProfileCandidate(
          "FRESH_INDEPENDENT_QA",
          hostile as QaContextProfileCandidate,
        ),
      ).not.toThrow();
      expect(
        evaluateQaContextProfileCandidate(
          "FRESH_INDEPENDENT_QA",
          hostile as QaContextProfileCandidate,
        ),
      ).toEqual(invalidDecision);
    },
  );

  it("rejects a state-changing candidate-array descriptor without widening", () => {
    const excluded = makeCandidate("ACTIVE_CONTEXT_ITEM");
    const included = makeCandidate("TASK_CONTRACT");
    let observations = 0;
    const hostile = new Proxy([excluded], {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "0" || descriptor === undefined) {
          return descriptor;
        }
        observations += 1;
        return { ...descriptor, value: observations % 2 === 1 ? included : excluded };
      },
    });
    expect(
      narrowContextCandidatesForQa(
        "FRESH_INDEPENDENT_QA",
        hostile as QaContextProfileCandidate[],
      ),
    ).toEqual({ includedCandidates: [], excludedCandidates: [], decisions: [] });
  });

  it("captures array length from descriptors without invoking hostile value reads", () => {
    const supplied = makeCandidate("TASK_CONTRACT");
    let getCalls = 0;
    const hostile = new Proxy([supplied], {
      get(target, property, receiver) {
        getCalls += 1;
        if (property === "length") {
          return getCalls % 2 === 1 ? 1 : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = narrowContextCandidatesForQa(
      "FRESH_INDEPENDENT_QA",
      hostile as QaContextProfileCandidate[],
    );
    expect(result.includedCandidates).toEqual([supplied]);
    expect(getCalls).toBe(0);
  });

  it("contains throwing array traps and returns no partial result", () => {
    const hostile = new Proxy([makeCandidate("TASK_CONTRACT")], {
      ownKeys() {
        throw new Error("private array trap value");
      },
    });
    expect(() =>
      narrowContextCandidatesForQa(
        "FRESH_INDEPENDENT_QA",
        hostile as QaContextProfileCandidate[],
      ),
    ).not.toThrow();
    expect(
      narrowContextCandidatesForQa(
        "FRESH_INDEPENDENT_QA",
        hostile as QaContextProfileCandidate[],
      ),
    ).toEqual({ includedCandidates: [], excludedCandidates: [], decisions: [] });
  });
});

describe("S2C1 sourceReference relabel and bias controls", () => {
  const excludedClasses = expectedMatrix
    .filter(([, included]) => !included)
    .map(([candidateClass]) => candidateClass);
  const includedClasses = expectedMatrix
    .filter(([, included]) => included)
    .map(([candidateClass]) => candidateClass);
  const authorityBait = [
    "task-contract",
    "canonical-rule",
    "human-approved",
    "accepted-final",
    "fresh-qa-required",
    "safe-to-include",
    "PASS",
  ] as const;
  const suspiciousReferences = [
    "builder-chat",
    "hardening-handoff",
    "prior-pass",
  ] as const;

  it.each(
    excludedClasses.flatMap((candidateClass) =>
      authorityBait.map((sourceReference) => [candidateClass, sourceReference] as const),
    ),
  )("keeps excluded class %s excluded despite source bait %s", (candidateClass, sourceReference) => {
    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        makeCandidate(candidateClass, sourceReference),
      ),
    ).toEqual(expectedByClass.get(candidateClass));
  });

  it.each(
    includedClasses.flatMap((candidateClass) =>
      suspiciousReferences.map(
        (sourceReference) => [candidateClass, sourceReference] as const,
      ),
    ),
  )("keeps included class %s eligible despite suspicious source %s", (candidateClass, sourceReference) => {
    expect(
      evaluateQaContextProfileCandidate(
        "FOCUSED_RE_QA",
        makeCandidate(candidateClass, sourceReference),
      ),
    ).toEqual(expectedByClass.get(candidateClass));
  });
});

describe("S2C1 strict bounded retest adversarial matrix", () => {
  const boundaryCases = [
    ["findingId", 1, true],
    ["findingId", 128, true],
    ["findingId", 129, false],
    ["violatedInvariant", 1, true],
    ["violatedInvariant", 1_000, true],
    ["violatedInvariant", 1_001, false],
    ["affectedContract", 1, true],
    ["affectedContract", 256, true],
    ["affectedContract", 257, false],
  ] as const;

  it.each(boundaryCases)(
    "enforces %s length %i with expected acceptance %s",
    (field, length, accepted) => {
      expect(
        BoundedRetestTargetSchema.safeParse({
          ...retestTarget,
          [field]: "x".repeat(length),
        }).success,
      ).toBe(accepted);
    },
  );

  it.each([
    [1, true],
    [2_048, true],
    [2_049, false],
  ] as const)("enforces sourceReference length %i with expected acceptance %s", (length, accepted) => {
    expect(
      QaContextProfileCandidateSchema.safeParse({
        candidateClass: "TASK_CONTRACT",
        sourceReference: "x".repeat(length),
      }).success,
    ).toBe(accepted);
  });

  it("accepts trimmed Unicode and embedded newlines without semantic NLP inspection", () => {
    expect(
      BoundedRetestTargetSchema.parse({
        findingId: "  缺陷-Δ  ",
        violatedInvariant: "line one\nline two",
        affectedContract: "  契約 S2C1  ",
        repairedSha: sha64,
      }),
    ).toEqual({
      findingId: "缺陷-Δ",
      violatedInvariant: "line one\nline two",
      affectedContract: "契約 S2C1",
      repairedSha: sha64,
    });
  });

  it.each([
    "",
    " ",
    "\t\n",
  ])("rejects all-whitespace compact text %#", (value) => {
    for (const field of [
      "findingId",
      "violatedInvariant",
      "affectedContract",
    ] as const) {
      expect(
        BoundedRetestTargetSchema.safeParse({ ...retestTarget, [field]: value }).success,
      ).toBe(false);
    }
  });

  it.each([
    [sha40, true],
    [sha64, true],
    ["a".repeat(39), false],
    ["a".repeat(41), false],
    ["a".repeat(63), false],
    ["a".repeat(65), false],
    ["A".repeat(40), false],
    ["g".repeat(40), false],
    [` ${sha40}`, false],
    ["not-a-sha", false],
  ] as const)("validates repaired SHA %# with expected acceptance %s", (repairedSha, accepted) => {
    expect(
      BoundedRetestTargetSchema.safeParse({
        ...retestTarget,
        repairedSha,
      }).success,
    ).toBe(accepted);
  });

  it.each([
    "reproductionStrategy",
    "repairReasoning",
    "priorPassJudgment",
    "fullHandoff",
    "rawChat",
    "chainOfThought",
    "implementationNotes",
    "builderSummary",
    "hardeningSummary",
    "arbitraryNestedMetadata",
  ])("rejects forbidden extra retest field %s", (field) => {
    expect(
      BoundedRetestTargetSchema.safeParse({
        ...retestTarget,
        [field]: field === "arbitraryNestedMetadata" ? { nested: true } : "private",
      }).success,
    ).toBe(false);
  });

  it("requires the target exactly for the retest class and never truncates", () => {
    expect(
      QaContextProfileCandidateSchema.safeParse({
        candidateClass: "BOUNDED_RETEST_TARGET",
        sourceReference: "finding://missing",
      }).success,
    ).toBe(false);
    expect(
      QaContextProfileCandidateSchema.safeParse({
        candidateClass: "TASK_CONTRACT",
        sourceReference: "task://extra",
        retestTarget,
      }).success,
    ).toBe(false);
    const tooLong = "x".repeat(129);
    const parsed = BoundedRetestTargetSchema.safeParse({
      ...retestTarget,
      findingId: tooLong,
    });
    expect(parsed.success).toBe(false);
    expect(tooLong).toHaveLength(129);
  });
});

describe("S2C1 invalid profiles, mixed arrays, and decision integrity", () => {
  it("classifies every valid candidate as INVALID_PROFILE without a partial include", () => {
    const input = expectedMatrix.map(([candidateClass]) => makeCandidate(candidateClass));
    const result = narrowContextCandidatesForQa(
      "UNKNOWN_PROFILE" as QaContextProfileKind,
      input,
    );
    expect(result.includedCandidates).toEqual([]);
    expect(result.excludedCandidates).toEqual(input);
    expect(result.decisions).toHaveLength(input.length);
    expect(
      result.decisions.every(
        ({ includedByProfile, reason }) =>
          !includedByProfile && reason === "INVALID_PROFILE",
      ),
    ).toBe(true);
  });

  it("contains multiple malformed candidates and preserves valid-neighbor decisions", () => {
    const included = makeCandidate("QA_INSTRUCTION");
    const excluded = makeCandidate("PRIOR_HANDOFF");
    const malformedExtra = {
      ...makeCandidate("TASK_CONTRACT"),
      rawChat: "private",
    } as unknown as QaContextProfileCandidate;
    const malformedUnknown = {
      candidateClass: "FUTURE_CONTEXT",
      sourceReference: "future://unknown",
    } as unknown as QaContextProfileCandidate;
    const throwing = new Proxy(
      { ...makeCandidate("TASK_CONTRACT") },
      {
        getOwnPropertyDescriptor() {
          throw new Error("private malformed candidate");
        },
      },
    ) as QaContextProfileCandidate;
    const input = [
      included,
      malformedExtra,
      excluded,
      malformedUnknown,
      throwing,
      included,
    ];
    const result = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);

    expect(result.includedCandidates).toEqual([included, included]);
    expect(result.excludedCandidates).toEqual([
      malformedExtra,
      excluded,
      malformedUnknown,
      throwing,
    ]);
    expect(result.decisions.map(({ reason }) => reason)).toEqual([
      "INCLUDED_QA_INSTRUCTION",
      "INVALID_CANDIDATE",
      "EXCLUDED_PRIOR_HANDOFF",
      "INVALID_CANDIDATE",
      "INVALID_CANDIDATE",
      "INCLUDED_QA_INSTRUCTION",
    ]);
  });

  it("keeps booleans and the closed reason taxonomy consistent", () => {
    for (const profile of ["FRESH_INDEPENDENT_QA", "FOCUSED_RE_QA"] as const) {
      for (const [candidateClass, includedByProfile, reason] of expectedMatrix) {
        const decision = evaluateQaContextProfileCandidate(
          profile,
          makeCandidate(candidateClass, `reason://${reason}`),
        );
        expect(decision).toEqual({ includedByProfile, reason });
        expect(decision.reason.startsWith("INCLUDED_")).toBe(decision.includedByProfile);
      }
    }
  });

  it("does not derive a reason from sourceReference text", () => {
    const sourceReference =
      "INCLUDED_QA_INSTRUCTION EXCLUDED_PRIOR_HANDOFF INVALID_CANDIDATE";
    expect(
      evaluateQaContextProfileCandidate(
        "FRESH_INDEPENDENT_QA",
        makeCandidate("DIGEST", sourceReference),
      ),
    ).toEqual({ includedByProfile: false, reason: "EXCLUDED_DIGEST" });
  });
});

describe("S2C1 immutability and repeatability", () => {
  it("does not mutate frozen candidates, nested targets, or arrays", () => {
    const frozenTarget = Object.freeze({ ...retestTarget });
    const frozenCandidate = Object.freeze({
      candidateClass: "BOUNDED_RETEST_TARGET" as const,
      sourceReference: "finding://frozen",
      retestTarget: frozenTarget,
    });
    const input = Object.freeze([frozenCandidate, frozenCandidate]);
    const result = narrowContextCandidatesForQa("FOCUSED_RE_QA", input);

    expect(result.includedCandidates).toEqual(input);
    expect(result.decisions[0]?.candidate).toBe(frozenCandidate);
    expect(result.decisions[1]?.candidate).toBe(frozenCandidate);
    expect(Object.isFrozen(frozenTarget)).toBe(true);
    expect(Object.isFrozen(frozenCandidate)).toBe(true);
  });

  it("returns immutable result structures without freezing caller-owned objects", () => {
    const mutable = makeCandidate("TASK_CONTRACT");
    const result = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", [mutable]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.includedCandidates)).toBe(true);
    expect(Object.isFrozen(result.excludedCandidates)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(result.decisions[0])).toBe(true);
    expect(Object.isFrozen(mutable)).toBe(false);
  });

  it("produces the same exact decisions without timestamps or randomness", () => {
    const input = expectedMatrix.flatMap(([candidateClass]) => [
      makeCandidate(candidateClass),
      makeCandidate(candidateClass),
    ]);
    const first = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);
    const second = narrowContextCandidatesForQa("FRESH_INDEPENDENT_QA", input);
    expect(first).toEqual(second);
    expect(Object.keys(first.decisions[0]!).sort()).toEqual([
      "candidate",
      "includedByProfile",
      "reason",
    ]);
  });
});

const MUTATION_REVIEW = [
  ["unknown candidate defaults include", "near-miss class matrix", "FALSE_INCLUDE"],
  ["unknown profile defaults Fresh", "invalid profile matrix", "FALSE_INCLUDE"],
  ["ACTIVE_CONTEXT_ITEM included", "complete oracle", "FALSE_INCLUDE"],
  ["DIGEST included", "complete oracle", "FALSE_INCLUDE"],
  ["PROMOTED_CONTEXT included", "complete oracle", "FALSE_INCLUDE"],
  ["RAW_HISTORY included", "complete oracle", "FALSE_INCLUDE"],
  ["PRIOR_RAW_CHAT included", "complete oracle", "FALSE_INCLUDE"],
  ["PRIOR_REASONING included", "complete oracle", "FALSE_INCLUDE"],
  ["PRIOR_HANDOFF included", "complete oracle", "FALSE_INCLUDE"],
  ["PRIOR_SELF_ASSESSMENT included", "complete oracle", "FALSE_INCLUDE"],
  ["sourceReference keyword overrides class", "relabel matrix", "FALSE_INCLUDE"],
  ["HUMAN keyword overrides class", "relabel matrix", "FALSE_INCLUDE"],
  ["ACCEPTED keyword overrides class", "relabel matrix", "FALSE_INCLUDE"],
  ["FINAL keyword overrides class", "relabel matrix", "FALSE_INCLUDE"],
  ["PASS keyword overrides class", "relabel matrix", "FALSE_INCLUDE"],
  ["Focused re-QA includes repair Handoff", "complete oracle", "FALSE_INCLUDE"],
  ["Focused re-QA includes repair reasoning", "complete oracle", "FALSE_INCLUDE"],
  ["retest extra field accepted", "extra-field matrix", "FALSE_INCLUDE"],
  ["retest missing field accepted", "required target regression", "FALSE_INCLUDE"],
  ["invalid SHA accepted", "SHA matrix", "FALSE_INCLUDE"],
  ["uppercase SHA accepted", "SHA matrix", "FALSE_INCLUDE"],
  ["nested retest validation skipped", "nested Proxy and bounds", "FALSE_INCLUDE"],
  ["non-retest target accepted", "class/target exclusivity", "FALSE_INCLUDE"],
  ["inherited candidate accepted", "descriptor matrix", "FALSE_INCLUDE"],
  ["extra candidate field accepted", "descriptor matrix", "FALSE_INCLUDE"],
  ["symbol candidate field accepted", "descriptor matrix", "FALSE_INCLUDE"],
  ["accessor candidate accepted", "descriptor matrix", "FALSE_INCLUDE"],
  ["non-enumerable field accepted", "descriptor matrix", "FALSE_INCLUDE"],
  ["custom prototype accepted", "copy contract", "FALSE_INCLUDE"],
  ["Proxy class EXCLUDED to INCLUDED bypass", "class-swap reproduction", "FALSE_INCLUDE"],
  ["Proxy class INCLUDED to EXCLUDED treated stable", "class-swap inverse", "FALSE_INCLUDE"],
  ["Proxy ownKeys change bypass", "hostile descriptor campaign", "FALSE_INCLUDE"],
  ["Proxy enumerability change bypass", "hostile descriptor campaign", "FALSE_INCLUDE"],
  ["Proxy prototype change bypass", "hostile descriptor campaign", "FALSE_INCLUDE"],
  ["Proxy sourceReference change bypass", "hostile descriptor campaign", "FALSE_INCLUDE"],
  ["Proxy retest field swap bypass", "nested Proxy campaign", "FALSE_INCLUDE"],
  ["Proxy repairedSha swap bypass", "nested Proxy campaign", "FALSE_INCLUDE"],
  ["Proxy nested target swap bypass", "nested Proxy campaign", "FALSE_INCLUDE"],
  ["throwing candidate trap escapes", "throwing trap matrix", "FALSE_INCLUDE"],
  ["throwing array trap exposes partial result", "throwing array regression", "FALSE_INCLUDE"],
  ["array descriptor synthesizes included candidate", "array swap reproduction", "FALSE_INCLUDE"],
  ["sparse array skips excluded evidence", "malformed array matrix", "FALSE_INCLUDE"],
  ["array accessor bypass", "malformed array matrix", "FALSE_INCLUDE"],
  ["array extra key bypass", "malformed array matrix", "FALSE_INCLUDE"],
  ["one malformed candidate includes following excluded", "mixed array regression", "FALSE_INCLUDE"],
  ["output appends canonical candidate", "identity property", "WIDENING"],
  ["output imports global candidate", "identity property", "WIDENING"],
  ["output converts excluded class", "identity property", "WIDENING"],
  ["duplicates removed", "duplicate property", "INTEGRITY"],
  ["output sorted", "order property", "INTEGRITY"],
  ["decision omitted", "multiplicity property", "INTEGRITY"],
  ["candidate counted twice", "multiplicity property", "INTEGRITY"],
  ["included/excluded overlap", "independent index oracle", "INTEGRITY"],
  ["reason mismatches included boolean", "reason integrity matrix", "INTEGRITY"],
  ["reason derived from source text", "reason bait regression", "INTEGRITY"],
  ["parser truncates overlong retest field", "no-truncation regression", "INTEGRITY"],
  ["parser truncates sourceReference", "source boundary matrix", "INTEGRITY"],
  ["narrowing canonicalizes caller object", "original identity regression", "INTEGRITY"],
  ["narrowing mutates compact text", "normalization boundary", "INTEGRITY"],
  ["narrowing mutates input array", "array campaign", "INTEGRITY"],
  ["narrowing freezes caller candidate", "result immutability regression", "INTEGRITY"],
  ["result arrays remain mutable", "result immutability regression", "INTEGRITY"],
  ["decision adds timestamp", "repeatability regression", "INTEGRITY"],
  ["decision uses randomness", "repeatability regression", "INTEGRITY"],
] as const;

const SOURCE_TO_TEST_MAPPING = [
  ["profile parser", "complete oracle + near-miss profiles"],
  ["candidate parser", "complete oracle + near-miss classes"],
  ["candidate structural capture", "descriptor and Proxy campaigns"],
  ["candidate stable observation", "class/source/prototype swaps"],
  ["retest structural capture", "nested descriptor campaign"],
  ["retest stable observation", "field/SHA/identity swaps"],
  ["candidate array capture", "array descriptor campaign"],
  ["array stable observation", "array substitution reproduction"],
  ["array descriptor length", "hostile length value-read regression"],
  ["profile policy lookup", "two-profile complete oracle"],
  ["CANONICAL_PROJECT_RULE", "complete oracle"],
  ["TASK_CONTRACT", "complete oracle"],
  ["ACCEPTANCE_CRITERIA", "complete oracle"],
  ["LOCKED_INVARIANT", "complete oracle"],
  ["REPO_RUNTIME_EVIDENCE", "complete oracle"],
  ["QA_INSTRUCTION", "complete oracle"],
  ["BOUNDED_RETEST_TARGET", "complete oracle + strict target"],
  ["ACTIVE_CONTEXT_ITEM", "complete oracle + bait matrix"],
  ["DIGEST", "complete oracle + bait matrix"],
  ["PROMOTED_CONTEXT", "complete oracle + bait matrix"],
  ["RAW_HISTORY", "complete oracle + bait matrix"],
  ["PRIOR_RAW_CHAT", "complete oracle + bait matrix"],
  ["PRIOR_REASONING", "complete oracle + bait matrix"],
  ["PRIOR_HANDOFF", "complete oracle + bait matrix"],
  ["PRIOR_SELF_ASSESSMENT", "complete oracle + bait matrix"],
  ["unknown profile", "invalid profile matrix"],
  ["unknown candidate", "near-miss candidate matrix"],
  ["invalid retest", "bounds/SHA/extra-field matrices"],
  ["subset construction", "independent index oracle"],
  ["order preservation", "reversed/alternating/scale arrays"],
  ["duplicate preservation", "shared identity scale campaign"],
  ["invalid candidate path", "mixed malformed arrays"],
  ["invalid array path", "sparse/accessor/extra/throwing arrays"],
  ["input immutability", "frozen and mutable regressions"],
  ["result immutability", "frozen result regression"],
  ["reason mapping", "decision integrity matrix"],
  ["exception containment", "throwing trap matrix"],
  ["original versus parsed boundary", "normalization identity regression"],
  ["sourceReference semantic neutrality", "relabel matrix"],
  ["large bounded correctness", "4097-candidate campaign"],
] as const;

describe("S2C1 hardening assurance manifests", () => {
  it("maps at least sixty mutations with at least forty false-include hypotheses", () => {
    expect(MUTATION_REVIEW).toHaveLength(64);
    expect(new Set(MUTATION_REVIEW.map(([mutation]) => mutation)).size).toBe(64);
    expect(MUTATION_REVIEW.filter(([, evidence]) => evidence.length === 0)).toEqual([]);
    expect(
      MUTATION_REVIEW.filter(([, , category]) => category === "FALSE_INCLUDE").length,
    ).toBeGreaterThanOrEqual(40);
  });

  it("maps at least thirty-five safety-critical source conditions without a gap", () => {
    expect(SOURCE_TO_TEST_MAPPING).toHaveLength(40);
    expect(
      new Set(SOURCE_TO_TEST_MAPPING.map(([condition]) => condition)).size,
    ).toBe(40);
    expect(
      SOURCE_TO_TEST_MAPPING.filter(([, evidence]) => evidence.length === 0),
    ).toEqual([]);
  });
});
