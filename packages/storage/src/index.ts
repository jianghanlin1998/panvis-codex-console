export { TaskStorageError, STORAGE_ERROR_CODES } from "./errors.js";
export type { StorageErrorCode } from "./errors.js";

export {
  auditEventsTable,
  bigTasksTable,
  contextDigestsTable,
  contextItemsTable,
  projectsTable,
  subtasksTable,
  taskDependenciesTable,
} from "./schema.js";

export { openTaskDatabase, TaskStorage } from "./task-storage.js";
export type { OpenTaskDatabaseOptions } from "./task-storage.js";
