import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  JitContextPacketCompilationInputSchema,
  BigTaskIdSchema,
  ProjectSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
  narrowContextCandidatesForQa,
} from "@codex-task-console/domain";
import type {
  Project,
  RepositoryReference,
  SubtaskId,
} from "@codex-task-console/domain";
import * as storageExports from "@codex-task-console/storage";
import {
  TrustedRepositorySourceError,
  TrustedRepositorySourceReader,
  openTaskDatabase,
} from "../src/index.js";
import type {
  TaskStorage,
  TrustedRepositorySourceSnapshot,
} from "../src/index.js";
import {
  fixedClock,
  makeBigTask,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_trusted_repository_source");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_trusted_repository_source");
const SUBTASK_ID = SubtaskIdSchema.parse("st_trusted_repository_source");
const FIXED_GIT_DATE = "2026-08-17T00:00:00Z";

interface SyntheticRepository {
  readonly path: string;
  readonly head: string;
  readonly initialBranch: string;
}

interface SyntheticRepositoryOptions {
  readonly agentsContent?: string;
  readonly initialBranch?: string;
  readonly trackingBranch?: string | null;
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_DATE: FIXED_GIT_DATE,
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_NAME: "Trusted Source Fixture",
  GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Trusted Source Fixture",
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

const gitStatus = (
  repositoryPath: string,
  arguments_: readonly string[],
): number => {
  const result = spawnSync(
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
      env: gitEnvironment(),
      stdio: "pipe",
    },
  );
  if (result.error !== undefined || result.status === null) {
    throw new Error("Synthetic Git fixture command failed to execute.");
  }
  return result.status;
};

const withSyntheticRepository = <T>(
  options: SyntheticRepositoryOptions,
  operation: (repository: SyntheticRepository) => T,
): T => {
  const repositoryPath = mkdtempSync(
    join(tmpdir(), "ctc trusted ; $(touch ctc_injected) ' \" 雪-"),
  );
  const initialBranch = options.initialBranch ?? "main";
  try {
    gitOutput(repositoryPath, ["init", "--initial-branch", initialBranch]);
    writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n", {
      encoding: "utf8",
    });
    if (options.agentsContent !== undefined) {
      writeFileSync(join(repositoryPath, "AGENTS.md"), options.agentsContent, {
        encoding: "utf8",
      });
    }
    gitOutput(repositoryPath, ["add", "--all"]);
    gitOutput(repositoryPath, ["commit", "--message", "fixture"]);
    const head = gitOutput(repositoryPath, ["rev-parse", "HEAD"]);
    const trackingBranch =
      options.trackingBranch === undefined
        ? initialBranch
        : options.trackingBranch;
    if (trackingBranch !== null) {
      gitOutput(repositoryPath, [
        "update-ref",
        `refs/remotes/origin/${trackingBranch}`,
        head,
      ]);
    }
    return operation({ path: repositoryPath, head, initialBranch });
  } finally {
    rmSync(repositoryPath, { force: true, recursive: true });
  }
};

const canonicalProject = (
  repository: RepositoryReference,
  defaultBranch = "main",
): Project =>
  ProjectSchema.parse({
    ...makeProject(PROJECT_ID, "trusted-repository-source"),
    repository,
    defaultBranch,
  });

const seedHierarchy = (
  storage: TaskStorage,
  repository: RepositoryReference,
  defaultBranch = "main",
): void => {
  storage.createProject(canonicalProject(repository, defaultBranch));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
  storage.createSubtask(makeSubtask(SUBTASK_ID, BIG_TASK_ID));
};

const readSnapshot = (
  storage: TaskStorage,
): TrustedRepositorySourceSnapshot =>
  new TrustedRepositorySourceReader(
    storage,
  ).readTrustedRepositorySourceSnapshotForSubtask(SUBTASK_ID);

const captureSourceError = (operation: () => unknown): TrustedRepositorySourceError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof TrustedRepositorySourceError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a TrustedRepositorySourceError.");
};

const evidence = (
  snapshot: TrustedRepositorySourceSnapshot,
  sourceReference: string,
): string => {
  const block = snapshot.repositoryRuntimeEvidence.find(
    (candidate) => candidate.sourceReference === sourceReference,
  );
  if (block === undefined) {
    throw new Error(`Missing evidence fixture ${sourceReference}.`);
  }
  return block.body;
};

const expectDeeplyFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nestedValue of Object.values(value)) {
    expectDeeplyFrozen(nestedValue);
  }
};

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
  untracked: existsSync(join(repositoryPath, "untracked.txt"))
    ? fileHash(join(repositoryPath, "untracked.txt"))
    : null,
  status: gitOutput(repositoryPath, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]),
});

describe.sequential("trusted repository source snapshot", () => {
  it("resolves only the canonical Project repository through the durable Subtask hierarchy", () => {
    withSyntheticRepository({ agentsContent: "target rules\n" }, (target) =>
      withSyntheticRepository({ agentsContent: "alternate rules\n" }, (alternate) =>
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: target.path });
          const reader = new TrustedRepositorySourceReader(storage);
          const readWithIgnoredExtraArgument =
            reader.readTrustedRepositorySourceSnapshotForSubtask.bind(reader) as (
              subtaskId: SubtaskId,
              alternatePath?: string,
            ) => TrustedRepositorySourceSnapshot;
          const snapshot = readWithIgnoredExtraArgument(SUBTASK_ID, alternate.path);

          expect(reader.readTrustedRepositorySourceSnapshotForSubtask).toHaveLength(1);
          expect(Object.keys(snapshot).sort()).toEqual([
            "canonicalProjectRules",
            "projectId",
            "repository",
            "repositoryRuntimeEvidence",
          ]);
          expect(snapshot.projectId).toBe(PROJECT_ID);
          expect(snapshot.repository).toEqual({ kind: "PATH", path: target.path });
          expect(snapshot.canonicalProjectRules).toEqual([
            {
              sourceReference: "repo:AGENTS.md",
              title: "Repository root AGENTS.md",
              body: "target rules\n",
            },
          ]);
          expect(JSON.stringify(snapshot)).not.toContain(alternate.path);
          expect(JSON.stringify(snapshot)).not.toContain("alternate rules");
        }),
      ),
    );
  });

  it("rejects REFERENCE repositories before any resolver, filesystem, or network behavior", () => {
    withMemoryStorage((storage) => {
      seedHierarchy(storage, {
        kind: "REFERENCE",
        reference: "https://private.invalid/sentinel-token/repository.git",
      });
      const error = captureSourceError(() => readSnapshot(storage));
      expect(error.code).toBe("UNSUPPORTED_REPOSITORY_REFERENCE");
      expect(error.message).not.toMatch(/private|sentinel|https|repository\.git/i);
    });
  });

  it("fails closed for invalid IDs, missing hierarchy, and hostile runtime inputs", () => {
    withMemoryStorage((storage) => {
      const reader = new TrustedRepositorySourceReader(storage);
      expect(
        captureSourceError(() =>
          reader.readTrustedRepositorySourceSnapshotForSubtask(
            " st_noncanonical " as SubtaskId,
          ),
        ).code,
      ).toBe("INVALID_SUBTASK_ID");
      expect(
        captureSourceError(() =>
          reader.readTrustedRepositorySourceSnapshotForSubtask(SUBTASK_ID),
        ).code,
      ).toBe("TASK_HIERARCHY_UNAVAILABLE");

      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("hostile-caller-sentinel");
          },
        },
      );
      const hostileError = captureSourceError(() =>
        reader.readTrustedRepositorySourceSnapshotForSubtask(
          hostile as unknown as SubtaskId,
        ),
      );
      expect(hostileError.code).toBe("INVALID_SUBTASK_ID");
      expect(hostileError.message).not.toContain("hostile-caller-sentinel");
    });

    const constructorError = captureSourceError(
      () => new TrustedRepositorySourceReader({} as TaskStorage),
    );
    expect(constructorError.code).toBe("TASK_HIERARCHY_UNAVAILABLE");
  });

  it("maps malformed durable hierarchy to a sanitized hierarchy error", () => {
    withSyntheticRepository({}, (repository) =>
      withTemporaryDatabasePath((databasePath) => {
        let storage = openTaskDatabase({ databasePath, clock: fixedClock });
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        try {
          sqlite.exec("PRAGMA ignore_check_constraints = ON");
          sqlite
            .prepare("UPDATE projects SET repository_kind = ? WHERE id = ?")
            .run("HOSTILE_SENTINEL", PROJECT_ID);
        } finally {
          sqlite.close();
        }

        storage = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          const error = captureSourceError(() => readSnapshot(storage));
          expect(error.code).toBe("TASK_HIERARCHY_UNAVAILABLE");
          expect(error.message).not.toContain("HOSTILE_SENTINEL");
        } finally {
          storage.close();
        }
      }),
    );
  });

  it("requires the configured PATH to be the exact local Git root", () => {
    const missingPath = join(tmpdir(), "ctc-definitely-missing-repository");
    rmSync(missingPath, { force: true, recursive: true });
    withMemoryStorage((storage) => {
      seedHierarchy(storage, { kind: "PATH", path: missingPath });
      expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
        "REPOSITORY_PATH_UNAVAILABLE",
      );
    });

    const ordinaryDirectory = mkdtempSync(join(tmpdir(), "ctc-ordinary-"));
    try {
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: ordinaryDirectory });
        expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
          "NOT_GIT_REPOSITORY",
        );
      });
    } finally {
      rmSync(ordinaryDirectory, { force: true, recursive: true });
    }

    withSyntheticRepository({}, (repository) => {
      const nested = join(repository.path, "nested");
      mkdirSync(nested);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: nested });
        expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
          "REPOSITORY_ROOT_MISMATCH",
        );
      });
    });
  });

  it("does not select another nearby repository for an ordinary configured directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ctc-nearby-boundary-"));
    const ordinary = join(parent, "configured");
    const nearby = join(parent, "nearby");
    mkdirSync(ordinary);
    mkdirSync(nearby);
    try {
      gitOutput(nearby, ["init", "--initial-branch", "main"]);
      writeFileSync(join(nearby, "tracked.txt"), "nearby\n", { encoding: "utf8" });
      gitOutput(nearby, ["add", "--all"]);
      gitOutput(nearby, ["commit", "--message", "nearby"]);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: ordinary });
        expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
          "NOT_GIT_REPOSITORY",
        );
      });
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("returns empty canonical rules when root AGENTS.md is absent", () => {
    withSyntheticRepository({}, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const snapshot = readSnapshot(storage);
        expect(snapshot.canonicalProjectRules).toEqual([]);
        expect(snapshot.repositoryRuntimeEvidence).toHaveLength(5);
      }),
    );
  });

  it("reads only the exact regular root AGENTS.md and preserves its UTF-8 text", () => {
    const content = "# Canonical rules\n\n- Preserve spacing.\n- 雪 and emoji 😀.\n";
    withSyntheticRepository({ agentsContent: content }, (repository) =>
      withMemoryStorage((storage) => {
        mkdirSync(join(repository.path, "docs"));
        writeFileSync(join(repository.path, "docs", "AGENTS.md"), "nested rules", {
          encoding: "utf8",
        });
        writeFileSync(join(repository.path, "README.md"), "README rules", {
          encoding: "utf8",
        });
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const snapshot = readSnapshot(storage);
        expect(snapshot.canonicalProjectRules.map(({ body }) => body).join(""))
          .toBe(content);
        expect(snapshot.canonicalProjectRules).toHaveLength(1);
        expect(JSON.stringify(snapshot.canonicalProjectRules)).not.toMatch(
          /nested rules|README rules/,
        );
      }),
    );
  });

  it("chunks long Unicode rules losslessly by the Packet Core UTF-16 limit", () => {
    const content = `${"a".repeat(3_999)}😀${"雪".repeat(4_100)}`;
    withSyntheticRepository({ agentsContent: content }, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const first = readSnapshot(storage).canonicalProjectRules;
        const second = readSnapshot(storage).canonicalProjectRules;
        expect(first.length).toBeGreaterThan(2);
        expect(first.every(({ body }) => body.length <= 4_000)).toBe(true);
        expect(first.map(({ body }) => body).join("")).toBe(content);
        expect(first).toEqual(second);
        expect(first.map(({ sourceReference }) => sourceReference)).toEqual(
          first.map(
            (_, index) =>
              `repo:AGENTS.md#part=${index + 1}/${first.length}`,
          ),
        );
        expect(first.some(({ body }) => /[\ud800-\udbff]$/.test(body))).toBe(false);
        expect(first.some(({ body }) => /^[\udc00-\udfff]/.test(body))).toBe(false);
      }),
    );
  });

  it("fails closed for both outside and inside AGENTS.md symlinks", () => {
    withSyntheticRepository({}, (repository) => {
      const outsideDirectory = mkdtempSync(join(tmpdir(), "ctc-rules-outside-"));
      try {
        const outsideRules = join(outsideDirectory, "rules.md");
        writeFileSync(outsideRules, "outside rules\n", { encoding: "utf8" });
        symlinkSync(outsideRules, join(repository.path, "AGENTS.md"));
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: repository.path });
          expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
            "UNSAFE_CANONICAL_RULE_SOURCE",
          );
        });

        unlinkSync(join(repository.path, "AGENTS.md"));
        writeFileSync(join(repository.path, "rules.md"), "inside rules\n", {
          encoding: "utf8",
        });
        symlinkSync("rules.md", join(repository.path, "AGENTS.md"));
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: repository.path });
          expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
            "UNSAFE_CANONICAL_RULE_SOURCE",
          );
        });
      } finally {
        rmSync(outsideDirectory, { force: true, recursive: true });
      }
    });
  });

  it("fails closed for a directory or invalid UTF-8 at the exact rules path", () => {
    withSyntheticRepository({}, (repository) => {
      mkdirSync(join(repository.path, "AGENTS.md"));
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
          "UNSAFE_CANONICAL_RULE_SOURCE",
        );
      });
      rmSync(join(repository.path, "AGENTS.md"), { recursive: true });
      writeFileSync(join(repository.path, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        expect(captureSourceError(() => readSnapshot(storage)).code).toBe(
          "UNSAFE_CANONICAL_RULE_SOURCE",
        );
      });
    });
  });

  it("renders exact HEAD, attached branch, Project default-branch tracking ref, clean state, and probe runtime", () => {
    withSyntheticRepository(
      {
        agentsContent: "rules\n",
        initialBranch: "work/attached",
        trackingBranch: "release/v1",
      },
      (repository) =>
        withMemoryStorage((storage) => {
          seedHierarchy(
            storage,
            { kind: "PATH", path: repository.path },
            "release/v1",
          );
          const snapshot = readSnapshot(storage);
          expect(evidence(snapshot, "repo:git#head")).toContain(repository.head);
          expect(evidence(snapshot, "repo:git#branch")).toBe(
            'Local repository branch state: ATTACHED "work/attached".',
          );
          const tracking = evidence(
            snapshot,
            "repo:git#local-origin-default-branch",
          );
          expect(tracking).toContain('"refs/remotes/origin/release/v1"');
          expect(tracking).toContain(repository.head);
          expect(tracking).toContain("local state only");
          expect(tracking).toContain("not live origin or GitHub truth");
          expect(evidence(snapshot, "repo:git#worktree")).toBe(
            "Local worktree state: CLEAN; tracked changes 0; untracked entries 0; unmerged/conflict entries 0.",
          );
          const runtime = evidence(snapshot, "probe:runtime#toolchain");
          expect(runtime).toContain(`Node ${JSON.stringify(process.version)}`);
          expect(runtime).toContain(
            `OS/platform ${JSON.stringify(process.platform)}`,
          );
          expect(runtime).toContain(
            `architecture ${JSON.stringify(process.arch)}`,
          );
          expect(runtime).toContain("git version");
          expect(runtime).toContain("not target repository requirements");
          expect(runtime).not.toMatch(/TypeScript|React|framework|package\.json/i);
        }),
    );
  });

  it("represents detached HEAD and an absent local tracking ref deterministically", () => {
    withSyntheticRepository({ trackingBranch: null }, (repository) => {
      gitOutput(repository.path, ["checkout", "--detach", repository.head]);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const snapshot = readSnapshot(storage);
        expect(evidence(snapshot, "repo:git#branch")).toBe(
          "Local repository branch state: DETACHED.",
        );
        expect(
          evidence(snapshot, "repo:git#local-origin-default-branch"),
        ).toContain("NOT_PRESENT");
      });
    });
  });

  it("counts tracked and untracked dirty entries without exposing filenames", () => {
    withSyntheticRepository({}, (repository) => {
      writeFileSync(join(repository.path, "tracked.txt"), "changed\n", {
        encoding: "utf8",
      });
      writeFileSync(join(repository.path, "private-secret-filename.txt"), "new\n", {
        encoding: "utf8",
      });
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const body = evidence(readSnapshot(storage), "repo:git#worktree");
        expect(body).toBe(
          "Local worktree state: DIRTY; tracked changes 1; untracked entries 1; unmerged/conflict entries 0.",
        );
        expect(body).not.toContain("private-secret-filename");
        expect(body).not.toContain("tracked.txt");
      });
    });
  });

  it("counts an unmerged conflict fixture without exposing conflict paths", () => {
    withSyntheticRepository({}, (repository) => {
      gitOutput(repository.path, ["checkout", "-b", "conflict-side"]);
      writeFileSync(join(repository.path, "tracked.txt"), "side\n", {
        encoding: "utf8",
      });
      gitOutput(repository.path, ["add", "tracked.txt"]);
      gitOutput(repository.path, ["commit", "--message", "side"]);
      gitOutput(repository.path, ["checkout", repository.initialBranch]);
      writeFileSync(join(repository.path, "tracked.txt"), "main\n", {
        encoding: "utf8",
      });
      gitOutput(repository.path, ["add", "tracked.txt"]);
      gitOutput(repository.path, ["commit", "--message", "main"]);
      expect(gitStatus(repository.path, ["merge", "conflict-side"])).not.toBe(0);

      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const body = evidence(readSnapshot(storage), "repo:git#worktree");
        expect(body).toContain("Local worktree state: DIRTY");
        expect(body).toContain("unmerged/conflict entries 1");
        expect(body).not.toContain("tracked.txt");
      });
    });
  });

  it("performs no target-repository mutation and treats shell metacharacters as path data", () => {
    withSyntheticRepository({ agentsContent: "safe rules\n" }, (repository) => {
      writeFileSync(join(repository.path, "tracked.txt"), "dirty before read\n", {
        encoding: "utf8",
      });
      writeFileSync(join(repository.path, "untracked.txt"), "untracked before read\n", {
        encoding: "utf8",
      });
      const before = repositoryFingerprint(repository.path);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const snapshot = readSnapshot(storage);
        expect(snapshot.repository.path).toBe(repository.path);
      });
      expect(repositoryFingerprint(repository.path)).toEqual(before);
      expect(existsSync(join(repository.path, "ctc_injected"))).toBe(false);
    });
  });

  it("uses only local read-only Git commands with optional locks disabled", () => {
    const source = readFileSync(
      new URL("../src/trusted-repository-source.ts", import.meta.url),
      { encoding: "utf8" },
    );
    expect(source).toContain('GIT_OPTIONAL_LOCKS: "0"');
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(
      /\[\s*"(?:fetch|pull|push|clone|ls-remote|checkout|switch|reset|clean|add|commit|update-ref)"/,
    );
    expect(source).not.toMatch(/node:(?:http|https|net|tls|dns)|\bfetch\s*\(/);
  });

  it("sanitizes Git stderr, durable values, and private paths", () => {
    withSyntheticRepository({}, (repository) =>
      withMemoryStorage((storage) => {
        const sentinel = "GIT_PRIVATE_SENTINEL";
        seedHierarchy(
          storage,
          { kind: "PATH", path: repository.path },
          `${sentinel} invalid branch`,
        );
        const error = captureSourceError(() => readSnapshot(storage));
        expect(error.code).toBe("MALFORMED_RUNTIME_OBSERVATION");
        expect(error.message).not.toContain(sentinel);
        expect(error.message).not.toContain(repository.path);
        expect(error.message).not.toMatch(/fatal:|show-ref|child_process|spawn/i);
      }),
    );
  });

  it("returns recursively frozen detached output and gives same-shaped DATA no authority", () => {
    withSyntheticRepository({ agentsContent: "immutable rules\n" }, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const reader = new TrustedRepositorySourceReader(storage);
        const snapshot = reader.readTrustedRepositorySourceSnapshotForSubtask(
          SUBTASK_ID,
        );
        expectDeeplyFrozen(snapshot);
        expect(() => {
          (snapshot.canonicalProjectRules as TrustedRepositorySourceSnapshot["canonicalProjectRules"] &
            unknown[]).push({
            sourceReference: "caller:data",
            title: "Caller data",
            body: "Caller data",
          });
        }).toThrow();
        expect(() => {
          (snapshot.repository as { path: string }).path = "/caller/mutation";
        }).toThrow();

        const sameShapedData = JSON.parse(
          JSON.stringify(snapshot),
        ) as TrustedRepositorySourceSnapshot;
        expect(sameShapedData).toEqual(snapshot);
        expect(Object.isFrozen(sameShapedData)).toBe(false);
        expect(
          Object.keys(storageExports).filter((name) =>
            /TrustedRepositorySource(?:Snapshot)?(?:Schema|Parser|parse|upgrade|Capability|Marker)/.test(
              name,
            ),
          ),
        ).toEqual([]);
        expect([...collectPropertyNames(snapshot)].join(" ")).not.toMatch(
          /candidateClass|trusted|verified|authorized|capability|signature|attestation/,
        );
        expect(
          reader.readTrustedRepositorySourceSnapshotForSubtask(SUBTASK_ID),
        ).toEqual(snapshot);
        expect(storage.getProjectById(PROJECT_ID)?.repository).toEqual({
          kind: "PATH",
          path: repository.path,
        });
        expect(readFileSync(join(repository.path, "AGENTS.md"), "utf8")).toBe(
          "immutable rules\n",
        );
      }),
    );
  });

  it("is Packet Core and QA-class compatible without packet assembly or an S2D6a bridge", () => {
    withSyntheticRepository({ agentsContent: "packet compatible rules" }, (repository) =>
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const snapshot = readSnapshot(storage);
        const project = storage.getProjectById(PROJECT_ID);
        const bigTask = storage.getBigTaskById(BIG_TASK_ID);
        const subtask = storage.getSubtaskById(SUBTASK_ID);
        if (project === null || bigTask === null || subtask === null) {
          throw new Error("Expected canonical fixture hierarchy.");
        }

        expect(
          JitContextPacketCompilationInputSchema.safeParse({
            profile: "FRESH_INDEPENDENT_QA",
            project,
            bigTask,
            subtask,
            canonicalProjectRules: snapshot.canonicalProjectRules,
            repositoryRuntimeEvidence: snapshot.repositoryRuntimeEvidence,
            lockedInvariants: [],
            qaInstructions: [],
            boundedRetestTargets: [],
          }).success,
        ).toBe(true);

        const candidates = [
          ...snapshot.canonicalProjectRules.map(({ sourceReference }) => ({
            candidateClass: "CANONICAL_PROJECT_RULE" as const,
            sourceReference,
          })),
          ...snapshot.repositoryRuntimeEvidence.map(({ sourceReference }) => ({
            candidateClass: "REPO_RUNTIME_EVIDENCE" as const,
            sourceReference,
          })),
        ];
        expect(
          narrowContextCandidatesForQa(
            "FRESH_INDEPENDENT_QA",
            candidates,
          ).includedCandidates,
        ).toEqual(candidates);

        const source = readFileSync(
          new URL("../src/trusted-repository-source.ts", import.meta.url),
          { encoding: "utf8" },
        );
        expect(source).not.toMatch(
          /DeterministicEngineeringFact|renderDeterministicEngineeringFact|compileJitContextPacket|candidateClass/,
        );
        expectTypeOf(snapshot.canonicalProjectRules).toEqualTypeOf<
          TrustedRepositorySourceSnapshot["canonicalProjectRules"]
        >();
      }),
    );
  });
});
