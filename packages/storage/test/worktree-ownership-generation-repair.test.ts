import { spawnSync } from "node:child_process";
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
  statSync,
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
import type { SubtaskId } from "@codex-task-console/domain";
import { openTaskDatabase, WorktreeOwnershipError } from "../src/index.js";
import type { TaskStorage, WorktreeOwnershipManager } from "../src/index.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import {
  createWorktreeOwnershipManagerForTesting,
  type WorktreeOwnershipTestDependencies,
} from "../src/worktree-ownership.js";

const FIXED_TIME = "2026-09-02T01:02:03.000Z";
const OWNERSHIP_ID = `wt_${"9".repeat(32)}`;
const SECOND_OWNERSHIP_ID = `wt_${"8".repeat(32)}`;
const MARKER_NAME = "ctc-worktree-ownership-v0";

interface Scenario {
  readonly directory: string;
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
}

interface PhysicalIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNanoseconds: string;
}

interface GenerationRow {
  readonly ownership_id: string;
  readonly git_admin_device: string;
  readonly git_admin_inode: string;
  readonly git_admin_birthtime_ns: string;
  readonly marker_device: string;
  readonly marker_inode: string;
  readonly marker_birthtime_ns: string;
}

const runGit = (cwd: string, arguments_: readonly string[]): string => {
  const result = spawnSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Synthetic repair fixture failed: ${arguments_[0] ?? "git"}`);
  }
  return result.stdout.trim();
};

const createScenario = (): Scenario => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-worktree-fqa-repair-")),
  );
  const repositoryPath = join(directory, "fresh source");
  mkdirSync(repositoryPath);
  runGit(repositoryPath, ["init", "-b", "main"]);
  runGit(repositoryPath, ["config", "user.name", "Repair Fixture"]);
  runGit(repositoryPath, ["config", "user.email", "repair@example.invalid"]);
  writeFileSync(join(repositoryPath, "README.md"), "initial\n", "utf8");
  runGit(repositoryPath, ["add", "README.md"]);
  runGit(repositoryPath, ["commit", "-m", "initial"]);
  return Object.freeze({
    directory,
    databasePath: join(directory, "console.sqlite"),
    repositoryPath,
    worktreeRoot: join(directory, "owned"),
  });
};

const seedHierarchy = (
  storage: TaskStorage,
  scenario: Scenario,
  subtaskValues: readonly string[] = ["st_repair"],
): readonly SubtaskId[] => {
  storage.createProject(
    ProjectSchema.parse({
      recordType: "PROJECT",
      id: "prj_repair",
      name: "Repair fixture",
      slug: "repair-fixture",
      repository: { kind: "PATH", path: scenario.repositoryPath },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 2,
    }),
  );
  storage.createBigTask(
    BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_repair",
      projectId: "prj_repair",
      title: "Checkout generation repair",
      goal: "Reject stale marker replay",
      rationale: "Physical authority must remain generation-specific",
      scopeIn: ["Synthetic Git worktrees"],
      scopeOut: ["Live execution"],
      acceptanceCriteria: ["Stale marker replay fails closed"],
      status: "IN_PROGRESS",
    }),
  );
  for (const value of subtaskValues) {
    storage.createSubtask(
      SubtaskCreateInputSchema.parse({
        recordType: "SUBTASK",
        id: value,
        bigTaskId: "bt_repair",
        title: `Repair ${value}`,
        goal: "Verify physical checkout generation",
        scopeIn: ["Synthetic fixture"],
        scopeOut: ["Provider execution"],
        acceptanceCriteria: ["Fail closed"],
        untouchedAreas: ["Step 5B"],
        status: "IN_PROGRESS",
        maturity: "NOT_STARTED",
        startPolicy: "MANUAL",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "XHIGH",
        promptSeed: "Repair regression fixture.",
      }),
    );
  }
  return subtaskValues.map((value) => SubtaskIdSchema.parse(value));
};

const openStorage = (scenario: Scenario): TaskStorage =>
  openTaskDatabase({
    databasePath: scenario.databasePath,
    clock: () => new Date(FIXED_TIME),
  });

const managerFor = (
  storage: TaskStorage,
  scenario: Scenario,
  ownershipIds: readonly string[] = [OWNERSHIP_ID],
  failureHooks: NonNullable<
    WorktreeOwnershipTestDependencies["failureHooks"]
  > = {},
): WorktreeOwnershipManager => {
  let index = 0;
  return createWorktreeOwnershipManagerForTesting(storage, {
    worktreeRoot: scenario.worktreeRoot,
    idGenerator: () => {
      const value = ownershipIds[index++];
      if (value === undefined) {
        throw new Error("Synthetic repair IDs exhausted.");
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

const gitAdminPath = (worktreePath: string): string =>
  runGit(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--absolute-git-dir",
  ]);

const physicalIdentity = (path: string): PhysicalIdentity => {
  const observation = statSync(path, { bigint: true });
  return Object.freeze({
    device: observation.dev.toString(),
    inode: observation.ino.toString(),
    birthtimeNanoseconds: observation.birthtimeNs.toString(),
  });
};

const generationRow = (
  storage: TaskStorage,
  ownershipId = OWNERSHIP_ID,
): GenerationRow | undefined =>
  getTaskStorageWorktreeAccess(storage)!.sqlite
    .prepare("SELECT * FROM worktree_checkout_generations WHERE ownership_id = ?")
    .get(ownershipId) as GenerationRow | undefined;

const cleanup = (scenario: Scenario): void => {
  rmSync(scenario.directory, { recursive: true, force: true });
};

describe("CTC-WORKTREE-FQA-001 physical checkout-generation repair", () => {
  it.each(["same-starting-sha", "later-branch-head"] as const)(
    "rejects an exact stale marker copy after same-path/branch/common-repository recreation at %s",
    (variant) => {
      const scenario = createScenario();
      let storage = openStorage(scenario);
      const [subtaskId] = seedHierarchy(storage, scenario);
      const active = managerFor(storage, scenario).provisionOwnedWorktreeForSubtask(
        subtaskId!,
      );
      if (variant === "later-branch-head") {
        writeFileSync(join(active.worktreePath, "later.txt"), "later\n", "utf8");
        runGit(active.worktreePath, ["add", "later.txt"]);
        runGit(active.worktreePath, ["commit", "-m", "later branch head"]);
      }
      const expectedHead = runGit(active.worktreePath, ["rev-parse", "HEAD"]);
      const oldAdmin = gitAdminPath(active.worktreePath);
      const oldMarker = join(oldAdmin, MARKER_NAME);
      const oldMarkerBytes = readFileSync(oldMarker);
      const oldAdminIdentity = physicalIdentity(oldAdmin);
      const oldMarkerIdentity = physicalIdentity(oldMarker);
      const oldCommon = runGit(active.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      const durableBefore = generationRow(storage);
      expect(durableBefore).toBeDefined();
      storage.close();

      runGit(scenario.repositoryPath, ["worktree", "remove", active.worktreePath]);
      runGit(scenario.repositoryPath, [
        "worktree",
        "add",
        active.worktreePath,
        active.branchName,
      ]);
      const newAdmin = gitAdminPath(active.worktreePath);
      const newMarker = join(newAdmin, MARKER_NAME);
      writeFileSync(newMarker, oldMarkerBytes, { flag: "wx", mode: 0o600 });
      chmodSync(newMarker, 0o600);

      expect(active.worktreePath).toBe(join(scenario.worktreeRoot, OWNERSHIP_ID));
      expect(runGit(active.worktreePath, ["symbolic-ref", "HEAD"])).toBe(
        `refs/heads/${active.branchName}`,
      );
      expect(
        runGit(active.worktreePath, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      ).toBe(oldCommon);
      expect(runGit(active.worktreePath, ["rev-parse", "HEAD"])).toBe(expectedHead);
      expect(readFileSync(newMarker)).toEqual(oldMarkerBytes);
      expect(physicalIdentity(newAdmin)).not.toEqual(oldAdminIdentity);
      expect(physicalIdentity(newMarker)).not.toEqual(oldMarkerIdentity);

      storage = openStorage(scenario);
      try {
        const reopened = managerFor(storage, scenario, [SECOND_OWNERSHIP_ID]);
        expect(
          captureOwnershipError(() =>
            reopened.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("OWNERSHIP_DRIFT");
        expect(generationRow(storage)).toEqual(durableBefore);
        expect(
          reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe("ACTIVE");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it.each(["atomic-replacement", "remove-and-recreate"] as const)(
    "rejects byte-identical marker %s inside the original checkout",
    (variant) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario);
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        const admin = gitAdminPath(active.worktreePath);
        const marker = join(admin, MARKER_NAME);
        const bytes = readFileSync(marker);
        const adminBefore = physicalIdentity(admin);
        const markerBefore = physicalIdentity(marker);
        if (variant === "atomic-replacement") {
          const replacement = join(admin, "replacement-marker");
          writeFileSync(replacement, bytes, { flag: "wx", mode: 0o600 });
          renameSync(replacement, marker);
        } else {
          unlinkSync(marker);
          writeFileSync(marker, bytes, { flag: "wx", mode: 0o600 });
        }
        expect(readFileSync(marker)).toEqual(bytes);
        expect(physicalIdentity(admin)).toEqual(adminBefore);
        expect(physicalIdentity(marker)).not.toEqual(markerBefore);
        expect(
          captureOwnershipError(() =>
            manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("OWNERSHIP_DRIFT");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it("rejects in-place malformed marker data even when its physical identity is unchanged", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario);
      const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      const marker = join(gitAdminPath(active.worktreePath), MARKER_NAME);
      const markerIdentity = physicalIdentity(marker);
      writeFileSync(marker, "malformed-generation-evidence\n", {
        encoding: "utf8",
        flag: "r+",
      });
      expect(physicalIdentity(marker)).toEqual(markerIdentity);
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

  it("rejects malformed durable physical evidence and Git-admin retargeting", () => {
    for (const variant of ["malformed-evidence", "admin-retarget"] as const) {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [firstSubtask, secondSubtask] = seedHierarchy(storage, scenario, [
          "st_repair_a",
          "st_repair_b",
        ]);
        const manager = managerFor(storage, scenario, [
          OWNERSHIP_ID,
          SECOND_OWNERSHIP_ID,
        ]);
        const first = manager.provisionOwnedWorktreeForSubtask(firstSubtask!);
        if (variant === "malformed-evidence") {
          const sqlite = getTaskStorageWorktreeAccess(storage)!.sqlite;
          sqlite.exec("PRAGMA ignore_check_constraints = ON");
          sqlite
            .prepare(
              "UPDATE worktree_checkout_generations SET git_admin_inode = '01' WHERE ownership_id = ?",
            )
            .run(first.id);
          sqlite.exec("PRAGMA ignore_check_constraints = OFF");
          expect(
            captureOwnershipError(() =>
              manager.resolveActiveOwnedWorktreeForSubtask(firstSubtask!),
            ).code,
          ).toBe("MALFORMED_STORED_OWNERSHIP");
        } else {
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
        }
      } finally {
        storage.close();
        cleanup(scenario);
      }
    }
  });

  it.each(["symlink", "widened-mode"] as const)(
    "keeps %s marker authority fail-closed",
    (variant) => {
      const scenario = createScenario();
      const storage = openStorage(scenario);
      try {
        const [subtaskId] = seedHierarchy(storage, scenario);
        const manager = managerFor(storage, scenario);
        const active = manager.provisionOwnedWorktreeForSubtask(subtaskId!);
        const marker = join(gitAdminPath(active.worktreePath), MARKER_NAME);
        if (variant === "widened-mode") {
          chmodSync(marker, 0o644);
        } else {
          const moved = `${marker}-moved`;
          renameSync(marker, moved);
          symlinkSync(moved, marker, "file");
        }
        expect(
          captureOwnershipError(() =>
            manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
          ).code,
        ).toBe("OWNERSHIP_DRIFT");
      } finally {
        storage.close();
        cleanup(scenario);
      }
    },
  );

  it("preserves authority across reopen, edits, two commits, and clean release", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const active = managerFor(storage, scenario).provisionOwnedWorktreeForSubtask(
      subtaskId!,
    );
    const durableGeneration = generationRow(storage);
    storage.close();

    storage = openStorage(scenario);
    try {
      const manager = managerFor(storage, scenario, [SECOND_OWNERSHIP_ID]);
      expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.id).toBe(
        active.id,
      );
      writeFileSync(join(active.worktreePath, "README.md"), "unstaged\n", "utf8");
      expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.id).toBe(
        active.id,
      );
      runGit(active.worktreePath, ["add", "README.md"]);
      expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.id).toBe(
        active.id,
      );
      writeFileSync(join(active.worktreePath, "untracked.txt"), "untracked\n", "utf8");
      expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).ownership.id).toBe(
        active.id,
      );
      runGit(active.worktreePath, ["add", "untracked.txt"]);
      runGit(active.worktreePath, ["commit", "-m", "first owned commit"]);
      const firstHead = runGit(active.worktreePath, ["rev-parse", "HEAD"]);
      expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).currentHeadSha).toBe(
        firstHead,
      );
      writeFileSync(join(active.worktreePath, "second.txt"), "second\n", "utf8");
      runGit(active.worktreePath, ["add", "second.txt"]);
      runGit(active.worktreePath, ["commit", "-m", "second owned commit"]);
      const secondHead = runGit(active.worktreePath, ["rev-parse", "HEAD"]);
      expect(secondHead).not.toBe(firstHead);
      expect(manager.resolveActiveOwnedWorktreeForSubtask(subtaskId!).currentHeadSha).toBe(
        secondHead,
      );
      expect(generationRow(storage)).toEqual(durableGeneration);

      const released = manager.releaseOwnedWorktreeForSubtask(subtaskId!);
      expect(released).toMatchObject({
        status: "RELEASED",
        releaseHeadSha: secondHead,
      });
      expect(existsSync(active.worktreePath)).toBe(false);
      expect(
        runGit(scenario.repositoryPath, ["rev-parse", `refs/heads/${active.branchName}`]),
      ).toBe(secondHead);
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("fails closed before evidence persistence and never auto-adopts the marker", () => {
    const scenario = createScenario();
    let storage = openStorage(scenario);
    const [subtaskId] = seedHierarchy(storage, scenario);
    const interrupted = managerFor(storage, scenario, [OWNERSHIP_ID], {
      beforeGenerationEvidencePersist: () => {
        throw new Error("injected identity persistence failure");
      },
    });
    expect(
      captureOwnershipError(() =>
        interrupted.provisionOwnedWorktreeForSubtask(subtaskId!),
      ).code,
    ).toBe("RECOVERY_REQUIRED");
    expect(generationRow(storage)).toBeUndefined();
    expect(
      interrupted.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
    ).toBe("PROVISIONING");
    storage.close();

    storage = openStorage(scenario);
    try {
      const reopened = managerFor(storage, scenario, [SECOND_OWNERSHIP_ID]);
      expect(
        captureOwnershipError(() =>
          reopened.reconcileWorktreeOwnershipForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      expect(generationRow(storage)).toBeUndefined();
      expect(
        reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
      ).toBe("PROVISIONING");
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });

  it("reconciles only a post-evidence original checkout and rejects its stale-marker recreation", () => {
    for (const variant of ["original", "recreated"] as const) {
      const scenario = createScenario();
      let storage = openStorage(scenario);
      const [subtaskId] = seedHierarchy(storage, scenario);
      const interrupted = managerFor(storage, scenario, [OWNERSHIP_ID], {
        afterGitAdd: () => {
          throw new Error("injected post-evidence interruption");
        },
      });
      expect(
        captureOwnershipError(() =>
          interrupted.provisionOwnedWorktreeForSubtask(subtaskId!),
        ).code,
      ).toBe("RECOVERY_REQUIRED");
      const pending = interrupted.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]!;
      const durableBefore = generationRow(storage);
      expect(durableBefore).toBeDefined();
      const markerBytes = readFileSync(
        join(gitAdminPath(pending.worktreePath), MARKER_NAME),
      );
      storage.close();

      if (variant === "recreated") {
        runGit(scenario.repositoryPath, ["worktree", "remove", pending.worktreePath]);
        runGit(scenario.repositoryPath, [
          "worktree",
          "add",
          pending.worktreePath,
          pending.branchName,
        ]);
        const marker = join(gitAdminPath(pending.worktreePath), MARKER_NAME);
        writeFileSync(marker, markerBytes, { flag: "wx", mode: 0o600 });
      }

      storage = openStorage(scenario);
      try {
        const reopened = managerFor(storage, scenario, [SECOND_OWNERSHIP_ID]);
        if (variant === "original") {
          expect(
            reopened.reconcileWorktreeOwnershipForSubtask(subtaskId!).status,
          ).toBe("ACTIVE");
        } else {
          expect(
            captureOwnershipError(() =>
              reopened.reconcileWorktreeOwnershipForSubtask(subtaskId!),
            ).code,
          ).toBe("RECOVERY_REQUIRED");
          expect(
            reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
          ).toBe("PROVISIONING");
        }
        expect(generationRow(storage)).toEqual(durableBefore);
      } finally {
        storage.close();
        cleanup(scenario);
      }
    }
  });

  it("fails closed for legacy nonterminal rows but keeps terminal history readable", () => {
    for (const status of ["ACTIVE", "RELEASED"] as const) {
      const scenario = createScenario();
      let storage = openStorage(scenario);
      const [subtaskId] = seedHierarchy(storage, scenario);
      const manager = managerFor(storage, scenario);
      manager.provisionOwnedWorktreeForSubtask(subtaskId!);
      if (status === "RELEASED") {
        manager.releaseOwnedWorktreeForSubtask(subtaskId!);
      }
      getTaskStorageWorktreeAccess(storage)!.sqlite
        .prepare("DELETE FROM worktree_checkout_generations WHERE ownership_id = ?")
        .run(OWNERSHIP_ID);
      storage.close();

      storage = openStorage(scenario);
      try {
        const reopened = managerFor(storage, scenario, [SECOND_OWNERSHIP_ID]);
        if (status === "ACTIVE") {
          expect(
            captureOwnershipError(() =>
              reopened.resolveActiveOwnedWorktreeForSubtask(subtaskId!),
            ).code,
          ).toBe("OWNERSHIP_DRIFT");
        }
        expect(
          reopened.listWorktreeOwnershipHistoryForSubtask(subtaskId!)[0]?.status,
        ).toBe(status);
        expect(generationRow(storage)).toBeUndefined();
      } finally {
        storage.close();
        cleanup(scenario);
      }
    }
  });

  it("enforces one canonical immutable generation row per ownership", () => {
    const scenario = createScenario();
    const storage = openStorage(scenario);
    try {
      const [subtaskId] = seedHierarchy(storage, scenario);
      managerFor(storage, scenario).provisionOwnedWorktreeForSubtask(subtaskId!);
      const sqlite = new DatabaseSync(scenario.databasePath);
      try {
        expect(
          sqlite.prepare("PRAGMA foreign_key_list(worktree_checkout_generations)").all(),
        ).toHaveLength(1);
        expect(() =>
          sqlite
            .prepare(
              `INSERT INTO worktree_checkout_generations (
                 ownership_id, git_admin_device, git_admin_inode,
                 git_admin_birthtime_ns, marker_device, marker_inode,
                 marker_birthtime_ns
               ) VALUES (?, '1', '1', '1', '1', '1', '1')`,
            )
            .run(OWNERSHIP_ID),
        ).toThrow();
        expect(() =>
          sqlite
            .prepare(
              `INSERT INTO worktree_checkout_generations (
                 ownership_id, git_admin_device, git_admin_inode,
                 git_admin_birthtime_ns, marker_device, marker_inode,
                 marker_birthtime_ns
               ) VALUES (?, '01', '1', '1', '1', '1', '1')`,
            )
            .run(SECOND_OWNERSHIP_ID),
        ).toThrow();
      } finally {
        sqlite.close();
      }
    } finally {
      storage.close();
      cleanup(scenario);
    }
  });
});
