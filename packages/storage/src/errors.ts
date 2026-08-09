export const STORAGE_ERROR_CODES = [
  "DATABASE_OPEN_FAILED",
  "DATABASE_CLOSE_FAILED",
  "DATABASE_CLOSED",
  "MIGRATION_FAILED",
  "INVALID_INPUT",
  "CONFLICT",
  "PARENT_NOT_FOUND",
  "DEPENDENCY_VALIDATION_FAILED",
  "MALFORMED_STORED_DATA",
  "STORAGE_OPERATION_FAILED",
  "TRANSACTION_FAILED",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export class TaskStorageError extends Error {
  readonly code: StorageErrorCode;
  readonly validationCodes: readonly string[];

  constructor(code: StorageErrorCode, message: string, validationCodes: readonly string[] = []) {
    super(message);
    this.name = "TaskStorageError";
    this.code = code;
    this.validationCodes = Object.freeze([...validationCodes]);
  }
}
