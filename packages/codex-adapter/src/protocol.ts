export const SUPPORTED_CLIENT_REQUEST_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
  "thread/goal/set",
  "thread/goal/get",
  "skills/list",
] as const;

export const SUPPORTED_CLIENT_NOTIFICATION_METHODS = ["initialized"] as const;

export const SUPPORTED_SERVER_NOTIFICATION_METHODS = [
  "thread/started",
  "thread/goal/updated",
  "turn/started",
  "item/started",
  "item/agentMessage/delta",
  "item/completed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "serverRequest/resolved",
] as const;

export const SUPPORTED_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
] as const;

export type ClientRequestMethod = (typeof SUPPORTED_CLIENT_REQUEST_METHODS)[number];
export type ClientNotificationMethod =
  (typeof SUPPORTED_CLIENT_NOTIFICATION_METHODS)[number];
export type ServerNotificationMethod =
  (typeof SUPPORTED_SERVER_NOTIFICATION_METHODS)[number];
export type ServerRequestMethod = (typeof SUPPORTED_SERVER_REQUEST_METHODS)[number];

export type ProtocolRequestId = number | string;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
  | boolean
  | JsonObject
  | JsonValue[]
  | null
  | number
  | string;

export interface ProtocolRequest<
  TMethod extends string = string,
  TParams extends JsonValue = JsonObject,
> {
  readonly id: ProtocolRequestId;
  readonly method: TMethod;
  readonly params: TParams;
}

export interface ProtocolNotification<
  TMethod extends string = string,
  TParams extends JsonValue = JsonObject,
> {
  readonly method: TMethod;
  readonly params?: TParams;
}

export interface ProtocolErrorPayload {
  readonly code: number;
  readonly message: string;
}

export type ProtocolResponse<TResult extends JsonValue = JsonValue> =
  | {
      readonly id: ProtocolRequestId | null;
      readonly result: TResult;
    }
  | {
      readonly error: ProtocolErrorPayload;
      readonly id: ProtocolRequestId | null;
    };

export interface TokenUsageBreakdown {
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface ThreadTokenUsage {
  readonly last: TokenUsageBreakdown;
  readonly modelContextWindow: number | null;
  readonly total: TokenUsageBreakdown;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "cancel" | "decline";

export function isProtocolResponse(value: unknown): value is ProtocolResponse {
  if (!isRecord(value) || !("id" in value) || "method" in value) {
    return false;
  }

  return "result" in value || "error" in value;
}

export function isProtocolRequest(value: unknown): value is ProtocolRequest {
  return (
    isRecord(value) &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    typeof value.method === "string" &&
    "params" in value
  );
}

export function isProtocolMessage(value: unknown): value is JsonObject {
  return isRecord(value) && ("method" in value || "id" in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
