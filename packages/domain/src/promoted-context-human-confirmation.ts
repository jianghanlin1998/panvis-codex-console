import { z } from "zod";

import {
  PromotedContextAcceptanceReasonSchema,
  evaluatePromotedContextAcceptanceRequirement,
} from "./promoted-context-acceptance.js";
import type { PromotedContextCandidate } from "./promoted-context-candidate.js";
import type { PromotedContextRouteTopology } from "./promoted-context-route.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

export const PromotedContextHumanConfirmationEvidenceSchema = z
  .object({
    evidenceType: z.literal("HUMAN_CONFIRMATION"),
    sourceReference: compactText(2_048),
    occurredAt: z
      .iso.datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();

const PromotedContextAcceptanceNonEligibleReasonSchema =
  PromotedContextAcceptanceReasonSchema.exclude([
    "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
    "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
  ]);

const PromotedContextHumanConfirmationNonApplicableReasonSchema = z.enum([
  ...PromotedContextAcceptanceNonEligibleReasonSchema.options,
  "INVALID_HUMAN_CONFIRMATION_EVIDENCE",
]);

export const PromotedContextHumanConfirmationReasonSchema = z.enum([
  ...PromotedContextHumanConfirmationNonApplicableReasonSchema.options,
  "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
]);

export const PromotedContextHumanConfirmationEvaluationSchema = z.union([
  z
    .object({
      structurallyApplicable: z.literal(false),
      reason: PromotedContextHumanConfirmationNonApplicableReasonSchema,
    })
    .strict(),
  z
    .object({
      structurallyApplicable: z.literal(true),
      requirement: z.literal("HUMAN_CONFIRMATION_REQUIRED"),
      reason: z.literal(
        "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
      ),
      evidence: PromotedContextHumanConfirmationEvidenceSchema,
    })
    .strict(),
  z
    .object({
      structurallyApplicable: z.literal(true),
      requirement: z.literal("DETERMINISTIC_EVIDENCE_OR_HUMAN"),
      reason: z.literal(
        "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
      ),
      evidence: PromotedContextHumanConfirmationEvidenceSchema,
    })
    .strict(),
]);

export type PromotedContextHumanConfirmationEvidence = z.infer<
  typeof PromotedContextHumanConfirmationEvidenceSchema
>;
export type PromotedContextHumanConfirmationReason = z.infer<
  typeof PromotedContextHumanConfirmationReasonSchema
>;
export type PromotedContextHumanConfirmationEvaluation = z.infer<
  typeof PromotedContextHumanConfirmationEvaluationSchema
>;

const captureEvidenceEnvelope = (input: unknown): unknown | null => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }

    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string")) {
      return null;
    }

    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
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
    }
    return captured;
  } catch {
    return null;
  }
};

const parseCanonicalEvidence = (
  input: unknown,
): PromotedContextHumanConfirmationEvidence | null => {
  const captured = captureEvidenceEnvelope(input);
  if (captured === null) {
    return null;
  }
  try {
    const parsed = PromotedContextHumanConfirmationEvidenceSchema.safeParse(captured);
    return parsed.success ? Object.freeze({ ...parsed.data }) : null;
  } catch {
    return null;
  }
};

const nonApplicableDecision = (
  reason: z.infer<
    typeof PromotedContextHumanConfirmationNonApplicableReasonSchema
  >,
): PromotedContextHumanConfirmationEvaluation =>
  Object.freeze({ structurallyApplicable: false, reason });

/**
 * Validates a human-confirmation evidence envelope and determines whether its
 * human branch is structurally applicable to the candidate's S2D3 requirement.
 * This does not authenticate a human or execute acceptance.
 */
export const evaluatePromotedContextHumanConfirmationEvidence = (
  topology: PromotedContextRouteTopology,
  candidate: PromotedContextCandidate,
  evidence: unknown,
): PromotedContextHumanConfirmationEvaluation => {
  const acceptanceEvaluation = evaluatePromotedContextAcceptanceRequirement(
    topology,
    candidate,
  );
  if (!acceptanceEvaluation.acceptanceEligible) {
    return nonApplicableDecision(acceptanceEvaluation.reason);
  }

  const canonicalEvidence = parseCanonicalEvidence(evidence);
  if (canonicalEvidence === null) {
    return nonApplicableDecision("INVALID_HUMAN_CONFIRMATION_EVIDENCE");
  }

  return Object.freeze({
    structurallyApplicable: true,
    requirement: acceptanceEvaluation.requirement,
    reason: "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
    evidence: canonicalEvidence,
  });
};
