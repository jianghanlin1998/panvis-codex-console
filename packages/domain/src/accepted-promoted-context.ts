import { z } from "zod";

import {
  PromotedContextCandidateSchema,
  evaluatePromotedContextCandidate,
} from "./promoted-context-candidate.js";
import type { PromotedContextCandidate } from "./promoted-context-candidate.js";
import {
  PromotedContextHumanConfirmationEvidenceSchema,
  PromotedContextHumanConfirmationReasonSchema,
  evaluatePromotedContextHumanConfirmationEvidence,
} from "./promoted-context-human-confirmation.js";
import type { PromotedContextRouteTopology } from "./promoted-context-route.js";
import { captureJointlyStableStructuralDataList } from "./structural-capture.js";

const AcceptedPromotedContextAcceptanceDataSchema = z
  .object({
    method: z.literal("HUMAN_CONFIRMATION"),
    evidence: PromotedContextHumanConfirmationEvidenceSchema,
  })
  .strict();

/**
 * Public serialized data shape only. Parsing this schema establishes structural
 * validity, not that a trusted human-action transition occurred.
 */
export const AcceptedPromotedContextSnapshotDataSchema = z
  .object({
    candidate: PromotedContextCandidateSchema,
    acceptance: AcceptedPromotedContextAcceptanceDataSchema,
  })
  .strict();

export type AcceptedPromotedContextSnapshotData = z.infer<
  typeof AcceptedPromotedContextSnapshotDataSchema
>;

const TrustedHumanAcceptanceUpstreamFailureReasonSchema =
  PromotedContextHumanConfirmationReasonSchema.exclude([
    "HUMAN_CONFIRMATION_EVIDENCE_STRUCTURALLY_APPLICABLE",
  ]);

export const TrustedHumanPromotedContextAcceptanceFailureReasonSchema = z.enum([
  ...TrustedHumanAcceptanceUpstreamFailureReasonSchema.options,
  "INVALID_ACCEPTANCE_INPUT_SNAPSHOT",
  "INCONSISTENT_UPSTREAM_EVALUATION",
]);

export const TrustedHumanPromotedContextAcceptanceResultSchema = z.union([
  z
    .object({
      accepted: z.literal(false),
      reason: TrustedHumanPromotedContextAcceptanceFailureReasonSchema,
    })
    .strict(),
  z
    .object({
      accepted: z.literal(true),
      snapshot: AcceptedPromotedContextSnapshotDataSchema,
    })
    .strict(),
]);

export type TrustedHumanPromotedContextAcceptanceFailureReason = z.infer<
  typeof TrustedHumanPromotedContextAcceptanceFailureReasonSchema
>;
export type TrustedHumanPromotedContextAcceptanceResult = z.infer<
  typeof TrustedHumanPromotedContextAcceptanceResultSchema
>;

const failure = (
  reason: TrustedHumanPromotedContextAcceptanceFailureReason,
): TrustedHumanPromotedContextAcceptanceResult =>
  Object.freeze({ accepted: false, reason });

/**
 * Internal transition core. Its caller must already be inside the trusted local
 * human-action boundary; this function does not authenticate or create that
 * boundary and is intentionally absent from the package-root public API.
 */
export const acceptPromotedContextFromTrustedHumanAction = (
  topology: PromotedContextRouteTopology,
  candidate: PromotedContextCandidate,
  evidence: unknown,
): TrustedHumanPromotedContextAcceptanceResult => {
  try {
    const capturedInputs = captureJointlyStableStructuralDataList([
      candidate,
      topology,
      evidence,
    ]);
    if (!capturedInputs.jointlyConsistent) {
      return failure("INVALID_ACCEPTANCE_INPUT_SNAPSHOT");
    }

    const [capturedCandidate, capturedTopology, capturedEvidence] =
      capturedInputs.data;
    const evidenceEvaluation =
      evaluatePromotedContextHumanConfirmationEvidence(
        capturedTopology as PromotedContextRouteTopology,
        capturedCandidate as PromotedContextCandidate,
        capturedEvidence,
      );
    if (!evidenceEvaluation.structurallyApplicable) {
      return failure(evidenceEvaluation.reason);
    }

    const candidateEvaluation = evaluatePromotedContextCandidate(
      capturedTopology as PromotedContextRouteTopology,
      capturedCandidate as PromotedContextCandidate,
    );
    if (!candidateEvaluation.eligibleForPromotion) {
      return failure("INCONSISTENT_UPSTREAM_EVALUATION");
    }

    const acceptance = Object.freeze({
      method: "HUMAN_CONFIRMATION" as const,
      evidence: evidenceEvaluation.evidence,
    });
    const snapshot = Object.freeze({
      candidate: candidateEvaluation.candidate,
      acceptance,
    });
    return Object.freeze({ accepted: true, snapshot });
  } catch {
    return failure("INVALID_ACCEPTANCE_INPUT_SNAPSHOT");
  }
};
