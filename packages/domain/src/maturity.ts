import { SubtaskMaturitySchema } from "./tasks.js";
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
): SubtaskMaturityTransitionResult => {
  const parsedFrom = SubtaskMaturitySchema.safeParse(from);
  const parsedTo = SubtaskMaturitySchema.safeParse(to);
  if (!parsedFrom.success || !parsedTo.success) {
    return { allowed: false, errorCodes: ["UNSUPPORTED_MATURITY_TRANSITION"] };
  }
  return NEXT_MATURITY[parsedFrom.data] === parsedTo.data
    ? { allowed: true, errorCodes: [] }
    : { allowed: false, errorCodes: ["UNSUPPORTED_MATURITY_TRANSITION"] };
};
