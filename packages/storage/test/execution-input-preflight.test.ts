import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ContextScopeSchema,
  ProjectIdSchema,
  ProjectSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";
import * as storageExports from "@codex-task-console/storage";
import {
  ExecutionInputPreflight,
  ExecutionInputPreflightError,
  OperationalJitContextAssembler,
  openTaskDatabase,
} from "../src/index.js";
import type {
  ExecutionInputPreflightResult,
  OperationalJitContextProfile,
  TaskStorage,
} from "../src/index.js";
import {
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_execution_preflight");
const BIG_TASK_ID = "bt_execution_preflight";
const SUBTASK_ID = SubtaskIdSchema.parse("st_execution_preflight");
const FIXED_GIT_DATE = "2026-08-17T00:00:00Z";
const MARKER = "CODEX_TASK_CONSOLE_JIT_CONTEXT_V0\n";
const FORMAT = "CTC_JIT_CONTEXT_JSON_V0";

interface SyntheticRepository {
  readonly path: string;
  readonly head: string;
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_DATE: FIXED_GIT_DATE,
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_NAME: "Execution Preflight Fixture",
  GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Execution Preflight Fixture",
  GIT_TERMINAL_PROMPT: "0",
});

const gitOutput = (repositoryPath: string, arguments_: readonly string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repositoryPath,
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trimEnd();

const withSyntheticRepository = <T>(
  agentsBody: string,
  operation: (repository: SyntheticRepository) => T,
): T => {
  const repositoryPath = mkdtempSync(join(tmpdir(), "ctc-execution-preflight-"));
  try {
    gitOutput(repositoryPath, ["init", "--initial-branch", "main"]);
    writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n", {
      encoding: "utf8",
    });
    writeFileSync(join(repositoryPath, "AGENTS.md"), agentsBody, {
      encoding: "utf8",
    });
    gitOutput(repositoryPath, ["add", "--all"]);
    gitOutput(repositoryPath, ["commit", "--message", "fixture"]);
    const head = gitOutput(repositoryPath, ["rev-parse", "HEAD"]);
    gitOutput(repositoryPath, [
      "update-ref",
      "refs/remotes/origin/main",
      head,
    ]);
    return operation({ path: repositoryPath, head });
  } finally {
    rmSync(repositoryPath, { force: true, recursive: true });
  }
};

const seedHierarchy = (storage: TaskStorage, repositoryPath: string): void => {
  storage.createProject(
    ProjectSchema.parse({
      ...makeProject(PROJECT_ID, "execution-preflight"),
      repository: { kind: "PATH", path: repositoryPath },
    }),
  );
  storage.createBigTask({
    ...makeBigTask(BIG_TASK_ID, PROJECT_ID),
    goal: "Prepare exact Console-owned execution input.",
  });
  storage.createSubtask({
    ...makeSubtask(SUBTASK_ID, BIG_TASK_ID),
    goal: "Serialize and measure trusted operational context.",
    promptSeed: "Use the exact preflight-approved text.",
  });
};

const seedSizedProjectContext = (
  storage: TaskStorage,
  itemCount: number,
  bodyLength = 3_800,
): string => {
  const body = `FULL_SOURCE_SENTINEL_${"x".repeat(bodyLength - 21)}`;
  const projectScope = ContextScopeSchema.parse({
    scopeType: "PROJECT",
    projectId: PROJECT_ID,
  });
  for (let index = 0; index < itemCount; index += 1) {
    storage.createContextItem(
      makeContextItem(`ctx_preflight_${index}`, projectScope, { body }),
    );
  }
  return body;
};

const capturePreflightError = (
  operation: () => unknown,
): ExecutionInputPreflightError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof ExecutionInputPreflightError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected ExecutionInputPreflightError.");
};

const fileHash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const applicationDatabaseFingerprint = (databasePath: string): object => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = [
      "projects",
      "big_tasks",
      "subtasks",
      "task_dependencies",
      "subtask_implementation_checkpoints",
      "context_items",
      "context_digests",
      "audit_events",
    ];
    return {
      rows: tables.map((table) => ({
        table,
        rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
      schema: sqlite
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
        )
        .all(),
      migrations: sqlite
        .prepare("SELECT * FROM __drizzle_migrations ORDER BY id")
        .all(),
    };
  } finally {
    sqlite.close();
  }
};

const repositoryFingerprint = (repositoryPath: string): object => ({
  head: gitOutput(repositoryPath, ["rev-parse", "HEAD"]),
  refs: gitOutput(repositoryPath, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)",
  ]),
  index: fileHash(join(repositoryPath, ".git", "index")),
  config: fileHash(join(repositoryPath, ".git", "config")),
  tracked: fileHash(join(repositoryPath, "tracked.txt")),
  agents: existsSync(join(repositoryPath, "AGENTS.md"))
    ? fileHash(join(repositoryPath, "AGENTS.md"))
    : null,
  status: gitOutput(repositoryPath, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]),
});

const collectPropertyNames = (
  value: unknown,
  names = new Set<string>(),
): ReadonlySet<string> => {
  if (typeof value !== "object" || value === null) {
    return names;
  }
  for (const [name, nested] of Object.entries(value)) {
    names.add(name);
    collectPropertyNames(nested, names);
  }
  return names;
};

describe.sequential("Execution Input Preflight V0", () => {
  it("serializes the exact Standard assembler packet with no extra framing", () => {
    withSyntheticRepository("# Canonical rules\n", (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        seedSizedProjectContext(storage, 1, 80);
        const expectedPacket = new OperationalJitContextAssembler(
          storage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );

        const result = new ExecutionInputPreflight(
          storage,
        ).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        if (!result.allowed) {
          throw new Error("Expected allowed Standard execution input.");
        }

        expect(result).toMatchObject({
          status: "WITHIN_TARGET",
          allowed: true,
          format: FORMAT,
          profile: "STANDARD_SUBTASK_EXECUTION",
          normalTargetBytes: 40_000,
          absoluteCapBytes: 64_000,
        });
        expect(result.text).toBe(MARKER + JSON.stringify(expectedPacket));
        expect(result.text.endsWith("\n")).toBe(false);
        expect(result.utf8Bytes).toBe(Buffer.byteLength(result.text, "utf8"));
        expect(Object.isFrozen(result)).toBe(true);
      }),
    );
  });

  it("serializes exact Fresh QA output and inherits its clean-context properties", () => {
    withSyntheticRepository("fresh canonical rules\n", (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        seedSizedProjectContext(storage, 1, 80);
        const expectedPacket = new OperationalJitContextAssembler(
          storage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "FRESH_INDEPENDENT_QA",
        );
        const result = new ExecutionInputPreflight(
          storage,
        ).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "FRESH_INDEPENDENT_QA",
        );
        if (!result.allowed) {
          throw new Error("Expected allowed Fresh QA execution input.");
        }

        expect(result.text).toBe(MARKER + JSON.stringify(expectedPacket));
        expect(result.text).not.toMatch(
          /FULL_SOURCE_SENTINEL|ACTIVE_PROJECT_CONTEXT|EXECUTION_INTENT/,
        );
        expect(result.profile).toBe("FRESH_INDEPENDENT_QA");
      }),
    );
  });

  it("measures exact UTF-8 bytes for Unicode and preserved text layout", () => {
    const rules = "ASCII\r\n中文 😀\r\n\t- Markdown\r\n    indented\r\n";
    withSyntheticRepository(rules, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        const result = new ExecutionInputPreflight(
          storage,
        ).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        if (!result.allowed) {
          throw new Error("Expected allowed Unicode execution input.");
        }

        expect(result.text).toContain("ASCII\\r\\n中文 😀\\r\\n\\t- Markdown");
        expect(result.utf8Bytes).toBe(Buffer.byteLength(result.text, "utf8"));
        expect(result.utf8Bytes).not.toBe(result.text.length);
      }),
    );
  });

  it("returns allowed text below target and above target, then blocks without text", () => {
    withSyntheticRepository("sized context rules\n", (repository) =>
      withMemoryStorage((withinStorage) => {
        seedHierarchy(withinStorage, repository.path);
        const within = new ExecutionInputPreflight(
          withinStorage,
        ).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        expect(within.status).toBe("WITHIN_TARGET");
        expect(within.allowed).toBe(true);
        expect(within).toHaveProperty("text");
      }),
    );

    withSyntheticRepository("sized context rules\n", (repository) =>
      withMemoryStorage((aboveStorage) => {
        seedHierarchy(aboveStorage, repository.path);
        const fullBody = seedSizedProjectContext(aboveStorage, 10);
        const above = new ExecutionInputPreflight(
          aboveStorage,
        ).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        expect(above.status).toBe("ABOVE_TARGET");
        expect(above.allowed).toBe(true);
        expect(above).toHaveProperty("text");
        if (above.allowed) {
          expect(above.text).toContain(fullBody);
        }
      }),
    );

    withSyntheticRepository("sized context rules\n", (repository) =>
      withMemoryStorage((blockedStorage) => {
        seedHierarchy(blockedStorage, repository.path);
        const fullBody = seedSizedProjectContext(blockedStorage, 17);
        const packet = new OperationalJitContextAssembler(
          blockedStorage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        const serializedPacket = JSON.stringify(packet);
        expect(serializedPacket).toContain(fullBody);
        expect(Buffer.byteLength(MARKER + serializedPacket, "utf8")).toBeGreaterThan(
          64_000,
        );

        const blocked = new ExecutionInputPreflight(
          blockedStorage,
        ).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        expect(blocked).toEqual({
          status: "HARD_CAP_EXCEEDED",
          allowed: false,
          format: FORMAT,
          profile: "STANDARD_SUBTASK_EXECUTION",
          utf8Bytes: Buffer.byteLength(MARKER + serializedPacket, "utf8"),
          normalTargetBytes: 40_000,
          absoluteCapBytes: 64_000,
        });
        expect(blocked).not.toHaveProperty("text");
        expect(blocked).not.toHaveProperty("serializedText");
        expect(blocked).not.toHaveProperty("payload");
        expect(Object.isFrozen(blocked)).toBe(true);
      }),
    );
  });

  it("is byte-identical and status-identical for unchanged trusted sources", () => {
    withSyntheticRepository("deterministic rules\n", (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        seedSizedProjectContext(storage, 10);
        const preflight = new ExecutionInputPreflight(storage);
        const first = preflight.prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        const second = preflight.prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        expect(second).toEqual(first);
        if (first.allowed && second.allowed) {
          expect(Buffer.from(second.text)).toEqual(Buffer.from(first.text));
        }
      }),
    );
  });

  it("accepts only canonical Subtask ID and profile, with no authority upgrade", () => {
    withSyntheticRepository("trusted rules\n", (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        const preflight = new ExecutionInputPreflight(storage);
        expect(preflight.prepareExecutionInputForSubtask).toHaveLength(2);
        expectTypeOf<
          Parameters<typeof preflight.prepareExecutionInputForSubtask>
        >().toEqualTypeOf<[SubtaskId, OperationalJitContextProfile]>();

        const invokeWithIgnoredData = preflight.prepareExecutionInputForSubtask.bind(
          preflight,
        ) as (
          subtaskId: SubtaskId,
          profile: OperationalJitContextProfile,
          packet: string,
          text: string,
          byteCount: number,
          normalTargetBytes: number,
          absoluteCapBytes: number,
          project: string,
          repository: string,
          contextItems: string,
          qaPolicy: string,
        ) => ExecutionInputPreflightResult;
        const result = invokeWithIgnoredData(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
          "CALLER_PACKET_SENTINEL",
          "CALLER_TEXT_SENTINEL",
          1,
          1,
          1,
          "CALLER_PROJECT_SENTINEL",
          "CALLER_REPOSITORY_SENTINEL",
          "CALLER_CONTEXT_SENTINEL",
          "CALLER_QA_SENTINEL",
        );
        expect(JSON.stringify(result)).not.toContain("CALLER_");

        const sameShapedData = Object.freeze(structuredClone(result));
        expect(sameShapedData).toEqual(result);
        expect(collectPropertyNames(result)).not.toContain("trusted");
        for (const forbiddenExport of [
          "authorizeExecutionInput",
          "trustExecutionInputPreflightResult",
          "verifyExecutionInputPreflightResult",
          "executePreflightResult",
        ]) {
          expect(storageExports).not.toHaveProperty(forbiddenExport);
        }
      }),
    );
  });

  it("fails closed with sanitized errors for unsupported and failed assembly", () => {
    withMemoryStorage((storage) => {
      expect(
        capturePreflightError(
          () => new ExecutionInputPreflight({} as TaskStorage),
        ).code,
      ).toBe("INVALID_INPUT");
      const preflight = new ExecutionInputPreflight(storage);
      const unsupported = capturePreflightError(() =>
        preflight.prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "FOCUSED_RE_QA" as OperationalJitContextProfile,
        ),
      );
      const invalid = capturePreflightError(() =>
        preflight.prepareExecutionInputForSubtask(
          " st_noncanonical " as SubtaskId,
          "STANDARD_SUBTASK_EXECUTION",
        ),
      );
      const missing = capturePreflightError(() =>
        preflight.prepareExecutionInputForSubtask(
          SubtaskIdSchema.parse("st_missing_execution_preflight"),
          "STANDARD_SUBTASK_EXECUTION",
        ),
      );
      expect([unsupported.code, invalid.code, missing.code]).toEqual([
        "UNSUPPORTED_PROFILE",
        "INVALID_INPUT",
        "ASSEMBLY_FAILED",
      ]);
      expect(`${unsupported.message} ${invalid.message} ${missing.message}`).not.toMatch(
        /sqlite|Zod|stack|st_missing|FOCUSED_RE_QA/i,
      );
    });

    const missingPath = join(tmpdir(), "ctc-secret-preflight-missing");
    rmSync(missingPath, { force: true, recursive: true });
    withMemoryStorage((storage) => {
      seedHierarchy(storage, missingPath);
      const error = capturePreflightError(() =>
        new ExecutionInputPreflight(storage).prepareExecutionInputForSubtask(
          SUBTASK_ID,
          "FRESH_INDEPENDENT_QA",
        ),
      );
      expect(error.code).toBe("ASSEMBLY_FAILED");
      expect(error.message).not.toContain(missingPath);
      expect(error.message).not.toMatch(/Git|path|repository/i);
    });
  });

  it("fails closed with a sanitized serialization error", () => {
    withSyntheticRepository("serialization rules\n", (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        const originalStringify = JSON.stringify;
        const originalDescriptor = Object.getOwnPropertyDescriptor(
          JSON,
          "stringify",
        );
        if (originalDescriptor === undefined) {
          throw new Error("Expected JSON.stringify descriptor.");
        }
        Object.defineProperty(JSON, "stringify", {
          configurable: true,
          value: (value: unknown): string | undefined => {
            if (
              typeof value === "object" &&
              value !== null &&
              "profile" in value &&
              "sections" in value
            ) {
              throw new Error("SECRET_SERIALIZATION_SENTINEL");
            }
            return originalStringify(value);
          },
        });
        try {
          const error = capturePreflightError(() =>
            new ExecutionInputPreflight(storage).prepareExecutionInputForSubtask(
              SUBTASK_ID,
              "STANDARD_SUBTASK_EXECUTION",
            ),
          );
          expect(error.code).toBe("SERIALIZATION_FAILED");
          expect(error.message).not.toContain("SECRET_SERIALIZATION_SENTINEL");
        } finally {
          Object.defineProperty(JSON, "stringify", originalDescriptor);
        }
      }),
    );
  });

  it.each([
    [0, true],
    [17, false],
  ] as const)(
    "performs no application database or target repository write with %i large items",
    (itemCount, expectedAllowed) => {
      withSyntheticRepository("read-only rules\n", (repository) =>
        withTemporaryDatabasePath((databasePath) => {
          const storage = openTaskDatabase({ databasePath, clock: fixedClock });
          try {
            seedHierarchy(storage, repository.path);
            seedSizedProjectContext(storage, itemCount);
            const databaseBefore = applicationDatabaseFingerprint(databasePath);
            const repositoryBefore = repositoryFingerprint(repository.path);

            const result = new ExecutionInputPreflight(
              storage,
            ).prepareExecutionInputForSubtask(
              SUBTASK_ID,
              "STANDARD_SUBTASK_EXECUTION",
            );

            expect(result.allowed).toBe(expectedAllowed);
            expect(applicationDatabaseFingerprint(databasePath)).toEqual(
              databaseBefore,
            );
            expect(repositoryFingerprint(repository.path)).toEqual(
              repositoryBefore,
            );
          } finally {
            storage.close();
          }
        }),
      );
    },
  );
});
