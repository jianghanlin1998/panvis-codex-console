import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import * as storagePackage from "../src/index.js";
import type { TaskStorage, WorktreeOwnershipManager } from "../src/index.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";

const FIXED_TIME = "2026-08-31T00:00:00.000Z";
const fixedClock = (): Date => new Date(FIXED_TIME);
const ids = {
  a: `wt_${"a".repeat(32)}`,
  b: `wt_${"b".repeat(32)}`,
  c: `wt_${"c".repeat(32)}`,
  d: `wt_${"d".repeat(32)}`,
} as const;

const runGit = (cwd: string, arguments_: readonly string[]): string => {
  const result = spawnSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Synthetic Git command failed: ${arguments_[0] ?? "unknown"}`);
  }
  return result.stdout.trim();
};

const makeIdGenerator = (values: readonly string[]): (() => string) => {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("The deterministic ownership ID fixture was exhausted.");
    }
    return value;
  };
};

interface Scenario {
  readonly directory: string;
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
}

const createScenario = (): Scenario => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-worktree-v0-")),
  );
  const repositoryPath = join(directory, "source");
  mkdirSync(repositoryPath);
  runGit(repositoryPath, ["init", "-b", "main"]);
  runGit(repositoryPath, ["config", "user.name", "Codex Test"]);
  runGit(repositoryPath, ["config", "user.email", "codex@example.invalid"]);
  writeFileSync(join(repositoryPath, "README.md"), "committed\n", "utf8");
  runGit(repositoryPath, ["add", "README.md"]);
  runGit(repositoryPath, ["commit", "-m", "initial"]);
  return Object.freeze({
    directory,
    databasePath: join(directory, "console.sqlite"),
    repositoryPath,
    worktreeRoot: join(directory, "owned-worktrees"),
  });
};

const cleanupScenario = (scenario: Scenario): void => {
  rmSync(scenario.directory, { recursive: true, force: true });
};

const makeProject = (
  scenario: Scenario,
  maximum = 2,
  repository: Project["repository"] = {
    kind: "PATH",
    path: scenario.repositoryPath,
  },
  id = "prj_worktree",
): Project =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id,
    name: `Project ${id}`,
    slug: id.replaceAll("_", "-"),
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
    readonly status?: "TODO" | "IN_PROGRESS" | "QA_DEBUG" | "DONE" | "DROPPED" | "ARCHIVED";
  } = {},
): readonly SubtaskId[] => {
  const subtaskIds = options.subtaskIds ?? ["st_a", "st_b", "st_c"];
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
      id: "bt_worktree",
      projectId: "prj_worktree",
      title: "Worktree ownership",
      goal: "Own isolated worktrees",
      rationale: "Safe local execution foundation",
      scopeIn: ["Worktree ownership"],
      scopeOut: ["Write execution"],
      acceptanceCriteria: ["Ownership is durable"],
      status: "IN_PROGRESS",
    }),
  );
  for (const id of subtaskIds) {
    storage.createSubtask(
      SubtaskCreateInputSchema.parse({
        recordType: "SUBTASK",
        id,
        bigTaskId: "bt_worktree",
        title: `Subtask ${id}`,
        goal: "Exercise ownership",
        scopeIn: ["Synthetic repository"],
        scopeOut: ["Provider execution"],
        acceptanceCriteria: ["Deterministic result"],
        untouchedAreas: ["Live Execution"],
        status: options.status ?? "IN_PROGRESS",
        maturity: "NOT_STARTED",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
        promptSeed: "Test the ownership primitive.",
      }),
    );
  }
  return subtaskIds.map((id) => SubtaskIdSchema.parse(id));
};

const openStorage = (scenario: Scenario): TaskStorage =>
  openTaskDatabase({ databasePath: scenario.databasePath, clock: fixedClock });

const managerFor = (
  storage: TaskStorage,
  scenario: Scenario,
  generatedIds: readonly string[],
  failureHooks: {
    readonly beforeGitAdd?: () => void;
    readonly afterGitAdd?: () => void;
    readonly afterGitRemove?: () => void;
  } = {},
): WorktreeOwnershipManager =>
  createWorktreeOwnershipManagerForTesting(storage, {
    worktreeRoot: scenario.worktreeRoot,
    idGenerator: makeIdGenerator(generatedIds),
    failureHooks,
  });

const captureOwnershipError = (operation: () => unknown): WorktreeOwnershipError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeOwnershipError);
    return error as WorktreeOwnershipError;
  }
  throw new Error("Expected the ownership operation to fail.");
};

const branchExists = (scenario: Scenario, branch: string): boolean => {
  const result = spawnSync(
    "git",
    ["-C", scenario.repositoryPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { shell: false },
  );
  return result.status === 0;
};

describe("Git Worktree Ownership & Provisioning V0", () => {
  it("provisions from exact local HEAD without copying dirty source changes", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const sourceHead = runGit(scenario.repositoryPath, ["rev-parse", "HEAD"]);
      writeFileSync(join(scenario.repositoryPath, "README.md"), "dirty source\n", "utf8");
      writeFileSync(join(scenario.repositoryPath, "source-only.txt"), "sentinel\n", "utf8");
      const sourceStatus = runGit(scenario.repositoryPath, ["status", "--porcelain"]);

      const ownership = managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(
        subtaskId!,
      );

      expect(ownership).toMatchObject({
        id: ids.a,
        status: "ACTIVE",
        startingCommitSha: sourceHead,
        branchName: `ctc/worktree/${ids.a}`,
        worktreePath: join(scenario.worktreeRoot, ids.a),
      });
      expect(Object.isFrozen(ownership)).toBe(true);
      expect(runGit(ownership.worktreePath, ["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(runGit(ownership.worktreePath, ["rev-parse", "--git-common-dir"])).toContain(
        ".git",
      );
      expect(readFileSync(join(ownership.worktreePath, "README.md"), "utf8")).toBe(
        "committed\n",
      );
      expect(() => readFileSync(join(ownership.worktreePath, "source-only.txt"), "utf8")).toThrow();
      expect(runGit(scenario.repositoryPath, ["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(runGit(scenario.repositoryPath, ["status", "--porcelain"])).toBe(sourceStatus);
      expect(readFileSync(join(scenario.repositoryPath, "README.md"), "utf8")).toBe(
        "dirty source\n",
      );
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("isolates two Subtasks in distinct worktrees and branches", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [firstId, secondId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [ids.a, ids.b]);
      const first = manager.provisionOwnedWorktreeForSubtask(firstId!);
      const second = manager.provisionOwnedWorktreeForSubtask(secondId!);
      writeFileSync(join(first.worktreePath, "only-a.txt"), "A\n", "utf8");

      expect(first.worktreePath).not.toBe(second.worktreePath);
      expect(first.branchName).not.toBe(second.branchName);
      expect(runGit(first.worktreePath, ["rev-parse", "--git-common-dir"])).toBe(
        runGit(second.worktreePath, ["rev-parse", "--git-common-dir"]),
      );
      expect(() => readFileSync(join(second.worktreePath, "only-a.txt"), "utf8")).toThrow();
      expect(() => readFileSync(join(scenario.repositoryPath, "only-a.txt"), "utf8")).toThrow();
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it.each(["DONE", "DROPPED", "ARCHIVED"] as const)(
    "rejects terminal Subtask status %s without dispatch-policy checks",
    (status) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario, { status });
        expect(
          captureOwnershipError(() =>
            managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(
              subtaskId!,
            ),
          ).code,
        ).toBe("INELIGIBLE_SUBTASK_STATUS");
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    },
  );

  it("fails closed for REFERENCE, missing, non-Git, and nested repository sources", () => {
    for (const repository of [
      { kind: "REFERENCE", reference: "github:owner/repository" } as const,
      { kind: "PATH", path: "/definitely/missing/ctc-worktree-source" } as const,
    ]) {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario, { repository });
        const code = captureOwnershipError(() =>
          managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(subtaskId!),
        ).code;
        expect(code).toBe(
          repository.kind === "REFERENCE"
            ? "UNSUPPORTED_REPOSITORY_REFERENCE"
            : "REPOSITORY_PATH_UNAVAILABLE",
        );
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    }

    for (const kind of ["plain", "nested"] as const) {
      const scenario = createScenario();
      const path = join(scenario.directory, kind);
      mkdirSync(path);
      const storage = openStorage(scenario);
      try {
        const repositoryPath =
          kind === "plain"
            ? path
            : (() => {
                const nested = join(scenario.repositoryPath, "nested");
                mkdirSync(nested);
                return nested;
              })();
        const [subtaskId] = seedHierarchy(storage, scenario, {
          repository: { kind: "PATH", path: repositoryPath },
        });
        expect(
          captureOwnershipError(() =>
            managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(
              subtaskId!,
            ),
          ).code,
        ).toBe(kind === "plain" ? "NOT_GIT_REPOSITORY" : "REPOSITORY_ROOT_MISMATCH");
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    }
  });

  it("accepts a configured symlink only when it resolves to the exact repository root", () => {
    const scenario = createScenario();
    const linkedRoot = join(scenario.directory, "source-link");
    symlinkSync(scenario.repositoryPath, linkedRoot, "dir");
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario, {
        repository: { kind: "PATH", path: linkedRoot },
      });
      expect(
        managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(subtaskId!)
          .status,
      ).toBe("ACTIVE");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("enforces one non-terminal ownership per Subtask and permits a new generation after release", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [ids.a, ids.b, ids.c]);
      const first = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      expect(
        captureOwnershipError(() => manager.provisionOwnedWorktreeForSubtask(subtaskId!)).code,
      ).toBe("OWNERSHIP_CONFLICT");
      expect(manager.releaseOwnedWorktreeForSubtask(subtaskId!).status).toBe("RELEASED");
      const second = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      expect(second.id).not.toBe(first.id);
      expect(manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)).toEqual([
        expect.objectContaining({ id: first.id, status: "RELEASED" }),
        expect.objectContaining({ id: second.id, status: "ACTIVE" }),
      ]);
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("releases FAILED reservations and Project slots without deleting leftover branches", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [firstId, secondId] = seedHierarchy(storage, scenario, { maximum: 1 });
      const failing = managerFor(storage, scenario, [ids.a], {
        beforeGitAdd: () => {
          throw new Error("injected before add");
        },
      });
      expect(
        captureOwnershipError(() => failing.provisionOwnedWorktreeForSubtask(firstId!)).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(failing.listWorktreeOwnershipHistoryForSubtask(firstId!)[0]?.status).toBe(
        "FAILED",
      );
      const successful = managerFor(storage, scenario, [ids.b, ids.c]);
      const regenerated = successful.provisionOwnedWorktreeForSubtask(firstId!);
      expect(regenerated).toMatchObject({ id: ids.b, status: "ACTIVE" });
      expect(
        captureOwnershipError(() =>
          successful.provisionOwnedWorktreeForSubtask(secondId!),
        ).code,
      ).toBe("PROJECT_CAPACITY_EXCEEDED");
      successful.releaseOwnedWorktreeForSubtask(firstId!);
      expect(
        managerFor(storage, scenario, [ids.c]).provisionOwnedWorktreeForSubtask(secondId!)
          .status,
      ).toBe("ACTIVE");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("enforces Project max=1 and max=2 transactionally across storage connections", () => {
    for (const maximum of [1, 2] as const) {
      const scenario = createScenario();
      const firstStorage = openStorage(scenario);
      let secondStorage: TaskStorage | null = null;
      try {
        const [firstId, secondId, thirdId] = seedHierarchy(firstStorage, scenario, {
          maximum,
        });
        secondStorage = openStorage(scenario);
        const firstManager = managerFor(firstStorage, scenario, [ids.a, ids.c]);
        const secondManager = managerFor(secondStorage, scenario, [ids.b, ids.d]);
        expect(firstManager.provisionOwnedWorktreeForSubtask(firstId!).status).toBe("ACTIVE");
        if (maximum === 1) {
          expect(
            captureOwnershipError(() =>
              secondManager.provisionOwnedWorktreeForSubtask(secondId!),
            ).code,
          ).toBe("PROJECT_CAPACITY_EXCEEDED");
        } else {
          expect(secondManager.provisionOwnedWorktreeForSubtask(secondId!).status).toBe(
            "ACTIVE",
          );
          expect(
            captureOwnershipError(() =>
              firstManager.provisionOwnedWorktreeForSubtask(thirdId!),
            ).code,
          ).toBe("PROJECT_CAPACITY_EXCEEDED");
        }
      } finally {
        secondStorage?.close();
        firstStorage.close();
        cleanupScenario(scenario);
      }
    }
  });

  it("fails closed on branch, file, symlink, and registered-worktree collisions", () => {
    for (const collision of ["branch", "file", "symlink", "registered"] as const) {
      const scenario = createScenario();
      mkdirSync(scenario.worktreeRoot, { mode: 0o700 });
      chmodSync(scenario.worktreeRoot, 0o700);
      const generatedPath = join(scenario.worktreeRoot, ids.a);
      if (collision === "branch") {
        runGit(scenario.repositoryPath, ["branch", `ctc/worktree/${ids.a}`]);
      } else if (collision === "file") {
        writeFileSync(generatedPath, "collision\n", "utf8");
      } else if (collision === "symlink") {
        symlinkSync(scenario.repositoryPath, generatedPath, "dir");
      } else {
        runGit(scenario.repositoryPath, [
          "worktree",
          "add",
          "-b",
          "unrelated-collision",
          generatedPath,
          "HEAD",
        ]);
      }
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [ids.a]);
        expect(
          captureOwnershipError(() => manager.provisionOwnedWorktreeForSubtask(subtaskId!))
            .code,
        ).toBe("OWNERSHIP_COLLISION");
        expect(manager.listWorktreeOwnershipHistoryForSubtask(subtaskId!)).toEqual([]);
        if (collision === "branch") {
          expect(branchExists(scenario, `ctc/worktree/${ids.a}`)).toBe(true);
        }
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    }
  });

  it("releases a clean committed worktree non-forcefully and preserves its branch and release HEAD", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [ids.a]);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      writeFileSync(join(active.worktreePath, "evidence.txt"), "committed evidence\n", "utf8");
      runGit(active.worktreePath, ["add", "evidence.txt"]);
      runGit(active.worktreePath, ["commit", "-m", "owned evidence"]);
      const releaseHead = runGit(active.worktreePath, ["rev-parse", "HEAD"]);

      const released = manager.releaseOwnedWorktreeForSubtask(subtaskId!);

      expect(released).toMatchObject({
        status: "RELEASED",
        releaseHeadSha: releaseHead,
      });
      expect(() => readFileSync(join(active.worktreePath, "evidence.txt"), "utf8")).toThrow();
      expect(branchExists(scenario, active.branchName)).toBe(true);
      expect(runGit(scenario.repositoryPath, ["show", `${active.branchName}:evidence.txt`])).toBe(
        "committed evidence",
      );
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it.each(["tracked", "untracked"] as const)(
    "rejects a dirty %s worktree without changing ACTIVE ownership",
    (kind) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [ids.a]);
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        writeFileSync(
          join(active.worktreePath, kind === "tracked" ? "README.md" : "untracked.txt"),
          "dirty\n",
          "utf8",
        );
        expect(
          captureOwnershipError(() => manager.releaseOwnedWorktreeForSubtask(subtaskId!))
            .code,
        ).toBe("WORKTREE_DIRTY");
        expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.status).toBe(
          "ACTIVE",
        );
        expect(branchExists(scenario, active.branchName)).toBe(true);
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    },
  );

  it("recovers PROVISIONING to ACTIVE after reopen when Git add completed", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const interrupted = managerFor(storage, scenario, [ids.a], {
      afterGitAdd: () => {
        throw new Error("injected after add");
      },
    });
    expect(
      captureOwnershipError(() => interrupted.provisionOwnedWorktreeForSubtask(subtaskId!)).code,
    ).toBe("RECOVERY_REQUIRED");
    expect(interrupted.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status).toBe(
      "PROVISIONING",
    );
    storage.close();

    storage = openStorage(scenario);
    try {
      const reconciled = managerFor(storage, scenario, [ids.b]).reconcileWorktreeOwnershipForSubtask(
        subtaskId!,
      );
      expect(reconciled.status).toBe("ACTIVE");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("recovers RELEASING to RELEASED after reopen when Git removal completed", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const interrupted = managerFor(storage, scenario, [ids.a], {
      afterGitRemove: () => {
        throw new Error("injected after remove");
      },
    });
    const active = interrupted.provisionOwnedWorktreeForSubtask(subtaskId!);
    expect(
      captureOwnershipError(() => interrupted.releaseOwnedWorktreeForSubtask(subtaskId!)).code,
    ).toBe("RECOVERY_REQUIRED");
    expect(interrupted.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status).toBe(
      "RELEASING",
    );
    expect(branchExists(scenario, active.branchName)).toBe(true);
    storage.close();

    storage = openStorage(scenario);
    try {
      expect(
        managerFor(storage, scenario, [ids.b]).reconcileWorktreeOwnershipForSubtask(
          subtaskId!,
        ).status,
      ).toBe("RELEASED");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("does not adopt an ambiguous wrong-branch pending worktree", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const interrupted = managerFor(storage, scenario, [ids.a], {
        afterGitAdd: () => {
          throw new Error("injected after add");
        },
      });
      captureOwnershipError(() => interrupted.provisionOwnedWorktreeForSubtask(subtaskId!));
      const pending = interrupted.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]!;
      runGit(pending.worktreePath, ["switch", "-c", "unexpected-branch"]);

      expect(
        captureOwnershipError(() =>
          interrupted.reconcileWorktreeOwnershipForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(interrupted.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status).toBe(
        "PROVISIONING",
      );
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("resolves only exact ACTIVE ownership and permits committed HEAD advancement", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario, [ids.a]);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      writeFileSync(join(active.worktreePath, "advance.txt"), "advance\n", "utf8");
      runGit(active.worktreePath, ["add", "advance.txt"]);
      runGit(active.worktreePath, ["commit", "-m", "advance owned head"]);
      const advancedHead = runGit(active.worktreePath, ["rev-parse", "HEAD"]);

      const resolved = manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!);
      expect(resolved.currentHeadSha).toBe(advancedHead);
      expect(resolved.currentHeadSha).not.toBe(active.startingCommitSha);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(Object.isFrozen(resolved.ownership)).toBe(true);
      expect(
        captureOwnershipError(() =>
          manager.resolveActiveOwnedWorktreeForSubtask(
            active as unknown as SubtaskId,
          ),
        ).code,
      ).toBe("INVALID_SUBTASK_ID");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it.each(["missing", "wrong-branch", "replacement"] as const)(
    "fails closed when ACTIVE ownership has %s drift",
    (drift) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario, [ids.a]);
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        if (drift === "wrong-branch") {
          runGit(active.worktreePath, ["switch", "-c", "wrong-active-branch"]);
        } else {
          runGit(scenario.repositoryPath, ["worktree", "remove", active.worktreePath]);
          if (drift === "replacement") {
            mkdirSync(active.worktreePath);
            runGit(active.worktreePath, ["init", "-b", "main"]);
          }
        }
        expect(
          captureOwnershipError(() =>
            manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("OWNERSHIP_DRIFT");
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    },
  );

  it("uses opaque IDs for unusual Subtask IDs and sanitizes public failures", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    const unusualId = "st_../../not-a-path-component";
    try {
      const [subtaskId] = seedHierarchy(storage, scenario, {
        subtaskIds: [unusualId],
      });
      const manager = managerFor(storage, scenario, [ids.a]);
      const ownership = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      expect(ownership.worktreePath).toBe(join(scenario.worktreeRoot, ids.a));
      expect(ownership.branchName).toBe(`ctc/worktree/${ids.a}`);
      expect(ownership.worktreePath).not.toContain(unusualId);
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }

    const missingScenario = createScenario();
    const missingStorage = openStorage(missingScenario);
    try {
      const secret = "credential-value-must-not-leak";
      const missingPath = join(missingScenario.directory, secret);
      const [subtaskId] = seedHierarchy(missingStorage, missingScenario, {
        repository: { kind: "PATH", path: missingPath },
      });
      const error = captureOwnershipError(() =>
        managerFor(missingStorage, missingScenario, [ids.a]).provisionOwnedWorktreeForSubtask(
          subtaskId!,
        ),
      );
      expect(error.message).not.toContain(missingPath);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("fatal:");
    } finally {
      missingStorage.close();
      cleanupScenario(missingScenario);
    }
  });

  it("rejects a symlinked or owner-insecure Console worktree root", () => {
    for (const unsafe of ["symlink", "permissions"] as const) {
      const scenario = createScenario();
      const actualRoot = join(scenario.directory, "actual-owned-root");
      mkdirSync(actualRoot, { mode: 0o700 });
      if (unsafe === "symlink") {
        symlinkSync(actualRoot, scenario.worktreeRoot, "dir");
      } else {
        mkdirSync(scenario.worktreeRoot, { mode: 0o755 });
        chmodSync(scenario.worktreeRoot, 0o755);
      }
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        expect(
          captureOwnershipError(() =>
            managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(
              subtaskId!,
            ),
          ).code,
        ).toBe("UNSAFE_WORKTREE_ROOT");
      } finally {
        storage.close();
        cleanupScenario(scenario);
      }
    }
  });

  it("detects deterministic source repository replacement through a configured symlink", () => {
    const scenario = createScenario();
    const sourceLink = join(scenario.directory, "configured-source");
    symlinkSync(scenario.repositoryPath, sourceLink, "dir");
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario, {
        repository: { kind: "PATH", path: sourceLink },
      });
      const manager = managerFor(storage, scenario, [ids.a]);
      manager.provisionOwnedWorktreeForSubtask(subtaskId!);

      const replacement = join(scenario.directory, "replacement-source");
      mkdirSync(replacement);
      runGit(replacement, ["init", "-b", "main"]);
      runGit(replacement, ["config", "user.name", "Codex Test"]);
      runGit(replacement, ["config", "user.email", "codex@example.invalid"]);
      writeFileSync(join(replacement, "README.md"), "replacement\n", "utf8");
      runGit(replacement, ["add", "README.md"]);
      runGit(replacement, ["commit", "-m", "replacement"]);
      unlinkSync(sourceLink);
      symlinkSync(replacement, sourceLink, "dir");

      expect(
        captureOwnershipError(() =>
          manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("OWNERSHIP_DRIFT");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("enforces same-Subtask cardinality across two storage connections", () => {
    const scenario = createScenario();
    const firstStorage = openStorage(scenario);
    let secondStorage: TaskStorage | null = null;
    try {
      const [subtaskId] = seedHierarchy(firstStorage, scenario);
      secondStorage = openStorage(scenario);
      const first = managerFor(firstStorage, scenario, [ids.a]);
      const second = managerFor(secondStorage, scenario, [ids.b]);
      expect(first.provisionOwnedWorktreeForSubtask(subtaskId!).status).toBe("ACTIVE");
      expect(
        captureOwnershipError(() => second.provisionOwnedWorktreeForSubtask(subtaskId!))
          .code,
      ).toBe("OWNERSHIP_CONFLICT");
      expect(second.listWorktreeOwnershipHistoryForSubtask(subtaskId!)).toHaveLength(1);
    } finally {
      secondStorage?.close();
      firstStorage.close();
      cleanupScenario(scenario);
    }
  });

  it("reconstructs deterministic history after reopen and fails closed on malformed stored data", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const manager = managerFor(storage, scenario, [ids.a]);
    manager.provisionOwnedWorktreeForSubtask(subtaskId!);
    manager.releaseOwnedWorktreeForSubtask(subtaskId!);
    storage.close();

    storage = openStorage(scenario);
    try {
      const reopened = managerFor(storage, scenario, [ids.b]);
      expect(reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!)).toEqual([
        expect.objectContaining({ id: ids.a, status: "RELEASED" }),
      ]);
      const sqlite = new DatabaseSync(scenario.databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare("UPDATE worktree_ownerships SET branch_name = ? WHERE id = ?")
        .run("ctc/worktree/wt_ffffffffffffffffffffffffffffffff", ids.a);
      sqlite.exec("PRAGMA ignore_check_constraints = OFF");
      sqlite.close();
      expect(
        captureOwnershipError(() =>
          reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!),
        ).code,
      ).toBe("MALFORMED_STORED_OWNERSHIP");
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });

  it("creates restrictive schema constraints and ownership indexes", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    managerFor(storage, scenario, [ids.a]).provisionOwnedWorktreeForSubtask(subtaskId!);
    storage.close();

    const sqlite = new DatabaseSync(scenario.databasePath);
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      const indexes = sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'worktree_ownerships' ORDER BY name",
        )
        .all()
        .map((row) => (row as { readonly name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "worktree_ownerships_branch_name_unique",
          "worktree_ownerships_project_slots_index",
          "worktree_ownerships_subtask_history_index",
          "worktree_ownerships_subtask_non_terminal_unique",
          "worktree_ownerships_worktree_path_unique",
        ]),
      );
      expect(sqlite.prepare("PRAGMA foreign_key_list(worktree_ownerships)").all()).toHaveLength(
        2,
      );
      expect(() =>
        sqlite.prepare("DELETE FROM subtasks WHERE id = ?").run(subtaskId!),
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO worktree_ownerships (
               id, project_id, subtask_id, status, worktree_path, branch_name,
               starting_commit_sha, release_head_sha, created_at, activated_at,
               release_started_at, released_at, updated_at
             ) VALUES (?, 'prj_worktree', ?, 'ACTIVE', ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
          )
          .run(
            ids.b,
            subtaskId!,
            join(scenario.worktreeRoot, ids.b),
            `ctc/worktree/${ids.b}`,
            "1".repeat(40),
            FIXED_TIME,
            FIXED_TIME,
          ),
      ).toThrow();
    } finally {
      sqlite.close();
      cleanupScenario(scenario);
    }
  });

  it("exports only the safe high-level manager boundary for worktree mutation", () => {
    expect(storagePackage.createWorktreeOwnershipManager).toBeTypeOf("function");
    expect(storagePackage.WorktreeOwnershipError).toBe(WorktreeOwnershipError);
    expect("createWorktreeOwnershipManagerForTesting" in storagePackage).toBe(false);
    expect("worktreeOwnershipsTable" in storagePackage).toBe(false);

    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const manager = managerFor(storage, scenario, [ids.a]);
      expect(Object.keys(manager)).toEqual([]);
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager)).sort()).toEqual([
        "constructor",
        "listWorktreeOwnershipHistoryForSubtask",
        "provisionOwnedWorktreeForSubtask",
        "reconcileWorktreeOwnershipForSubtask",
        "releaseOwnedWorktreeForSubtask",
        "resolveActiveOwnedWorktreeForSubtask",
      ]);
    } finally {
      storage.close();
      cleanupScenario(scenario);
    }
  });
});
