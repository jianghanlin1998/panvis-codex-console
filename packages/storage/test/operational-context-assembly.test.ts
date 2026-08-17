import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
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
  JitContextPacketSchema,
  ProjectIdSchema,
  ProjectSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  JitContextPacketProfileKind,
  SubtaskId,
} from "@codex-task-console/domain";
import * as storageExports from "@codex-task-console/storage";
import {
  OperationalJitContextAssembler,
  OperationalJitContextAssemblyError,
  TrustedRepositorySourceReader,
  openTaskDatabase,
} from "../src/index.js";
import type {
  JitContextStorageSourceSnapshot,
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

const PROJECT_ID = ProjectIdSchema.parse("prj_operational_context");
const BIG_TASK_ID = "bt_operational_context";
const SUBTASK_ID = SubtaskIdSchema.parse("st_operational_context");
const FIXED_GIT_DATE = "2026-08-17T00:00:00Z";
const RULES_BODY = "\n# Canonical rules\n\n    preserve this indentation\n\n";
const FRESH_QA_POLICY = {
  sourceReference:
    "system:operational-context-assembly-v0#fresh-independent-qa-policy",
  title: "Operational Context Assembly V0 Fresh Independent QA Policy",
  body:
    "Perform fresh independent no-write QA against the current canonical task contract, acceptance criteria, canonical Project rules, and current repository/runtime evidence. Do not treat prior builder, hardening, repair, Handoff, prior PASS conclusion, or self-assessment as authority. Report bounded findings and do not repair them or modify the target repository.",
};

interface SyntheticRepository {
  readonly path: string;
  readonly head: string;
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_DATE: FIXED_GIT_DATE,
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_NAME: "Operational Context Fixture",
  GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Operational Context Fixture",
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
  agentsBody: string | undefined,
  operation: (repository: SyntheticRepository) => T,
): T => {
  const repositoryPath = mkdtempSync(join(tmpdir(), "ctc-operational-context-"));
  try {
    gitOutput(repositoryPath, ["init", "--initial-branch", "main"]);
    writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n", {
      encoding: "utf8",
    });
    if (agentsBody !== undefined) {
      writeFileSync(join(repositoryPath, "AGENTS.md"), agentsBody, {
        encoding: "utf8",
      });
    }
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
      ...makeProject(PROJECT_ID, "operational-context"),
      repository: { kind: "PATH", path: repositoryPath },
    }),
  );
  storage.createBigTask({
    ...makeBigTask(BIG_TASK_ID, PROJECT_ID),
    goal: "Assemble canonical operational context.",
    acceptanceCriteria: ["Assembly is deterministic.", "Sources stay coherent."],
  });
  storage.createSubtask({
    ...makeSubtask(SUBTASK_ID, BIG_TASK_ID),
    goal: "Produce the bounded V0 packet.",
    acceptanceCriteria: ["Standard and Fresh QA packets compile."],
    promptSeed: "Assemble only trusted V0 sources.",
  });
};

const seedActiveContext = (storage: TaskStorage, prefix = "ctx_operational") => {
  const scopes = [
    ContextScopeSchema.parse({ scopeType: "PROJECT", projectId: PROJECT_ID }),
    ContextScopeSchema.parse({
      scopeType: "BIG_TASK",
      projectId: PROJECT_ID,
      bigTaskId: BIG_TASK_ID,
    }),
    ContextScopeSchema.parse({
      scopeType: "SUBTASK",
      projectId: PROJECT_ID,
      bigTaskId: BIG_TASK_ID,
      subtaskId: SUBTASK_ID,
    }),
  ] as const;
  return scopes.map((scope, index) =>
    storage.createContextItem(
      makeContextItem(`${prefix}_${index}`, scope, {
        body: `${prefix.toUpperCase()}_SENTINEL_${index}`,
      }),
    ),
  );
};

const captureAssemblyError = (
  operation: () => unknown,
): OperationalJitContextAssemblyError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof OperationalJitContextAssemblyError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected OperationalJitContextAssemblyError.");
};

const captureContextItemQueries = <T>(operation: () => T): {
  readonly result: T;
  readonly queries: readonly string[];
} => {
  const prototype = StatementSync.prototype as unknown as {
    all: (...parameters: unknown[]) => unknown[];
    get: (...parameters: unknown[]) => unknown;
    readonly sourceSQL: string;
  };
  const originalAll = prototype.all;
  const originalGet = prototype.get;
  const queries: string[] = [];
  prototype.all = function (...parameters: unknown[]): unknown[] {
    if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
      queries.push(this.sourceSQL);
    }
    return Reflect.apply(originalAll, this, parameters) as unknown[];
  };
  prototype.get = function (...parameters: unknown[]): unknown {
    if (/from\s+"?context_items"?/i.test(this.sourceSQL)) {
      queries.push(this.sourceSQL);
    }
    return Reflect.apply(originalGet, this, parameters);
  };
  try {
    return { result: operation(), queries };
  } finally {
    prototype.all = originalAll;
    prototype.get = originalGet;
  }
};

type StorageSnapshotRead = TaskStorage["readJitContextSourceSnapshotForSubtask"];

const interceptStorageSnapshotReads = (
  storage: TaskStorage,
  interceptor: (
    readNumber: number,
    invoke: () => JitContextStorageSourceSnapshot,
    profile: JitContextPacketProfileKind,
  ) => JitContextStorageSourceSnapshot,
): void => {
  const original = storage.readJitContextSourceSnapshotForSubtask.bind(storage);
  let readNumber = 0;
  Object.defineProperty(storage, "readJitContextSourceSnapshotForSubtask", {
    configurable: true,
    value: (...arguments_: Parameters<StorageSnapshotRead>) => {
      readNumber += 1;
      return interceptor(
        readNumber,
        () => original(...arguments_),
        arguments_[1],
      );
    },
  });
};

const mutateDatabase = (
  databasePath: string,
  statement: string,
  ...parameters: readonly string[]
): void => {
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
    sqlite.prepare(statement).run(...parameters);
  } finally {
    sqlite.close();
  }
};

const applicationRows = (databasePath: string): string => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return JSON.stringify(
      [
        "projects",
        "big_tasks",
        "subtasks",
        "task_dependencies",
        "subtask_implementation_checkpoints",
        "context_items",
        "context_digests",
        "audit_events",
      ].map((table) => ({
        table,
        rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
    );
  } finally {
    sqlite.close();
  }
};

const fileHash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

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
  for (const [name, nestedValue] of Object.entries(value)) {
    names.add(name);
    collectPropertyNames(nestedValue, names);
  }
  return names;
};

describe.sequential("Operational Context Assembly V0", () => {
  it("assembles the exact Standard vertical packet from trusted producers", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        const activeContext = seedActiveContext(storage);
        const repositorySnapshot = new TrustedRepositorySourceReader(
          storage,
        ).readTrustedRepositorySourceSnapshotForSubtask(SUBTASK_ID);

        const packet = new OperationalJitContextAssembler(
          storage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        if (packet.profile !== "STANDARD_SUBTASK_EXECUTION") {
          throw new Error("Expected Standard packet.");
        }

        expect(packet.sections.map(({ sectionType }) => sectionType)).toEqual([
          "CANONICAL_PROJECT_RULES",
          "REPOSITORY_RUNTIME_EVIDENCE",
          "PROJECT_CORE",
          "BIG_TASK_CONTRACT",
          "SUBTASK_CONTRACT",
          "ACCEPTANCE_CRITERIA",
          "EXECUTION_INTENT",
          "ACTIVE_PROJECT_CONTEXT",
          "ACTIVE_BIG_TASK_CONTEXT",
          "ACTIVE_SUBTASK_CONTEXT",
        ]);
        expect(packet.sections[0].blocks).toEqual(
          repositorySnapshot.canonicalProjectRules,
        );
        expect(packet.sections[0].blocks[0]?.body).toBe(RULES_BODY);
        expect(packet.sections[1].blocks).toEqual(
          repositorySnapshot.repositoryRuntimeEvidence,
        );
        expect(packet.sections[2].project).toMatchObject({
          id: PROJECT_ID,
          repository: { kind: "PATH", path: repository.path },
        });
        expect(packet.sections[3].bigTask).toMatchObject({
          id: BIG_TASK_ID,
          goal: "Assemble canonical operational context.",
        });
        expect(packet.sections[4].subtask).toMatchObject({
          id: SUBTASK_ID,
          goal: "Produce the bounded V0 packet.",
        });
        expect(packet.sections[5].acceptanceCriteria).toEqual({
          bigTask: {
            bigTaskId: BIG_TASK_ID,
            criteria: ["Assembly is deterministic.", "Sources stay coherent."],
          },
          subtask: {
            subtaskId: SUBTASK_ID,
            criteria: ["Standard and Fresh QA packets compile."],
          },
        });
        expect(packet.sections[6].executionIntent).toEqual({
          recommendedReasoningLevel: "HIGH",
          promptSeed: "Assemble only trusted V0 sources.",
        });
        expect(packet.sections[7].items).toEqual([activeContext[0]]);
        expect(packet.sections[8].items).toEqual([activeContext[1]]);
        expect(packet.sections[9].items).toEqual([activeContext[2]]);
      }),
    );
  });

  it("assembles Fresh QA with zero generic Context Item retrieval or leakage", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        seedActiveContext(storage, "ctx_fresh_excluded");
        const assembler = new OperationalJitContextAssembler(storage);
        const { result: packet, queries } = captureContextItemQueries(() =>
          assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "FRESH_INDEPENDENT_QA",
          ),
        );
        if (packet.profile !== "FRESH_INDEPENDENT_QA") {
          throw new Error("Expected Fresh QA packet.");
        }

        expect(queries).toEqual([]);
        expect(packet.sections.map(({ sectionType }) => sectionType)).toEqual([
          "CANONICAL_PROJECT_RULES",
          "REPOSITORY_RUNTIME_EVIDENCE",
          "PROJECT_CORE",
          "BIG_TASK_CONTRACT",
          "SUBTASK_CONTRACT",
          "ACCEPTANCE_CRITERIA",
          "LOCKED_INVARIANTS",
          "QA_INSTRUCTIONS",
          "BOUNDED_RETEST_TARGETS",
        ]);
        expect(packet.sections[0].blocks[0]?.body).toBe(RULES_BODY);
        expect(packet.sections[1].blocks.length).toBeGreaterThan(0);
        expect(packet.sections[4].subtask.goal).toBe(
          "Produce the bounded V0 packet.",
        );
        expect(packet.sections[5].acceptanceCriteria.subtask.criteria).toEqual([
          "Standard and Fresh QA packets compile.",
        ]);
        expect(packet.sections[6].blocks).toEqual([]);
        expect(packet.sections[7].blocks).toEqual([FRESH_QA_POLICY]);
        expect(packet.sections[8].targets).toEqual([]);
        expect(JSON.stringify(packet)).not.toMatch(
          /CTX_FRESH_EXCLUDED_SENTINEL|EXECUTION_INTENT/,
        );
      }),
    );
  });

  it("fails closed for Focused Re-QA and unknown profiles", () => {
    withMemoryStorage((storage) => {
      const assembler = new OperationalJitContextAssembler(storage);
      expect(
        captureAssemblyError(() =>
          assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "FOCUSED_RE_QA" as OperationalJitContextProfile,
          ),
        ).code,
      ).toBe("UNSUPPORTED_PROFILE");
      expect(
        captureAssemblyError(() =>
          assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "UNKNOWN" as OperationalJitContextProfile,
          ),
        ).code,
      ).toBe("UNSUPPORTED_PROFILE");
    });
  });

  it("accepts only the Subtask ID and profile and adds no packet trust upgrade", () => {
    withSyntheticRepository("canonical target rules\n", (target) =>
      withSyntheticRepository("caller injected rules\n", (alternate) =>
        withMemoryStorage((storage) => {
          seedHierarchy(storage, target.path);
          const assembler = new OperationalJitContextAssembler(storage);
          expect(
            assembler.assembleOperationalJitContextPacketForSubtask,
          ).toHaveLength(2);
          expectTypeOf<
            Parameters<
              typeof assembler.assembleOperationalJitContextPacketForSubtask
            >
          >().toEqualTypeOf<[SubtaskId, OperationalJitContextProfile]>();

          const invokeWithIgnoredSources =
            assembler.assembleOperationalJitContextPacketForSubtask.bind(
              assembler,
            ) as (
              subtaskId: SubtaskId,
              profile: OperationalJitContextProfile,
              repositoryPath: string,
              canonicalProjectRules: string,
              runtimeEvidence: string,
              activeContext: string,
              qaInstructions: string,
              candidateClass: string,
            ) => ReturnType<
              typeof assembler.assembleOperationalJitContextPacketForSubtask
            >;
          const packet = invokeWithIgnoredSources(
            SUBTASK_ID,
            "STANDARD_SUBTASK_EXECUTION",
            alternate.path,
            "CALLER_RULE_SENTINEL",
            "CALLER_RUNTIME_SENTINEL",
            "CALLER_CONTEXT_SENTINEL",
            "CALLER_QA_SENTINEL",
            "CALLER_CLASS_SENTINEL",
          );
          const serialized = JSON.stringify(packet);
          expect(serialized).toContain("canonical target rules");
          expect(serialized).toContain(target.path);
          expect(serialized).not.toContain(alternate.path);
          expect(serialized).not.toMatch(/caller injected|CALLER_/);

          const sameShapedData = JitContextPacketSchema.parse(
            JSON.parse(serialized) as unknown,
          );
          expect(sameShapedData).toEqual(packet);
          const propertyNames = collectPropertyNames(packet);
          expect(propertyNames.has("trusted")).toBe(false);
          expect(propertyNames.has("verified")).toBe(false);
          expect(propertyNames.has("authorized")).toBe(false);
          expect(propertyNames.has("capability")).toBe(false);
          expect(propertyNames.has("signature")).toBe(false);
          expect(propertyNames.has("attestation")).toBe(false);
          expect(storageExports).not.toHaveProperty("trustJitContextPacket");
          expect(storageExports).not.toHaveProperty("verifyJitContextPacket");
        }),
      ),
    );
  });

  it.each([
    {
      name: "Project repository",
      mutate: (databasePath: string, alternatePath: string) =>
        mutateDatabase(
          databasePath,
          "UPDATE projects SET repository_value = ? WHERE id = ?",
          alternatePath,
          PROJECT_ID,
        ),
    },
    {
      name: "Big Task contract",
      mutate: (databasePath: string) =>
        mutateDatabase(
          databasePath,
          "UPDATE big_tasks SET goal = ? WHERE id = ?",
          "DRIFTED_BIG_TASK_GOAL",
          BIG_TASK_ID,
        ),
    },
  ])("detects $name drift across storage A/repository/storage B", ({ mutate }) => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withSyntheticRepository("alternate\n", (alternate) =>
        withTemporaryDatabasePath((databasePath) => {
          const storage = openTaskDatabase({ databasePath, clock: fixedClock });
          try {
            seedHierarchy(storage, repository.path);
            interceptStorageSnapshotReads(
              storage,
              (readNumber, invoke) => {
                if (readNumber === 3) {
                  mutate(databasePath, alternate.path);
                }
                return invoke();
              },
            );
            const error = captureAssemblyError(() =>
              new OperationalJitContextAssembler(
                storage,
              ).assembleOperationalJitContextPacketForSubtask(
                SUBTASK_ID,
                "FRESH_INDEPENDENT_QA",
              ),
            );
            expect(error.code).toBe("SOURCE_DRIFT");
            expect(error.message).not.toMatch(
              /DRIFTED_BIG_TASK_GOAL|ctc-operational-context|sqlite/i,
            );
          } finally {
            storage.close();
          }
        }),
      ),
    );
  });

  it("detects Standard ACTIVE context drift and returns no mixed packet", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        seedActiveContext(storage);
        interceptStorageSnapshotReads(storage, (readNumber, invoke, profile) => {
          if (readNumber === 3 && profile === "STANDARD_SUBTASK_EXECUTION") {
            storage.createContextItem(
              makeContextItem(
                "ctx_operational_drift",
                ContextScopeSchema.parse({
                  scopeType: "PROJECT",
                  projectId: PROJECT_ID,
                }),
                { body: "DRIFTED_ACTIVE_CONTEXT" },
              ),
            );
          }
          return invoke();
        });
        const error = captureAssemblyError(() =>
          new OperationalJitContextAssembler(
            storage,
          ).assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "STANDARD_SUBTASK_EXECUTION",
          ),
        );
        expect(error.code).toBe("SOURCE_DRIFT");
        expect(error.message).not.toContain("DRIFTED_ACTIVE_CONTEXT");
      }),
    );
  });

  it("fails closed when repository-source Project identity does not correspond", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        interceptStorageSnapshotReads(storage, (readNumber, invoke) => {
          const snapshot = invoke();
          if (readNumber !== 2) {
            return snapshot;
          }
          return {
            ...snapshot,
            project: {
              ...snapshot.project,
              id: ProjectIdSchema.parse("prj_repository_mismatch"),
            },
          } as JitContextStorageSourceSnapshot;
        });
        expect(
          captureAssemblyError(() =>
            new OperationalJitContextAssembler(
              storage,
            ).assembleOperationalJitContextPacketForSubtask(
              SUBTASK_ID,
              "FRESH_INDEPENDENT_QA",
            ),
          ).code,
        ).toBe("SOURCE_DRIFT");
      }),
    );
  });

  it("uses only sanitized assembly errors for invalid and failed sources", () => {
    withMemoryStorage((storage) => {
      const assembler = new OperationalJitContextAssembler(storage);
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("HOSTILE_PROXY_SENTINEL");
          },
        },
      );
      const errors = [
        captureAssemblyError(() =>
          assembler.assembleOperationalJitContextPacketForSubtask(
            " st_noncanonical " as SubtaskId,
            "STANDARD_SUBTASK_EXECUTION",
          ),
        ),
        captureAssemblyError(() =>
          assembler.assembleOperationalJitContextPacketForSubtask(
            SubtaskIdSchema.parse("st_missing_operational_context"),
            "FRESH_INDEPENDENT_QA",
          ),
        ),
        captureAssemblyError(() =>
          assembler.assembleOperationalJitContextPacketForSubtask(
            hostile as unknown as SubtaskId,
            "FRESH_INDEPENDENT_QA",
          ),
        ),
      ];
      expect(errors.map(({ code }) => code)).toEqual([
        "INVALID_INPUT",
        "TRUSTED_STORAGE_SOURCE_FAILED",
        "INVALID_INPUT",
      ]);
      expect(errors.map(({ message }) => message).join(" ")).not.toMatch(
        /HOSTILE_PROXY_SENTINEL|Zod|Proxy|sqlite|stack/i,
      );
    });

    withMemoryStorage((storage) => {
      storage.createProject({
        ...makeProject(PROJECT_ID, "reference-operational-context"),
        repository: {
          kind: "REFERENCE",
          reference: "https://private.invalid/SECRET_REPOSITORY_SENTINEL.git",
        },
      });
      storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
      storage.createSubtask(makeSubtask(SUBTASK_ID, BIG_TASK_ID));
      const error = captureAssemblyError(() =>
        new OperationalJitContextAssembler(
          storage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "FRESH_INDEPENDENT_QA",
        ),
      );
      expect(error.code).toBe("TRUSTED_REPOSITORY_SOURCE_FAILED");
      expect(error.message).not.toMatch(/private|SECRET|https|git/i);
    });

    const missingPath = join(tmpdir(), "ctc-operational-context-missing");
    rmSync(missingPath, { force: true, recursive: true });
    withMemoryStorage((storage) => {
      seedHierarchy(storage, missingPath);
      const error = captureAssemblyError(() =>
        new OperationalJitContextAssembler(
          storage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        ),
      );
      expect(error.code).toBe("TRUSTED_REPOSITORY_SOURCE_FAILED");
      expect(error.message).not.toContain(missingPath);
    });
  });

  it("sanitizes malformed hierarchy and Packet compilation failures", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage, repository.path);
        storage.close();
        mutateDatabase(
          databasePath,
          "UPDATE big_tasks SET project_id = ? WHERE id = ?",
          "prj_malformed_sentinel",
          BIG_TASK_ID,
        );
        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const error = captureAssemblyError(() =>
            new OperationalJitContextAssembler(
              storage,
            ).assembleOperationalJitContextPacketForSubtask(
              SUBTASK_ID,
              "FRESH_INDEPENDENT_QA",
            ),
          );
          expect(error.code).toBe("TRUSTED_STORAGE_SOURCE_FAILED");
          expect(error.message).not.toMatch(/malformed_sentinel|sqlite|parent/i);
        } finally {
          storage.close();
        }
      }),
    );

    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        interceptStorageSnapshotReads(storage, (_readNumber, invoke) => {
          const snapshot = invoke();
          return {
            ...snapshot,
            subtask: { ...snapshot.subtask, goal: "" },
          } as JitContextStorageSourceSnapshot;
        });
        const error = captureAssemblyError(() =>
          new OperationalJitContextAssembler(
            storage,
          ).assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "FRESH_INDEPENDENT_QA",
          ),
        );
        expect(error.code).toBe("PACKET_COMPILATION_FAILED");
        expect(error.message).not.toMatch(/Zod|goal|schema/i);
      }),
    );
  });

  it("performs no application database or target repository write", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          seedHierarchy(storage, repository.path);
          seedActiveContext(storage);
          const beforeDatabase = applicationRows(databasePath);
          const beforeRepository = repositoryFingerprint(repository.path);
          const assembler = new OperationalJitContextAssembler(storage);

          assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "STANDARD_SUBTASK_EXECUTION",
          );
          assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "FRESH_INDEPENDENT_QA",
          );

          expect(applicationRows(databasePath)).toBe(beforeDatabase);
          expect(repositoryFingerprint(repository.path)).toEqual(
            beforeRepository,
          );
        } finally {
          storage.close();
        }
      }),
    );
  });
});
