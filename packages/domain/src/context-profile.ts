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

const captureStrictDataObject = (
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string") ||
      expectedKeys.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }

    const captured: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    return null;
  }
};

const parseCandidateMetadata = (input: unknown): QaContextProfileCandidate | null => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const classDescriptor = Object.getOwnPropertyDescriptor(input, "candidateClass");
    if (classDescriptor === undefined || !("value" in classDescriptor)) {
      return null;
    }
    const isRetestTarget = classDescriptor.value === "BOUNDED_RETEST_TARGET";
    const capturedCandidate = captureStrictDataObject(
      input,
      isRetestTarget
        ? ["candidateClass", "sourceReference", "retestTarget"]
        : ["candidateClass", "sourceReference"],
    );
    if (capturedCandidate === null) {
      return null;
    }

    if (isRetestTarget) {
      const capturedTarget = captureStrictDataObject(capturedCandidate.retestTarget, [
        "findingId",
        "violatedInvariant",
        "affectedContract",
        "repairedSha",
      ]);
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

const captureCandidateArray = (input: unknown): readonly unknown[] | null => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    const expectedKeys = [
      ...Array.from({ length: input.length }, (_, index) => String(index)),
      "length",
    ];
    if (
      ownKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const candidates: unknown[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
      candidates.push(descriptor.value);
    }
    return candidates;
  } catch {
    return null;
  }
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
