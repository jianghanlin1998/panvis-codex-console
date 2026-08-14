import { z } from "zod";

import { RepositoryCommitShaSchema } from "./implementation-checkpoint.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

export const QaContextProfileKindSchema = z.enum([
  "FRESH_INDEPENDENT_QA",
  "FOCUSED_RE_QA",
]);

export const QaContextCandidateClassSchema = z.enum([
  "CANONICAL_PROJECT_RULE",
  "TASK_CONTRACT",
  "ACCEPTANCE_CRITERIA",
  "LOCKED_INVARIANT",
  "REPO_RUNTIME_EVIDENCE",
  "QA_INSTRUCTION",
  "BOUNDED_RETEST_TARGET",
  "ACTIVE_CONTEXT_ITEM",
  "DIGEST",
  "PROMOTED_CONTEXT",
  "RAW_HISTORY",
  "PRIOR_RAW_CHAT",
  "PRIOR_REASONING",
  "PRIOR_HANDOFF",
  "PRIOR_SELF_ASSESSMENT",
]);

const NonRetestQaContextCandidateClassSchema = z.enum([
  "CANONICAL_PROJECT_RULE",
  "TASK_CONTRACT",
  "ACCEPTANCE_CRITERIA",
  "LOCKED_INVARIANT",
  "REPO_RUNTIME_EVIDENCE",
  "QA_INSTRUCTION",
  "ACTIVE_CONTEXT_ITEM",
  "DIGEST",
  "PROMOTED_CONTEXT",
  "RAW_HISTORY",
  "PRIOR_RAW_CHAT",
  "PRIOR_REASONING",
  "PRIOR_HANDOFF",
  "PRIOR_SELF_ASSESSMENT",
]);

export const BoundedRetestTargetSchema = z
  .object({
    findingId: compactText(128),
    violatedInvariant: compactText(1_000),
    affectedContract: compactText(256),
    repairedSha: RepositoryCommitShaSchema,
  })
  .strict();

const sourceReference = compactText(2_048);

export const QaContextProfileCandidateSchema = z.union([
  z
    .object({
      candidateClass: z.literal("BOUNDED_RETEST_TARGET"),
      sourceReference,
      retestTarget: BoundedRetestTargetSchema,
    })
    .strict(),
  z
    .object({
      candidateClass: NonRetestQaContextCandidateClassSchema,
      sourceReference,
    })
    .strict(),
]);

export const QaContextProfileDecisionReasonSchema = z.enum([
  "INCLUDED_CANONICAL_EVIDENCE",
  "INCLUDED_QA_INSTRUCTION",
  "INCLUDED_BOUNDED_RETEST_TARGET",
  "EXCLUDED_GENERIC_ACTIVE_CONTEXT",
  "EXCLUDED_DIGEST",
  "EXCLUDED_PROMOTED_CONTEXT",
  "EXCLUDED_RAW_HISTORY",
  "EXCLUDED_PRIOR_RAW_CHAT",
  "EXCLUDED_PRIOR_REASONING",
  "EXCLUDED_PRIOR_HANDOFF",
  "EXCLUDED_PRIOR_SELF_ASSESSMENT",
  "INVALID_PROFILE",
  "INVALID_CANDIDATE",
]);

export type QaContextProfileKind = z.infer<typeof QaContextProfileKindSchema>;
export type QaContextCandidateClass = z.infer<typeof QaContextCandidateClassSchema>;
export type BoundedRetestTarget = z.infer<typeof BoundedRetestTargetSchema>;
export type QaContextProfileCandidate = z.infer<
  typeof QaContextProfileCandidateSchema
>;
export type QaContextProfileDecisionReason = z.infer<
  typeof QaContextProfileDecisionReasonSchema
>;

export interface QaContextProfileDecision {
  /**
   * True means only that this profile does not exclude the already-allowed
   * candidate. The profile is not an ACL and grants no source access.
   */
  readonly includedByProfile: boolean;
  readonly reason: QaContextProfileDecisionReason;
}

export interface QaContextProfileCandidateEvaluation
  extends QaContextProfileDecision {
  readonly candidate: QaContextProfileCandidate;
}

export interface QaContextProfileNarrowingResult {
  readonly includedCandidates: readonly QaContextProfileCandidate[];
  readonly excludedCandidates: readonly QaContextProfileCandidate[];
  readonly decisions: readonly QaContextProfileCandidateEvaluation[];
}

const includedDecision = (
  reason: Extract<QaContextProfileDecisionReason, `INCLUDED_${string}`>,
): QaContextProfileDecision => Object.freeze({ includedByProfile: true, reason });

const excludedDecision = (
  reason: Exclude<QaContextProfileDecisionReason, `INCLUDED_${string}`>,
): QaContextProfileDecision => Object.freeze({ includedByProfile: false, reason });

const CLEAN_QA_POLICY: Readonly<
  Record<QaContextCandidateClass, QaContextProfileDecision>
> = Object.freeze({
  CANONICAL_PROJECT_RULE: includedDecision("INCLUDED_CANONICAL_EVIDENCE"),
  TASK_CONTRACT: includedDecision("INCLUDED_CANONICAL_EVIDENCE"),
  ACCEPTANCE_CRITERIA: includedDecision("INCLUDED_CANONICAL_EVIDENCE"),
  LOCKED_INVARIANT: includedDecision("INCLUDED_CANONICAL_EVIDENCE"),
  REPO_RUNTIME_EVIDENCE: includedDecision("INCLUDED_CANONICAL_EVIDENCE"),
  QA_INSTRUCTION: includedDecision("INCLUDED_QA_INSTRUCTION"),
  BOUNDED_RETEST_TARGET: includedDecision("INCLUDED_BOUNDED_RETEST_TARGET"),
  ACTIVE_CONTEXT_ITEM: excludedDecision("EXCLUDED_GENERIC_ACTIVE_CONTEXT"),
  DIGEST: excludedDecision("EXCLUDED_DIGEST"),
  PROMOTED_CONTEXT: excludedDecision("EXCLUDED_PROMOTED_CONTEXT"),
  RAW_HISTORY: excludedDecision("EXCLUDED_RAW_HISTORY"),
  PRIOR_RAW_CHAT: excludedDecision("EXCLUDED_PRIOR_RAW_CHAT"),
  PRIOR_REASONING: excludedDecision("EXCLUDED_PRIOR_REASONING"),
  PRIOR_HANDOFF: excludedDecision("EXCLUDED_PRIOR_HANDOFF"),
  PRIOR_SELF_ASSESSMENT: excludedDecision("EXCLUDED_PRIOR_SELF_ASSESSMENT"),
});

const PROFILE_POLICIES: Readonly<
  Record<
    QaContextProfileKind,
    Readonly<Record<QaContextCandidateClass, QaContextProfileDecision>>
  >
> = Object.freeze({
  FRESH_INDEPENDENT_QA: CLEAN_QA_POLICY,
  FOCUSED_RE_QA: CLEAN_QA_POLICY,
});

interface StrictDataObservation {
  readonly prototype: "OBJECT" | "NULL" | "ARRAY";
  readonly keys: readonly string[];
  readonly descriptors: readonly {
    readonly key: string;
    readonly enumerable: boolean;
    readonly configurable: boolean;
    readonly writable: boolean;
    readonly value: unknown;
  }[];
}

interface StrictDataObjectCapture {
  readonly data: Record<string, unknown>;
  readonly observation: StrictDataObservation;
}

interface StrictCandidateArrayCapture {
  readonly data: readonly unknown[];
  readonly observation: StrictDataObservation;
}

const observationsEqual = (
  left: StrictDataObservation,
  right: StrictDataObservation,
): boolean =>
  left.prototype === right.prototype &&
  left.keys.length === right.keys.length &&
  left.keys.every((key, index) => key === right.keys[index]) &&
  left.descriptors.length === right.descriptors.length &&
  left.descriptors.every((descriptor, index) => {
    const other = right.descriptors[index];
    return (
      other !== undefined &&
      descriptor.key === other.key &&
      descriptor.enumerable === other.enumerable &&
      descriptor.configurable === other.configurable &&
      descriptor.writable === other.writable &&
      Object.is(descriptor.value, other.value)
    );
  });

const captureStrictDataObjectOnce = (
  input: unknown,
): StrictDataObjectCapture | null => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return null;
    }

    const keys = ownKeys as string[];
    const captured = Object.create(
      prototype === null ? null : Object.prototype,
    ) as Record<string, unknown>;
    const descriptors: StrictDataObservation["descriptors"][number][] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      Object.defineProperty(captured, key, {
        value: descriptor.value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      descriptors.push({
        key,
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
        writable: descriptor.writable ?? false,
        value: descriptor.value,
      });
    }
    return {
      data: captured,
      observation: {
        prototype: prototype === null ? "NULL" : "OBJECT",
        keys,
        descriptors,
      },
    };
  } catch {
    return null;
  }
};

const captureStableStrictDataObject = (
  input: unknown,
): Record<string, unknown> | null => {
  const captures = Array.from({ length: 3 }, () =>
    captureStrictDataObjectOnce(input),
  );
  const first = captures[0];
  if (first === undefined || first === null) {
    return null;
  }
  if (
    captures.slice(1).some(
      (capture) =>
        capture === undefined ||
        capture === null ||
        !observationsEqual(first.observation, capture.observation),
    )
  ) {
    return null;
  }
  return first.data;
};

const parseCandidateMetadata = (input: unknown): QaContextProfileCandidate | null => {
  try {
    const capturedCandidate = captureStableStrictDataObject(input);
    if (capturedCandidate === null) {
      return null;
    }

    if (capturedCandidate.candidateClass === "BOUNDED_RETEST_TARGET") {
      const capturedTarget = captureStableStrictDataObject(
        capturedCandidate.retestTarget,
      );
      if (capturedTarget === null) {
        return null;
      }
      capturedCandidate.retestTarget = capturedTarget;
    }

    const parsed = QaContextProfileCandidateSchema.safeParse(capturedCandidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const captureCandidateArrayOnce = (
  input: unknown,
): StrictCandidateArrayCapture | null => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return null;
    }
    const keys = ownKeys as string[];
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return null;
    }
    const length = lengthDescriptor.value as number;
    const expectedKeys = [
      ...Array.from({ length }, (_, index) => String(index)),
      "length",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return null;
    }
    const candidates: unknown[] = [];
    const descriptors: StrictDataObservation["descriptors"][number][] = [
      {
        key: "length",
        enumerable: lengthDescriptor.enumerable ?? false,
        configurable: lengthDescriptor.configurable ?? false,
        writable: lengthDescriptor.writable ?? false,
        value: length,
      },
    ];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
      candidates.push(descriptor.value);
      descriptors.push({
        key: String(index),
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
        writable: descriptor.writable ?? false,
        value: descriptor.value,
      });
    }
    return {
      data: candidates,
      observation: {
        prototype: "ARRAY",
        keys,
        descriptors,
      },
    };
  } catch {
    return null;
  }
};

const captureCandidateArray = (input: unknown): readonly unknown[] | null => {
  const captures = Array.from({ length: 3 }, () =>
    captureCandidateArrayOnce(input),
  );
  const first = captures[0];
  if (first === undefined || first === null) {
    return null;
  }
  if (
    captures.slice(1).some(
      (capture) =>
        capture === undefined ||
        capture === null ||
        !observationsEqual(first.observation, capture.observation),
    )
  ) {
    return null;
  }
  return first.data;
};

export const evaluateQaContextProfileCandidate = (
  profile: QaContextProfileKind,
  candidate: QaContextProfileCandidate,
): QaContextProfileDecision => {
  const parsedProfile = QaContextProfileKindSchema.safeParse(profile);
  if (!parsedProfile.success) {
    return excludedDecision("INVALID_PROFILE");
  }
  const parsedCandidate = parseCandidateMetadata(candidate);
  if (parsedCandidate === null) {
    return excludedDecision("INVALID_CANDIDATE");
  }

  const policyDecision =
    PROFILE_POLICIES[parsedProfile.data][parsedCandidate.candidateClass];
  return Object.freeze({ ...policyDecision });
};

export const narrowContextCandidatesForQa = (
  profile: QaContextProfileKind,
  alreadyAllowedCandidates: readonly QaContextProfileCandidate[],
): QaContextProfileNarrowingResult => {
  const capturedCandidates = captureCandidateArray(alreadyAllowedCandidates);
  if (capturedCandidates === null) {
    return Object.freeze({
      includedCandidates: Object.freeze([]),
      excludedCandidates: Object.freeze([]),
      decisions: Object.freeze([]),
    });
  }

  const includedCandidates: QaContextProfileCandidate[] = [];
  const excludedCandidates: QaContextProfileCandidate[] = [];
  const decisions: QaContextProfileCandidateEvaluation[] = [];
  for (const suppliedCandidate of capturedCandidates) {
    const candidate = suppliedCandidate as QaContextProfileCandidate;
    const decision = evaluateQaContextProfileCandidate(profile, candidate);
    if (decision.includedByProfile) {
      includedCandidates.push(candidate);
    } else {
      excludedCandidates.push(candidate);
    }
    decisions.push(Object.freeze({ candidate, ...decision }));
  }

  return Object.freeze({
    includedCandidates: Object.freeze(includedCandidates),
    excludedCandidates: Object.freeze(excludedCandidates),
    decisions: Object.freeze(decisions),
  });
};
