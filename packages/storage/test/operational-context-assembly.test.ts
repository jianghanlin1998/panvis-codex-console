import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
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

const applicationDatabaseFingerprint = (databasePath: string): object => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      rows: applicationRows(databasePath),
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

const storageProductionSource = (): string =>
  readdirSync(new URL("../src/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) =>
      readFileSync(new URL(`../src/${entry.name}`, import.meta.url), {
        encoding: "utf8",
      }),
    )
    .join("\n");

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

  it("composes only the independently expected Standard sources in accepted storage order", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        const project = storage.createProject(
          ProjectSchema.parse({
            ...makeProject(PROJECT_ID, "operational-context-exact"),
            name: "Exact target Project",
            repository: { kind: "PATH", path: repository.path },
          }),
        );
        const bigTask = storage.createBigTask({
          ...makeBigTask(BIG_TASK_ID, PROJECT_ID),
          title: "Exact target Big Task",
          goal: "Keep exact source ownership.",
          rationale: "Prevent cross-source widening.",
          scopeIn: ["Exact assembly"],
          scopeOut: ["Ranking", "Conflict resolution"],
          acceptanceCriteria: ["Big Task criterion A", "Big Task criterion B"],
        });
        const subtask = storage.createSubtask({
          ...makeSubtask(SUBTASK_ID, BIG_TASK_ID),
          title: "Exact target Subtask",
          goal: "Compile one exact packet.",
          scopeIn: ["Trusted composition"],
          scopeOut: ["Provider execution"],
          acceptanceCriteria: ["Subtask criterion A", "Subtask criterion B"],
          untouchedAreas: ["Accepted producers"],
          recommendedReasoningLevel: "MEDIUM",
          promptSeed: "Use only exact accepted sources.",
        });

        storage.createBigTask(
          makeBigTask("bt_operational_sibling", PROJECT_ID),
        );
        storage.createSubtask(
          makeSubtask("st_operational_sibling", BIG_TASK_ID),
        );
        storage.createSubtask(
          makeSubtask("st_other_big", "bt_operational_sibling"),
        );
        const foreignProjectId = ProjectIdSchema.parse(
          "prj_operational_foreign",
        );
        storage.createProject(
          ProjectSchema.parse({
            ...makeProject(foreignProjectId, "operational-context-foreign"),
            repository: { kind: "PATH", path: repository.path },
          }),
        );
        storage.createBigTask(
          makeBigTask("bt_operational_foreign", foreignProjectId),
        );
        storage.createSubtask(
          makeSubtask("st_operational_foreign", "bt_operational_foreign"),
        );

        const projectScope = ContextScopeSchema.parse({
          scopeType: "PROJECT",
          projectId: PROJECT_ID,
        });
        const bigTaskScope = ContextScopeSchema.parse({
          scopeType: "BIG_TASK",
          projectId: PROJECT_ID,
          bigTaskId: BIG_TASK_ID,
        });
        const subtaskScope = ContextScopeSchema.parse({
          scopeType: "SUBTASK",
          projectId: PROJECT_ID,
          bigTaskId: BIG_TASK_ID,
          subtaskId: SUBTASK_ID,
        });
        const projectLater = storage.createContextItem(
          makeContextItem("ctx_exact_project_later", projectScope, {
            body: "CONTRADICTORY_MODE=B",
            effectiveAt: "2026-08-17T02:00:00.000Z",
          }),
        );
        const projectEarlier = storage.createContextItem(
          makeContextItem("ctx_exact_project_earlier", projectScope, {
            body: "CONTRADICTORY_MODE=A",
            effectiveAt: "2026-08-17T01:00:00.000Z",
          }),
        );
        const bigTaskContext = storage.createContextItem(
          makeContextItem("ctx_exact_big_task", bigTaskScope),
        );
        const subtaskContext = storage.createContextItem(
          makeContextItem("ctx_exact_subtask", subtaskScope),
        );
        storage.createContextItem(
          makeContextItem("ctx_exact_non_active", projectScope, {
            status: "PROPOSED",
            body: "NON_ACTIVE_LEAK_SENTINEL",
          }),
        );
        storage.createContextItem(
          makeContextItem(
            "ctx_exact_sibling_subtask",
            ContextScopeSchema.parse({
              scopeType: "SUBTASK",
              projectId: PROJECT_ID,
              bigTaskId: BIG_TASK_ID,
              subtaskId: "st_operational_sibling",
            }),
            { body: "SIBLING_SUBTASK_LEAK_SENTINEL" },
          ),
        );
        storage.createContextItem(
          makeContextItem(
            "ctx_exact_sibling_big_task",
            ContextScopeSchema.parse({
              scopeType: "BIG_TASK",
              projectId: PROJECT_ID,
              bigTaskId: "bt_operational_sibling",
            }),
            { body: "SIBLING_BIG_TASK_LEAK_SENTINEL" },
          ),
        );
        storage.createContextItem(
          makeContextItem(
            "ctx_exact_foreign",
            ContextScopeSchema.parse({
              scopeType: "PROJECT",
              projectId: foreignProjectId,
            }),
            { body: "FOREIGN_PROJECT_LEAK_SENTINEL" },
          ),
        );

        writeFileSync(join(repository.path, "tracked.txt"), "dirty tracked\n", {
          encoding: "utf8",
        });
        writeFileSync(join(repository.path, "untracked.txt"), "untracked\n", {
          encoding: "utf8",
        });

        const packet = new OperationalJitContextAssembler(
          storage,
        ).assembleOperationalJitContextPacketForSubtask(
          SUBTASK_ID,
          "STANDARD_SUBTASK_EXECUTION",
        );
        const gitVersion = gitOutput(repository.path, ["--version"]);

        expect(packet).toEqual({
          profile: "STANDARD_SUBTASK_EXECUTION",
          sections: [
            {
              sectionType: "CANONICAL_PROJECT_RULES",
              reasonIncluded: "CANONICAL_PROJECT_RULES",
              blocks: [
                {
                  sourceReference: "repo:AGENTS.md",
                  title: "Repository root AGENTS.md",
                  body: RULES_BODY,
                },
              ],
            },
            {
              sectionType: "REPOSITORY_RUNTIME_EVIDENCE",
              reasonIncluded: "REPOSITORY_RUNTIME_EVIDENCE",
              blocks: [
                {
                  sourceReference: "repo:git#head",
                  title: "Local repository HEAD",
                  body: `Local repository HEAD commit observation: ${repository.head}.`,
                },
                {
                  sourceReference: "repo:git#branch",
                  title: "Local repository branch state",
                  body: 'Local repository branch state: ATTACHED "main".',
                },
                {
                  sourceReference: "repo:git#local-origin-default-branch",
                  title: "Local origin/default-branch tracking ref",
                  body: `Local remote-tracking ref "refs/remotes/origin/main": ${repository.head}. This is local state only and is not live origin or GitHub truth.`,
                },
                {
                  sourceReference: "repo:git#worktree",
                  title: "Local repository worktree state",
                  body: "Local worktree state: DIRTY; tracked changes 1; untracked entries 1; unmerged/conflict entries 0.",
                },
                {
                  sourceReference: "probe:runtime#toolchain",
                  title: "Producer/probe runtime observation",
                  body: `Producer/probe runtime: Node ${JSON.stringify(process.version)}; OS/platform ${JSON.stringify(process.platform)}; architecture ${JSON.stringify(process.arch)}; Git ${JSON.stringify(gitVersion)}. These are producer observations, not target repository requirements.`,
                },
              ],
            },
            {
              sectionType: "PROJECT_CORE",
              reasonIncluded: "CURRENT_PROJECT_CORE",
              project: {
                id: project.id,
                name: project.name,
                slug: project.slug,
                repository: project.repository,
                defaultBranch: project.defaultBranch,
              },
            },
            {
              sectionType: "BIG_TASK_CONTRACT",
              reasonIncluded: "CURRENT_BIG_TASK_CONTRACT",
              bigTask: {
                id: bigTask.id,
                projectId: bigTask.projectId,
                title: bigTask.title,
                goal: bigTask.goal,
                rationale: bigTask.rationale,
                scopeIn: bigTask.scopeIn,
                scopeOut: bigTask.scopeOut,
              },
            },
            {
              sectionType: "SUBTASK_CONTRACT",
              reasonIncluded: "CURRENT_SUBTASK_CONTRACT",
              subtask: {
                id: subtask.id,
                bigTaskId: subtask.bigTaskId,
                title: subtask.title,
                goal: subtask.goal,
                scopeIn: subtask.scopeIn,
                scopeOut: subtask.scopeOut,
                untouchedAreas: subtask.untouchedAreas,
              },
            },
            {
              sectionType: "ACCEPTANCE_CRITERIA",
              reasonIncluded: "CURRENT_ACCEPTANCE_CRITERIA",
              acceptanceCriteria: {
                bigTask: {
                  bigTaskId: bigTask.id,
                  criteria: bigTask.acceptanceCriteria,
                },
                subtask: {
                  subtaskId: subtask.id,
                  criteria: subtask.acceptanceCriteria,
                },
              },
            },
            {
              sectionType: "EXECUTION_INTENT",
              reasonIncluded: "STANDARD_EXECUTION_INTENT",
              executionIntent: {
                recommendedReasoningLevel: subtask.recommendedReasoningLevel,
                promptSeed: subtask.promptSeed,
              },
            },
            {
              sectionType: "ACTIVE_PROJECT_CONTEXT",
              reasonIncluded: "ALREADY_SELECTED_ACTIVE_PROJECT_CONTEXT",
              items: [projectEarlier, projectLater],
            },
            {
              sectionType: "ACTIVE_BIG_TASK_CONTEXT",
              reasonIncluded: "ALREADY_SELECTED_ACTIVE_BIG_TASK_CONTEXT",
              items: [bigTaskContext],
            },
            {
              sectionType: "ACTIVE_SUBTASK_CONTEXT",
              reasonIncluded: "ALREADY_SELECTED_ACTIVE_SUBTASK_CONTEXT",
              items: [subtaskContext],
            },
          ],
        });
        expect(JSON.stringify(packet)).not.toMatch(
          /NON_ACTIVE_LEAK|SIBLING_(?:SUBTASK|BIG_TASK)_LEAK|FOREIGN_PROJECT_LEAK/,
        );
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

  it("assembles Fresh QA when any generic Context Item retrieval would fail", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          seedHierarchy(storage, repository.path);
          seedActiveContext(storage, "ctx_forbidden_query");
          mutateDatabase(
            databasePath,
            "ALTER TABLE context_items RENAME TO context_items_blocked",
          );

          const assembler = new OperationalJitContextAssembler(storage);
          const packet = assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            "FRESH_INDEPENDENT_QA",
          );
          expect(packet.profile).toBe("FRESH_INDEPENDENT_QA");
          expect(JSON.stringify(packet)).not.toMatch(
            /CTX_FORBIDDEN_QUERY_SENTINEL|context_items_blocked/,
          );

          expect(
            captureAssemblyError(() =>
              assembler.assembleOperationalJitContextPacketForSubtask(
                SUBTASK_ID,
                "STANDARD_SUBTASK_EXECUTION",
              ),
            ).code,
          ).toBe("TRUSTED_STORAGE_SOURCE_FAILED");
        } finally {
          storage.close();
        }
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

  it.each([
    { name: "empty string", profile: "", code: "UNSUPPORTED_PROFILE" },
    { name: "whitespace string", profile: "   ", code: "UNSUPPORTED_PROFILE" },
    { name: "number", profile: 0, code: "INVALID_INPUT" },
    { name: "null", profile: null, code: "INVALID_INPUT" },
    { name: "array", profile: [], code: "INVALID_INPUT" },
    {
      name: "plain object",
      profile: { profile: "FRESH_INDEPENDENT_QA" },
      code: "INVALID_INPUT",
    },
    { name: "symbol", profile: Symbol("PROFILE_SENTINEL"), code: "INVALID_INPUT" },
    {
      name: "function",
      profile: () => "PROFILE_SENTINEL",
      code: "INVALID_INPUT",
    },
    {
      name: "hostile Proxy",
      profile: new Proxy(
        {},
        {
          get() {
            throw new Error("PROFILE_PROXY_SENTINEL");
          },
        },
      ),
      code: "INVALID_INPUT",
    },
  ] as const)("fails closed before trusted reads for a $name profile", ({ profile, code }) => {
    withMemoryStorage((storage) => {
      const assembler = new OperationalJitContextAssembler(storage);
      const invoke =
        assembler.assembleOperationalJitContextPacketForSubtask.bind(
          assembler,
        ) as (subtaskId: unknown, requestedProfile: unknown) => unknown;
      const error = captureAssemblyError(() => invoke(SUBTASK_ID, profile));
      expect(error.code).toBe(code);
      expect(error.message).not.toMatch(
        /PROFILE_(?:PROXY_)?SENTINEL|sqlite|Zod|Proxy/i,
      );
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

  it.each([
    {
      name: "Subtask contract",
      profile: "FRESH_INDEPENDENT_QA",
      mutate: (databasePath: string) =>
        mutateDatabase(
          databasePath,
          "UPDATE subtasks SET goal = ? WHERE id = ?",
          "DRIFTED_SUBTASK_CONTRACT",
          SUBTASK_ID,
        ),
    },
    {
      name: "acceptance criteria",
      profile: "FRESH_INDEPENDENT_QA",
      mutate: (databasePath: string) =>
        mutateDatabase(
          databasePath,
          "UPDATE subtasks SET acceptance_criteria = ? WHERE id = ?",
          '["DRIFTED_ACCEPTANCE_CRITERION"]',
          SUBTASK_ID,
        ),
    },
    {
      name: "Standard ACTIVE Context Item status",
      profile: "STANDARD_SUBTASK_EXECUTION",
      mutate: (databasePath: string) =>
        mutateDatabase(
          databasePath,
          "UPDATE context_items SET status = ? WHERE id = ?",
          "REJECTED",
          "ctx_operational_0",
        ),
    },
  ] as const)(
    "detects $name drift and returns no packet",
    ({ profile, mutate }) => {
      withSyntheticRepository(RULES_BODY, (repository) =>
        withTemporaryDatabasePath((databasePath) => {
          const storage = openTaskDatabase({ databasePath, clock: fixedClock });
          try {
            seedHierarchy(storage, repository.path);
            if (profile === "STANDARD_SUBTASK_EXECUTION") {
              seedActiveContext(storage);
            }
            interceptStorageSnapshotReads(storage, (readNumber, invoke) => {
              if (readNumber === 3) {
                mutate(databasePath);
              }
              return invoke();
            });

            const error = captureAssemblyError(() =>
              new OperationalJitContextAssembler(
                storage,
              ).assembleOperationalJitContextPacketForSubtask(
                SUBTASK_ID,
                profile,
              ),
            );
            expect(error.code).toBe("SOURCE_DRIFT");
            expect(error.message).not.toMatch(
              /DRIFTED_(?:SUBTASK|ACCEPTANCE)|ctx_operational|sqlite/i,
            );
          } finally {
            storage.close();
          }
        }),
      );
    },
  );

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

  it("fails closed when repository-source repository identity does not correspond", () => {
    withSyntheticRepository("target repository rules\n", (target) =>
      withSyntheticRepository("ALTERNATE_REPOSITORY_SENTINEL\n", (alternate) =>
        withMemoryStorage((storage) => {
          seedHierarchy(storage, target.path);
          interceptStorageSnapshotReads(storage, (readNumber, invoke) => {
            const snapshot = invoke();
            if (readNumber !== 2) {
              return snapshot;
            }
            return {
              ...snapshot,
              project: {
                ...snapshot.project,
                repository: { kind: "PATH", path: alternate.path },
              },
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
          expect(error.code).toBe("SOURCE_DRIFT");
          expect(error.message).not.toMatch(
            /ALTERNATE_REPOSITORY_SENTINEL|ctc-operational-context/,
          );
        }),
      ),
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

  it("translates repository probe failure without leaking process details", () => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, repository.path);
        const originalPath = process.env.PATH;
        let error: OperationalJitContextAssemblyError;
        try {
          process.env.PATH = "";
          error = captureAssemblyError(() =>
            new OperationalJitContextAssembler(
              storage,
            ).assembleOperationalJitContextPacketForSubtask(
              SUBTASK_ID,
              "FRESH_INDEPENDENT_QA",
            ),
          );
        } finally {
          if (originalPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = originalPath;
          }
        }
        expect(error.code).toBe("TRUSTED_REPOSITORY_SOURCE_FAILED");
        expect(error.message).not.toContain(repository.path);
        expect(error.message).not.toMatch(/ENOENT|spawn|PATH|stderr|Git/i);
      }),
    );
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

  it("delegates packet structure and projections only to the accepted compiler", () => {
    const assemblySource = readFileSync(
      new URL("../src/operational-context-assembly.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const storageSource = storageProductionSource();

    expect(
      (assemblySource.match(/compileJitContextPacket\s*\(/g) ?? []).length,
    ).toBe(1);
    expect(
      (storageSource.match(/compileJitContextPacket\s*\(/g) ?? []).length,
    ).toBe(1);
    expect(storageSource).not.toMatch(/sectionType\s*:|reasonIncluded\s*:/);
    expect(assemblySource).not.toMatch(
      /acceptanceCriteria\s*:|recommendedReasoningLevel|promptSeed|\.sections\b/,
    );
  });

  it("keeps the V0 trust boundary narrow and deferred scope absent", () => {
    const assemblySource = readFileSync(
      new URL("../src/operational-context-assembly.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const storageSource = storageProductionSource();

    expect(assemblySource).not.toMatch(
      /candidateClass|callerSource|trusted\s*:|verified\s*:|authorized\s*:|signature\s*:|capability\s*:/i,
    );
    expect(assemblySource).not.toContain("FOCUSED_RE_QA");
    expect(assemblySource).not.toMatch(
      /acceptedPromotedContext|ContextDigest|rawHistory|tokenMeter|tokenBudget|budgetPrun|providerSerial|Codex App Server|executionRecord|threadRecord|worktree|daemon|scheduler|user interface/i,
    );
    expect(storageSource).not.toMatch(
      /trustJitContextPacket|verifyJitContextPacket|authorizeJitContextPacket/,
    );
    expect(assemblySource).toContain("lockedInvariants: []");
    expect(assemblySource).toContain("boundedRetestTargets: []");
  });

  it.each([
    "STANDARD_SUBTASK_EXECUTION",
    "FRESH_INDEPENDENT_QA",
  ] as const)("performs no application database or target repository write for %s", (profile) => {
    withSyntheticRepository(RULES_BODY, (repository) =>
      withTemporaryDatabasePath((databasePath) => {
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          seedHierarchy(storage, repository.path);
          seedActiveContext(storage);
          const beforeDatabase = applicationDatabaseFingerprint(databasePath);
          const beforeRepository = repositoryFingerprint(repository.path);
          const assembler = new OperationalJitContextAssembler(storage);

          assembler.assembleOperationalJitContextPacketForSubtask(
            SUBTASK_ID,
            profile,
          );

          expect(applicationDatabaseFingerprint(databasePath)).toEqual(
            beforeDatabase,
          );
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
