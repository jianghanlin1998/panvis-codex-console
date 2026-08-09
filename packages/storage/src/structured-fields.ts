import { TaskStorageError } from "./errors.js";

export const encodeStringArray = (values: readonly string[]): string => JSON.stringify([...values]);

export const decodeStringArray = (encoded: string): readonly unknown[] => {
  try {
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value)) {
      throw new TaskStorageError(
        "MALFORMED_STORED_DATA",
        "Stored structured task data is malformed.",
      );
    }
    return [...value];
  } catch (error) {
    if (error instanceof TaskStorageError) {
      throw error;
    }
    throw new TaskStorageError(
      "MALFORMED_STORED_DATA",
      "Stored structured task data is malformed.",
    );
  }
};
