export const CODEX_ADAPTER_ERROR_CODES = [
  "INVALID_SCHEMA_OUTPUT_PATH",
  "CODEX_CLI_NOT_FOUND",
  "SCHEMA_GENERATION_FAILED",
  "MOCK_PROTOCOL_ERROR",
  "MOCK_PROTOCOL_TIMEOUT",
  "MOCK_PROCESS_DISCONNECTED",
] as const;

export type CodexAdapterErrorCode = (typeof CODEX_ADAPTER_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<CodexAdapterErrorCode, string>> = {
  CODEX_CLI_NOT_FOUND: "Codex CLI is unavailable; schema generation was not run.",
  INVALID_SCHEMA_OUTPUT_PATH:
    "Schema output must be an explicit temporary or repository-ignored path.",
  MOCK_PROCESS_DISCONNECTED:
    "Mock App Server disconnected before a pending request resolved.",
  MOCK_PROTOCOL_ERROR: "Mock App Server reported a sanitized protocol error.",
  MOCK_PROTOCOL_TIMEOUT: "Mock App Server did not respond within the bounded timeout.",
  SCHEMA_GENERATION_FAILED: "Codex protocol schema generation failed.",
};

export class CodexAdapterError extends Error {
  public readonly code: CodexAdapterErrorCode;

  public constructor(code: CodexAdapterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}
