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

type StructuralObservation =
  | { readonly kind: "PRIMITIVE"; readonly value: unknown }
  | {
      readonly kind: "OBJECT" | "ARRAY";
      readonly prototype: "OBJECT" | "NULL" | "ARRAY";
      readonly keys: readonly string[];
      readonly descriptors: readonly {
        readonly key: string;
        readonly enumerable: boolean;
        readonly configurable: boolean;
        readonly writable: boolean;
        readonly value: StructuralObservation;
      }[];
    };

interface StructuralCapture {
  readonly data: unknown;
  readonly observation: StructuralObservation;
}

interface StableStructuralCaptureResult {
  readonly stable: readonly boolean[];
  readonly data: readonly unknown[];
}

const structuralObservationsEqual = (
  left: StructuralObservation,
  right: StructuralObservation,
): boolean => {
  if (left.kind === "PRIMITIVE" || right.kind === "PRIMITIVE") {
    return (
      left.kind === "PRIMITIVE" &&
      right.kind === "PRIMITIVE" &&
      Object.is(left.value, right.value)
    );
  }
  if (
    left.kind !== right.kind ||
    left.prototype !== right.prototype ||
    left.keys.length !== right.keys.length ||
    left.keys.some((key, index) => key !== right.keys[index]) ||
    left.descriptors.length !== right.descriptors.length
  ) {
    return false;
  }
  return left.descriptors.every((descriptor, index) => {
    const other = right.descriptors[index];
    return (
      other !== undefined &&
      descriptor.key === other.key &&
      descriptor.enumerable === other.enumerable &&
      descriptor.configurable === other.configurable &&
      descriptor.writable === other.writable &&
      structuralObservationsEqual(descriptor.value, other.value)
    );
  });
};

const captureStructuralDataOnce = (
  input: unknown,
  ancestors: Set<object>,
): StructuralCapture | null => {
  try {
    if ((typeof input !== "object" && typeof input !== "function") || input === null) {
      return {
        data: input,
        observation: { kind: "PRIMITIVE", value: input },
      };
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
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
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
      const capturedDescriptors: Array<{
        readonly key: string;
        readonly descriptor: PropertyDescriptor & { readonly value: unknown };
        readonly capture: StructuralCapture;
      }> = [];
      for (const { key, descriptor } of descriptors) {
        if (descriptor === undefined || !("value" in descriptor)) {
          return null;
        }
        const capture = captureStructuralDataOnce(descriptor.value, ancestors);
        if (capture === null) {
          return null;
        }
        capturedDescriptors.push({
          key,
          descriptor: descriptor as PropertyDescriptor & { readonly value: unknown },
          capture,
        });
      }

      let data: unknown;
      if (isArray) {
        const lengthDescriptor = descriptors.find(({ key }) => key === "length")!.descriptor!;
        const length = (lengthDescriptor as PropertyDescriptor & { value: number }).value;
        data = Array.from({ length }, (_, index) =>
          capturedDescriptors.find(({ key }) => key === String(index))!.capture.data,
        );
      } else {
        const capturedRecord = Object.create(
          prototype === null ? null : Object.prototype,
        ) as Record<string, unknown>;
        for (const { key, capture } of capturedDescriptors) {
          Object.defineProperty(capturedRecord, key, {
            value: capture.data,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        data = capturedRecord;
      }

      return {
        data,
        observation: {
          kind: isArray ? "ARRAY" : "OBJECT",
          prototype: isArray ? "ARRAY" : prototype === null ? "NULL" : "OBJECT",
          keys,
          descriptors: capturedDescriptors.map(({ key, descriptor, capture }) => ({
            key,
            enumerable: descriptor.enumerable ?? false,
            configurable: descriptor.configurable ?? false,
            writable: descriptor.writable ?? false,
            value: capture.observation,
          })),
        },
      };
    } finally {
      ancestors.delete(input);
    }
  } catch {
    return null;
  }
};

const captureStableStructuralDataList = (
  inputs: readonly unknown[],
): StableStructuralCaptureResult => {
  const passes = Array.from({ length: 3 }, () =>
    inputs.map((input) => captureStructuralDataOnce(input, new Set<object>())),
  );
  const stable = inputs.map((_input, inputIndex) => {
    const first = passes[0]?.[inputIndex];
    return (
      first !== undefined &&
      first !== null &&
      passes.slice(1).every((pass) => {
        const capture = pass[inputIndex];
        return (
          capture !== undefined &&
          capture !== null &&
          structuralObservationsEqual(first.observation, capture.observation)
        );
      })
    );
  });
  return {
    stable,
    data: inputs.map((_input, inputIndex) =>
      stable[inputIndex] ? passes[0]![inputIndex]!.data : undefined,
    ),
  };
};

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
  const capturedEvidence = captureStableStructuralDataList([candidate, topology]);
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
  if (!capturedEvidence.stable[1]) {
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
