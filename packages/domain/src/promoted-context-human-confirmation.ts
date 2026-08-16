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

interface EvidenceEnvelopeObservation {
  readonly prototype: "OBJECT" | "NULL";
  readonly keys: readonly string[];
  readonly descriptors: readonly {
    readonly key: string;
    readonly enumerable: boolean;
    readonly configurable: boolean;
    readonly writable: boolean;
    readonly value: unknown;
  }[];
}

interface EvidenceEnvelopeCapture {
  readonly data: unknown;
  readonly observation: EvidenceEnvelopeObservation;
}

const EVIDENCE_ENVELOPE_KEYS = Object.freeze([
  "evidenceType",
  "sourceReference",
  "occurredAt",
] as const);

const keysEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

const descriptorsEqual = (
  left: PropertyDescriptor & { readonly value: unknown },
  right: PropertyDescriptor & { readonly value: unknown },
): boolean =>
  left.enumerable === right.enumerable &&
  left.configurable === right.configurable &&
  left.writable === right.writable &&
  Object.is(left.value, right.value);

const observationsEqual = (
  left: EvidenceEnvelopeObservation,
  right: EvidenceEnvelopeObservation,
): boolean =>
  left.prototype === right.prototype &&
  keysEqual(left.keys, right.keys) &&
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

const rotateKeys = (
  keys: readonly string[],
  passIndex: number,
): readonly string[] => {
  if (keys.length < 2 || passIndex === 0) {
    return keys;
  }
  if (passIndex === 1) {
    return [...keys].reverse();
  }
  return [...keys.slice(1), keys[0]!];
};

const captureEvidenceEnvelopeOnce = (
  input: unknown,
  passIndex: number,
): EvidenceEnvelopeCapture | null => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const prototypeBefore = Object.getPrototypeOf(input) as unknown;
    if (prototypeBefore !== Object.prototype && prototypeBefore !== null) {
      return null;
    }

    const ownKeysBefore = Reflect.ownKeys(input);
    if (ownKeysBefore.some((key) => typeof key !== "string")) {
      return null;
    }
    const keys = ownKeysBefore as string[];
    if (
      keys.length !== EVIDENCE_ENVELOPE_KEYS.length ||
      keys.some(
        (key) =>
          !EVIDENCE_ENVELOPE_KEYS.some((expectedKey) => expectedKey === key),
      )
    ) {
      return null;
    }
    const descriptorOrder = rotateKeys(keys, passIndex);
    const firstDescriptors = new Map<
      string,
      PropertyDescriptor & { readonly value: unknown }
    >();
    for (const key of descriptorOrder) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return null;
      }
      firstDescriptors.set(
        key,
        descriptor as PropertyDescriptor & { readonly value: unknown },
      );
    }

    for (const key of [...descriptorOrder].reverse()) {
      const firstDescriptor = firstDescriptors.get(key);
      const repeatedDescriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        firstDescriptor === undefined ||
        repeatedDescriptor === undefined ||
        !("value" in repeatedDescriptor) ||
        !descriptorsEqual(
          firstDescriptor,
          repeatedDescriptor as PropertyDescriptor & { readonly value: unknown },
        )
      ) {
        return null;
      }
    }

    const ownKeysAfter = Reflect.ownKeys(input);
    if (
      ownKeysAfter.some((key) => typeof key !== "string") ||
      !keysEqual(keys, ownKeysAfter as string[])
    ) {
      return null;
    }
    const prototypeAfter = Object.getPrototypeOf(input) as unknown;
    if (prototypeAfter !== prototypeBefore) {
      return null;
    }

    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = firstDescriptors.get(key);
      if (descriptor === undefined || !descriptor.enumerable) {
        return null;
      }
      Object.defineProperty(captured, key, {
        value: descriptor.value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    return {
      data: captured,
      observation: {
        prototype: prototypeBefore === null ? "NULL" : "OBJECT",
        keys,
        descriptors: keys.map((key) => {
          const descriptor = firstDescriptors.get(key)!;
          return {
            key,
            enumerable: descriptor.enumerable ?? false,
            configurable: descriptor.configurable ?? false,
            writable: descriptor.writable ?? false,
            value: descriptor.value,
          };
        }),
      },
    };
  } catch {
    return null;
  }
};

const captureStableEvidenceEnvelope = (input: unknown): unknown | null => {
  const captures: EvidenceEnvelopeCapture[] = [];
  for (let passIndex = 0; passIndex < 3; passIndex += 1) {
    const capture = captureEvidenceEnvelopeOnce(input, passIndex);
    if (capture === null) {
      return null;
    }
    captures.push(capture);
  }
  const first = captures[0]!;
  return captures
    .slice(1)
    .every((capture) => observationsEqual(first.observation, capture.observation))
    ? first.data
    : null;
};

const parseCanonicalEvidence = (
  input: unknown,
): PromotedContextHumanConfirmationEvidence | null => {
  const captured = captureStableEvidenceEnvelope(input);
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
