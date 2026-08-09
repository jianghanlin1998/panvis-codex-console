import { DatabaseSync } from "node:sqlite";

import {
  BigTaskIdSchema,
  BigTaskSchema,
  ProjectIdSchema,
  ProjectSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  SubtaskSchema,
  validateSubtaskDependencies,
} from "@codex-task-console/domain";
import type {
  BigTask,
  BigTaskId,
  DependencySubtask,
  Project,
  ProjectId,
  Subtask,
  SubtaskDependency,
  SubtaskId,
} from "@codex-task-console/domain";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { TaskStorageError } from "./errors.js";
import { defaultMigrationsFolder, runMigrations } from "./migrations.js";
import {
  bigTasksTable,
  projectsTable,
  subtasksTable,
  taskDependenciesTable,
} from "./schema.js";
import { decodeStringArray, encodeStringArray } from "./structured-fields.js";

export interface OpenTaskDatabaseOptions {
  readonly databasePath: string;
  readonly clock?: () => Date;
  readonly migrationsFolder?: string;
}

type ProjectRow = typeof projectsTable.$inferSelect;
type BigTaskRow = typeof bigTasksTable.$inferSelect;
type SubtaskRow = typeof subtasksTable.$inferSelect;

const invalidInput = (entity: string): TaskStorageError =>
  new TaskStorageError("INVALID_INPUT", `${entity} input does not satisfy the domain contract.`);

const parseProjectInput = (input: Project): Project => {
  const result = ProjectSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Project");
  }
  return result.data;
};

const parseBigTaskInput = (input: BigTask): BigTask => {
  const result = BigTaskSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Big Task");
  }
  return result.data;
};

const parseSubtaskInput = (input: Subtask): Subtask => {
  const result = SubtaskSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Subtask");
  }
  return result.data;
};

const parseProjectId = (input: ProjectId): ProjectId => {
  const result = ProjectIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Project ID");
  }
  return result.data;
};

const parseBigTaskId = (input: BigTaskId): BigTaskId => {
  const result = BigTaskIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Big Task ID");
  }
  return result.data;
};

const parseSubtaskId = (input: SubtaskId): SubtaskId => {
  const result = SubtaskIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Subtask ID");
  }
  return result.data;
};

const parseDependencyInput = (input: SubtaskDependency): SubtaskDependency => {
  const result = SubtaskDependencySchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Subtask dependency");
  }
  return result.data;
};

const malformedStoredData = (): TaskStorageError =>
  new TaskStorageError("MALFORMED_STORED_DATA", "Stored task data is malformed.");

const projectFromRow = (row: ProjectRow): Project => {
  const repository =
    row.repositoryKind === "PATH"
      ? { kind: "PATH", path: row.repositoryValue }
      : { kind: row.repositoryKind, reference: row.repositoryValue };
  const result = ProjectSchema.safeParse({
    recordType: "PROJECT",
    id: row.id,
    name: row.name,
    slug: row.slug,
    repository,
    defaultBranch: row.defaultBranch,
    maxActiveCodingSubtasks: row.maxActiveCodingSubtasks,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  return result.data;
};

const bigTaskFromRow = (row: BigTaskRow): BigTask => {
  const result = BigTaskSchema.safeParse({
    recordType: "BIG_TASK",
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    goal: row.goal,
    rationale: row.rationale,
    scopeIn: decodeStringArray(row.scopeIn),
    scopeOut: decodeStringArray(row.scopeOut),
    acceptanceCriteria: decodeStringArray(row.acceptanceCriteria),
    status: row.status,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  return result.data;
};

const subtaskFromRow = (row: SubtaskRow): Subtask => {
  const result = SubtaskSchema.safeParse({
    recordType: "SUBTASK",
    id: row.id,
    bigTaskId: row.bigTaskId,
    title: row.title,
    goal: row.goal,
    scopeIn: decodeStringArray(row.scopeIn),
    scopeOut: decodeStringArray(row.scopeOut),
    acceptanceCriteria: decodeStringArray(row.acceptanceCriteria),
    untouchedAreas: decodeStringArray(row.untouchedAreas),
    status: row.status,
    startPolicy: row.startPolicy,
    delegationPolicy: row.delegationPolicy,
    recommendedReasoningLevel: row.recommendedReasoningLevel,
    promptSeed: row.promptSeed,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  return result.data;
};

const dependencyFromRow = (row: {
  readonly upstreamSubtaskId: string;
  readonly downstreamSubtaskId: string;
  readonly dependencyType: string;
}): SubtaskDependency => {
  const result = SubtaskDependencySchema.safeParse(row);
  if (!result.success) {
    throw malformedStoredData();
  }
  return result.data;
};

export class TaskStorage {
  readonly #sqlite: DatabaseSync;
  readonly #database: NodeSQLiteDatabase;
  readonly #clock: () => Date;
  #closed = false;

  constructor(sqlite: DatabaseSync, database: NodeSQLiteDatabase, clock: () => Date) {
    this.#sqlite = sqlite;
    this.#database = database;
    this.#clock = clock;
  }

  get isOpen(): boolean {
    return !this.#closed && this.#sqlite.isOpen;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#sqlite.close();
      this.#closed = true;
    } catch {
      throw new TaskStorageError("DATABASE_CLOSE_FAILED", "The task database could not be closed.");
    }
  }

  isForeignKeyEnforcementEnabled(): boolean {
    return this.#operation(() => {
      const row = this.#sqlite.prepare("PRAGMA foreign_keys").get() as
        | { readonly foreign_keys: number }
        | undefined;
      return row?.foreign_keys === 1;
    });
  }

  createProject(input: Project): Project {
    const project = parseProjectInput(input);
    return this.#operation(() => {
      const existing = this.#database
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(or(eq(projectsTable.id, project.id), eq(projectsTable.slug, project.slug)))
        .get();
      if (existing !== undefined) {
        throw new TaskStorageError("CONFLICT", "A Project with this ID or slug already exists.");
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(projectsTable)
        .values({
          id: project.id,
          name: project.name,
          slug: project.slug,
          repositoryKind: project.repository.kind,
          repositoryValue:
            project.repository.kind === "PATH"
              ? project.repository.path
              : project.repository.reference,
          defaultBranch: project.defaultBranch,
          maxActiveCodingSubtasks: project.maxActiveCodingSubtasks,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getProject(project.id);
      if (stored === null) {
        throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The Project was not persisted.");
      }
      return stored;
    });
  }

  getProjectById(input: ProjectId): Project | null {
    const projectId = parseProjectId(input);
    return this.#operation(() => this.#getProject(projectId));
  }

  getProjectBySlug(slug: string): Project | null {
    if (typeof slug !== "string" || slug.trim().length === 0) {
      throw invalidInput("Project slug");
    }
    return this.#operation(() => {
      const row = this.#database
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.slug, slug))
        .get();
      return row === undefined ? null : projectFromRow(row);
    });
  }

  listProjects(): readonly Project[] {
    return this.#operation(() =>
      this.#database
        .select()
        .from(projectsTable)
        .orderBy(asc(projectsTable.createdAt), asc(projectsTable.id))
        .all()
        .map(projectFromRow),
    );
  }

  createBigTask(input: BigTask): BigTask {
    const bigTask = parseBigTaskInput(input);
    return this.#operation(() => {
      if (this.#getProject(bigTask.projectId) === null) {
        throw new TaskStorageError("PARENT_NOT_FOUND", "The parent Project does not exist.");
      }
      if (this.#getBigTask(bigTask.id) !== null) {
        throw new TaskStorageError("CONFLICT", "A Big Task with this ID already exists.");
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(bigTasksTable)
        .values({
          id: bigTask.id,
          projectId: bigTask.projectId,
          title: bigTask.title,
          goal: bigTask.goal,
          rationale: bigTask.rationale,
          scopeIn: encodeStringArray(bigTask.scopeIn),
          scopeOut: encodeStringArray(bigTask.scopeOut),
          acceptanceCriteria: encodeStringArray(bigTask.acceptanceCriteria),
          status: bigTask.status,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getBigTask(bigTask.id);
      if (stored === null) {
        throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The Big Task was not persisted.");
      }
      return stored;
    });
  }

  getBigTaskById(input: BigTaskId): BigTask | null {
    const bigTaskId = parseBigTaskId(input);
    return this.#operation(() => this.#getBigTask(bigTaskId));
  }

  listBigTasksByProject(input: ProjectId): readonly BigTask[] {
    const projectId = parseProjectId(input);
    return this.#operation(() =>
      this.#database
        .select()
        .from(bigTasksTable)
        .where(eq(bigTasksTable.projectId, projectId))
        .orderBy(asc(bigTasksTable.createdAt), asc(bigTasksTable.id))
        .all()
        .map(bigTaskFromRow),
    );
  }

  createSubtask(input: Subtask): Subtask {
    const subtask = parseSubtaskInput(input);
    return this.#operation(() => {
      if (this.#getBigTask(subtask.bigTaskId) === null) {
        throw new TaskStorageError("PARENT_NOT_FOUND", "The parent Big Task does not exist.");
      }
      if (this.#getSubtask(subtask.id) !== null) {
        throw new TaskStorageError("CONFLICT", "A Subtask with this ID already exists.");
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(subtasksTable)
        .values({
          id: subtask.id,
          bigTaskId: subtask.bigTaskId,
          title: subtask.title,
          goal: subtask.goal,
          scopeIn: encodeStringArray(subtask.scopeIn),
          scopeOut: encodeStringArray(subtask.scopeOut),
          acceptanceCriteria: encodeStringArray(subtask.acceptanceCriteria),
          untouchedAreas: encodeStringArray(subtask.untouchedAreas),
          status: subtask.status,
          startPolicy: subtask.startPolicy,
          delegationPolicy: subtask.delegationPolicy,
          recommendedReasoningLevel: subtask.recommendedReasoningLevel,
          promptSeed: subtask.promptSeed,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getSubtask(subtask.id);
      if (stored === null) {
        throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The Subtask was not persisted.");
      }
      return stored;
    });
  }

  getSubtaskById(input: SubtaskId): Subtask | null {
    const subtaskId = parseSubtaskId(input);
    return this.#operation(() => this.#getSubtask(subtaskId));
  }

  listSubtasksByBigTask(input: BigTaskId): readonly Subtask[] {
    const bigTaskId = parseBigTaskId(input);
    return this.#operation(() =>
      this.#database
        .select()
        .from(subtasksTable)
        .where(eq(subtasksTable.bigTaskId, bigTaskId))
        .orderBy(asc(subtasksTable.createdAt), asc(subtasksTable.id))
        .all()
        .map(subtaskFromRow),
    );
  }

  replaceDependenciesForBigTask(
    input: BigTaskId,
    dependencyInputs: readonly SubtaskDependency[],
  ): readonly SubtaskDependency[] {
    const bigTaskId = parseBigTaskId(input);
    const dependencies = dependencyInputs.map(parseDependencyInput);
    return this.#operation(() => {
      if (this.#getBigTask(bigTaskId) === null) {
        throw new TaskStorageError("PARENT_NOT_FOUND", "The Big Task does not exist.");
      }

      const allSubtasks = this.#allDependencySubtasks();
      const validation = validateSubtaskDependencies(allSubtasks, dependencies);
      if (!validation.valid) {
        throw new TaskStorageError(
          "DEPENDENCY_VALIDATION_FAILED",
          "The dependency set is invalid.",
          validation.errors.map(({ code }) => code),
        );
      }

      const subtasksById = new Map(allSubtasks.map((subtask) => [subtask.id, subtask]));
      const outsideRequestedBigTask = dependencies.some(
        (dependency) =>
          subtasksById.get(dependency.upstreamSubtaskId)?.bigTaskId !== bigTaskId ||
          subtasksById.get(dependency.downstreamSubtaskId)?.bigTaskId !== bigTaskId,
      );
      if (outsideRequestedBigTask) {
        throw new TaskStorageError(
          "DEPENDENCY_VALIDATION_FAILED",
          "The dependency set is invalid.",
          ["DEPENDENCY_BIG_TASK_MISMATCH"],
        );
      }

      return this.#atomic(() => {
        const targetSubtaskIds = allSubtasks
          .filter((subtask) => subtask.bigTaskId === bigTaskId)
          .map(({ id }) => id);
        if (targetSubtaskIds.length > 0) {
          this.#database
            .delete(taskDependenciesTable)
            .where(inArray(taskDependenciesTable.downstreamSubtaskId, targetSubtaskIds))
            .run();
        }

        if (dependencies.length > 0) {
          const timestamp = this.#timestamp();
          this.#database
            .insert(taskDependenciesTable)
            .values(
              dependencies.map((dependency) => ({
                upstreamSubtaskId: dependency.upstreamSubtaskId,
                downstreamSubtaskId: dependency.downstreamSubtaskId,
                dependencyType: dependency.dependencyType,
                createdAt: timestamp,
              })),
            )
            .run();
        }
        return this.#listDependencies(bigTaskId);
      });
    });
  }

  listDependenciesForBigTask(input: BigTaskId): readonly SubtaskDependency[] {
    const bigTaskId = parseBigTaskId(input);
    return this.#operation(() => this.#listDependencies(bigTaskId));
  }

  runInTransaction<T>(operation: (storage: TaskStorage) => T): T {
    this.#ensureOpen();
    if (this.#sqlite.isTransaction) {
      throw new TaskStorageError("TRANSACTION_FAILED", "Nested transactions are not supported.");
    }
    return this.#atomic(() => operation(this));
  }

  #getProject(projectId: ProjectId): Project | null {
    const row = this.#database
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .get();
    return row === undefined ? null : projectFromRow(row);
  }

  #getBigTask(bigTaskId: BigTaskId): BigTask | null {
    const row = this.#database
      .select()
      .from(bigTasksTable)
      .where(eq(bigTasksTable.id, bigTaskId))
      .get();
    return row === undefined ? null : bigTaskFromRow(row);
  }

  #getSubtask(subtaskId: SubtaskId): Subtask | null {
    const row = this.#database
      .select()
      .from(subtasksTable)
      .where(eq(subtasksTable.id, subtaskId))
      .get();
    return row === undefined ? null : subtaskFromRow(row);
  }

  #allDependencySubtasks(): readonly DependencySubtask[] {
    return this.#database
      .select({ id: subtasksTable.id, bigTaskId: subtasksTable.bigTaskId })
      .from(subtasksTable)
      .all()
      .map((row) => {
        const id = SubtaskIdSchema.safeParse(row.id);
        const bigTaskId = BigTaskIdSchema.safeParse(row.bigTaskId);
        if (!id.success || !bigTaskId.success) {
          throw malformedStoredData();
        }
        return { id: id.data, bigTaskId: bigTaskId.data };
      });
  }

  #listDependencies(bigTaskId: BigTaskId): readonly SubtaskDependency[] {
    return this.#database
      .select({
        upstreamSubtaskId: taskDependenciesTable.upstreamSubtaskId,
        downstreamSubtaskId: taskDependenciesTable.downstreamSubtaskId,
        dependencyType: taskDependenciesTable.dependencyType,
      })
      .from(taskDependenciesTable)
      .innerJoin(
        subtasksTable,
        and(
          eq(taskDependenciesTable.downstreamSubtaskId, subtasksTable.id),
          eq(subtasksTable.bigTaskId, bigTaskId),
        ),
      )
      .orderBy(
        asc(taskDependenciesTable.upstreamSubtaskId),
        asc(taskDependenciesTable.downstreamSubtaskId),
        asc(taskDependenciesTable.dependencyType),
      )
      .all()
      .map(dependencyFromRow);
  }

  #timestamp(): string {
    const timestamp = this.#clock();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The storage clock is invalid.");
    }
    return timestamp.toISOString();
  }

  #ensureOpen(): void {
    if (!this.isOpen) {
      throw new TaskStorageError("DATABASE_CLOSED", "The task database is closed.");
    }
  }

  #operation<T>(operation: () => T): T {
    this.#ensureOpen();
    try {
      return operation();
    } catch (error) {
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "The task storage operation failed.",
      );
    }
  }

  #atomic<T>(operation: () => T): T {
    const ownsTransaction = !this.#sqlite.isTransaction;
    if (ownsTransaction) {
      try {
        this.#sqlite.exec("BEGIN IMMEDIATE");
      } catch {
        throw new TaskStorageError("TRANSACTION_FAILED", "The transaction could not start.");
      }
    }

    try {
      const result = operation();
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        throw new TaskStorageError(
          "TRANSACTION_FAILED",
          "Asynchronous transaction callbacks are not supported.",
        );
      }
      if (ownsTransaction) {
        this.#sqlite.exec("COMMIT");
      }
      return result;
    } catch (error) {
      if (ownsTransaction && this.#sqlite.isTransaction) {
        try {
          this.#sqlite.exec("ROLLBACK");
        } catch {
          throw new TaskStorageError("TRANSACTION_FAILED", "The transaction rollback failed.");
        }
      }
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError("TRANSACTION_FAILED", "The transaction failed and was rolled back.");
    }
  }
}

export const openTaskDatabase = (options: OpenTaskDatabaseOptions): TaskStorage => {
  if (typeof options.databasePath !== "string" || options.databasePath.trim().length === 0) {
    throw new TaskStorageError("DATABASE_OPEN_FAILED", "The task database path is invalid.");
  }

  let sqlite: DatabaseSync | undefined;
  try {
    sqlite = new DatabaseSync(options.databasePath, { timeout: 5_000 });
    sqlite.exec("PRAGMA foreign_keys = ON");
  } catch {
    try {
      sqlite?.close();
    } catch {
      // The sanitized open error remains the public failure contract.
    }
    throw new TaskStorageError("DATABASE_OPEN_FAILED", "The task database could not be opened.");
  }

  const database = drizzle({ client: sqlite });
  try {
    runMigrations(database, options.migrationsFolder ?? defaultMigrationsFolder);
  } catch {
    try {
      sqlite.close();
    } catch {
      // The migration error remains the public failure contract.
    }
    throw new TaskStorageError("MIGRATION_FAILED", "Task database migration failed.");
  }

  return new TaskStorage(sqlite, database, options.clock ?? (() => new Date()));
};
