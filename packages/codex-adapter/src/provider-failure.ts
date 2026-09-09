/** Classify only structured provider fields. Never retain error messages or details. */
export function providerFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("codexErrorInfo" in error)) return undefined;
  const info: unknown = error.codexErrorInfo;
  const key = typeof info === "string" ? info : info && typeof info === "object" && !Array.isArray(info) && Object.keys(info).length === 1 ? Object.keys(info)[0] : undefined;
  if (!key) return undefined;
  const tag = key[0]!.toLowerCase() + key.slice(1);
  if (tag === "contextWindowExceeded") return "MODEL_CONTEXT_TOO_LARGE";
  if (tag === "usageLimitExceeded") return "MODEL_ACCOUNT_LIMIT";
  if (tag === "unauthorized") return "CHATGPT_AUTH_REQUIRED";
  if (tag === "badRequest") return "MODEL_REQUEST_REJECTED";
  if (["responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].includes(tag)) return "MODEL_CONNECTION_FAILED";
  if (tag === "httpConnectionFailed") {
    const details: unknown = typeof info === "object" && info !== null ? (info as Record<string, unknown>)[key] : undefined;
    const status = details && typeof details === "object" && "httpStatusCode" in details ? details.httpStatusCode : undefined;
    if (status === 401) return "CHATGPT_AUTH_REQUIRED";
    if (status === 429) return "MODEL_ACCOUNT_LIMIT";
    if (typeof status === "number" && status >= 400 && status < 500) return "MODEL_REQUEST_REJECTED";
    return "MODEL_CONNECTION_FAILED";
  }
  return undefined;
}
