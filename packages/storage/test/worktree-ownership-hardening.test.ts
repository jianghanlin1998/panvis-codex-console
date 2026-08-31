import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ProjectSchema,
  SubtaskCreateInputSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type { Project, SubtaskId } from "@codex-task-console/domain";
import {
  openTaskDatabase,
  WorktreeOwnershipError,
} from "../src/index.js";
import type { TaskStorage, WorktreeOwnershipManager } from "../src/index.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import {
  createWorktreeOwnershipManagerForTesting,
  parseRegisteredWorktreesForTesting,
  type WorktreeOwnershipTestDependencies,
} from "../src/worktree-ownership.js";

const FIXED_TIME = "2026-09-01T03:04:05.000Z";
const id = (character: string): string => `wt_${character.repeat(32)}`;

const runGitResult = (
  cwd: string,
  arguments_: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
  } = {},
) =>
  spawnSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: options.env,
    input: options.input,
    shell: false,
  });

const runGit = (cwd: string, arguments_: readonly string[]): string => {
  const result = runGitResult(cwd, arguments_);
  if (result.status !== 0) {
    throw new Error(`Synthetic Git fixture failed: ${arguments_[0] ?? "unknown"}`);
  }
  return result.stdout.trim();
};

interface Scenario {
  readonly directory: string;
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
}

const createScenario = (prefix = "ctc-worktree-hard-"): Scenario => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const repositoryPath = join(directory, "source repo Ω");
  mkdirSync(repositoryPath);
  runGit(repositoryPath, ["init", "-b", "main"]);
  runGit(repositoryPath, ["config", "user.name", "Hardening Fixture"]);
  runGit(repositoryPath, ["config", "user.email", "hardening@example.invalid"]);
  writeFileSync(join(repositoryPath, "README.md"), "initial\n", "utf8");
  writeFileSync(join(repositoryPath, "tracked.txt"), "tracked initial\n", "utf8");
  runGit(repositoryPath, ["add", "README.md", "tracked.txt"]);
  runGit(repositoryPath, ["commit", "-m", "initial"]);
  return Object.freeze({
    directory,
    databasePath: join(directory, "console.sqlite"),
    repositoryPath,
    worktreeRoot: join(directory, "owned worktrees Ω"),
  });
};

const cleanup = (scenario: Scenario): void => {
  rmSync(scenario.directory, { recursive: true, force: true });
};

const makeProject = (
  scenario: Scenario,
  maximum: 1 | 2 = 2,
  repository: Project["repository"] = {
    kind: "PATH",
    path: scenario.repositoryPath,
  },
): Project =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id: "prj_hardening",
    name: "Hardening project",
    slug: "hardening-project",
    repository,
    defaultBranch: "main",
    maxActiveCodingSubtasks: maximum,
  });

const seedHierarchy = (
  storage: TaskStorage,
  scenario: Scenario,
  options: {
    readonly maximum?: 1 | 2;
    readonly repository?: Project["repository"];
    readonly subtaskIds?: readonly string[];
  } = {},
): readonly SubtaskId[] => {
  storage.createProject(
    makeProject(
      scenario,
      options.maximum ?? 2,
      options.repository ?? { kind: "PATH", path: scenario.repositoryPath },
    ),
  );
  storage.createBigTask(
    BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_hardening",
      projectId: "prj_hardening",
      title: "Hardening",
      goal: "Challenge worktree ownership",
      rationale: "Write authority depends on it",
      scopeIn: ["Synthetic Git"],
      scopeOut: ["Live execution"],
      acceptanceCriteria: ["Fail closed"],
      status: "IN_PROGRESS",
    }),
  );
  const values = options.subtaskIds ?? ["st_hard_a", "st_hard_b", "st_hard_c"];
  for (const value of values) {
    storage.createSubtask(
      SubtaskCreateInputSchema.parse({
        recordType: "SUBTASK",
        id: value,
        bigTaskId: "bt_hardening",
        title: `Hardening ${value}`,
        goal: "Challenge ownership",
        scopeIn: ["Synthetic fixture"],
        scopeOut: ["Provider execution"],
        acceptanceCriteria: ["Deterministic evidence"],
        untouchedAreas: ["Live Execution"],
        status: "IN_PROGRESS",
        maturity: "NOT_STARTED",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "XHIGH",
        promptSeed: "Hardening fixture",
      }),
    );
  }
  return values.map((value) => SubtaskIdSchema.parse(value));
};

const openStorage = (
  scenario: Scenario,
  clock: () => Date = () => new Date(FIXED_TIME),
): TaskStorage =>
  openTaskDatabase({
    databasePath: scenario.databasePath,
    clock,
  });

const managerFor = (
  storage: TaskStorage,
  scenario: Scenario,
  generatedIds: readonly string[],
  failureHooks: NonNullable<
    WorktreeOwnershipTestDependencies["failureHooks"]
  > = {},
): WorktreeOwnershipManager => {
  let index = 0;
  return createWorktreeOwnershipManagerForTesting(storage, {
    worktreeRoot: scenario.worktreeRoot,
    idGenerator: () => {
      const value = generatedIds[index++];
      if (value === undefined) {
        throw new Error("Synthetic ownership IDs exhausted.");
      }
      return value;
    },
    failureHooks,
  });
};

const captureOwnershipError = (operation: () => unknown): WorktreeOwnershipError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeOwnershipError);
    return error as WorktreeOwnershipError;
  }
  throw new Error("Expected WorktreeOwnershipError.");
};

const sqliteForCorruption = (scenario: Scenario): DatabaseSync => {
  const sqlite = new DatabaseSync(scenario.databasePath);
  sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
  return sqlite;
};

const branchExists = (scenario: Scenario, branchName: string): boolean =>
  runGitResult(scenario.repositoryPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`,
  ]).status === 0;

const waitForFiles = async (paths: readonly string[]): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 5);
    });
  }
  throw new Error("Cross-process barrier was not reached.");
};

const runProcessWorker = (
  scenario: Scenario,
  role: string,
  ownershipId: string,
  readyPath: string,
  goPath: string,
  outcomePath: string,
): Promise<Readonly<{ readonly status: number | null; readonly output: string }>> =>
  new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
        "run",
        "packages/storage/test/worktree-ownership-process-worker.test.ts",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTC_PROCESS_WORKER_ROLE: role,
          CTC_PROCESS_DATABASE_PATH: scenario.databasePath,
          CTC_PROCESS_REPOSITORY_PATH: scenario.repositoryPath,
          CTC_PROCESS_WORKTREE_ROOT: scenario.worktreeRoot,
          CTC_PROCESS_OWNERSHIP_ID: ownershipId,
          CTC_PROCESS_READY_PATH: readyPath,
          CTC_PROCESS_GO_PATH: goPath,
          CTC_PROCESS_OUTCOME_PATH: outcomePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      resolvePromise(Object.freeze({ status, output }));
    });
  });

describe("Git Worktree Ownership V0 comprehensive hardening", () => {
  it("CTC-WORKTREE-HARD-001 rejects same-path, same-branch, same-common-repository recreation after reopen", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const manager = managerFor(storage, scenario, [id("a")]);
    const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
    const originalCommon = runGit(active.worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    storage.close();

    runGit(scenario.repositoryPath, ["worktree", "remove", active.worktreePath]);
    runGit(scenario.repositoryPath, [
      "worktree",
      "add",
      active.worktreePath,
      active.branchName,
    ]);
    expect(runGit(active.worktreePath, ["symbolic-ref", "HEAD"])).toBe(
      `refs/heads/${active.branchName}`,
    );
    expect(
      runGit(active.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ).toBe(originalCommon);

    storage = openStorage(scenario);
    try {
      const reopened = managerFor(storage, scenario, [id("b")]);
      expect(
        captureOwnershipError(() =>
          reopened.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("OWNERSHIP_DRIFT");
      expect(
        captureOwnershipError(() =>
          reopened.releaseOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("OWNERSHIP_DRIFT");
      expect(
        reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
      ).toBe("ACTIVE");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("rejects linked-worktree .git administrative retargeting", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [firstSubtask, secondSubtask] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a"), id("b")]);
      const first = manager.provisionOwnedWorktreeForSubtask(firstSubtask!);
      const second = manager.provisionOwnedWorktreeForSubtask(secondSubtask!);
      writeFileSync(
        join(first.worktreePath, ".git"),
        readFileSync(join(second.worktreePath, ".git"), "utf8"),
        "utf8",
      );

      expect(
        captureOwnershipError(() =>
          manager.resolveActiveOwnedWorktreeForSubtask(firstSubtask!),
        ).code,
      ).toBe("OWNERSHIP_DRIFT");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it.each(["resolve", "release", "reconcile"] as const)(
    "CTC-WORKTREE-HARD-002 %s does not recreate a missing authority root",
    (operation) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [id("a")]);
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        runGit(scenario.repositoryPath, ["worktree", "remove", active.worktreePath]);
        rmSync(scenario.worktreeRoot, { recursive: true });

        const error = captureOwnershipError(() => {
          if (operation === "resolve") {
            manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!);
          } else if (operation === "release") {
            manager.releaseOwnedWorktreeForSubtask(subtaskId!);
          } else {
            manager.reconcileWorktreeOwnershipForSubtask(subtaskId!);
          }
        });
        expect(error.code).toBe("UNSAFE_WORKTREE_ROOT");
        expect(existsSync(scenario.worktreeRoot)).toBe(false);
        expect(
          manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe("ACTIVE");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it.each(["permissions", "symlink"] as const)(
    "rejects an ACTIVE authority root replaced through %s drift",
    (drift) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [id("a")]);
        manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        if (drift === "permissions") {
          chmodSync(scenario.worktreeRoot, 0o755);
        } else {
          const moved = `${scenario.worktreeRoot}-moved`;
          renameSync(scenario.worktreeRoot, moved);
          symlinkSync(moved, scenario.worktreeRoot, "dir");
        }
        expect(
          captureOwnershipError(() =>
            manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("UNSAFE_WORKTREE_ROOT");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it("CTC-WORKTREE-HARD-003 rejects canonicalization, lifecycle, path, SHA, and hierarchy corruption on history read", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")]);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      manager.releaseOwnedWorktreeForSubtask(subtaskId!);
      const sqlite = sqliteForCorruption(scenario);
      try {
        const cases = [
          ["project_id", " prj_hardening"],
          ["subtask_id", " st_hard_a"],
          ["status", "ACTIVE "],
          ["worktree_path", join(scenario.directory, "wrong-root", active.id)],
          ["worktree_path", `${scenario.worktreeRoot}/x/../${active.id}`],
          ["worktree_path", `${scenario.worktreeRoot}//${active.id}`],
          ["branch_name", `ctc/worktree/${id("f")}`],
          ["starting_commit_sha", "A".repeat(40)],
          ["release_head_sha", "f".repeat(39)],
          ["created_at", "2026-09-01T11:04:05+08:00"],
          ["created_at", "2026-09-01T03:04:05Z"],
          ["updated_at", "2026-08-31T03:04:05.000Z"],
        ] as const;
        for (const [column, value] of cases) {
          const original = sqlite
            .prepare(`SELECT ${column} AS value FROM worktree_ownerships WHERE id = ?`)
            .get(active.id) as { readonly value: string | null };
          sqlite
            .prepare(`UPDATE worktree_ownerships SET ${column} = ? WHERE id = ?`)
            .run(value, active.id);
          expect(
            captureOwnershipError(() =>
              manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!),
            ).code,
          ).toBe("MALFORMED_STORED_OWNERSHIP");
          sqlite
            .prepare(`UPDATE worktree_ownerships SET ${column} = ? WHERE id = ?`)
            .run(original.value, active.id);
        }

        sqlite
          .prepare("UPDATE worktree_ownerships SET project_id = ? WHERE id = ?")
          .run("prj_other", active.id);
        expect(
          captureOwnershipError(() =>
            manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!),
          ).code,
        ).toBe("MALFORMED_STORED_OWNERSHIP");
      } finally {
        sqlite.close();
      }
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("fails closed and sanitizes a foreign-key-bypassed missing ownership parent", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")]);
      manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      const sqlite = sqliteForCorruption(scenario);
      try {
        sqlite.prepare("DELETE FROM projects WHERE id = ?").run("prj_hardening");
      } finally {
        sqlite.close();
      }
      const error = captureOwnershipError(() =>
        manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!),
      );
      expect(error.code).toBe("TASK_HIERARCHY_UNAVAILABLE");
      expect(error.message).not.toMatch(/prj_hardening|console\.sqlite|foreign key/i);
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("CTC-WORKTREE-HARD-004 classifies exact post-reservation absence as terminal failure without recovery", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [firstSubtask, secondSubtask] = seedHierarchy(storage, scenario, {
        maximum: 1,
      });
      const firstBranch = `ctc/worktree/${id("a")}`;
      const interrupted = managerFor(storage, scenario, [id("a")], {
        beforeGitAdd: () => {
          runGit(scenario.repositoryPath, ["branch", firstBranch]);
          throw new Error("injected exact absence");
        },
      });
      expect(
        captureOwnershipError(() =>
          interrupted.provisionOwnedWorktreeForSubtask(firstSubtask!),
        ).code,
      ).toBe("GIT_OPERATION_FAILED");
      expect(
        interrupted.listWorktreeOwnershipHistoryForSubtask(firstSubtask!)[0]
          ?.status,
      ).toBe("FAILED");
      expect(branchExists(scenario, firstBranch)).toBe(true);
      expect(
        managerFor(storage, scenario, [id("b")]).provisionOwnedWorktreeForSubtask(
          secondSubtask!,
        ).status,
      ).toBe("ACTIVE");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("rejects invalid generated and durable-colliding IDs before any second Git mutation", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [firstSubtask, secondSubtask] = seedHierarchy(storage, scenario);
      const invalid = managerFor(storage, scenario, ["wt_NOT_CANONICAL"]);
      expect(
        captureOwnershipError(() =>
          invalid.provisionOwnedWorktreeForSubtask(firstSubtask!),
        ).code,
      ).toBe("OWNERSHIP_COLLISION");
      expect(invalid.listWorktreeOwnershipHistoryForSubtask(firstSubtask!)).toEqual([]);

      const first = managerFor(storage, scenario, [id("a")]);
      first.provisionOwnedWorktreeForSubtask(firstSubtask!);
      first.releaseOwnedWorktreeForSubtask(firstSubtask!);
      runGit(scenario.repositoryPath, ["branch", "-D", `ctc/worktree/${id("a")}`]);
      expect(
        captureOwnershipError(() =>
          managerFor(storage, scenario, [id("a")]).provisionOwnedWorktreeForSubtask(
            secondSubtask!,
          ),
        ).code,
      ).toBe("OWNERSHIP_COLLISION");
      expect(
        first.listWorktreeOwnershipHistoryForSubtask(secondSubtask!),
      ).toEqual([]);
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it.each(["path-only", "registry-only", "recreated-impostor"] as const)(
    "preserves ambiguous PROVISIONING evidence for %s",
    (variant) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [firstSubtask, secondSubtask] = seedHierarchy(storage, scenario, {
          maximum: 1,
        });
        const generatedPath = join(scenario.worktreeRoot, id("a"));
        const interrupted = managerFor(storage, scenario, [id("a")],
          variant === "path-only"
            ? {
                beforeGitAdd: () => {
                  mkdirSync(generatedPath);
                  throw new Error("path-only ambiguity");
                },
              }
            : {
                afterGitAdd: () => {
                  if (variant === "registry-only") {
                    rmSync(generatedPath, { recursive: true });
                  }
                  throw new Error("post-add interruption");
                },
              },
        );
        expect(
          captureOwnershipError(() =>
            interrupted.provisionOwnedWorktreeForSubtask(firstSubtask!),
          ).code,
        ).toBe("RECOVERY_REQUIRED");
        const pending =
          interrupted.listWorktreeOwnershipHistoryForSubtask(firstSubtask!)[0]!;
        expect(pending.status).toBe("PROVISIONING");

        if (variant === "recreated-impostor") {
          runGit(scenario.repositoryPath, ["worktree", "remove", pending.worktreePath]);
          runGit(scenario.repositoryPath, [
            "worktree",
            "add",
            pending.worktreePath,
            pending.branchName,
          ]);
        }

        expect(
          captureOwnershipError(() =>
            interrupted.reconcileWorktreeOwnershipForSubtask(firstSubtask!),
          ).code,
        ).toBe("RECOVERY_REQUIRED");
        expect(
          captureOwnershipError(() =>
            managerFor(storage, scenario, [id("b")]).provisionOwnedWorktreeForSubtask(
              secondSubtask!,
            ),
          ).code,
        ).toBe("PROJECT_CAPACITY_EXCEEDED");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it("preserves the complete staged, unstaged, untracked, and ignored source checkout", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      writeFileSync(join(scenario.repositoryPath, ".gitignore"), "ignored.txt\n", "utf8");
      runGit(scenario.repositoryPath, ["add", ".gitignore"]);
      runGit(scenario.repositoryPath, ["commit", "-m", "second baseline commit"]);
      const [subtaskId] = seedHierarchy(storage, scenario);
      const sourceHead = runGit(scenario.repositoryPath, ["rev-parse", "HEAD"]);
      const sourceBranch = runGit(scenario.repositoryPath, ["symbolic-ref", "HEAD"]);
      writeFileSync(join(scenario.repositoryPath, "README.md"), "staged source\n", "utf8");
      runGit(scenario.repositoryPath, ["add", "README.md"]);
      writeFileSync(
        join(scenario.repositoryPath, "tracked.txt"),
        "unstaged source\n",
        "utf8",
      );
      writeFileSync(join(scenario.repositoryPath, "untracked.txt"), "untracked\n", "utf8");
      writeFileSync(join(scenario.repositoryPath, "ignored.txt"), "ignored\n", "utf8");
      const statusBefore = runGit(scenario.repositoryPath, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
        "--ignored=matching",
      ]);
      const indexBefore = runGit(scenario.repositoryPath, ["diff", "--cached", "--binary"]);
      const trackedBefore = readFileSync(join(scenario.repositoryPath, "tracked.txt"), "utf8");

      const active = managerFor(storage, scenario, [id("a")])
        .provisionOwnedWorktreeForSubtask(subtaskId!);

      expect(runGit(scenario.repositoryPath, ["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(runGit(scenario.repositoryPath, ["symbolic-ref", "HEAD"])).toBe(sourceBranch);
      expect(
        runGit(scenario.repositoryPath, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
          "--ignored=matching",
        ]),
      ).toBe(statusBefore);
      expect(runGit(scenario.repositoryPath, ["diff", "--cached", "--binary"])).toBe(
        indexBefore,
      );
      expect(readFileSync(join(scenario.repositoryPath, "tracked.txt"), "utf8")).toBe(
        trackedBefore,
      );
      expect(readFileSync(join(active.worktreePath, "README.md"), "utf8")).toBe(
        "initial\n",
      );
      expect(readFileSync(join(active.worktreePath, "tracked.txt"), "utf8")).toBe(
        "tracked initial\n",
      );
      expect(existsSync(join(active.worktreePath, "untracked.txt"))).toBe(false);
      expect(existsSync(join(active.worktreePath, "ignored.txt"))).toBe(false);
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it.each(["before-reservation", "before-add", "after-add", "source-branch"] as const)(
    "keeps source TOCTOU drift at %s out of ACTIVE state",
    (seam) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        let commitIndex = 0;
        const drift = (): void => {
          if (seam === "source-branch") {
            runGit(scenario.repositoryPath, ["switch", "-c", "source-drift"]);
          } else {
            commitIndex += 1;
            writeFileSync(
              join(scenario.repositoryPath, `drift-${commitIndex}.txt`),
              "source drift\n",
              "utf8",
            );
            runGit(scenario.repositoryPath, ["add", `drift-${commitIndex}.txt`]);
            runGit(scenario.repositoryPath, ["commit", "-m", `drift ${commitIndex}`]);
          }
        };
        const manager = managerFor(storage, scenario, [id("a")], {
          ...(seam === "before-reservation" ? { beforeReservation: drift } : {}),
          ...(seam === "before-add" || seam === "source-branch"
            ? { beforeGitAdd: drift }
            : {}),
          ...(seam === "after-add" ? { afterGitAdd: drift } : {}),
        });
        expect(
          captureOwnershipError(() =>
            manager.provisionOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("RECOVERY_REQUIRED");
        expect(
          manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe("PROVISIONING");
        expect(
          captureOwnershipError(() =>
            manager.reconcileWorktreeOwnershipForSubtask(subtaskId!),
          ).code,
        ).toBe("RECOVERY_REQUIRED");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it("removes inherited Git-control variables case-insensitively and neutralizes hooks", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    const sentinel = join(scenario.directory, "hook-secret-sentinel");
    const hook = join(scenario.repositoryPath, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nprintf sentinel > '${sentinel}'\n`, "utf8");
    chmodSync(hook, 0o755);
    const environmentPatch = {
      GIT_DIR: join(scenario.directory, "wrong-git-dir"),
      git_work_tree: join(scenario.directory, "wrong-work-tree"),
      GiT_INDEX_FILE: join(scenario.directory, "secret-index"),
      GIT_OBJECT_DIRECTORY: join(scenario.directory, "secret-objects"),
      git_alternate_object_directories: join(scenario.directory, "secret-alternates"),
      GIT_CONFIG_GLOBAL: join(scenario.directory, "secret-global"),
      Git_Config_System: join(scenario.directory, "secret-system"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(scenario.repositoryPath, ".git", "hooks"),
    } as const;
    const originals = new Map<string, string | undefined>();
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      for (const [name, value] of Object.entries(environmentPatch)) {
        originals.set(name, process.env[name]);
        process.env[name] = value;
      }
      expect(
        managerFor(storage, scenario, [id("a")]).provisionOwnedWorktreeForSubtask(
          subtaskId!,
        ).status,
      ).toBe("ACTIVE");
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      for (const [name, value] of originals) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      storage.close();
      cleanup(scenario);
    }
  });

  it("accepts locked registry metadata but rejects detached ACTIVE ownership", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")]);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      runGit(scenario.repositoryPath, ["worktree", "lock", active.worktreePath]);
      expect(
        manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.id,
      ).toBe(active.id);
      runGit(scenario.repositoryPath, ["worktree", "unlock", active.worktreePath]);
      runGit(active.worktreePath, ["switch", "--detach"]);
      expect(
        captureOwnershipError(() =>
          manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("OWNERSHIP_DRIFT");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("fails closed on truncated, duplicate, and unknown Git registry fields", () => {
    const sha = "a".repeat(40);
    for (const malformed of [
      `worktree /tmp/owned\0HEAD ${sha}\0branch refs/heads/main\0`,
      `worktree /tmp/owned\0HEAD ${sha}\0HEAD ${sha}\0branch refs/heads/main\0\0`,
      `worktree /tmp/owned\0HEAD ${sha}\0branch refs/heads/main\0mystery value\0\0`,
      `HEAD ${sha}\0branch refs/heads/main\0\0`,
    ]) {
      expect(
        captureOwnershipError(() =>
          parseRegisteredWorktreesForTesting(0, Buffer.from(malformed, "utf8")),
        ).code,
      ).toBe("GIT_OPERATION_FAILED");
    }
    expect(
      captureOwnershipError(() =>
        parseRegisteredWorktreesForTesting(1, Buffer.alloc(0)),
      ).code,
    ).toBe("GIT_OPERATION_FAILED");
  });

  it("parses prunable registry metadata without confusing it for valid ACTIVE path evidence", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")]);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      rmSync(active.worktreePath, { recursive: true });
      expect(
        runGit(scenario.repositoryPath, ["worktree", "list", "--porcelain"]),
      ).toContain("prunable");
      expect(
        captureOwnershipError(() =>
          manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("OWNERSHIP_DRIFT");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("blocks staged, unmerged, and dirty-submodule release before RELEASING", () => {
    for (const variant of ["staged", "unmerged", "submodule"] as const) {
      const scenario = createScenario();
      if (variant === "submodule") {
        const submodule = join(scenario.directory, "submodule-source");
        mkdirSync(submodule);
        runGit(submodule, ["init", "-b", "main"]);
        runGit(submodule, ["config", "user.name", "Submodule Fixture"]);
        runGit(submodule, ["config", "user.email", "submodule@example.invalid"]);
        writeFileSync(join(submodule, "module.txt"), "module\n", "utf8");
        runGit(submodule, ["add", "module.txt"]);
        runGit(submodule, ["commit", "-m", "module initial"]);
        runGit(scenario.repositoryPath, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          submodule,
          "module",
        ]);
        runGit(scenario.repositoryPath, ["commit", "-m", "add submodule"]);
      }
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [id("a")]);
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        if (variant === "staged") {
          writeFileSync(join(active.worktreePath, "README.md"), "staged\n", "utf8");
          runGit(active.worktreePath, ["add", "README.md"]);
        } else if (variant === "unmerged") {
          writeFileSync(join(active.worktreePath, "README.md"), "owned\n", "utf8");
          runGit(active.worktreePath, ["add", "README.md"]);
          runGit(active.worktreePath, ["commit", "-m", "owned conflict side"]);
          writeFileSync(join(scenario.repositoryPath, "README.md"), "source\n", "utf8");
          runGit(scenario.repositoryPath, ["add", "README.md"]);
          runGit(scenario.repositoryPath, ["commit", "-m", "source conflict side"]);
          expect(runGitResult(active.worktreePath, ["merge", "main"]).status).not.toBe(0);
        } else {
          runGit(active.worktreePath, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "update",
            "--init",
          ]);
          writeFileSync(join(active.worktreePath, "module", "module.txt"), "dirty\n", "utf8");
        }

        expect(
          captureOwnershipError(() =>
            manager.releaseOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("WORKTREE_DIRTY");
        expect(
          manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe("ACTIVE");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    }
  });

  it.each(["dirty", "commit", "replacement"] as const)(
    "does not falsely release after %s drift following release evidence",
    (variant) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      let activePath = "";
      let branchName = "";
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [id("a")], {
          beforeGitRemove: () => {
            if (variant === "dirty") {
              writeFileSync(join(activePath, "late.txt"), "late dirty\n", "utf8");
            } else if (variant === "commit") {
              writeFileSync(join(activePath, "late.txt"), "late commit\n", "utf8");
              runGit(activePath, ["add", "late.txt"]);
              runGit(activePath, ["commit", "-m", "late commit"]);
            } else {
              runGit(scenario.repositoryPath, ["worktree", "remove", activePath]);
              runGit(scenario.repositoryPath, [
                "worktree",
                "add",
                activePath,
                branchName,
              ]);
            }
          },
        });
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        activePath = active.worktreePath;
        branchName = active.branchName;
        expect(
          captureOwnershipError(() =>
            manager.releaseOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("RECOVERY_REQUIRED");
        expect(
          manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe("RELEASING");
        expect(
          captureOwnershipError(() =>
            manager.reconcileWorktreeOwnershipForSubtask(subtaskId!),
          ).code,
        ).not.toBe("OWNERSHIP_NOT_ACTIVE");
        expect(
          manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe("RELEASING");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it("preserves RELEASING, its slot, and its checkout across a pre-remove crash and reopen", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [firstSubtask, secondSubtask] = seedHierarchy(storage, scenario, {
      maximum: 1,
    });
    const interrupted = managerFor(storage, scenario, [id("a")], {
      beforeGitRemove: () => {
        throw new Error("crash before remove");
      },
    });
    const active = interrupted.provisionOwnedWorktreeForSubtask(firstSubtask!);
    expect(
      captureOwnershipError(() =>
        interrupted.releaseOwnedWorktreeForSubtask(firstSubtask!),
      ).code,
    ).toBe("RECOVERY_REQUIRED");
    storage.close();

    storage = openStorage(scenario);
    try {
      const reopened = managerFor(storage, scenario, [id("b"), id("c")]);
      expect(existsSync(active.worktreePath)).toBe(true);
      expect(
        reopened.listWorktreeOwnershipHistoryForSubtask(firstSubtask!)[0]?.status,
      ).toBe("RELEASING");
      expect(
        captureOwnershipError(() =>
          reopened.resolveActiveOwnedWorktreeForSubtask(firstSubtask!),
        ).code,
      ).toBe("OWNERSHIP_NOT_ACTIVE");
      expect(
        captureOwnershipError(() =>
          reopened.reconcileWorktreeOwnershipForSubtask(firstSubtask!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(
        captureOwnershipError(() =>
          reopened.provisionOwnedWorktreeForSubtask(firstSubtask!),
        ).code,
      ).toBe("OWNERSHIP_CONFLICT");
      expect(
        captureOwnershipError(() =>
          reopened.provisionOwnedWorktreeForSubtask(secondSubtask!),
        ).code,
      ).toBe("PROJECT_CAPACITY_EXCEEDED");
      expect(existsSync(active.worktreePath)).toBe(true);
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("keeps backward-clock activation recoverable and never fabricates time", () => {
    const scenario = createScenario();
    let now = new Date("2026-09-01T03:04:05.000Z");
    const storage = openStorage(scenario, () => new Date(now));
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")], {
        beforeGitAdd: () => {
          now = new Date("2026-09-01T03:04:04.000Z");
        },
      });
      expect(
        captureOwnershipError(() =>
          manager.provisionOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      const pending = manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]!;
      expect(pending).toMatchObject({
        status: "PROVISIONING",
        createdAt: "2026-09-01T03:04:05.000Z",
        updatedAt: "2026-09-01T03:04:05.000Z",
      });
      now = new Date("2026-09-01T03:04:06.000Z");
      expect(manager.reconcileWorktreeOwnershipForSubtask(subtaskId!)).toMatchObject({
        status: "ACTIVE",
        activatedAt: "2026-09-01T03:04:06.000Z",
      });
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("keeps a post-remove backward clock RELEASING until safe reconciliation", () => {
    const scenario = createScenario();
    let now = new Date("2026-09-01T03:04:05.000Z");
    const storage = openStorage(scenario, () => new Date(now));
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")], {
        afterGitRemove: () => {
          now = new Date("2026-09-01T03:04:04.000Z");
        },
      });
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      expect(
        captureOwnershipError(() =>
          manager.releaseOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(existsSync(active.worktreePath)).toBe(false);
      expect(
        manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
      ).toBe("RELEASING");
      now = new Date("2026-09-01T03:04:06.000Z");
      expect(manager.reconcileWorktreeOwnershipForSubtask(subtaskId!)).toMatchObject({
        status: "RELEASED",
        releasedAt: "2026-09-01T03:04:06.000Z",
      });
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("sanitizes SQLite busy failure without reservation or Git mutation and recovers", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    const locker = new DatabaseSync(scenario.databasePath);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      getTaskStorageWorktreeAccess(storage)!.sqlite.exec("PRAGMA busy_timeout = 0");
      locker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      const blocked = managerFor(storage, scenario, [id("a")]);
      const error = captureOwnershipError(() =>
        blocked.provisionOwnedWorktreeForSubtask(subtaskId!),
      );
      expect(error.code).toBe("STORAGE_UNAVAILABLE");
      expect(error.message).not.toMatch(/sqlite|locked|console\.sqlite/i);
      expect(existsSync(join(scenario.worktreeRoot, id("a")))).toBe(false);
      expect(branchExists(scenario, `ctc/worktree/${id("a")}`)).toBe(false);
      locker.exec("ROLLBACK");

      expect(
        managerFor(storage, scenario, [id("b")]).provisionOwnedWorktreeForSubtask(
          subtaskId!,
        ).status,
      ).toBe("ACTIVE");
    } finally {
      if (locker.isTransaction) {
        locker.exec("ROLLBACK");
      }
      locker.close();
      storage.close();
      cleanup(scenario);
    }
  });

  it("serializes provision/reconcile and release/reconcile across managers", () => {
    const scenario = createScenario();
    const firstStorage = openStorage(scenario);
    let secondStorage: TaskStorage | null = null;
    try {
      const [subtaskId] = seedHierarchy(firstStorage, scenario);
      const interruptedProvision = managerFor(firstStorage, scenario, [id("a")], {
        afterGitAdd: () => {
          throw new Error("post-add crash");
        },
      });
      captureOwnershipError(() =>
        interruptedProvision.provisionOwnedWorktreeForSubtask(subtaskId!),
      );
      secondStorage = openStorage(scenario);
      const reconciler = managerFor(secondStorage, scenario, [id("b")]);
      expect(
        reconciler.reconcileWorktreeOwnershipForSubtask(subtaskId!).status,
      ).toBe("ACTIVE");
      expect(
        interruptedProvision.reconcileWorktreeOwnershipForSubtask(subtaskId!).status,
      ).toBe("ACTIVE");

      const interruptedRelease = managerFor(firstStorage, scenario, [id("c")], {
        beforeGitRemove: () => {
          throw new Error("pre-remove crash");
        },
      });
      expect(
        captureOwnershipError(() =>
          interruptedRelease.releaseOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(
        captureOwnershipError(() =>
          reconciler.reconcileWorktreeOwnershipForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(
        reconciler.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
      ).toBe("RELEASING");
    } finally {
      secondStorage?.close();
      firstStorage.close();
      cleanup(scenario);
    }
  });

  it("allows exactly one same-Subtask Git mutation across two barrier-synchronized processes", async () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario, { maximum: 1 });
    storage.close();
    const firstReady = join(scenario.directory, "first.ready");
    const secondReady = join(scenario.directory, "second.ready");
    const goPath = join(scenario.directory, "go.signal");
    const firstOutcome = join(scenario.directory, "first.outcome");
    const secondOutcome = join(scenario.directory, "second.outcome");
    try {
      const first = runProcessWorker(
        scenario,
        "first",
        id("a"),
        firstReady,
        goPath,
        firstOutcome,
      );
      const second = runProcessWorker(
        scenario,
        "second",
        id("b"),
        secondReady,
        goPath,
        secondOutcome,
      );
      await waitForFiles([firstReady, secondReady]);
      writeFileSync(goPath, "go\n", "utf8");
      const results = await Promise.all([first, second]);
      expect(
        results.map((result) => ({ status: result.status })),
        results.map((result) => result.output).join("\n"),
      ).toEqual([{ status: 0 }, { status: 0 }]);
      expect(
        [
          readFileSync(firstOutcome, "utf8").trim(),
          readFileSync(secondOutcome, "utf8").trim(),
        ].sort(),
      ).toEqual(["ACTIVE", "OWNERSHIP_CONFLICT"]);

      const verified = openStorage(scenario);
      try {
        const history = managerFor(verified, scenario, [id("c")])
          .listWorktreeOwnershipHistoryForSubtask(subtaskId!);
        expect(history).toHaveLength(1);
        expect(history[0]?.status).toBe("ACTIVE");
        expect(
          [id("a"), id("b")].filter((ownershipId) =>
            branchExists(scenario, `ctc/worktree/${ownershipId}`),
          ),
        ).toHaveLength(1);
      } finally {
        verified.close();
      }
    } finally {
      cleanup(scenario);
    }
  }, 20_000);

  it("orders multi-generation history by canonical time then ID after reopen and fails on terminal corruption", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const first = managerFor(storage, scenario, [id("b")]);
    first.provisionOwnedWorktreeForSubtask(subtaskId!);
    first.releaseOwnedWorktreeForSubtask(subtaskId!);
    const failed = managerFor(storage, scenario, [id("a")], {
      beforeGitAdd: () => {
        throw new Error("exact absence");
      },
    });
    captureOwnershipError(() => failed.provisionOwnedWorktreeForSubtask(subtaskId!));
    const third = managerFor(storage, scenario, [id("d")]);
    third.provisionOwnedWorktreeForSubtask(subtaskId!);
    third.releaseOwnedWorktreeForSubtask(subtaskId!);
    managerFor(storage, scenario, [id("c")]).provisionOwnedWorktreeForSubtask(
      subtaskId!,
    );
    storage.close();

    storage = openStorage(scenario);
    try {
      const reopened = managerFor(storage, scenario, [id("e")]);
      expect(
        reopened
          .listWorktreeOwnershipHistoryForSubtask(subtaskId!)
          .map((ownership) => [ownership.id, ownership.status]),
      ).toEqual([
        [id("a"), "FAILED"],
        [id("b"), "RELEASED"],
        [id("c"), "ACTIVE"],
        [id("d"), "RELEASED"],
      ]);
      const sqlite = sqliteForCorruption(scenario);
      try {
        sqlite
          .prepare("UPDATE worktree_ownerships SET worktree_path = ? WHERE id = ?")
          .run(join(scenario.directory, "terminal-corruption", id("b")), id("b"));
      } finally {
        sqlite.close();
      }
      expect(
        captureOwnershipError(() =>
          reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!),
        ).code,
      ).toBe("MALFORMED_STORED_OWNERSHIP");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("keeps ACTIVE ownership physical when the Subtask later becomes terminal", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [id("a")]);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      const sqlite = new DatabaseSync(scenario.databasePath);
      try {
        sqlite.prepare("UPDATE subtasks SET status = 'DONE' WHERE id = ?").run(subtaskId!);
      } finally {
        sqlite.close();
      }
      expect(
        manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.id,
      ).toBe(active.id);
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });
});
