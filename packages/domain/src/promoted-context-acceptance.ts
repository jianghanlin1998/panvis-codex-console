import { z } from "zod";

import type { ContextKind } from "./context.js";
import {
  evaluatePromotedContextCandidate,
} from "./promoted-context-candidate.js";
import type {
  PromotedContextCandidate,
} from "./promoted-context-candidate.js";
import type {
  PromotedContextRouteTopology,
} from "./promoted-context-route.js";

export const PromotedContextAcceptanceRequirementSchema = z.enum([
  "HUMAN_CONFIRMATION_REQUIRED",
  "DETERMINISTIC_EVIDENCE_OR_HUMAN",
]);

const PromotedContextAcceptanceNonEligibleReasonSchema = z.enum([
  "INVALID_CANDIDATE",
  "SOURCE_SUBTASK_NOT_FOUND",
  "TARGET_BIG_TASK_NOT_FOUND",
  "TARGET_SUBTASK_NOT_FOUND",
  "NOT_SOURCE_PARENT_BIG_TASK",
  "NO_EXPLICIT_DEPENDENCY",
  "REVERSE_DIRECTION_NOT_ALLOWED",
  "CROSS_BIG_TASK_NOT_ALLOWED",
  "CROSS_PROJECT_NOT_ALLOWED",
  "INVALID_TOPOLOGY",
  "INVALID_ROUTE",
]);

export const PromotedContextAcceptanceReasonSchema = z.enum([
  ...PromotedContextAcceptanceNonEligibleReasonSchema.options,
  "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
  "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
]);

export const PromotedContextAcceptanceEvaluationSchema = z.union([
  z
    .object({
      acceptanceEligible: z.literal(false),
      reason: PromotedContextAcceptanceNonEligibleReasonSchema,
    })
    .strict(),
  z
    .object({
      acceptanceEligible: z.literal(true),
      requirement: z.literal("HUMAN_CONFIRMATION_REQUIRED"),
      reason: z.literal("HUMAN_CONFIRMATION_REQUIRED_BY_KIND"),
    })
    .strict(),
  z
    .object({
      acceptanceEligible: z.literal(true),
      requirement: z.literal("DETERMINISTIC_EVIDENCE_OR_HUMAN"),
      reason: z.literal(
        "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
      ),
    })
    .strict(),
]);

export type PromotedContextAcceptanceRequirement = z.infer<
  typeof PromotedContextAcceptanceRequirementSchema
>;
export type PromotedContextAcceptanceReason = z.infer<
  typeof PromotedContextAcceptanceReasonSchema
>;
export type PromotedContextAcceptanceEvaluation = z.infer<
  typeof PromotedContextAcceptanceEvaluationSchema
>;

type EligibleAcceptanceEvaluation = Extract<
  PromotedContextAcceptanceEvaluation,
  { readonly acceptanceEligible: true }
>;

const HUMAN_CONFIRMATION_POLICY = Object.freeze({
  acceptanceEligible: true,
  requirement: "HUMAN_CONFIRMATION_REQUIRED",
  reason: "HUMAN_CONFIRMATION_REQUIRED_BY_KIND",
}) satisfies EligibleAcceptanceEvaluation;

const ENGINEERING_FACT_POLICY = Object.freeze({
  acceptanceEligible: true,
  requirement: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
  reason: "ENGINEERING_FACT_DETERMINISTIC_EVIDENCE_OR_HUMAN",
}) satisfies EligibleAcceptanceEvaluation;

const ACCEPTANCE_POLICY_BY_KIND: Readonly<
  Record<ContextKind, EligibleAcceptanceEvaluation>
> = Object.freeze({
  DECISION: HUMAN_CONFIRMATION_POLICY,
  REQUIREMENT: HUMAN_CONFIRMATION_POLICY,
  CONSTRAINT: HUMAN_CONFIRMATION_POLICY,
  ENGINEERING_FACT: ENGINEERING_FACT_POLICY,
  OPEN_QUESTION: HUMAN_CONFIRMATION_POLICY,
  RISK: HUMAN_CONFIRMATION_POLICY,
});

const nonEligibleDecision = (
  reason: unknown,
): PromotedContextAcceptanceEvaluation => {
  const parsedReason = PromotedContextAcceptanceNonEligibleReasonSchema.safeParse(reason);
  return Object.freeze({
    acceptanceEligible: false,
    reason: parsedReason.success ? parsedReason.data : "INVALID_CANDIDATE",
  });
};

/**
 * Declares the authority path required before a promotion-eligible candidate
 * could later be accepted. This evaluator neither validates authority evidence
 * nor creates an acceptance decision or accepted context record.
 */
export const evaluatePromotedContextAcceptanceRequirement = (
  topology: PromotedContextRouteTopology,
  candidate: PromotedContextCandidate,
): PromotedContextAcceptanceEvaluation => {
  const candidateEvaluation = evaluatePromotedContextCandidate(topology, candidate);
  if (!candidateEvaluation.eligibleForPromotion) {
    return nonEligibleDecision(candidateEvaluation.reason);
  }

  return ACCEPTANCE_POLICY_BY_KIND[candidateEvaluation.candidate.kind];
};
