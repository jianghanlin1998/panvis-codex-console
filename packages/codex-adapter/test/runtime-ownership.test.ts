import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
let originalNodeEnvironment: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "ctc-owned-codex-"));
  options = { trustedRuntimeRoot: runtimeRoot };
  originalBinaryOverride = process.env.CTC_CODEX_BINARY;
  originalNodeEnvironment = process.env.NODE_ENV;
  originalPath = process.env.PATH;
  process.env.NODE_ENV = "test";
  delete process.env.CTC_CODEX_BINARY;
});

afterEach(() => {
  restoreEnvironmentVariable("CTC_CODEX_BINARY", originalBinaryOverride);
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
  it("accepts only an absolute executable with the exact expected version", () => {
    const overridePath = join(runtimeRoot, "development-codex");
    writeFakeExecutable(overridePath, TESTED_CODEX_VERSION);
    process.env.CTC_CODEX_BINARY = overridePath;

    expect(resolveDevelopmentCodexOverride(TESTED_CODEX_VERSION)).toMatchObject({
      canonicalExecutablePath: realpathSync(overridePath),
      exactVersionOutput: TESTED_CODEX_VERSION,
      source: "DEVELOPMENT_OVERRIDE",
    });
    expect(resolveCodexExecutionRuntime(options).source).toBe("DEVELOPMENT_OVERRIDE");
  });

  it.each(["relative/codex", join(tmpdir(), "missing-ctc-codex")])(
    "rejects invalid override path %s",
    (overridePath) => {
      process.env.CTC_CODEX_BINARY = overridePath;
      expect(() => resolveDevelopmentCodexOverride(TESTED_CODEX_VERSION)).toThrowError(
        expect.objectContaining({ code: "DEVELOPMENT_OVERRIDE_INVALID" }),
      );
    },
  );

  it("rejects an override version mismatch without weakening the expected version", () => {
    const overridePath = join(runtimeRoot, "mismatched-development-codex");
    writeFakeExecutable(overridePath, "codex-cli 0.148.0-alpha.8");
    process.env.CTC_CODEX_BINARY = overridePath;
    expect(() => resolveDevelopmentCodexOverride(TESTED_CODEX_VERSION)).toThrowError(
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
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      '[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 9',
      `printf '%s\\n' '${output}'`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
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
