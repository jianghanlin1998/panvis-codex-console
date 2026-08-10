import type { SubtaskMaturity } from "./tasks.js";

export type SubtaskMaturityTransitionErrorCode =
  "UNSUPPORTED_MATURITY_TRANSITION";

export interface SubtaskMaturityTransitionResult {
  readonly allowed: boolean;
  readonly errorCodes: readonly SubtaskMaturityTransitionErrorCode[];
}

const NEXT_MATURITY = {
  NOT_STARTED: "IMPLEMENTED",
  IMPLEMENTED: "HARDENED",
  HARDENED: "ACCEPTED",
  ACCEPTED: null,
} as const satisfies Record<SubtaskMaturity, SubtaskMaturity | null>;

export const validateSubtaskMaturityTransition = (
  from: SubtaskMaturity,
  to: SubtaskMaturity,
): SubtaskMaturityTransitionResult =>
  NEXT_MATURITY[from] === to
    ? { allowed: true, errorCodes: [] }
    : { allowed: false, errorCodes: ["UNSUPPORTED_MATURITY_TRANSITION"] };
