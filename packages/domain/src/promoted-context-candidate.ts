import { z } from "zod";

import { ContextKindSchema, ContextSourceTypeSchema } from "./context.js";
import {
  PromotedContextRouteReasonSchema,
  PromotedContextRouteSchema,
  evaluatePromotedContextRoute,
} from "./promoted-context-route.js";
import type {
  PromotedContextRouteReason,
  PromotedContextRouteTopology,
} from "./promoted-context-route.js";

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
      reason: "INVALID_CANDIDATE";
    }>
  | Readonly<{
      valid: true;
      eligibleForPromotion: boolean;
      reason: PromotedContextRouteReason;
      candidate: PromotedContextCandidate;
    }>;

const captureDataProperties = (
  input: unknown,
  ancestors: Set<object>,
): unknown | null => {
  try {
    if ((typeof input !== "object" && typeof input !== "function") || input === null) {
      return input;
    }
    if (typeof input === "function" || ancestors.has(input)) {
      return null;
    }

    const isArray = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.some((key) => typeof key !== "string")) {
      return null;
    }
    const keys = ownKeys as string[];
    const descriptors = keys.map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(input, key),
    }));
    if (
      descriptors.some(
        ({ descriptor }) => descriptor === undefined || !("value" in descriptor),
      )
    ) {
      return null;
    }

    if (isArray) {
      const lengthDescriptor = descriptors.find(({ key }) => key === "length")?.descriptor;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return null;
      }
      const expectedKeys = [
        ...Array.from({ length: lengthDescriptor.value as number }, (_, index) =>
          String(index),
        ),
        "length",
      ];
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index]) ||
        descriptors.some(
          ({ key, descriptor }) =>
            key !== "length" && descriptor !== undefined && !descriptor.enumerable,
        )
      ) {
        return null;
      }
    } else if (descriptors.some(({ descriptor }) => !descriptor?.enumerable)) {
      return null;
    }

    ancestors.add(input);
    try {
      if (isArray) {
        const length = (
          descriptors.find(({ key }) => key === "length")!.descriptor as PropertyDescriptor & {
            value: number;
          }
        ).value;
        const captured: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors.find(({ key }) => key === String(index))!.descriptor as
            | (PropertyDescriptor & { value: unknown })
            | undefined;
          if (descriptor === undefined) {
            return null;
          }
          const value = captureDataProperties(descriptor.value, ancestors);
          if (value === null && descriptor.value !== null) {
            return null;
          }
          captured.push(value);
        }
        return captured;
      }

      const captured = Object.create(
        prototype === null ? null : Object.prototype,
      ) as Record<string, unknown>;
      for (const { key, descriptor } of descriptors) {
        const dataDescriptor = descriptor as PropertyDescriptor & { value: unknown };
        const value = captureDataProperties(dataDescriptor.value, ancestors);
        if (value === null && dataDescriptor.value !== null) {
          return null;
        }
        Object.defineProperty(captured, key, {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      return captured;
    } finally {
      ancestors.delete(input);
    }
  } catch {
    return null;
  }
};

const parseCandidate = (input: unknown): PromotedContextCandidate | null => {
  const captured = captureDataProperties(input, new Set<object>());
  if (captured === null) {
    return null;
  }
  const parsed = PromotedContextCandidateSchema.safeParse(captured);
  return parsed.success ? parsed.data : null;
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
  const parsedCandidate = parseCandidate(candidate);
  if (parsedCandidate === null) {
    return Object.freeze({
      valid: false,
      eligibleForPromotion: false,
      reason: "INVALID_CANDIDATE",
    });
  }

  const canonicalCandidate = freezeCandidate(parsedCandidate);
  const routeEvaluation = evaluatePromotedContextRoute(
    topology,
    canonicalCandidate.route,
  );
  return Object.freeze({
    valid: true,
    eligibleForPromotion: routeEvaluation.eligible,
    reason: routeEvaluation.reason,
    candidate: canonicalCandidate,
  });
};
