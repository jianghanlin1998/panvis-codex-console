import {
  SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  SUPPORTED_CLIENT_REQUEST_METHODS,
  SUPPORTED_SERVER_NOTIFICATION_METHODS,
  SUPPORTED_SERVER_REQUEST_METHODS,
} from "./protocol.js";

export const TESTED_CODEX_VERSION = "codex-cli 0.147.0-alpha.6.5" as const;

export const EXCLUDED_EXPERIMENTAL_CAPABILITIES = [
  "dynamicTools",
  "paginated-thread creation",
  "permission profiles",
  "process/spawn",
] as const;

export interface ProtocolCompatibilityRecord {
  readonly checkedOn: string;
  readonly codexVersion: string;
  readonly excludedExperimentalCapabilities: readonly string[];
  readonly fixtureVersion: string;
  readonly stableMethodsCovered: readonly string[];
}

export const S0C_PROTOCOL_COMPATIBILITY: ProtocolCompatibilityRecord = {
  checkedOn: "2026-08-09",
  codexVersion: TESTED_CODEX_VERSION,
  excludedExperimentalCapabilities: EXCLUDED_EXPERIMENTAL_CAPABILITIES,
  fixtureVersion: "1.0.0",
  stableMethodsCovered: [
    ...SUPPORTED_CLIENT_REQUEST_METHODS,
    ...SUPPORTED_CLIENT_NOTIFICATION_METHODS,
    ...SUPPORTED_SERVER_NOTIFICATION_METHODS,
    ...SUPPORTED_SERVER_REQUEST_METHODS,
  ],
};

export type CompatibilityAssessment =
  | {
      readonly compatible: true;
      readonly requiresRevalidation: false;
      readonly status: "tested";
    }
  | {
      readonly compatible: false;
      readonly requiresRevalidation: true;
      readonly status: "unknown-incompatible";
    };

export function assessCodexCompatibility(version: string): CompatibilityAssessment {
  if (version === TESTED_CODEX_VERSION) {
    return {
      compatible: true,
      requiresRevalidation: false,
      status: "tested",
    };
  }

  return {
    compatible: false,
    requiresRevalidation: true,
    status: "unknown-incompatible",
  };
}
