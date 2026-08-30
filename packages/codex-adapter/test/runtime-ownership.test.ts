import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TESTED_CODEX_VERSION,
  activateOwnedCodexRuntime,
  deriveOwnedCodexExecutablePath,
  getCodexRuntimeTarget,
  getDefaultCodexRuntimeRoot,
  readOwnedCodexRuntimeSelector,
  resolveActiveOwnedCodexRuntime,
  resolveCodexExecutionRuntime,
  resolveDevelopmentCodexOverride,
  resolveOwnedCodexCandidate,
  rollbackOwnedCodexRuntime,
  type CodexRuntimeOwnershipOptions,
  type CodexRuntimeSelection,
} from "../src/index.js";

const CURRENT_SELECTION = {
  target: "aarch64-apple-darwin",
  version: "0.148.0-alpha.9",
} as const satisfies CodexRuntimeSelection;
const NEXT_SELECTION = {
  target: "aarch64-apple-darwin",
  version: "0.148.0-alpha.10",
} as const satisfies CodexRuntimeSelection;

let runtimeRoot: string;
let options: CodexRuntimeOwnershipOptions;
let originalBinaryOverride: string | undefined;
let originalCodexHome: string | undefined;
let originalHome: string | undefined;
let originalNodeEnvironment: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "ctc-owned-codex-"));
  options = { trustedRuntimeRoot: runtimeRoot };
  originalBinaryOverride = process.env.CTC_CODEX_BINARY;
  originalCodexHome = process.env.CODEX_HOME;
  originalHome = process.env.HOME;
  originalNodeEnvironment = process.env.NODE_ENV;
  originalPath = process.env.PATH;
  process.env.NODE_ENV = "test";
  delete process.env.CTC_CODEX_BINARY;
});

afterEach(() => {
  restoreEnvironmentVariable("CTC_CODEX_BINARY", originalBinaryOverride);
  restoreEnvironmentVariable("CODEX_HOME", originalCodexHome);
  restoreEnvironmentVariable("HOME", originalHome);
  restoreEnvironmentVariable("NODE_ENV", originalNodeEnvironment);
  restoreEnvironmentVariable("PATH", originalPath);
  try {
    chmodSync(runtimeRoot, 0o700);
  } catch {
    // The fixture may already be absent.
  }
  rmSync(runtimeRoot, { force: true, recursive: true });
});

describe("owned Codex runtime root and target", () => {
  it("uses macOS Application Support without repository or PATH input", () => {
    expect(getDefaultCodexRuntimeRoot()).toBe(
      join(
        homedir(),
        "Library",
        "Application Support",
        "Codex Task Console",
        "codex-runtime",
      ),
    );
    expect(getDefaultCodexRuntimeRoot("darwin", "/Users/example")).toBe(
      "/Users/example/Library/Application Support/Codex Task Console/codex-runtime",
    );
  });

  it("maps official macOS and Linux x64/arm64 targets exactly", () => {
    expect(getCodexRuntimeTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(getCodexRuntimeTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(getCodexRuntimeTarget("linux", "arm64")).toBe(
      "aarch64-unknown-linux-musl",
    );
    expect(getCodexRuntimeTarget("linux", "x64")).toBe(
      "x86_64-unknown-linux-musl",
    );
  });

  it("fails closed for unsupported platforms and non-temporary root overrides", () => {
    expect(() => getCodexRuntimeTarget("win32", "x64")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_RUNTIME_PLATFORM" }),
    );
    expect(() =>
      deriveOwnedCodexExecutablePath(CURRENT_SELECTION, {
        trustedRuntimeRoot: homedir(),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRUSTED_RUNTIME_ROOT" }));
  });
});

describe("owned Codex candidate resolution", () => {
  it("derives only the exact versioned standalone release path", () => {
    expect(deriveOwnedCodexExecutablePath(CURRENT_SELECTION, options)).toBe(
      join(
        realpathSync(runtimeRoot),
        "standalone-home",
        "packages",
        "standalone",
        "releases",
        "0.148.0-alpha.9-aarch64-apple-darwin",
        "bin",
        "codex",
      ),
    );
  });

  it("resolves a confined regular executable using only exact --version", () => {
    const executablePath = installFakeCandidate(CURRENT_SELECTION);
    expect(resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toEqual({
      canonicalExecutablePath: realpathSync(executablePath),
      exactVersionOutput: TESTED_CODEX_VERSION,
      executable: true,
      readable: true,
      releaseVersion: CURRENT_SELECTION.version,
      source: "OWNED_RELEASE",
      target: CURRENT_SELECTION.target,
    });
  });

  it("confines HOME, CODEX_HOME, TMPDIR, and PATH side effects to one cleaned probe root", () => {
    const ambient = createAmbientProbeFixture();
    const captureRoot = mkdtempSync(join(tmpdir(), "ctc-probe-capture-"));
    const capturePath = join(captureRoot, "environment.txt");
    try {
      const executablePath = installFakeCandidate(CURRENT_SELECTION);
      writeExecutableBody(
        executablePath,
        probeEnvironmentCaptureBody(
          capturePath,
          `printf '%s\\n' '${TESTED_CODEX_VERSION}'`,
        ),
      );

      expect(resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toMatchObject({
        exactVersionOutput: TESTED_CODEX_VERSION,
        source: "OWNED_RELEASE",
      });
      expectCapturedProbeEnvironmentWasIsolated(capturePath, ambient);
    } finally {
      rmSync(captureRoot, { force: true, recursive: true });
    }
  });

  it("fails closed for a missing or non-executable binary", () => {
    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CANDIDATE_UNAVAILABLE" }),
    );

    const executablePath = installFakeCandidate(CURRENT_SELECTION);
    chmodSync(executablePath, 0o600);
    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_NOT_EXECUTABLE" }),
    );
  });

  it("fails closed on exact version mismatch", () => {
    installFakeCandidate(CURRENT_SELECTION, "codex-cli 0.148.0-alpha.8");
    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_VERSION_MISMATCH" }),
    );
  });

  it("rejects escape through the deterministic executable symlink", () => {
    const outsideExecutable = join(runtimeRoot, "outside-codex");
    writeFakeExecutable(outsideExecutable, TESTED_CODEX_VERSION);
    const candidatePath = deriveOwnedCodexExecutablePath(CURRENT_SELECTION, options);
    mkdirSync(join(candidatePath, ".."), { recursive: true });
    symlinkSync(outsideExecutable, candidatePath);

    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_PATH_ESCAPE" }),
    );
  });

  it("rejects runtime-root, releases-root, release-directory, and binary symlinks", () => {
    const actualRoot = mkdtempSync(join(tmpdir(), "ctc-owned-codex-actual-"));
    const linkedRoot = `${actualRoot}-link`;
    symlinkSync(actualRoot, linkedRoot);
    expect(() =>
      deriveOwnedCodexExecutablePath(CURRENT_SELECTION, {
        trustedRuntimeRoot: linkedRoot,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRUSTED_RUNTIME_ROOT" }));
    unlinkSync(linkedRoot);
    rmSync(actualRoot, { recursive: true });

    const releasesPath = join(
      runtimeRoot,
      "standalone-home",
      "packages",
      "standalone",
      "releases",
    );
    const outsideReleases = mkdtempSync(join(tmpdir(), "ctc-outside-releases-"));
    mkdirSync(join(releasesPath, ".."), { recursive: true });
    symlinkSync(outsideReleases, releasesPath);
    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_PATH_ESCAPE" }),
    );
    unlinkSync(releasesPath);
    rmSync(outsideReleases, { recursive: true });

    const executablePath = installFakeCandidate(CURRENT_SELECTION);
    const releasePath = join(executablePath, "..", "..");
    const realReleasePath = `${releasePath}-real`;
    renameSync(releasePath, realReleasePath);
    symlinkSync(realReleasePath, releasePath);
    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_PATH_ESCAPE" }),
    );
  });

  it("fails closed when the executable inode is replaced during --version", () => {
    const executablePath = installFakeCandidate(CURRENT_SELECTION);
    const replacementPath = `${executablePath}.replacement`;
    writeFakeExecutable(replacementPath, TESTED_CODEX_VERSION);
    writeExecutableBody(
      executablePath,
      [
        `/bin/mv '${replacementPath}' '${executablePath}'`,
        `printf '%s\\n' '${TESTED_CODEX_VERSION}'`,
      ].join("\n"),
    );

    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_VERSION_CHECK_FAILED" }),
    );
  });

  it("fails closed when the runtime root is replaced during --version", () => {
    const executablePath = installFakeCandidate(CURRENT_SELECTION);
    const replacementRoot = `${runtimeRoot}.replacement`;
    const displacedRoot = `${runtimeRoot}.displaced`;
    mkdirSync(replacementRoot);
    const replacementExecutable = join(
      replacementRoot,
      "standalone-home",
      "packages",
      "standalone",
      "releases",
      `${CURRENT_SELECTION.version}-${CURRENT_SELECTION.target}`,
      "bin",
      "codex",
    );
    mkdirSync(join(replacementExecutable, ".."), { recursive: true });
    writeFakeExecutable(replacementExecutable, TESTED_CODEX_VERSION);
    writeExecutableBody(
      executablePath,
      [
        `/bin/mv '${runtimeRoot}' '${displacedRoot}'`,
        `/bin/mv '${replacementRoot}' '${runtimeRoot}'`,
        `printf '%s\\n' '${TESTED_CODEX_VERSION}'`,
      ].join("\n"),
    );

    expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_VERSION_CHECK_FAILED" }),
    );
    rmSync(runtimeRoot, { force: true, recursive: true });
    renameSync(displacedRoot, runtimeRoot);
  });

  it("accepts one optional LF or CRLF and rejects all other stdout shapes", () => {
    const executablePath = installFakeCandidate(CURRENT_SELECTION);
    for (const body of [
      `printf '%s' '${TESTED_CODEX_VERSION}'`,
      `printf '%s\\n' '${TESTED_CODEX_VERSION}'`,
      `printf '%s\\r\\n' '${TESTED_CODEX_VERSION}'`,
    ]) {
      writeExecutableBody(executablePath, body);
      expect(resolveOwnedCodexCandidate(CURRENT_SELECTION, options).exactVersionOutput).toBe(
        TESTED_CODEX_VERSION,
      );
    }

    for (const body of [
      `printf ' %s\\n' '${TESTED_CODEX_VERSION}'`,
      `printf '%s \\n' '${TESTED_CODEX_VERSION}'`,
      `printf '%s\\nextra\\n' '${TESTED_CODEX_VERSION}'`,
      `printf '%s\\n\\n' '${TESTED_CODEX_VERSION}'`,
    ]) {
      writeExecutableBody(executablePath, body);
      expect(() => resolveOwnedCodexCandidate(CURRENT_SELECTION, options)).toThrowError(
        expect.objectContaining({ code: "RUNTIME_VERSION_MISMATCH" }),
      );
    }
  });

  it.each([
    {
      body: "printf 'private diagnostic' >&2\nexit 7",
      expectedCode: "RUNTIME_VERSION_CHECK_FAILED",
      scenario: "nonzero exit",
    },
    {
      body: "kill -TERM $$",
      expectedCode: "RUNTIME_VERSION_CHECK_FAILED",
      scenario: "signal",
    },
    {
      body: "/bin/sleep 10",
      expectedCode: "RUNTIME_VERSION_CHECK_FAILED",
      scenario: "timeout",
    },
    {
      body: "/usr/bin/yes x | /usr/bin/head -c 8192",
      expectedCode: "RUNTIME_VERSION_CHECK_FAILED",
      scenario: "oversized output",
    },
    {
      body: "printf '%s\\n' 'codex-cli 0.148.0-alpha.8'",
      expectedCode: "RUNTIME_VERSION_MISMATCH",
      scenario: "wrong version",
    },
  ])(
    "sanitizes $scenario and cleans its isolated probe state",
    ({ body, expectedCode }) => {
      const ambient = createAmbientProbeFixture();
      const captureRoot = mkdtempSync(join(tmpdir(), "ctc-probe-capture-"));
      const capturePath = join(captureRoot, "environment.txt");
      try {
        const executablePath = installFakeCandidate(CURRENT_SELECTION);
        writeExecutableBody(
          executablePath,
          probeEnvironmentCaptureBody(capturePath, body),
        );
        expectSanitizedVersionCheckFailure(executablePath, expectedCode);
        expectCapturedProbeEnvironmentWasIsolated(capturePath, ambient);
      } finally {
        rmSync(captureRoot, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it("executes a confined candidate whose path contains shell metacharacters literally", () => {
    const metacharacterRoot = mkdtempSync(join(tmpdir(), "ctc runtime ;$() "));
    const metacharacterOptions = { trustedRuntimeRoot: metacharacterRoot };
    const previousRoot = runtimeRoot;
    const previousOptions = options;
    runtimeRoot = metacharacterRoot;
    options = metacharacterOptions;
    try {
      installFakeCandidate(CURRENT_SELECTION);
      expect(resolveOwnedCodexCandidate(CURRENT_SELECTION, options).releaseVersion).toBe(
        CURRENT_SELECTION.version,
      );
    } finally {
      runtimeRoot = previousRoot;
      options = previousOptions;
      rmSync(metacharacterRoot, { force: true, recursive: true });
    }
  });

  it("rejects hostile version and target input before path derivation", () => {
    expect(() =>
      deriveOwnedCodexExecutablePath(
        { ...CURRENT_SELECTION, version: "../../Applications/ChatGPT.app" },
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RUNTIME_SELECTION" }));
    expect(() =>
      deriveOwnedCodexExecutablePath(
        {
          ...CURRENT_SELECTION,
          target: "../aarch64-apple-darwin",
        } as unknown as CodexRuntimeSelection,
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RUNTIME_SELECTION" }));
  });
});

describe("owned Codex selector parsing", () => {
  it("treats a missing selector as no active or previous runtime", () => {
    const missing = readOwnedCodexRuntimeSelector(options);
    expect(missing).toEqual({
      active: null,
      previous: null,
      schemaVersion: 1,
    });
    (missing as { active: CodexRuntimeSelection | null }).active = CURRENT_SELECTION;
    expect(readOwnedCodexRuntimeSelector(options).active).toBeNull();
  });

  it("parses only the exact selector schema", () => {
    writeSelectorFixture({
      active: CURRENT_SELECTION,
      previous: null,
      schemaVersion: 1,
    });
    expect(readOwnedCodexRuntimeSelector(options)).toEqual({
      active: CURRENT_SELECTION,
      previous: null,
      schemaVersion: 1,
    });
  });

  it.each([
    "not json",
    JSON.stringify({ active: null, previous: null, schemaVersion: 1, token: "no" }),
    JSON.stringify({
      active: { target: CURRENT_SELECTION.target, version: "/absolute/codex" },
      previous: null,
      schemaVersion: 1,
    }),
    JSON.stringify({
      active: { target: "unsupported-target", version: CURRENT_SELECTION.version },
      previous: null,
      schemaVersion: 1,
    }),
    JSON.stringify({
      active: { ...CURRENT_SELECTION, command: "codex app-server" },
      previous: null,
      schemaVersion: 1,
    }),
  ])("rejects malformed, extended, or path-bearing selector input", (contents) => {
    writeFileSync(join(runtimeRoot, "active.json"), contents, { encoding: "utf8" });
    expect(() => readOwnedCodexRuntimeSelector(options)).toThrowError(
      expect.objectContaining({ code: "INVALID_SELECTOR" }),
    );
  });

  it("rejects invalid UTF-8, oversized, blank, trailing, duplicate, and aliased selectors", () => {
    const selectorPath = join(runtimeRoot, "active.json");
    const invalidSelectors: Array<string | Buffer> = [
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(4_097, 0x20),
      "",
      `${JSON.stringify({ active: null, previous: null, schemaVersion: 1 })} trailing`,
      '{"schemaVersion":1,"active":null,"active":null,"previous":null}',
      '{"schemaVersion":1,"active":{"version":"0.148.0-alpha.9","version":"0.148.0-alpha.9","target":"aarch64-apple-darwin"},"previous":null}',
      JSON.stringify({
        active: CURRENT_SELECTION,
        previous: CURRENT_SELECTION,
        schemaVersion: 1,
      }),
    ];

    for (const contents of invalidSelectors) {
      writeFileSync(selectorPath, contents, { mode: 0o600 });
      expect(() => readOwnedCodexRuntimeSelector(options)).toThrowError(
        expect.objectContaining({ code: "INVALID_SELECTOR" }),
      );
    }
  });

  it("rejects selector symlinks, directories, and FIFOs without following or blocking", () => {
    const selectorPath = join(runtimeRoot, "active.json");
    const outsideSelector = join(runtimeRoot, "outside-selector.json");
    writeFileSync(
      outsideSelector,
      `${JSON.stringify({ active: null, previous: null, schemaVersion: 1 })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    symlinkSync(outsideSelector, selectorPath);
    expect(() => readOwnedCodexRuntimeSelector(options)).toThrowError(
      expect.objectContaining({ code: "INVALID_SELECTOR" }),
    );

    unlinkSync(selectorPath);
    mkdirSync(selectorPath);
    expect(() => readOwnedCodexRuntimeSelector(options)).toThrowError(
      expect.objectContaining({ code: "INVALID_SELECTOR" }),
    );

    rmSync(selectorPath, { recursive: true });
    const fifoResult = spawnSync("mkfifo", [selectorPath], { encoding: "utf8" });
    expect(fifoResult.status).toBe(0);
    expect(() => readOwnedCodexRuntimeSelector(options)).toThrowError(
      expect.objectContaining({ code: "INVALID_SELECTOR" }),
    );
  });
});

describe("owned Codex activation and rollback", () => {
  it("atomically activates, advances previous, and preserves an exact no-op", () => {
    installFakeCandidate(CURRENT_SELECTION);
    installFakeCandidate(NEXT_SELECTION);

    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    expect(readOwnedCodexRuntimeSelector(options)).toEqual({
      active: CURRENT_SELECTION,
      previous: null,
      schemaVersion: 1,
    });
    expect(lstatSync(join(runtimeRoot, "active.json")).mode & 0o777).toBe(0o600);

    activateOwnedCodexRuntime(NEXT_SELECTION, options);
    expect(readOwnedCodexRuntimeSelector(options)).toEqual({
      active: NEXT_SELECTION,
      previous: CURRENT_SELECTION,
      schemaVersion: 1,
    });
    const beforeNoOp = readFileSync(join(runtimeRoot, "active.json"), "utf8");
    activateOwnedCodexRuntime(NEXT_SELECTION, options);
    expect(readFileSync(join(runtimeRoot, "active.json"), "utf8")).toBe(beforeNoOp);
  });

  it("does not corrupt the existing selector when its atomic write fails", () => {
    installFakeCandidate(CURRENT_SELECTION);
    installFakeCandidate(NEXT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    const beforeFailure = readFileSync(join(runtimeRoot, "active.json"), "utf8");

    chmodSync(runtimeRoot, 0o500);
    expect(() => activateOwnedCodexRuntime(NEXT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "SELECTOR_WRITE_FAILED" }),
    );
    expect(readFileSync(join(runtimeRoot, "active.json"), "utf8")).toBe(beforeFailure);
    expect(
      readdirSync(runtimeRoot).filter(
        (name) => name.includes(".active.json.") || name === ".active.lock",
      ),
    ).toEqual([]);
  });

  it("fails closed under mutation-lock contention without changing the selector", () => {
    installFakeCandidate(CURRENT_SELECTION);
    installFakeCandidate(NEXT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    const selectorPath = join(runtimeRoot, "active.json");
    const beforeContention = readFileSync(selectorPath, "utf8");
    const lockPath = join(runtimeRoot, ".active.lock");
    writeFileSync(lockPath, "", { mode: 0o600 });

    expect(() => activateOwnedCodexRuntime(NEXT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "SELECTOR_MUTATION_BUSY" }),
    );
    expect(() => rollbackOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "SELECTOR_MUTATION_BUSY" }),
    );
    expect(readFileSync(selectorPath, "utf8")).toBe(beforeContention);
    unlinkSync(lockPath);
  });

  it("keeps the private directory and selector modes and removes mutation artifacts", () => {
    installFakeCandidate(CURRENT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);

    expect(lstatSync(runtimeRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(runtimeRoot, "active.json")).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(runtimeRoot).filter(
        (name) => name.includes(".active.json.") || name === ".active.lock",
      ),
    ).toEqual([]);
  });

  it("does not mutate the selector before a new activation candidate verifies", () => {
    installFakeCandidate(CURRENT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    const selectorPath = join(runtimeRoot, "active.json");
    const beforeFailure = readFileSync(selectorPath, "utf8");

    expect(() => activateOwnedCodexRuntime(NEXT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CANDIDATE_UNAVAILABLE" }),
    );
    expect(readFileSync(selectorPath, "utf8")).toBe(beforeFailure);

    installFakeCandidate(NEXT_SELECTION, "codex-cli 0.148.0-alpha.8");
    expect(() => activateOwnedCodexRuntime(NEXT_SELECTION, options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_VERSION_MISMATCH" }),
    );
    expect(readFileSync(selectorPath, "utf8")).toBe(beforeFailure);
  });

  it("rolls back only after verifying and atomically swapping previous", () => {
    installFakeCandidate(CURRENT_SELECTION);
    installFakeCandidate(NEXT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    activateOwnedCodexRuntime(NEXT_SELECTION, options);

    expect(rollbackOwnedCodexRuntime(options).releaseVersion).toBe(
      CURRENT_SELECTION.version,
    );
    expect(readOwnedCodexRuntimeSelector(options)).toEqual({
      active: CURRENT_SELECTION,
      previous: NEXT_SELECTION,
      schemaVersion: 1,
    });
  });

  it("fails rollback with no previous runtime", () => {
    expect(() => rollbackOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "NO_PREVIOUS_RUNTIME" }),
    );
  });

  it("preserves the selector when previous is missing or version-mismatched", () => {
    installFakeCandidate(CURRENT_SELECTION);
    writeSelectorFixture({
      active: CURRENT_SELECTION,
      previous: NEXT_SELECTION,
      schemaVersion: 1,
    });
    const missingBefore = readFileSync(join(runtimeRoot, "active.json"), "utf8");
    expect(() => rollbackOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CANDIDATE_UNAVAILABLE" }),
    );
    expect(readFileSync(join(runtimeRoot, "active.json"), "utf8")).toBe(missingBefore);

    installFakeCandidate(NEXT_SELECTION, "codex-cli 0.148.0-alpha.8");
    const mismatchBefore = readFileSync(join(runtimeRoot, "active.json"), "utf8");
    expect(() => rollbackOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_VERSION_MISMATCH" }),
    );
    expect(readFileSync(join(runtimeRoot, "active.json"), "utf8")).toBe(
      mismatchBefore,
    );
  });
});

describe("future execution resolution", () => {
  it("resolves only an active exact tested owned runtime", () => {
    installFakeCandidate(CURRENT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    expect(resolveActiveOwnedCodexRuntime(options)).toMatchObject({
      exactVersionOutput: TESTED_CODEX_VERSION,
      source: "OWNED_RELEASE",
    });
  });

  it("fails closed for no active runtime or an untested active version", () => {
    expect(() => resolveActiveOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_RUNTIME" }),
    );

    writeSelectorFixture({
      active: NEXT_SELECTION,
      previous: null,
      schemaVersion: 1,
    });
    expect(() => resolveActiveOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "ACTIVE_RUNTIME_VERSION_MISMATCH" }),
    );
  });

  it("fails closed when the tested active binary is missing or mismatched", () => {
    writeSelectorFixture({
      active: CURRENT_SELECTION,
      previous: null,
      schemaVersion: 1,
    });
    expect(() => resolveActiveOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_CANDIDATE_UNAVAILABLE" }),
    );

    installFakeCandidate(CURRENT_SELECTION, "codex-cli 0.148.0-alpha.8");
    expect(() => resolveActiveOwnedCodexRuntime(options)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_VERSION_MISMATCH" }),
    );
  });

  it("does not fall back to PATH when no owned runtime is active", () => {
    const pathBinaryDirectory = join(runtimeRoot, "ambient-bin");
    const ambientBinary = join(pathBinaryDirectory, "codex");
    mkdirSync(pathBinaryDirectory);
    writeFakeExecutable(ambientBinary, TESTED_CODEX_VERSION);
    process.env.PATH = `${pathBinaryDirectory}:${originalPath ?? ""}`;

    expect(() => resolveCodexExecutionRuntime(options)).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_RUNTIME" }),
    );
  });
});

describe("CTC_CODEX_BINARY development override", () => {
  it.each(["development", "test"])(
    "accepts the exact canonical tested executable in %s",
    (nodeEnvironment) => {
      process.env.NODE_ENV = nodeEnvironment;
      const overridePath = join(runtimeRoot, "development-codex");
      writeFakeExecutable(overridePath, TESTED_CODEX_VERSION);
      const canonicalOverridePath = realpathSync(overridePath);
      process.env.CTC_CODEX_BINARY = canonicalOverridePath;

      expect(resolveDevelopmentCodexOverride()).toMatchObject({
        canonicalExecutablePath: canonicalOverridePath,
        exactVersionOutput: TESTED_CODEX_VERSION,
        source: "DEVELOPMENT_OVERRIDE",
      });
      expect(resolveCodexExecutionRuntime(options).source).toBe(
        "DEVELOPMENT_OVERRIDE",
      );
    },
  );

  it("applies the same disposable environment to the development override", () => {
    const ambient = createAmbientProbeFixture();
    const captureRoot = mkdtempSync(join(tmpdir(), "ctc-probe-capture-"));
    const capturePath = join(captureRoot, "environment.txt");
    try {
      const overridePath = join(runtimeRoot, "development-codex");
      writeExecutableBody(
        overridePath,
        probeEnvironmentCaptureBody(
          capturePath,
          `printf '%s\\n' '${TESTED_CODEX_VERSION}'`,
        ),
      );
      process.env.CTC_CODEX_BINARY = realpathSync(overridePath);

      expect(resolveDevelopmentCodexOverride()).toMatchObject({
        exactVersionOutput: TESTED_CODEX_VERSION,
        source: "DEVELOPMENT_OVERRIDE",
      });
      expectCapturedProbeEnvironmentWasIsolated(capturePath, ambient);
    } finally {
      rmSync(captureRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlink even when its target is the exact tested executable", () => {
    const overridePath = join(runtimeRoot, "development-codex");
    writeFakeExecutable(overridePath, TESTED_CODEX_VERSION);
    const canonicalOverridePath = realpathSync(overridePath);
    const symlinkPath = join(realpathSync(runtimeRoot), "development-codex-link");
    symlinkSync(canonicalOverridePath, symlinkPath);
    process.env.CTC_CODEX_BINARY = symlinkPath;

    expect(() => resolveDevelopmentCodexOverride()).toThrowError(
      expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
    );
  });

  it("rejects relative, missing, and noncanonical override paths", () => {
    const overridePath = join(runtimeRoot, "canonical-codex");
    writeFakeExecutable(overridePath, TESTED_CODEX_VERSION);
    const canonicalOverridePath = realpathSync(overridePath);
    for (const invalidPath of [
      "relative/codex",
      join(tmpdir(), "missing-ctc-codex"),
      `${realpathSync(runtimeRoot)}/./canonical-codex`,
    ]) {
      expect(invalidPath).not.toBe(canonicalOverridePath);
      process.env.CTC_CODEX_BINARY = invalidPath;
      expect(() => resolveDevelopmentCodexOverride()).toThrowError(
        expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
      );
    }
  });

  it("rejects non-regular and non-executable canonical paths", () => {
    const directoryPath = join(realpathSync(runtimeRoot), "override-directory");
    mkdirSync(directoryPath);
    process.env.CTC_CODEX_BINARY = directoryPath;
    expect(() => resolveDevelopmentCodexOverride()).toThrowError(
      expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
    );

    const nonExecutablePath = join(runtimeRoot, "non-executable-codex");
    writeFakeExecutable(nonExecutablePath, TESTED_CODEX_VERSION);
    chmodSync(nonExecutablePath, 0o600);
    process.env.CTC_CODEX_BINARY = realpathSync(nonExecutablePath);
    expect(() => resolveDevelopmentCodexOverride()).toThrowError(
      expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
    );
  });

  it("cannot accept an alternate binary through caller-controlled version input", () => {
    const overridePath = join(runtimeRoot, "mismatched-development-codex");
    writeFakeExecutable(overridePath, "codex-cli 0.148.0-alpha.8");
    process.env.CTC_CODEX_BINARY = realpathSync(overridePath);

    expect(() =>
      Reflect.apply(resolveDevelopmentCodexOverride, undefined, [
        "codex-cli 0.148.0-alpha.8",
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
    );
    expect(() => resolveCodexExecutionRuntime(options)).toThrowError(
      expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
    );
  });

  it.each([undefined, "production", "staging", "Test"])(
    "rejects an arbitrary exact-version override outside a development/test environment: %s",
    (nodeEnvironment) => {
      const overridePath = join(runtimeRoot, "production-codex");
      writeFakeExecutable(overridePath, TESTED_CODEX_VERSION);
      process.env.CTC_CODEX_BINARY = realpathSync(overridePath);
      restoreEnvironmentVariable("NODE_ENV", nodeEnvironment);

      expect(() => resolveDevelopmentCodexOverride()).toThrowError(
        expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
      );
      expect(() => resolveCodexExecutionRuntime(options)).toThrowError(
        expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
      );
    },
  );

  it("never substitutes an owned or PATH runtime for an invalid override", () => {
    installFakeCandidate(CURRENT_SELECTION);
    activateOwnedCodexRuntime(CURRENT_SELECTION, options);
    const pathBinaryDirectory = join(runtimeRoot, "ambient-override-bin");
    const ambientBinary = join(pathBinaryDirectory, "codex");
    mkdirSync(pathBinaryDirectory);
    writeFakeExecutable(ambientBinary, TESTED_CODEX_VERSION);
    process.env.PATH = `${pathBinaryDirectory}:${originalPath ?? ""}`;
    process.env.CTC_CODEX_BINARY = "relative/invalid-override";

    expect(() => resolveCodexExecutionRuntime(options)).toThrowError(
      expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
    );
  });
});

function installFakeCandidate(
  selection: CodexRuntimeSelection,
  output = `codex-cli ${selection.version}`,
): string {
  const executablePath = deriveOwnedCodexExecutablePath(selection, options);
  mkdirSync(join(executablePath, ".."), { recursive: true });
  writeFakeExecutable(executablePath, output);
  return executablePath;
}

function writeFakeExecutable(path: string, output: string): void {
  writeExecutableBody(
    path,
    [
      '[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 9',
      `printf '%s\\n' '${output}'`,
    ].join("\n"),
  );
}

function writeExecutableBody(path: string, body: string): void {
  writeFileSync(
    path,
    ["#!/bin/sh", body, ""].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
}

function expectSanitizedVersionCheckFailure(
  executablePath: string,
  expectedCode = "RUNTIME_VERSION_CHECK_FAILED",
): void {
  try {
    resolveOwnedCodexCandidate(CURRENT_SELECTION, options);
    throw new Error("expected version check failure");
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: expectedCode });
    expect((error as Error).message).not.toContain("private diagnostic");
    expect((error as Error).message).not.toContain(executablePath);
  }
}

interface AmbientProbeFixture {
  readonly codexHome: string;
  readonly home: string;
  readonly pathDirectory: string;
}

function createAmbientProbeFixture(): AmbientProbeFixture {
  const fixture = {
    codexHome: join(runtimeRoot, "ambient-codex-home"),
    home: join(runtimeRoot, "ambient-home"),
    pathDirectory: join(runtimeRoot, "ambient-bin"),
  };
  mkdirSync(fixture.codexHome);
  mkdirSync(fixture.home);
  mkdirSync(fixture.pathDirectory);
  process.env.CODEX_HOME = fixture.codexHome;
  process.env.HOME = fixture.home;
  process.env.PATH = fixture.pathDirectory;
  return fixture;
}

function probeEnvironmentCaptureBody(
  capturePath: string,
  terminalBody: string,
): string {
  return [
    '/bin/mkdir -p "$HOME/.codex/tmp/arg0" "$CODEX_HOME/tmp/arg0" "$TMPDIR/arg0"',
    `printf '%s\\n' isolated > "$HOME/.codex/tmp/arg0/sentinel"`,
    `printf '%s\\n' isolated > "$CODEX_HOME/tmp/arg0/sentinel"`,
    `printf '%s\\n' isolated > "$TMPDIR/arg0/sentinel"`,
    `printf '%s\\n' "$HOME" "$CODEX_HOME" "$TMPDIR" "$PATH" > ${shellSingleQuote(capturePath)}`,
    terminalBody,
  ].join("\n");
}

function expectCapturedProbeEnvironmentWasIsolated(
  capturePath: string,
  ambient: AmbientProbeFixture,
): void {
  const [probeHome, probeCodexHome, probeTemporaryDirectory, probePath] =
    readFileSync(capturePath, "utf8").trimEnd().split("\n");
  expect(probeHome).toBeDefined();
  const probeRoot = dirname(probeHome as string);
  expect(probeHome).toBe(join(probeRoot, "home"));
  expect(probeCodexHome).toBe(join(probeRoot, "codex-home"));
  expect(probeTemporaryDirectory).toBe(join(probeRoot, "tmp"));
  expect(probePath).toBe(join(probeRoot, "bin"));
  expect(probeHome).not.toBe(ambient.home);
  expect(probeCodexHome).not.toBe(ambient.codexHome);
  expect(probePath).not.toContain(ambient.pathDirectory);
  expect(existsSync(join(ambient.home, ".codex", "tmp", "arg0", "sentinel"))).toBe(
    false,
  );
  expect(existsSync(join(ambient.codexHome, "tmp", "arg0", "sentinel"))).toBe(
    false,
  );
  expect(existsSync(probeRoot)).toBe(false);
  expect(existsSync(probeHome as string)).toBe(false);
  expect(existsSync(probeCodexHome as string)).toBe(false);
  expect(existsSync(probeTemporaryDirectory as string)).toBe(false);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeSelectorFixture(value: unknown): void {
  writeFileSync(join(runtimeRoot, "active.json"), `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
