import { z } from "zod";

import { ContextKindSchema, ContextSourceTypeSchema } from "./context.js";
import {
  PromotedContextRouteReasonSchema,
  PromotedContextRouteSchema,
  evaluatePromotedContextRoute,
} from "./promoted-context-route.js";
import type {
  PromotedContextRoute,
  PromotedContextRouteReason,
  PromotedContextRouteTopology,
} from "./promoted-context-route.js";
import { captureJointlyStableStructuralDataList } from "./structural-capture.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

const candidateReference = compactText(2_048);

export const PromotedContextCandidateProvenanceSchema = z
  .object({
    sourceType: ContextSourceTypeSchema,
    sourceReference: candidateReference,
    evidenceReferences: z.array(candidateReference).max(8),
  })
  .strict();

export const PromotedContextCandidateSchema = z
  .object({
    route: PromotedContextRouteSchema,
    kind: ContextKindSchema,
    title: compactText(256),
    body: compactText(4_000),
    provenance: PromotedContextCandidateProvenanceSchema,
  })
  .strict();

export const PromotedContextCandidateReasonSchema = z.union([
  z.literal("INVALID_CANDIDATE"),
  PromotedContextRouteReasonSchema,
]);

export type PromotedContextCandidateProvenance = z.infer<
  typeof PromotedContextCandidateProvenanceSchema
>;
export type PromotedContextCandidate = z.infer<
  typeof PromotedContextCandidateSchema
>;
export type PromotedContextCandidateReason = z.infer<
  typeof PromotedContextCandidateReasonSchema
>;

export type PromotedContextCandidateEvaluation =
  | Readonly<{
      valid: false;
      eligibleForPromotion: false;
      reason: "INVALID_CANDIDATE" | "INVALID_ROUTE";
    }>
  | Readonly<{
      valid: true;
      eligibleForPromotion: boolean;
      reason: PromotedContextRouteReason;
      candidate: PromotedContextCandidate;
    }>;

const parseCapturedCandidate = (input: unknown): PromotedContextCandidate | null => {
  try {
    const parsed = PromotedContextCandidateSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const freezeCandidate = (
  candidate: PromotedContextCandidate,
): PromotedContextCandidate => {
  const route = Object.freeze({ ...candidate.route });
  const evidenceReferences = [...candidate.provenance.evidenceReferences];
  Object.freeze(evidenceReferences);
  const provenance = Object.freeze({
    ...candidate.provenance,
    evidenceReferences,
  });
  return Object.freeze({ ...candidate, route, provenance });
};

/**
 * Evaluates candidate structure and delegates relationship eligibility to S2D1.
 * `valid` describes candidate shape only. Eligibility does not mean accepted,
 * trusted, persisted, injectable, or materialized as a Context Item.
 */
export const evaluatePromotedContextCandidate = (
  topology: PromotedContextRouteTopology,
  candidate: PromotedContextCandidate,
): PromotedContextCandidateEvaluation => {
  const capturedEvidence = captureJointlyStableStructuralDataList([
    candidate,
    topology,
  ]);
  if (!capturedEvidence.stable[0]) {
    return Object.freeze({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
  }

  const capturedCandidate = capturedEvidence.data[0];
  const parsedCandidate = parseCapturedCandidate(capturedCandidate);
  if (parsedCandidate === null) {
    return Object.freeze({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
  }

  const canonicalCandidate = freezeCandidate(parsedCandidate);
  if (!capturedEvidence.stable[1] || !capturedEvidence.jointlyConsistent) {
    return Object.freeze({
      valid: true,
      eligibleForPromotion: false,
      reason: "INVALID_TOPOLOGY",
      candidate: canonicalCandidate,
    });
  }

  const capturedRoute = Object.getOwnPropertyDescriptor(
    capturedCandidate as object,
    "route",
  )?.value as PromotedContextRoute;
  const routeEvaluation = evaluatePromotedContextRoute(
    capturedEvidence.data[1] as PromotedContextRouteTopology,
    capturedRoute,
  );
  if (routeEvaluation.reason === "INVALID_ROUTE") {
    return Object.freeze({
      valid: false,
      eligibleForPromotion: false,
      reason: routeEvaluation.reason,
    });
  }
  return Object.freeze({
    valid: true,
    eligibleForPromotion: routeEvaluation.eligible,
    reason: routeEvaluation.reason,
    candidate: canonicalCandidate,
  });
};
