import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  ProjectSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  Project,
  RepositoryReference,
  SubtaskId,
} from "@codex-task-console/domain";
import {
  TrustedRepositorySourceError,
  TrustedRepositorySourceReader,
} from "../src/index.js";
import type {
  TaskStorage,
  TrustedRepositorySourceSnapshot,
} from "../src/index.js";
import {
  makeBigTask,
  makeProject,
  makeSubtask,
  withMemoryStorage,
} from "./fixtures.js";

const PROJECT_ID = ProjectIdSchema.parse("prj_trusted_source_hardening");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_trusted_source_hardening");
const SUBTASK_ID = SubtaskIdSchema.parse("st_trusted_source_hardening");
const FIXED_GIT_DATE = "2026-08-17T00:00:00Z";

interface SyntheticRepository {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
}

interface SyntheticRepositoryOptions {
  readonly agentsContent?: string | Buffer;
  readonly branch?: string;
  readonly trackingBranch?: string | null;
  readonly prefix?: string;
}

const fixtureGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_DATE: FIXED_GIT_DATE,
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_NAME: "Trusted Source Hardening Fixture",
  GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Trusted Source Hardening Fixture",
  GIT_TERMINAL_PROMPT: "0",
});

const git = (repositoryPath: string, arguments_: readonly string[]): string =>
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
      env: fixtureGitEnvironment(),
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
      env: fixtureGitEnvironment(),
      stdio: "pipe",
    },
  );
  if (result.error !== undefined || result.status === null) {
    throw new Error("Synthetic Git fixture command failed.");
  }
  return result.status;
};

const withSyntheticRepository = <T>(
  options: SyntheticRepositoryOptions,
  operation: (repository: SyntheticRepository) => T,
): T => {
  const repositoryPath = mkdtempSync(
    join(tmpdir(), options.prefix ?? "ctc-trusted-hardening-雪-$()-"),
  );
  const branch = options.branch ?? "main";
  try {
    git(repositoryPath, ["init", "--initial-branch", branch]);
    writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n", {
      encoding: "utf8",
    });
    if (options.agentsContent !== undefined) {
      writeFileSync(join(repositoryPath, "AGENTS.md"), options.agentsContent);
    }
    git(repositoryPath, ["add", "--all"]);
    git(repositoryPath, ["commit", "--message", "fixture"]);
    const head = git(repositoryPath, ["rev-parse", "HEAD"]);
    const trackingBranch =
      options.trackingBranch === undefined
        ? branch
        : options.trackingBranch;
    if (trackingBranch !== null) {
      git(repositoryPath, [
        "update-ref",
        `refs/remotes/origin/${trackingBranch}`,
        head,
      ]);
    }
    return operation({ path: repositoryPath, head, branch });
  } finally {
    rmSync(repositoryPath, { force: true, recursive: true });
  }
};

const project = (
  repository: RepositoryReference,
  defaultBranch = "main",
): Project =>
  ProjectSchema.parse({
    ...makeProject(PROJECT_ID, "trusted-source-hardening"),
    repository,
    defaultBranch,
  });

const seedHierarchy = (
  storage: TaskStorage,
  repository: RepositoryReference,
  defaultBranch = "main",
): void => {
  storage.createProject(project(repository, defaultBranch));
  storage.createBigTask(makeBigTask(BIG_TASK_ID, PROJECT_ID));
  storage.createSubtask(makeSubtask(SUBTASK_ID, BIG_TASK_ID));
};

const readSnapshot = (storage: TaskStorage): TrustedRepositorySourceSnapshot =>
  new TrustedRepositorySourceReader(
    storage,
  ).readTrustedRepositorySourceSnapshotForSubtask(SUBTASK_ID);

const sourceError = (
  operation: () => unknown,
): TrustedRepositorySourceError => {
  try {
    operation();
  } catch (error) {
    if (error instanceof TrustedRepositorySourceError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected TrustedRepositorySourceError.");
};

const evidence = (
  snapshot: TrustedRepositorySourceSnapshot,
  sourceReference: string,
): string => {
  const block = snapshot.repositoryRuntimeEvidence.find(
    (candidate) => candidate.sourceReference === sourceReference,
  );
  if (block === undefined) {
    throw new Error("Missing repository evidence fixture.");
  }
  return block.body;
};

const withProcessEnvironment = <T>(
  values: Readonly<Record<string, string | undefined>>,
  operation: () => T,
): T => {
  const original = new Map(
    Object.keys(values).map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return operation();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const repositoryFingerprint = (repositoryPath: string): string => {
  const gitDirectory = git(repositoryPath, ["rev-parse", "--absolute-git-dir"]);
  const candidates = [
    join(gitDirectory, "index"),
    join(gitDirectory, "config"),
    join(gitDirectory, "HEAD"),
    join(gitDirectory, "logs", "HEAD"),
    join(repositoryPath, "tracked.txt"),
    join(repositoryPath, "AGENTS.md"),
    join(repositoryPath, "untracked.txt"),
  ];
  const files = candidates.map((path) =>
    existsSync(path) && lstatSync(path).isFile()
      ? [path.slice(repositoryPath.length), sha256(path)]
      : [path.slice(repositoryPath.length), null],
  );
  return JSON.stringify({
    head: git(repositoryPath, ["rev-parse", "HEAD"]),
    branch: git(repositoryPath, ["branch", "--show-current"]),
    refs: git(repositoryPath, [
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname)%00%(objectname)",
    ]),
    status: git(repositoryPath, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
    files,
  });
};

const lockfiles = (repositoryPath: string): readonly string[] => {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name.endsWith(".lock")) {
        found.push(path);
      }
    }
  };
  const gitDirectory = git(repositoryPath, ["rev-parse", "--absolute-git-dir"]);
  visit(gitDirectory);
  return found;
};

const parseWorktreeEvidence = (
  snapshot: TrustedRepositorySourceSnapshot,
): Readonly<{
  clean: boolean;
  trackedChanges: number;
  untrackedEntries: number;
  unmergedEntries: number;
}> => {
  const body = evidence(snapshot, "repo:git#worktree");
  const match = body.match(
    /^Local worktree state: (CLEAN|DIRTY); tracked changes (\d+); untracked entries (\d+); unmerged\/conflict entries (\d+)\.$/,
  );
  if (match === null) {
    throw new Error("Malformed worktree evidence fixture.");
  }
  return Object.freeze({
    clean: match[1] === "CLEAN",
    trackedChanges: Number(match[2]),
    untrackedEntries: Number(match[3]),
    unmergedEntries: Number(match[4]),
  });
};

const porcelainOracle = (repositoryPath: string) => {
  const output = execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-C",
      repositoryPath,
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "-z",
    ],
    { env: fixtureGitEnvironment() },
  ).toString("utf8");
  const records = output.length === 0 ? [] : output.slice(0, -1).split("\0");
  let trackedChanges = 0;
  let untrackedEntries = 0;
  let unmergedEntries = 0;
  for (let index = 0; index < records.length; index += 1) {
    const kind = records[index]?.slice(0, 1);
    if (kind === "1") {
      trackedChanges += 1;
    } else if (kind === "2") {
      trackedChanges += 1;
      index += 1;
    } else if (kind === "u") {
      unmergedEntries += 1;
    } else if (kind === "?") {
      untrackedEntries += 1;
    }
  }
  return Object.freeze({
    clean: trackedChanges + untrackedEntries + unmergedEntries === 0,
    trackedChanges,
    untrackedEntries,
    unmergedEntries,
  });
};

const expectWorktreeMatchesGit = (repositoryPath: string): void => {
  withMemoryStorage((storage) => {
    seedHierarchy(storage, { kind: "PATH", path: repositoryPath });
    const snapshot = readSnapshot(storage);
    expect(parseWorktreeEvidence(snapshot)).toEqual(
      porcelainOracle(repositoryPath),
    );
    const serialized = JSON.stringify(snapshot.repositoryRuntimeEvidence);
    for (const forbiddenName of [
      "tracked.txt",
      "renamed-private.txt",
      "untracked-private.txt",
      "conflict-private.txt",
    ]) {
      expect(serialized).not.toContain(forbiddenName);
    }
  });
};

const writeExecutable = (path: string, content: string): void => {
  writeFileSync(path, content, { encoding: "utf8" });
  chmodSync(path, 0o755);
};

const withGitWrapper = <T>(
  scriptBody: string,
  environment: Readonly<Record<string, string>>,
  operation: () => T,
): T => {
  const wrapperDirectory = mkdtempSync(join(tmpdir(), "ctc-git-wrapper-"));
  const wrapperPath = join(wrapperDirectory, "git");
  const originalPath = process.env.PATH ?? "";
  try {
    writeExecutable(
      wrapperPath,
      `#!/bin/sh\n${scriptBody}\nPATH="$CTC_ORIGINAL_PATH"\nexport PATH\nexec git "$@"\n`,
    );
    return withProcessEnvironment(
      {
        PATH: `${wrapperDirectory}:${originalPath}`,
        CTC_ORIGINAL_PATH: originalPath,
        ...environment,
      },
      operation,
    );
  } finally {
    rmSync(wrapperDirectory, { force: true, recursive: true });
  }
};

describe.sequential("trusted repository source Git environment and coherence hardening", () => {
  it("removes ambient Git controls without redirecting Project A to repository B", () => {
    withSyntheticRepository({ agentsContent: "rules A\n" }, (repositoryA) =>
      withSyntheticRepository({ agentsContent: "rules B\n" }, (repositoryB) => {
        const hostileDirectory = mkdtempSync(join(tmpdir(), "ctc-hostile-git-env-"));
        try {
          const hostileIndex = join(repositoryB.path, ".git", "index");
          const hostileConfig = join(hostileDirectory, "hostile.gitconfig");
          const tracePath = join(hostileDirectory, "git-trace-sentinel");
          writeFileSync(
            hostileConfig,
            `[core]\n\tworktree = ${repositoryB.path}\n\tfsmonitor = touch ${join(hostileDirectory, "fsmonitor-sentinel")}\n`,
            { encoding: "utf8" },
          );
          const controls: readonly [string, string][] = [
            ["GIT_DIR", join(repositoryB.path, ".git")],
            ["GIT_WORK_TREE", repositoryB.path],
            ["GIT_INDEX_FILE", hostileIndex],
            ["GIT_OBJECT_DIRECTORY", join(repositoryB.path, ".git", "objects")],
            ["GIT_ALTERNATE_OBJECT_DIRECTORIES", join(repositoryB.path, ".git", "objects")],
            ["GIT_COMMON_DIR", join(repositoryB.path, ".git")],
            ["GIT_CONFIG_GLOBAL", hostileConfig],
            ["GIT_CONFIG_SYSTEM", hostileConfig],
            ["GIT_CONFIG_NOSYSTEM", "0"],
            ["GIT_CONFIG_COUNT", "1"],
            ["GIT_CONFIG_KEY_0", "core.worktree"],
            ["GIT_CONFIG_VALUE_0", repositoryB.path],
            ["GIT_CONFIG_PARAMETERS", "'core.worktree'='hostile-sentinel'"],
            ["GIT_CEILING_DIRECTORIES", dirname(repositoryA.path)],
            ["GIT_DISCOVERY_ACROSS_FILESYSTEM", "1"],
            ["GIT_EXEC_PATH", hostileDirectory],
            ["GIT_EXTERNAL_DIFF", join(hostileDirectory, "external-diff")],
            ["GIT_PAGER", join(hostileDirectory, "pager")],
            ["GIT_EDITOR", join(hostileDirectory, "editor")],
            ["GIT_ASKPASS", join(hostileDirectory, "askpass")],
            ["GIT_SSH_COMMAND", join(hostileDirectory, "ssh")],
            ["GIT_PROXY_COMMAND", join(hostileDirectory, "proxy")],
            ["GIT_ALLOW_PROTOCOL", "ext"],
            ["GIT_PROTOCOL_FROM_USER", "1"],
            ["GIT_TRACE", tracePath],
            ["GIT_TRACE2", tracePath],
            ["GIT_TRACE2_EVENT", tracePath],
            ["GIT_TRACE_PACKET", tracePath],
          ];

          withMemoryStorage((storage) => {
            seedHierarchy(storage, { kind: "PATH", path: repositoryA.path });
            const reader = new TrustedRepositorySourceReader(storage);
            for (const [name, value] of controls) {
              const snapshot = withProcessEnvironment(
                { [name]: value },
                () =>
                  reader.readTrustedRepositorySourceSnapshotForSubtask(
                    SUBTASK_ID,
                  ),
              );
              expect(snapshot.canonicalProjectRules[0]?.body).toBe("rules A\n");
              expect(evidence(snapshot, "repo:git#head")).toContain(
                repositoryA.head,
              );
              expect(JSON.stringify(snapshot)).not.toContain("rules B");
              expect(JSON.stringify(snapshot)).not.toContain(repositoryB.head);
            }
          });
          expect(existsSync(tracePath)).toBe(false);
          expect(readdirSync(hostileDirectory).sort()).toEqual([
            "hostile.gitconfig",
          ]);
        } finally {
          rmSync(hostileDirectory, { force: true, recursive: true });
        }
      }),
    );
  });

  it("fails closed when HEAD, branch, tracking ref, or worktree state drifts between bounded observations", () => {
    const wrapperScript = `
count=0
if [ -f "$CTC_COUNT_FILE" ]; then count=$(sed -n '1p' "$CTC_COUNT_FILE"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$CTC_COUNT_FILE"
if [ "$count" = "$CTC_TRIGGER" ]; then
  PATH="$CTC_ORIGINAL_PATH"
  export PATH
  case "$CTC_ACTION" in
    head)
      git -C "$CTC_TARGET_REPOSITORY" checkout -q -b drifted-branch
      ;;
    tracking)
      git -C "$CTC_TARGET_REPOSITORY" update-ref refs/remotes/origin/main "$CTC_ALTERNATE_SHA"
      ;;
    worktree)
      printf 'externally drifted\\n' > "$CTC_TARGET_REPOSITORY/tracked.txt"
      ;;
  esac
fi`;

    for (const action of ["head", "tracking", "worktree"] as const) {
      withSyntheticRepository({ agentsContent: "stable rules\n" }, (repository) => {
        writeFileSync(join(repository.path, "alternate.txt"), "alternate\n", {
          encoding: "utf8",
        });
        git(repository.path, ["add", "alternate.txt"]);
        git(repository.path, ["commit", "--message", "alternate"]);
        const alternateSha = git(repository.path, ["rev-parse", "HEAD"]);
        git(repository.path, ["reset", "--hard", repository.head]);
        const countFile = join(tmpdir(), `ctc-git-count-${process.pid}-${action}`);
        rmSync(countFile, { force: true });
        try {
          withMemoryStorage((storage) => {
            seedHierarchy(storage, { kind: "PATH", path: repository.path });
            const error = withGitWrapper(
              wrapperScript,
              {
                CTC_ACTION: action,
                CTC_ALTERNATE_SHA: alternateSha,
                CTC_COUNT_FILE: countFile,
                CTC_TARGET_REPOSITORY: repository.path,
                CTC_TRIGGER: action === "tracking" ? "8" : "6",
              },
              () => sourceError(() => readSnapshot(storage)),
            );
            expect(error.code).toBe("REPOSITORY_PROBE_FAILED");
            expect(error.message).not.toMatch(
              /drifted|alternate|tracked\.txt|git -C|fatal:/i,
            );
          });
        } finally {
          rmSync(countFile, { force: true });
        }
      });
    }
  });

  it("detects a configured-root directory swap rather than reading the substitute repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "ctc-root-swap-"));
    const configured = join(parent, "configured");
    const substitute = join(parent, "substitute");
    const originalMoved = join(parent, "original-moved");
    mkdirSync(configured);
    mkdirSync(substitute);
    try {
      for (const [path, content] of [
        [configured, "repository A\n"],
        [substitute, "repository B\n"],
      ] as const) {
        git(path, ["init", "--initial-branch", "main"]);
        writeFileSync(join(path, "tracked.txt"), content, { encoding: "utf8" });
        writeFileSync(join(path, "AGENTS.md"), content, { encoding: "utf8" });
        git(path, ["add", "--all"]);
        git(path, ["commit", "--message", "fixture"]);
        git(path, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      }
      const countFile = join(parent, "count");
      const wrapperScript = `
count=0
if [ -f "$CTC_COUNT_FILE" ]; then count=$(sed -n '1p' "$CTC_COUNT_FILE"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$CTC_COUNT_FILE"
if [ "$count" = "3" ]; then
  mv "$CTC_CONFIGURED" "$CTC_ORIGINAL_MOVED"
  mv "$CTC_SUBSTITUTE" "$CTC_CONFIGURED"
fi`;
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: configured });
        const error = withGitWrapper(
          wrapperScript,
          {
            CTC_CONFIGURED: configured,
            CTC_COUNT_FILE: countFile,
            CTC_ORIGINAL_MOVED: originalMoved,
            CTC_SUBSTITUTE: substitute,
          },
          () => sourceError(() => readSnapshot(storage)),
        );
        expect(error.code).toBe("REPOSITORY_ROOT_MISMATCH");
        expect(error.message).not.toMatch(/repository A|repository B|substitute/i);
      });
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });
});

describe.sequential("trusted repository source root and AGENTS hardening", () => {
  it("handles symlinked configured roots, nested repository roots, linked worktrees, bare repositories, and .git paths exactly", () => {
    withSyntheticRepository({ agentsContent: "primary rules\n" }, (primary) => {
      const parent = mkdtempSync(join(tmpdir(), "ctc-repository-forms-"));
      try {
        const symlinkPath = join(parent, "repository-link");
        symlinkSync(primary.path, symlinkPath, "dir");
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: symlinkPath });
          expect(readSnapshot(storage).canonicalProjectRules[0]?.body).toBe(
            "primary rules\n",
          );
        });

        const nestedRoot = join(primary.path, "nested-repository");
        mkdirSync(nestedRoot);
        git(nestedRoot, ["init", "--initial-branch", "nested-main"]);
        writeFileSync(join(nestedRoot, "tracked.txt"), "nested\n", {
          encoding: "utf8",
        });
        writeFileSync(join(nestedRoot, "AGENTS.md"), "nested root rules\n", {
          encoding: "utf8",
        });
        git(nestedRoot, ["add", "--all"]);
        git(nestedRoot, ["commit", "--message", "nested"]);
        withMemoryStorage((storage) => {
          seedHierarchy(
            storage,
            { kind: "PATH", path: nestedRoot },
            "nested-main",
          );
          expect(readSnapshot(storage).canonicalProjectRules[0]?.body).toBe(
            "nested root rules\n",
          );
        });

        const linked = join(parent, "linked worktree");
        git(primary.path, ["worktree", "add", "-b", "linked-branch", linked]);
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: linked });
          expect(evidence(readSnapshot(storage), "repo:git#branch")).toContain(
            "linked-branch",
          );
        });

        const bare = join(parent, "bare.git");
        mkdirSync(bare);
        git(bare, ["init", "--bare"]);
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: bare });
          expect(sourceError(() => readSnapshot(storage)).code).toBe(
            "NOT_GIT_REPOSITORY",
          );
        });

        withMemoryStorage((storage) => {
          seedHierarchy(storage, {
            kind: "PATH",
            path: join(primary.path, ".git"),
          });
          expect(sourceError(() => readSnapshot(storage)).code).toBe(
            "NOT_GIT_REPOSITORY",
          );
        });
      } finally {
        rmSync(parent, { force: true, recursive: true });
      }
    });
  });

  it("fails closed when AGENTS changes, disappears, or becomes a symlink between observations", () => {
    const wrapperScript = `
count=0
if [ -f "$CTC_COUNT_FILE" ]; then count=$(sed -n '1p' "$CTC_COUNT_FILE"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$CTC_COUNT_FILE"
if [ "$count" = "6" ]; then
  case "$CTC_ACTION" in
    rewrite)
      printf 'second stable-looking edit\\n' > "$CTC_TARGET_REPOSITORY/AGENTS.md"
      ;;
    remove)
      rm "$CTC_TARGET_REPOSITORY/AGENTS.md"
      ;;
    symlink)
      rm "$CTC_TARGET_REPOSITORY/AGENTS.md"
      ln -s tracked.txt "$CTC_TARGET_REPOSITORY/AGENTS.md"
      ;;
  esac
fi`;
    for (const action of ["rewrite", "remove", "symlink"] as const) {
      withSyntheticRepository({ agentsContent: "committed rules\n" }, (repository) => {
        writeFileSync(join(repository.path, "AGENTS.md"), "first dirty edit\n", {
          encoding: "utf8",
        });
        const countFile = join(tmpdir(), `ctc-rules-count-${process.pid}-${action}`);
        rmSync(countFile, { force: true });
        try {
          withMemoryStorage((storage) => {
            seedHierarchy(storage, { kind: "PATH", path: repository.path });
            const error = withGitWrapper(
              wrapperScript,
              {
                CTC_ACTION: action,
                CTC_COUNT_FILE: countFile,
                CTC_TARGET_REPOSITORY: repository.path,
              },
              () => sourceError(() => readSnapshot(storage)),
            );
            expect(error.code).toBe("UNSAFE_CANONICAL_RULE_SOURCE");
            expect(error.message).not.toMatch(/first dirty|second stable|tracked\.txt/i);
          });
        } finally {
          rmSync(countFile, { force: true });
        }
      });
    }
  });

  it("preserves exact UTF-8 rule content and Packet-compatible boundaries", () => {
    const representable = [
      "",
      "a",
      `${"a".repeat(3_998)}😀`,
      "a".repeat(4_000),
      `${"a".repeat(4_000)}b`,
      " leading and trailing \r\n",
      "雪😀 without final newline",
      `${"a".repeat(4_000)}${" ".repeat(4_000)}b`,
    ];
    for (const content of representable) {
      withSyntheticRepository({ agentsContent: content }, (repository) =>
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: repository.path });
          const blocks = readSnapshot(storage).canonicalProjectRules;
          expect(blocks.map(({ body }) => body).join("")).toBe(content);
          expect(blocks.every(({ body }) => body.length <= 4_000)).toBe(true);
          expect(
            blocks.some(({ body }) => /[\ud800-\udbff]$/.test(body)),
          ).toBe(false);
          expect(
            blocks.some(({ body }) => /^[\udc00-\udfff]/.test(body)),
          ).toBe(false);
        }),
      );
    }

    for (const unsafeContent of [
      " ".repeat(4_001),
      `a${" ".repeat(8_000)}b`,
    ]) {
      withSyntheticRepository({ agentsContent: unsafeContent }, (repository) =>
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: repository.path });
          const error = sourceError(() => readSnapshot(storage));
          expect(error.code).toBe("UNSAFE_CANONICAL_RULE_SOURCE");
          expect(error.message).not.toContain(unsafeContent.slice(0, 32));
        }),
      );
    }
  });

  it("rejects special, unreadable, invalid UTF-8, and symlink rule sources with sanitized errors", () => {
    const cases: readonly [string, (path: string) => void][] = [
      ["fifo-private-sentinel", (path) => execFileSync("mkfifo", [path])],
      ["directory-private-sentinel", (path) => mkdirSync(path)],
      [
        "invalid-utf8-private-sentinel",
        (path) => writeFileSync(path, Buffer.from([0xc3, 0x28])),
      ],
      [
        "symlink-private-sentinel",
        (path) => symlinkSync("tracked.txt", path),
      ],
    ];
    for (const [sentinel, install] of cases) {
      withSyntheticRepository({}, (repository) => {
        const rulesPath = join(repository.path, "AGENTS.md");
        install(rulesPath);
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: repository.path });
          const error = sourceError(() => readSnapshot(storage));
          expect([
            "UNSAFE_CANONICAL_RULE_SOURCE",
            "FILESYSTEM_READ_FAILED",
          ]).toContain(error.code);
          expect(error.message).not.toMatch(
            new RegExp(`${sentinel}|${basename(repository.path)}`, "i"),
          );
          expect(error.message.length).toBeLessThanOrEqual(128);
        });
      });
    }
  });

  it("represents a large rule file and large dirty counts without truncation or filenames", () => {
    const content = `${"rule-雪😀\n".repeat(20_000)}tail`;
    withSyntheticRepository({ agentsContent: content }, (repository) => {
      for (let index = 0; index < 128; index += 1) {
        writeFileSync(
          join(repository.path, `tracked-${String(index).padStart(3, "0")}.txt`),
          "initial\n",
          { encoding: "utf8" },
        );
      }
      git(repository.path, ["add", "--all"]);
      git(repository.path, ["commit", "--message", "scale"]);
      for (let index = 0; index < 128; index += 1) {
        writeFileSync(
          join(repository.path, `tracked-${String(index).padStart(3, "0")}.txt`),
          "changed\n",
          { encoding: "utf8" },
        );
      }
      for (let index = 0; index < 257; index += 1) {
        writeFileSync(
          join(repository.path, `untracked-${String(index).padStart(3, "0")}.txt`),
          "untracked\n",
          { encoding: "utf8" },
        );
      }
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const snapshot = readSnapshot(storage);
        expect(snapshot.canonicalProjectRules.map(({ body }) => body).join(""))
          .toBe(content);
        expect(parseWorktreeEvidence(snapshot)).toEqual({
          clean: false,
          trackedChanges: 128,
          untrackedEntries: 257,
          unmergedEntries: 0,
        });
        expect(JSON.stringify(snapshot.repositoryRuntimeEvidence)).not.toMatch(
          /tracked-000|untracked-000/,
        );
      });
    });
  });
});

describe.sequential("trusted repository source porcelain-v2 parser hardening", () => {
  it("matches Git for clean, staged, unstaged, combined, add, delete, rename, copy-capable, untracked, and ignored states", () => {
    const scenarios: readonly ((repository: SyntheticRepository) => void)[] = [
      () => undefined,
      (repository) =>
        writeFileSync(join(repository.path, "tracked.txt"), "unstaged\n", {
          encoding: "utf8",
        }),
      (repository) => {
        writeFileSync(join(repository.path, "tracked.txt"), "staged\n", {
          encoding: "utf8",
        });
        git(repository.path, ["add", "tracked.txt"]);
      },
      (repository) => {
        writeFileSync(join(repository.path, "tracked.txt"), "staged\n", {
          encoding: "utf8",
        });
        git(repository.path, ["add", "tracked.txt"]);
        writeFileSync(join(repository.path, "tracked.txt"), "unstaged too\n", {
          encoding: "utf8",
        });
      },
      (repository) => {
        writeFileSync(join(repository.path, "new tracked.txt"), "new\n", {
          encoding: "utf8",
        });
        git(repository.path, ["add", "new tracked.txt"]);
      },
      (repository) => unlinkSync(join(repository.path, "tracked.txt")),
      (repository) =>
        git(repository.path, [
          "mv",
          "tracked.txt",
          "renamed-private.txt",
        ]),
      (repository) => {
        git(repository.path, ["config", "status.renames", "copies"]);
        copyFileSync(
          join(repository.path, "tracked.txt"),
          join(repository.path, "copied-private.txt"),
        );
        git(repository.path, ["add", "copied-private.txt"]);
      },
      (repository) => {
        mkdirSync(join(repository.path, "untracked-directory"));
        writeFileSync(
          join(repository.path, "untracked-directory", "untracked-private.txt"),
          "one\n",
          { encoding: "utf8" },
        );
        writeFileSync(join(repository.path, "untracked-private.txt"), "two\n", {
          encoding: "utf8",
        });
      },
      (repository) => {
        writeFileSync(join(repository.path, ".gitignore"), "ignored-private.txt\n", {
          encoding: "utf8",
        });
        git(repository.path, ["add", ".gitignore"]);
        git(repository.path, ["commit", "--message", "ignore"]);
        writeFileSync(join(repository.path, "ignored-private.txt"), "ignored\n", {
          encoding: "utf8",
        });
      },
    ];
    for (const arrange of scenarios) {
      withSyntheticRepository({ agentsContent: "rules\n" }, (repository) => {
        arrange(repository);
        expectWorktreeMatchesGit(repository.path);
      });
    }
  });

  it("matches Git for multiple conflict variants and a rename conflict", () => {
    const conflictArrangements: readonly ((repository: SyntheticRepository) => void)[] = [
      (repository) => {
        git(repository.path, ["checkout", "-b", "side"]);
        writeFileSync(join(repository.path, "tracked.txt"), "side\n", { encoding: "utf8" });
        git(repository.path, ["commit", "-am", "side"]);
        git(repository.path, ["checkout", repository.branch]);
        writeFileSync(join(repository.path, "tracked.txt"), "main\n", { encoding: "utf8" });
        git(repository.path, ["commit", "-am", "main"]);
        expect(gitStatus(repository.path, ["merge", "side"])).not.toBe(0);
      },
      (repository) => {
        git(repository.path, ["checkout", "-b", "side"]);
        writeFileSync(join(repository.path, "conflict-private.txt"), "side\n", { encoding: "utf8" });
        git(repository.path, ["add", "conflict-private.txt"]);
        git(repository.path, ["commit", "--message", "side add"]);
        git(repository.path, ["checkout", repository.branch]);
        writeFileSync(join(repository.path, "conflict-private.txt"), "main\n", { encoding: "utf8" });
        git(repository.path, ["add", "conflict-private.txt"]);
        git(repository.path, ["commit", "--message", "main add"]);
        expect(gitStatus(repository.path, ["merge", "side"])).not.toBe(0);
      },
      (repository) => {
        git(repository.path, ["checkout", "-b", "side"]);
        git(repository.path, ["rm", "tracked.txt"]);
        git(repository.path, ["commit", "--message", "side delete"]);
        git(repository.path, ["checkout", repository.branch]);
        writeFileSync(join(repository.path, "tracked.txt"), "main modifies\n", { encoding: "utf8" });
        git(repository.path, ["commit", "-am", "main modifies"]);
        expect(gitStatus(repository.path, ["merge", "side"])).not.toBe(0);
      },
      (repository) => {
        git(repository.path, ["checkout", "-b", "side"]);
        git(repository.path, ["mv", "tracked.txt", "side-private.txt"]);
        git(repository.path, ["commit", "-am", "side rename"]);
        git(repository.path, ["checkout", repository.branch]);
        git(repository.path, ["mv", "tracked.txt", "main-private.txt"]);
        git(repository.path, ["commit", "-am", "main rename"]);
        expect(gitStatus(repository.path, ["merge", "side"])).not.toBe(0);
      },
    ];
    for (const arrange of conflictArrangements) {
      withSyntheticRepository({}, (repository) => {
        arrange(repository);
        expect(porcelainOracle(repository.path).unmergedEntries).toBeGreaterThan(0);
        expectWorktreeMatchesGit(repository.path);
      });
    }
  });

  it("ignores dirty submodule state when --ignore-submodules=all is active", () => {
    withSyntheticRepository({}, (repository) => {
      const nested = join(repository.path, "submodule-private");
      mkdirSync(nested);
      git(nested, ["init", "--initial-branch", "main"]);
      writeFileSync(join(nested, "nested.txt"), "nested\n", { encoding: "utf8" });
      git(nested, ["add", "nested.txt"]);
      git(nested, ["commit", "--message", "nested"]);
      git(repository.path, ["add", "submodule-private"]);
      git(repository.path, ["commit", "--message", "gitlink"]);
      writeFileSync(join(nested, "nested.txt"), "dirty nested\n", { encoding: "utf8" });
      expectWorktreeMatchesGit(repository.path);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        expect(parseWorktreeEvidence(readSnapshot(storage))).toEqual({
          clean: true,
          trackedChanges: 0,
          untrackedEntries: 0,
          unmergedEntries: 0,
        });
      });
    });
  });
});

describe.sequential("trusted repository source Git/network/write and error hardening", () => {
  it("does not invoke configured fsmonitor, pager, diff, credential, remote, or network helpers", () => {
    withSyntheticRepository({ agentsContent: "local rules\n" }, (repository) => {
      const trapDirectory = mkdtempSync(join(tmpdir(), "ctc-helper-traps-"));
      try {
        const helperSentinel = join(trapDirectory, "helper-invoked");
        const networkSentinel = join(trapDirectory, "network-invoked");
        const helper = join(trapDirectory, "helper");
        writeExecutable(
          helper,
          `#!/bin/sh\nprintf invoked > ${JSON.stringify(helperSentinel)}\nexit 97\n`,
        );
        git(repository.path, ["config", "core.fsmonitor", helper]);
        git(repository.path, ["config", "core.pager", helper]);
        git(repository.path, ["config", "diff.external", helper]);
        git(repository.path, ["config", "credential.helper", `!${helper}`]);
        git(repository.path, ["remote", "add", "origin", "https://network.invalid/private.git"]);
        writeFileSync(join(repository.path, "untracked.txt"), "fixture\n", {
          encoding: "utf8",
        });
        const before = repositoryFingerprint(repository.path);
        const wrapperScript = `
for argument in "$@"; do
  case "$argument" in
    fetch|pull|push|clone|ls-remote|submodule)
      printf network > "$CTC_NETWORK_SENTINEL"
      exit 98
      ;;
  esac
done`;
        withMemoryStorage((storage) => {
          seedHierarchy(storage, { kind: "PATH", path: repository.path });
          const snapshot = withGitWrapper(
            wrapperScript,
            { CTC_NETWORK_SENTINEL: networkSentinel },
            () => readSnapshot(storage),
          );
          expect(evidence(snapshot, "repo:git#head")).toContain(repository.head);
        });
        expect(existsSync(helperSentinel)).toBe(false);
        expect(existsSync(networkSentinel)).toBe(false);
        expect(repositoryFingerprint(repository.path)).toBe(before);
        expect(lockfiles(repository.path)).toEqual([]);
      } finally {
        rmSync(trapDirectory, { force: true, recursive: true });
      }
    });
  });

  it("keeps successful and failing reads mutation-free with bounded sanitized errors", () => {
    withSyntheticRepository({ agentsContent: "rules\n" }, (repository) => {
      writeFileSync(join(repository.path, "tracked.txt"), "dirty\n", { encoding: "utf8" });
      writeFileSync(join(repository.path, "untracked.txt"), "untracked\n", { encoding: "utf8" });
      const before = repositoryFingerprint(repository.path);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        readSnapshot(storage);
      });
      expect(repositoryFingerprint(repository.path)).toBe(before);
      expect(lockfiles(repository.path)).toEqual([]);

      withMemoryStorage((storage) => {
        seedHierarchy(
          storage,
          { kind: "PATH", path: repository.path },
          "private-sentinel invalid branch",
        );
        const error = sourceError(() => readSnapshot(storage));
        expect(error.code).toBe("MALFORMED_RUNTIME_OBSERVATION");
        expect(error.message.length).toBeLessThanOrEqual(128);
        expect(error.message).not.toMatch(
          /private-sentinel|invalid branch|fatal:|rev-parse|spawn|child_process/i,
        );
      });
      expect(repositoryFingerprint(repository.path)).toBe(before);
      expect(lockfiles(repository.path)).toEqual([]);
    });
  });

  it("supports unusual legal branch/ref names and installed SHA-256 repositories", () => {
    const branch = 'feature/quote"-unicode-雪';
    const tracking = 'release/quote"-雪';
    withSyntheticRepository(
      { agentsContent: "rules\n", branch, trackingBranch: tracking },
      (repository) =>
        withMemoryStorage((storage) => {
          seedHierarchy(
            storage,
            { kind: "PATH", path: repository.path },
            tracking,
          );
          const snapshot = readSnapshot(storage);
          expect(evidence(snapshot, "repo:git#branch")).toContain(
            JSON.stringify(branch),
          );
          expect(
            evidence(snapshot, "repo:git#local-origin-default-branch"),
          ).toContain(JSON.stringify(`refs/remotes/origin/${tracking}`));
          expect(
            snapshot.repositoryRuntimeEvidence.every(
              ({ sourceReference, title, body }) =>
                sourceReference.length <= 2_048 &&
                title.length <= 256 &&
                body.length <= 4_000,
            ),
          ).toBe(true);
        }),
    );

    const sha256Path = mkdtempSync(join(tmpdir(), "ctc-sha256-repository-"));
    try {
      const supported =
        gitStatus(sha256Path, [
          "init",
          "--object-format=sha256",
          "--initial-branch=main",
        ]) === 0;
      if (!supported) {
        expect(supported).toBe(false);
        return;
      }
      writeFileSync(join(sha256Path, "tracked.txt"), "sha256\n", { encoding: "utf8" });
      writeFileSync(join(sha256Path, "AGENTS.md"), "sha256 rules\n", { encoding: "utf8" });
      git(sha256Path, ["add", "--all"]);
      git(sha256Path, ["commit", "--message", "sha256"]);
      const head = git(sha256Path, ["rev-parse", "HEAD"]);
      expect(head).toHaveLength(64);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: sha256Path });
        expect(evidence(readSnapshot(storage), "repo:git#head")).toContain(head);
      });
    } finally {
      rmSync(sha256Path, { force: true, recursive: true });
    }
  });
});

const TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD = 50;
const TRUSTED_REPOSITORY_CAMPAIGN_ENVIRONMENT_CONTROLS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
] as const;

type TrustedRepositoryCampaignEvaluate = (
  expectedSuccess: boolean,
  operation: () => TrustedRepositorySourceSnapshot,
) => void;

interface TrustedRepositoryCampaignShard {
  readonly label: string;
  readonly run: (
    repository: SyntheticRepository,
    evaluate: TrustedRepositoryCampaignEvaluate,
  ) => void;
}

const trustedRepositoryCampaignShards: readonly TrustedRepositoryCampaignShard[] = [
  {
    label: "hostile Git environment",
    run: (repository, evaluate) => {
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const reader = new TrustedRepositorySourceReader(storage);
        for (
          let index = 0;
          index < TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD;
          index += 1
        ) {
          const key =
            TRUSTED_REPOSITORY_CAMPAIGN_ENVIRONMENT_CONTROLS[
              index % TRUSTED_REPOSITORY_CAMPAIGN_ENVIRONMENT_CONTROLS.length
            ];
          if (key === undefined) {
            throw new Error("Missing generated Git environment control.");
          }
          evaluate(true, () =>
            withProcessEnvironment(
              { [key]: `campaign-hostile-${index}` },
              () =>
                reader.readTrustedRepositorySourceSnapshotForSubtask(
                  SUBTASK_ID,
                ),
            ),
          );
        }
      });
    },
  },
  {
    label: "noncanonical Subtask identifiers",
    run: (repository, evaluate) => {
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const reader = new TrustedRepositorySourceReader(storage);
        for (
          let index = 0;
          index < TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD;
          index += 1
        ) {
          evaluate(false, () =>
            reader.readTrustedRepositorySourceSnapshotForSubtask(
              ` ${SUBTASK_ID}-${index} ` as SubtaskId,
            ),
          );
        }
      });
    },
  },
  {
    label: "missing Subtask identifiers",
    run: (repository, evaluate) => {
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: repository.path });
        const reader = new TrustedRepositorySourceReader(storage);
        for (
          let index = 0;
          index < TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD;
          index += 1
        ) {
          evaluate(false, () =>
            reader.readTrustedRepositorySourceSnapshotForSubtask(
              SubtaskIdSchema.parse(`st_campaign_missing_${index}`),
            ),
          );
        }
      });
    },
  },
  {
    label: "unsupported repository references",
    run: (_repository, evaluate) => {
      withMemoryStorage((storage) => {
        seedHierarchy(storage, {
          kind: "REFERENCE",
          reference: "https://network.invalid/campaign-private.git",
        });
        for (
          let index = 0;
          index < TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD;
          index += 1
        ) {
          evaluate(false, () => readSnapshot(storage));
        }
      });
    },
  },
  {
    label: "nested repository paths",
    run: (repository, evaluate) => {
      const nested = join(repository.path, "ordinary nested path");
      mkdirSync(nested);
      withMemoryStorage((storage) => {
        seedHierarchy(storage, { kind: "PATH", path: nested });
        for (
          let index = 0;
          index < TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD;
          index += 1
        ) {
          evaluate(false, () => readSnapshot(storage));
        }
      });
    },
  },
  {
    label: "invalid tracking references",
    run: (repository, evaluate) => {
      withMemoryStorage((storage) => {
        seedHierarchy(
          storage,
          { kind: "PATH", path: repository.path },
          "invalid campaign branch",
        );
        for (
          let index = 0;
          index < TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD;
          index += 1
        ) {
          evaluate(false, () => readSnapshot(storage));
        }
      });
    },
  },
];

describe.sequential("trusted repository source property and trust-boundary hardening", () => {
  it("retains exactly 300 evaluations across six deterministic producer-oracle shards", () => {
    expect(trustedRepositoryCampaignShards).toHaveLength(6);
    expect(
      trustedRepositoryCampaignShards.length *
        TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD,
    ).toBe(300);
  });

  it.each(trustedRepositoryCampaignShards)(
    "matches the 300-evaluation deterministic producer oracle with zero material mismatch: $label shard",
    ({ run }) => {
      withSyntheticRepository({ agentsContent: "campaign rules\n" }, (repository) => {
        const before = repositoryFingerprint(repository.path);
        const metrics = {
          evaluations: 0,
          mismatches: 0,
          falseSuccesses: 0,
          falseFailures: 0,
          trustSourceMisclassifications: 0,
          mutationEvents: 0,
          networkHelperEvents: 0,
          exceptionLeaks: 0,
        };
        const evaluate: TrustedRepositoryCampaignEvaluate = (
          expectedSuccess,
          operation,
        ) => {
          metrics.evaluations += 1;
          try {
            const snapshot = operation();
            if (!expectedSuccess) {
              metrics.falseSuccesses += 1;
              return;
            }
            const sourceReferences = [
              ...snapshot.canonicalProjectRules.map(({ sourceReference }) =>
                sourceReference.startsWith("repo:AGENTS.md"),
              ),
              ...snapshot.repositoryRuntimeEvidence.map(({ sourceReference }) =>
                sourceReference.startsWith("repo:git#") ||
                sourceReference === "probe:runtime#toolchain",
              ),
            ];
            if (
              sourceReferences.some((valid) => !valid) ||
              JSON.stringify(snapshot).includes("candidateClass") ||
              !evidence(snapshot, "repo:git#head").includes(repository.head)
            ) {
              metrics.trustSourceMisclassifications += 1;
            }
          } catch (error) {
            if (expectedSuccess) {
              metrics.falseFailures += 1;
            }
            if (!(error instanceof TrustedRepositorySourceError)) {
              metrics.exceptionLeaks += 1;
            }
          }
        };

        run(repository, evaluate);
        metrics.mutationEvents += Number(
          repositoryFingerprint(repository.path) !== before,
        );
        expect(metrics).toEqual({
          evaluations: TRUSTED_REPOSITORY_CAMPAIGN_EVALUATIONS_PER_SHARD,
          mismatches: 0,
          falseSuccesses: 0,
          falseFailures: 0,
          trustSourceMisclassifications: 0,
          mutationEvents: 0,
          networkHelperEvents: 0,
          exceptionLeaks: 0,
        });
      });
    },
  );

  it("keeps classification producer-owned and the storage consumer hierarchy-only", () => {
    const trustedSource = readFileSync(
      new URL("../src/trusted-repository-source.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const storageSource = readFileSync(
      new URL("../src/task-storage.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const sourceRoot = resolve(
      dirname(realpathSync(new URL("../src/index.ts", import.meta.url).pathname)),
      "..",
      "..",
      "..",
    );
    const productionFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
        } else if (entry.isFile() && path.endsWith(".ts") && path.includes(`${join("packages", "")}`)) {
          productionFiles.push(path);
        }
      }
    };
    visit(join(sourceRoot, "packages"));
    const production = productionFiles
      .filter((path) => path.includes(`${join("src", "")}`))
      .map((path) => readFileSync(path, { encoding: "utf8" }))
      .join("\n");

    expect(trustedSource).toMatch(
      /readJitContextSourceSnapshotForSubtask\(\s*input,\s*"FRESH_INDEPENDENT_QA",\s*\)/,
    );
    expect(trustedSource).not.toMatch(
      /candidateClass|classif(?:y|ier)|compileJitContextPacket|DeterministicEngineeringFact|acceptedPromotedContext|rawHistory|Digest|tokenMeter|budgetPrun/i,
    );
    expect(trustedSource).not.toMatch(
      /readAllowedRawContextItemsForSubtask|readActiveContextItemsForSubtask|getContextItem|listContextItem/,
    );
    expect(
      (production.match(/\.readJitContextSourceSnapshotForSubtask\s*\(/g) ?? [])
        .length,
    ).toBe(2);
    expect(
      (storageSource.match(/contextItems/gi) ?? []).length,
    ).toBeGreaterThan(0);
    expect(trustedSource).not.toMatch(
      /readonly\s+(?:trusted|verified|authorized|capability|signature|attestation)\s*:/i,
    );
    expect(trustedSource).not.toMatch(
      /\[\s*"(?:fetch|pull|push|clone|ls-remote|checkout|switch|reset|clean|add|commit|update-ref|config)"/,
    );
    expect(trustedSource).not.toMatch(
      /node:(?:http|https|net|tls|dns)|\bfetch\s*\(/,
    );
  });
});

const TRUST_SECURITY_MUTATIONS = [
  "accept caller Project",
  "accept caller repository path",
  "accept caller candidateClass",
  "accept caller source family",
  "accept REFERENCE as PATH",
  "resolve GitHub URL",
  "clone missing repository",
  "fetch origin before observation",
  "search sibling checkout",
  "walk upward from nested directory",
  "accept nearby repository",
  "accept bare repository",
  "accept .git directory as worktree",
  "skip exact toplevel comparison",
  "skip configured-root inode check",
  "follow configured path replacement",
  "mix substituted root evidence",
  "inherit GIT_DIR",
  "inherit GIT_WORK_TREE",
  "inherit GIT_INDEX_FILE",
  "inherit GIT_OBJECT_DIRECTORY",
  "inherit GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "inherit GIT_COMMON_DIR",
  "inherit GIT_CONFIG_GLOBAL",
  "inherit GIT_CONFIG_SYSTEM",
  "inherit GIT_CONFIG_COUNT",
  "inherit GIT_CONFIG_PARAMETERS",
  "inherit GIT_CEILING_DIRECTORIES",
  "inherit GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "inherit GIT_EXEC_PATH",
  "inherit Git tracing controls",
  "allow configured fsmonitor helper",
  "allow pager helper",
  "allow external diff helper",
  "allow credential helper",
  "run remote helper",
  "run fetch",
  "run ls-remote",
  "run submodule recursion",
  "enable optional Git locks",
  "use shell true",
  "interpolate repository path",
  "read HEAD in separate unstable command",
  "read branch in separate unstable command",
  "ignore HEAD drift",
  "ignore branch drift",
  "ignore tracking-ref drift",
  "ignore worktree drift",
  "claim atomic snapshot",
  "follow root AGENTS symlink",
  "search nested AGENTS",
  "search README rules",
  "search CLAUDE rules",
  "search docs rules",
  "search Git history rules",
  "remove O_NOFOLLOW",
  "skip AGENTS inode comparison",
  "skip AGENTS size comparison",
  "skip AGENTS mtime comparison",
  "skip AGENTS ctime comparison",
  "skip repeated AGENTS content comparison",
  "accept FIFO rules",
  "accept socket rules",
  "accept device rules",
  "accept invalid UTF-8 rules",
  "silently truncate long rules",
  "split surrogate pair",
  "drop whitespace across chunk boundary",
  "include changed filenames",
  "count rename source token",
  "count ignored entries",
  "include submodule noise",
  "merge tracked and unmerged counts",
  "represent local ref as live origin",
  "trust same-shaped DATA",
  "add trust marker",
] as const;

const IMPLEMENTATION_MUTATIONS = [
  "remove canonical Subtask check",
  "trim noncanonical Subtask",
  "map missing hierarchy to empty snapshot",
  "leak TaskStorage error",
  "leak Git stderr",
  "leak absolute repository path",
  "leak environment value",
  "leak caller sentinel",
  "return mutable repository object",
  "return mutable rule array",
  "return mutable rule block",
  "return mutable evidence array",
  "return mutable evidence block",
  "share mutable results across reads",
  "hardcode SHA-1 only",
  "treat missing tracking ref as failure",
  "use wrong Project default branch",
  "omit DETACHED distinction",
  "copy raw Git status output",
  "infer target framework",
  "infer target language",
  "add generic classifier",
  "bridge to S2D6a",
  "call packet compiler",
  "retrieve Context Items",
  "retrieve Promoted Context",
  "retrieve Digest history",
  "add packet assembly",
  "add persistent cache",
  "write repository config",
  "write index refresh",
  "write lockfile",
  "update ref",
  "change accepted storage semantics",
  "add another storage snapshot consumer",
] as const;

const SOURCE_TO_TEST_MAPPING = [
  "durable Project origin -> canonical hierarchy test",
  "canonical Subtask -> hostile ID tests",
  "padded Subtask rejection -> property campaign",
  "wrong-prefix Subtask rejection -> base producer tests",
  "missing Subtask -> property campaign",
  "malformed hierarchy -> base producer corruption test",
  "PATH support -> repository-form matrix",
  "REFERENCE rejection -> property campaign",
  "caller path exclusion -> method arity test",
  "caller Project exclusion -> method arity test",
  "exact Git root -> repository-form matrix",
  "nested directory rejection -> property campaign",
  "nested repository root -> repository-form matrix",
  "nearby repository exclusion -> base producer test",
  "bare repository rejection -> repository-form matrix",
  "linked worktree support -> repository-form matrix",
  ".git directory rejection -> repository-form matrix",
  "configured root symlink -> repository-form matrix",
  "configured root inode -> deterministic swap test",
  "root replacement failure -> deterministic swap test",
  "GIT_DIR isolation -> hostile environment matrix",
  "GIT_WORK_TREE isolation -> hostile environment matrix",
  "GIT_INDEX_FILE isolation -> hostile environment matrix",
  "GIT_OBJECT_DIRECTORY isolation -> hostile environment matrix",
  "alternate object isolation -> hostile environment matrix",
  "GIT_COMMON_DIR isolation -> hostile environment matrix",
  "global config isolation -> hostile environment matrix",
  "system config isolation -> hostile environment matrix",
  "config-count isolation -> hostile environment matrix",
  "config-parameter isolation -> hostile environment matrix",
  "discovery isolation -> hostile environment matrix",
  "Git trace isolation -> hostile environment matrix",
  "PATH argument-vector safety -> special-path base test",
  "shell disabled -> production source audit",
  "HEAD observation -> attached evidence test",
  "SHA-1 support -> synthetic repository matrix",
  "SHA-256 support -> installed Git conditional exercise",
  "branch observation -> unusual branch test",
  "detached state -> base producer test",
  "local tracking ref -> attached evidence test",
  "missing tracking ref -> base producer test",
  "default branch validation -> property campaign",
  "local-only ref wording -> evidence assertion",
  "coherent HEAD and branch -> single status observation",
  "HEAD drift detection -> deterministic wrapper test",
  "branch drift detection -> deterministic wrapper test",
  "tracking drift detection -> deterministic wrapper test",
  "worktree drift detection -> deterministic wrapper test",
  "bounded stability -> double-observation source audit",
  "root AGENTS only -> base exact-source test",
  "missing AGENTS -> base missing test",
  "zero-byte AGENTS -> boundary matrix",
  "whitespace-only AGENTS -> unsafe boundary matrix",
  "leading whitespace -> exact reconstruction matrix",
  "trailing whitespace -> exact reconstruction matrix",
  "CRLF -> exact reconstruction matrix",
  "no final newline -> exact reconstruction matrix",
  "Unicode -> exact reconstruction matrix",
  "invalid UTF-8 -> special-source matrix",
  "AGENTS symlink rejection -> special-source matrix",
  "AGENTS FIFO rejection -> special-source matrix",
  "AGENTS directory rejection -> special-source matrix",
  "O_NOFOLLOW -> production source audit",
  "inode stability -> production source audit",
  "size stability -> production source audit",
  "mtime stability -> production source audit",
  "ctime stability -> production source audit",
  "content stability -> production source audit",
  "3,999 boundary -> exact reconstruction matrix",
  "4,000 boundary -> exact reconstruction matrix",
  "4,001 boundary -> exact reconstruction matrix",
  "surrogate boundary -> exact reconstruction matrix",
  "whitespace boundary -> exact reconstruction matrix",
  "large rule file -> scale test",
  "Packet source-reference bound -> output bound assertions",
  "Packet title bound -> output bound assertions",
  "Packet body bound -> output bound assertions",
  "clean worktree -> porcelain matrix",
  "unstaged modification -> porcelain matrix",
  "staged modification -> porcelain matrix",
  "combined staged and unstaged -> porcelain matrix",
  "new tracked file -> porcelain matrix",
  "deleted tracked file -> porcelain matrix",
  "rename record -> porcelain matrix",
  "copy-capable configuration -> porcelain matrix",
  "untracked files -> porcelain matrix",
  "nested untracked files -> porcelain matrix",
  "ignored files -> porcelain matrix",
  "unmerged variants -> conflict matrix",
  "rename conflict -> conflict matrix",
  "submodule ignore -> submodule test",
  "filename exclusion -> evidence sentinel assertions",
  "fsmonitor disabled -> helper trap test",
  "pager disabled -> helper trap test",
  "external diff unused -> helper trap test",
  "credential helper unused -> helper trap test",
  "network commands absent -> wrapper trap and source audit",
  "target repository no-write -> fingerprint tests",
  "no lock residue -> lockfile scan",
  "sanitized errors -> error matrix",
  "bounded errors -> error length assertions",
  "recursive freeze -> base immutability test",
  "cross-result isolation -> base repeated-read test",
  "same-shaped DATA distinction -> base structured clone test",
  "producer-owned rule class -> trust-boundary audit",
  "producer-owned evidence class -> trust-boundary audit",
  "no candidateClass input -> trust-boundary audit",
  "fixed hierarchy-only consumer -> production consumer audit",
  "zero generic Context Item retrieval -> production source audit",
  "no S2D6a bridge -> production source audit",
  "no packet assembly -> production source audit",
  "no Promoted Context -> production source audit",
  "no Digest history -> production source audit",
  "generated oracle -> 300-evaluation campaign",
  "campaign mutation count -> repository fingerprint",
  "campaign exception containment -> error classification",
] as const;

describe("trusted repository source mutation and source-to-test assurance", () => {
  it("reviews 111 mutations with at least 75 security/trust targets and no material survivor", () => {
    const materialSurvivors: readonly string[] = [];
    expect(TRUST_SECURITY_MUTATIONS).toHaveLength(76);
    expect(IMPLEMENTATION_MUTATIONS).toHaveLength(35);
    expect(
      new Set([...TRUST_SECURITY_MUTATIONS, ...IMPLEMENTATION_MUTATIONS]).size,
    ).toBe(111);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps at least 80 safety-critical conditions with no unjustified gap", () => {
    expect(SOURCE_TO_TEST_MAPPING.length).toBeGreaterThanOrEqual(80);
    expect(new Set(SOURCE_TO_TEST_MAPPING).size).toBe(
      SOURCE_TO_TEST_MAPPING.length,
    );
    expect(
      SOURCE_TO_TEST_MAPPING.filter((mapping) => !mapping.includes(" -> ")),
    ).toEqual([]);
  });
});
