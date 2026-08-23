import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { TESTED_CODEX_VERSION } from "./compatibility.js";

const RELEASE_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha(?:\.[0-9]+){0,2}|beta(?:\.[0-9]+)?))?$/;
const VERSION_CHECK_TIMEOUT_MILLISECONDS = 5_000;
const VERSION_OUTPUT_MAX_BYTES = 4_096;
const SELECTOR_MAX_BYTES = 4_096;
const PRIVATE_DIRECTORY_FORBIDDEN_MODE = 0o077;
const SELECTOR_MUTATION_LOCK_NAME = ".active.lock";

export const CODEX_RUNTIME_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
] as const;

export type CodexRuntimeTarget = (typeof CODEX_RUNTIME_TARGETS)[number];

export interface CodexRuntimeSelection {
  readonly target: CodexRuntimeTarget;
  readonly version: string;
}

export interface CodexRuntimeSelector {
  readonly active: CodexRuntimeSelection | null;
  readonly previous: CodexRuntimeSelection | null;
  readonly schemaVersion: 1;
}

export interface ResolvedCodexRuntime {
  readonly canonicalExecutablePath: string;
  readonly exactVersionOutput: string;
  readonly executable: true;
  readonly readable: true;
  readonly releaseVersion: string;
  readonly source: "DEVELOPMENT_OVERRIDE" | "OWNED_RELEASE";
  readonly target: CodexRuntimeTarget;
}

export interface CodexRuntimeOwnershipOptions {
  /** Test-only override. Production operations always use the platform default. */
  readonly trustedRuntimeRoot?: string;
}

export const CODEX_RUNTIME_OWNERSHIP_ERROR_CODES = [
  "ACTIVE_RUNTIME_VERSION_MISMATCH",
  "DEVELOPMENT_OVERRIDE_INVALID",
  "INVALID_RUNTIME_SELECTION",
  "INVALID_SELECTOR",
  "INVALID_TRUSTED_RUNTIME_ROOT",
  "NO_ACTIVE_RUNTIME",
  "NO_PREVIOUS_RUNTIME",
  "RUNTIME_CANDIDATE_UNAVAILABLE",
  "RUNTIME_NOT_EXECUTABLE",
  "RUNTIME_PATH_ESCAPE",
  "RUNTIME_VERSION_CHECK_FAILED",
  "RUNTIME_VERSION_MISMATCH",
  "SELECTOR_MUTATION_BUSY",
  "SELECTOR_WRITE_FAILED",
  "UNSUPPORTED_RUNTIME_PLATFORM",
] as const;

export type CodexRuntimeOwnershipErrorCode =
  (typeof CODEX_RUNTIME_OWNERSHIP_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<CodexRuntimeOwnershipErrorCode, string>> = {
  ACTIVE_RUNTIME_VERSION_MISMATCH:
    "The active owned Codex runtime is not the exact tested version.",
  DEVELOPMENT_OVERRIDE_INVALID:
    "CTC_CODEX_BINARY is available only in development or test and must name an absolute executable with the exact tested version.",
  INVALID_RUNTIME_SELECTION: "The owned Codex runtime selection is invalid.",
  INVALID_SELECTOR: "The owned Codex runtime selector is invalid.",
  INVALID_TRUSTED_RUNTIME_ROOT: "The trusted Codex runtime root override is invalid.",
  NO_ACTIVE_RUNTIME: "No owned Codex runtime is active.",
  NO_PREVIOUS_RUNTIME: "No previous owned Codex runtime is available for rollback.",
  RUNTIME_CANDIDATE_UNAVAILABLE: "The owned Codex runtime candidate is unavailable.",
  RUNTIME_NOT_EXECUTABLE: "The Codex runtime candidate is not a regular executable file.",
  RUNTIME_PATH_ESCAPE: "The Codex runtime candidate escapes the owned runtime root.",
  RUNTIME_VERSION_CHECK_FAILED: "The bounded Codex runtime version check failed.",
  RUNTIME_VERSION_MISMATCH: "The Codex runtime candidate reported an unexpected version.",
  SELECTOR_MUTATION_BUSY:
    "Another owned Codex runtime selector mutation is already in progress.",
  SELECTOR_WRITE_FAILED: "The owned Codex runtime selector could not be replaced atomically.",
  UNSUPPORTED_RUNTIME_PLATFORM: "The current platform has no supported Codex runtime target.",
};

export class CodexRuntimeOwnershipError extends Error {
  public readonly code: CodexRuntimeOwnershipErrorCode;

  public constructor(code: CodexRuntimeOwnershipErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexRuntimeOwnershipError";
    this.code = code;
  }
}

let selectorWriteSequence = 0;

export function getDefaultCodexRuntimeRoot(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string {
  if (platform !== "darwin") {
    throw new CodexRuntimeOwnershipError("UNSUPPORTED_RUNTIME_PLATFORM");
  }

  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "Codex Task Console",
    "codex-runtime",
  );
}

export function getCodexRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): CodexRuntimeTarget {
  const mapping = `${platform}:${architecture}`;
  switch (mapping) {
    case "darwin:arm64":
      return "aarch64-apple-darwin";
    case "darwin:x64":
      return "x86_64-apple-darwin";
    case "linux:arm64":
      return "aarch64-unknown-linux-musl";
    case "linux:x64":
      return "x86_64-unknown-linux-musl";
    default:
      throw new CodexRuntimeOwnershipError("UNSUPPORTED_RUNTIME_PLATFORM");
  }
}

export function deriveOwnedCodexExecutablePath(
  selection: CodexRuntimeSelection,
  options: CodexRuntimeOwnershipOptions = {},
): string {
  assertSelection(selection);
  const runtimeRoot = resolveRuntimeRoot(options);
  return join(
    releasesRoot(runtimeRoot),
    `${selection.version}-${selection.target}`,
    "bin",
    "codex",
  );
}

export function resolveOwnedCodexCandidate(
  selection: CodexRuntimeSelection,
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
  assertSelection(selection);
  const runtimeRoot = resolveRuntimeRoot(options);
  const ownedReleasesRoot = releasesRoot(runtimeRoot);
  const executablePath = join(
    ownedReleasesRoot,
    `${selection.version}-${selection.target}`,
    "bin",
    "codex",
  );

  let canonicalRuntimeRoot: string;
  let canonicalReleasesRoot: string;
  let canonicalExecutablePath: string;
  try {
    assertPrivateRuntimeDirectory(runtimeRoot, "RUNTIME_PATH_ESCAPE");
    assertOwnedPathHasNoSymlinks(runtimeRoot, executablePath);
    canonicalRuntimeRoot = realpathSync(runtimeRoot);
    canonicalReleasesRoot = realpathSync(ownedReleasesRoot);
    canonicalExecutablePath = realpathSync(executablePath);
  } catch (error: unknown) {
    if (error instanceof CodexRuntimeOwnershipError) {
      throw error;
    }
    throw new CodexRuntimeOwnershipError("RUNTIME_CANDIDATE_UNAVAILABLE");
  }

  if (
    !isStrictDescendant(canonicalReleasesRoot, canonicalRuntimeRoot) ||
    !isStrictDescendant(canonicalExecutablePath, canonicalReleasesRoot)
  ) {
    throw new CodexRuntimeOwnershipError("RUNTIME_PATH_ESCAPE");
  }

  let pathIdentities: ObservedOwnedPathIdentity[];
  try {
    pathIdentities = observeOwnedPathIdentities(runtimeRoot, executablePath);
  } catch {
    throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_CHECK_FAILED");
  }
  const resolved = verifyExecutable(
    canonicalExecutablePath,
    selection.version,
    selection.target,
    "OWNED_RELEASE",
  );
  assertOwnedPathIdentitiesStable(pathIdentities);
  return resolved;
}

export function readOwnedCodexRuntimeSelector(
  options: CodexRuntimeOwnershipOptions = {},
): CodexRuntimeSelector {
  const runtimeRoot = resolveRuntimeRoot(options);
  const selectorPath = join(runtimeRoot, "active.json");
  let descriptor: number | undefined;
  let runtimeRootIdentity: FileIdentity;
  try {
    const rootStat = lstatSync(runtimeRoot, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (rootStat.mode & BigInt(PRIVATE_DIRECTORY_FORBIDDEN_MODE)) !== 0n
    ) {
      throw new Error("insecure runtime directory");
    }
    runtimeRootIdentity = fileIdentity(rootStat);
    descriptor = openSync(
      selectorPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { active: null, previous: null, schemaVersion: 1 };
    }
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }

  let value: unknown;
  let selectorReadFailed = false;
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    if (!beforeRead.isFile() || beforeRead.size > BigInt(SELECTOR_MAX_BYTES)) {
      throw new Error("invalid selector file");
    }
    const bytes = Buffer.alloc(SELECTOR_MAX_BYTES + 1);
    const bytesRead = readSync(descriptor, bytes, 0, bytes.length, 0);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(selectorPath, { bigint: true });
    const rootAfter = lstatSync(runtimeRoot, { bigint: true });
    if (
      bytesRead > SELECTOR_MAX_BYTES ||
      !sameFileIdentity(fileIdentity(beforeRead), fileIdentity(afterRead)) ||
      !sameFileIdentity(fileIdentity(afterRead), fileIdentity(pathAfter)) ||
      !sameFileIdentity(runtimeRootIdentity, fileIdentity(rootAfter)) ||
      afterRead.size !== BigInt(bytesRead)
    ) {
      throw new Error("unstable selector file");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
    assertJsonObjectKeysAreUnique(text);
    value = JSON.parse(text) as unknown;
  } catch {
    selectorReadFailed = true;
  }
  try {
    closeSync(descriptor);
  } catch {
    selectorReadFailed = true;
  }
  if (selectorReadFailed) {
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }

  if (!isExactRecord(value, ["active", "previous", "schemaVersion"])) {
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }
  if (value.schemaVersion !== 1) {
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }

  const active = parseSelectorSelection(value.active);
  const previous = parseSelectorSelection(value.previous);
  if (active !== null && previous !== null && sameSelection(active, previous)) {
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }
  return { active, previous, schemaVersion: 1 };
}

export function activateOwnedCodexRuntime(
  selection: CodexRuntimeSelection,
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
  return withSelectorMutationLock(options, (runtimeRoot, runtimeRootIdentity) => {
    const candidate = resolveOwnedCodexCandidate(selection, options);
    const current = readOwnedCodexRuntimeSelector(options);

    if (sameSelection(current.active, selection)) {
      return candidate;
    }

    writeSelector(
      {
        active: selection,
        previous: current.active,
        schemaVersion: 1,
      },
      runtimeRoot,
      runtimeRootIdentity,
    );
    return candidate;
  });
}

export function rollbackOwnedCodexRuntime(
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
  return withSelectorMutationLock(options, (runtimeRoot, runtimeRootIdentity) => {
    const current = readOwnedCodexRuntimeSelector(options);
    if (current.previous === null) {
      throw new CodexRuntimeOwnershipError("NO_PREVIOUS_RUNTIME");
    }

    const previousRuntime = resolveOwnedCodexCandidate(current.previous, options);
    writeSelector(
      {
        active: current.previous,
        previous: current.active,
        schemaVersion: 1,
      },
      runtimeRoot,
      runtimeRootIdentity,
    );
    return previousRuntime;
  });
}

export function resolveActiveOwnedCodexRuntime(
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
  const selector = readOwnedCodexRuntimeSelector(options);
  if (selector.active === null) {
    throw new CodexRuntimeOwnershipError("NO_ACTIVE_RUNTIME");
  }

  const testedReleaseVersion = releaseVersionFromExactOutput(TESTED_CODEX_VERSION);
  if (selector.active.version !== testedReleaseVersion) {
    throw new CodexRuntimeOwnershipError("ACTIVE_RUNTIME_VERSION_MISMATCH");
  }

  return resolveOwnedCodexCandidate(selector.active, options);
}

export function resolveDevelopmentCodexOverride(
  expectedVersionOutput: string,
): ResolvedCodexRuntime {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    throw new CodexRuntimeOwnershipError("DEVELOPMENT_OVERRIDE_INVALID");
  }
  const overridePath = process.env.CTC_CODEX_BINARY;
  const expectedReleaseVersion = releaseVersionFromExactOutput(expectedVersionOutput);
  if (overridePath === undefined || !isAbsolute(overridePath)) {
    throw new CodexRuntimeOwnershipError("DEVELOPMENT_OVERRIDE_INVALID");
  }

  let canonicalExecutablePath: string;
  try {
    canonicalExecutablePath = realpathSync(overridePath);
  } catch {
    throw new CodexRuntimeOwnershipError("DEVELOPMENT_OVERRIDE_INVALID");
  }

  try {
    return verifyExecutable(
      canonicalExecutablePath,
      expectedReleaseVersion,
      getCodexRuntimeTarget(),
      "DEVELOPMENT_OVERRIDE",
    );
  } catch {
    throw new CodexRuntimeOwnershipError("DEVELOPMENT_OVERRIDE_INVALID");
  }
}

export function resolveCodexExecutionRuntime(
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
  if (process.env.CTC_CODEX_BINARY !== undefined) {
    return resolveDevelopmentCodexOverride(TESTED_CODEX_VERSION);
  }
  return resolveActiveOwnedCodexRuntime(options);
}

function resolveRuntimeRoot(options: CodexRuntimeOwnershipOptions): string {
  if (options.trustedRuntimeRoot === undefined) {
    return getDefaultCodexRuntimeRoot();
  }

  if (process.env.NODE_ENV !== "test" || !isAbsolute(options.trustedRuntimeRoot)) {
    throw new CodexRuntimeOwnershipError("INVALID_TRUSTED_RUNTIME_ROOT");
  }

  let canonicalTemporaryRoot: string;
  let canonicalOverride: string;
  try {
    const overrideStat = lstatSync(options.trustedRuntimeRoot);
    if (!overrideStat.isDirectory() || overrideStat.isSymbolicLink()) {
      throw new Error("invalid root override");
    }
    canonicalTemporaryRoot = realpathSync(tmpdir());
    canonicalOverride = realpathSync(options.trustedRuntimeRoot);
  } catch {
    throw new CodexRuntimeOwnershipError("INVALID_TRUSTED_RUNTIME_ROOT");
  }

  if (!isStrictDescendant(canonicalOverride, canonicalTemporaryRoot)) {
    throw new CodexRuntimeOwnershipError("INVALID_TRUSTED_RUNTIME_ROOT");
  }
  return canonicalOverride;
}

function releasesRoot(runtimeRoot: string): string {
  return join(
    runtimeRoot,
    "standalone-home",
    "packages",
    "standalone",
    "releases",
  );
}

function assertSelection(value: unknown): asserts value is CodexRuntimeSelection {
  if (
    !isExactRecord(value, ["target", "version"]) ||
    typeof value.version !== "string" ||
    !RELEASE_VERSION_PATTERN.test(value.version) ||
    !isRuntimeTarget(value.target)
  ) {
    throw new CodexRuntimeOwnershipError("INVALID_RUNTIME_SELECTION");
  }
}

function parseSelectorSelection(value: unknown): CodexRuntimeSelection | null {
  if (value === null) {
    return null;
  }
  try {
    assertSelection(value);
  } catch {
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }
  return value;
}

function verifyExecutable(
  canonicalExecutablePath: string,
  expectedReleaseVersion: string,
  target: CodexRuntimeTarget,
  source: ResolvedCodexRuntime["source"],
): ResolvedCodexRuntime {
  let descriptor: number | undefined;
  let observedIdentity: FileIdentity;
  try {
    descriptor = openSync(
      canonicalExecutablePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(canonicalExecutablePath, { bigint: true });
    if (
      !descriptorStat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !sameFileIdentity(fileIdentity(descriptorStat), fileIdentity(pathStat))
    ) {
      throw new CodexRuntimeOwnershipError("RUNTIME_NOT_EXECUTABLE");
    }
    observedIdentity = fileIdentity(descriptorStat);
    accessSync(canonicalExecutablePath, constants.R_OK | constants.X_OK);
  } catch (error: unknown) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the sanitized executable failure.
      }
    }
    if (error instanceof CodexRuntimeOwnershipError) {
      throw error;
    }
    throw new CodexRuntimeOwnershipError("RUNTIME_NOT_EXECUTABLE");
  }

  try {
    const result = spawnSync(canonicalExecutablePath, ["--version"], {
      encoding: "utf8",
      maxBuffer: VERSION_OUTPUT_MAX_BYTES,
      shell: false,
      stdio: "pipe",
      timeout: VERSION_CHECK_TIMEOUT_MILLISECONDS,
    });
    if (result.error !== undefined || result.signal !== null || result.status !== 0) {
      throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_CHECK_FAILED");
    }

    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(canonicalExecutablePath, { bigint: true });
    if (
      !sameFileIdentity(observedIdentity, fileIdentity(descriptorAfter)) ||
      !sameFileIdentity(observedIdentity, fileIdentity(pathAfter))
    ) {
      throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_CHECK_FAILED");
    }

    const exactVersionOutput = removeOneTrailingLineEnding(result.stdout);
    const expectedOutput = `codex-cli ${expectedReleaseVersion}`;
    if (exactVersionOutput !== expectedOutput) {
      throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_MISMATCH");
    }

    closeSync(descriptor);
    descriptor = undefined;
    return {
      canonicalExecutablePath,
      exactVersionOutput,
      executable: true,
      readable: true,
      releaseVersion: expectedReleaseVersion,
      source,
      target,
    };
  } catch (error: unknown) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the sanitized version or identity failure.
      }
    }
    if (error instanceof CodexRuntimeOwnershipError) {
      throw error;
    }
    throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_CHECK_FAILED");
  }
}

function writeSelector(
  selector: CodexRuntimeSelector,
  runtimeRoot: string,
  runtimeRootIdentity: FileIdentity,
): void {
  const selectorPath = join(runtimeRoot, "active.json");
  selectorWriteSequence += 1;
  const temporaryPath = join(
    runtimeRoot,
    `.active.json.${process.pid}.${selectorWriteSequence}.tmp`,
  );
  let descriptor: number | undefined;

  try {
    assertPathIdentity(
      runtimeRoot,
      runtimeRootIdentity,
      "SELECTOR_WRITE_FAILED",
    );
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(selector, null, 2)}\n`, {
      encoding: "utf8",
    });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertPathIdentity(
      runtimeRoot,
      runtimeRootIdentity,
      "SELECTOR_WRITE_FAILED",
    );
    renameSync(temporaryPath, selectorPath);
    assertPathIdentity(
      runtimeRoot,
      runtimeRootIdentity,
      "SELECTOR_WRITE_FAILED",
    );
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the sanitized selector-write failure.
      }
    }
    try {
      const currentRootIdentity = fileIdentity(
        lstatSync(runtimeRoot, { bigint: true }),
      );
      if (
        sameFileNodeIdentity(runtimeRootIdentity, currentRootIdentity) &&
        existsSync(temporaryPath)
      ) {
        unlinkSync(temporaryPath);
      }
    } catch {
      // Best-effort cleanup only when the runtime root still has the owned identity.
    }
    throw new CodexRuntimeOwnershipError("SELECTOR_WRITE_FAILED");
  }
}

function withSelectorMutationLock<T>(
  options: CodexRuntimeOwnershipOptions,
  operation: (runtimeRoot: string, runtimeRootIdentity: FileIdentity) => T,
): T {
  const runtimeRoot = resolveRuntimeRoot(options);
  const lockPath = join(runtimeRoot, SELECTOR_MUTATION_LOCK_NAME);
  let descriptor: number | undefined;
  let lockCreated = false;
  let runtimeRootIdentity: FileIdentity | undefined;
  try {
    runtimeRootIdentity = assertPrivateRuntimeDirectory(
      runtimeRoot,
      "SELECTOR_WRITE_FAILED",
    );
    descriptor = openSync(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    lockCreated = true;
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    assertPathIdentity(
      runtimeRoot,
      runtimeRootIdentity,
      "SELECTOR_WRITE_FAILED",
    );
  } catch (error: unknown) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the sanitized mutation-lock failure.
      }
    }
    if (lockCreated && runtimeRootIdentity !== undefined) {
      releaseSelectorMutationLock(lockPath, runtimeRoot, runtimeRootIdentity);
    }
    if (isNodeErrorWithCode(error, "EEXIST")) {
      throw new CodexRuntimeOwnershipError("SELECTOR_MUTATION_BUSY");
    }
    throw new CodexRuntimeOwnershipError("SELECTOR_WRITE_FAILED");
  }
  if (runtimeRootIdentity === undefined) {
    throw new CodexRuntimeOwnershipError("SELECTOR_WRITE_FAILED");
  }

  try {
    const result = operation(runtimeRoot, runtimeRootIdentity);
    assertPathIdentity(
      runtimeRoot,
      runtimeRootIdentity,
      "SELECTOR_WRITE_FAILED",
    );
    return result;
  } finally {
    releaseSelectorMutationLock(lockPath, runtimeRoot, runtimeRootIdentity);
  }
}

function releaseSelectorMutationLock(
  lockPath: string,
  runtimeRoot: string,
  runtimeRootIdentity: FileIdentity,
): void {
  try {
    const currentRootIdentity = fileIdentity(
      lstatSync(runtimeRoot, { bigint: true }),
    );
    if (!sameFileNodeIdentity(runtimeRootIdentity, currentRootIdentity)) {
      return;
    }
    unlinkSync(lockPath);
  } catch {
    // A retained lock fails future mutations closed rather than deleting an unowned lock.
  }
}

interface FileIdentity {
  readonly ctimeNanoseconds: bigint;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly size: bigint;
}

interface ObservedOwnedPathIdentity {
  readonly identity: FileIdentity;
  readonly path: string;
}

function fileIdentity(stats: BigIntStats): FileIdentity {
  return {
    ctimeNanoseconds: stats.ctimeNs,
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    modifiedNanoseconds: stats.mtimeNs,
    size: stats.size,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.ctimeNanoseconds === right.ctimeNanoseconds &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.size === right.size
  );
}

function sameFileNodeIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

function ownedPathComponents(runtimeRoot: string, executablePath: string): string[] {
  const relativeExecutablePath = relative(runtimeRoot, executablePath);
  if (
    relativeExecutablePath === "" ||
    relativeExecutablePath.startsWith("..") ||
    isAbsolute(relativeExecutablePath)
  ) {
    throw new CodexRuntimeOwnershipError("RUNTIME_PATH_ESCAPE");
  }

  const components = relativeExecutablePath.split(/[\\/]/u);
  const paths = [runtimeRoot];
  let current = runtimeRoot;
  for (const component of components) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

function assertOwnedPathHasNoSymlinks(
  runtimeRoot: string,
  executablePath: string,
): void {
  const paths = ownedPathComponents(runtimeRoot, executablePath);
  for (const [index, path] of paths.entries()) {
    const stats = lstatSync(path);
    const isExecutable = index === paths.length - 1;
    if (
      stats.isSymbolicLink() ||
      (isExecutable ? !stats.isFile() : !stats.isDirectory())
    ) {
      throw new CodexRuntimeOwnershipError("RUNTIME_PATH_ESCAPE");
    }
  }
}

function observeOwnedPathIdentities(
  runtimeRoot: string,
  executablePath: string,
): ObservedOwnedPathIdentity[] {
  return ownedPathComponents(runtimeRoot, executablePath).map((path) => ({
    identity: fileIdentity(lstatSync(path, { bigint: true })),
    path,
  }));
}

function assertOwnedPathIdentitiesStable(
  observations: readonly ObservedOwnedPathIdentity[],
): void {
  try {
    for (const observation of observations) {
      const after = fileIdentity(lstatSync(observation.path, { bigint: true }));
      if (!sameFileIdentity(observation.identity, after)) {
        throw new Error("owned path changed");
      }
    }
  } catch {
    throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_CHECK_FAILED");
  }
}

function assertPrivateRuntimeDirectory(
  runtimeRoot: string,
  errorCode: CodexRuntimeOwnershipErrorCode,
): FileIdentity {
  try {
    const stats = lstatSync(runtimeRoot, { bigint: true });
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & BigInt(PRIVATE_DIRECTORY_FORBIDDEN_MODE)) !== 0n
    ) {
      throw new Error("insecure runtime directory");
    }
    return fileIdentity(stats);
  } catch {
    throw new CodexRuntimeOwnershipError(errorCode);
  }
}

function assertPathIdentity(
  path: string,
  expectedIdentity: FileIdentity,
  errorCode: CodexRuntimeOwnershipErrorCode,
): void {
  try {
    const currentIdentity = fileIdentity(lstatSync(path, { bigint: true }));
    if (!sameFileNodeIdentity(expectedIdentity, currentIdentity)) {
      throw new Error("path identity changed");
    }
  } catch {
    throw new CodexRuntimeOwnershipError(errorCode);
  }
}

function assertJsonObjectKeysAreUnique(text: string): void {
  let cursor = 0;

  const skipWhitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? "")) {
      cursor += 1;
    }
  };

  const parseString = (): string => {
    if (text[cursor] !== '"') {
      throw new Error("expected JSON string");
    }
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') {
        cursor += 1;
        return JSON.parse(text.slice(start, cursor)) as string;
      }
      cursor += 1;
    }
    throw new Error("unterminated JSON string");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const next = text[cursor];
    if (next === "{") {
      parseObject();
      return;
    }
    if (next === "[") {
      parseArray();
      return;
    }
    if (next === '"') {
      parseString();
      return;
    }
    const primitive = text
      .slice(cursor)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);
    if (primitive === null) {
      throw new Error("invalid JSON value");
    }
    cursor += primitive[0].length;
  };

  const parseObject = (): void => {
    cursor += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[cursor] === "}") {
      cursor += 1;
      return;
    }
    while (cursor < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) {
        throw new Error("duplicate JSON key");
      }
      keys.add(key);
      skipWhitespace();
      if (text[cursor] !== ":") {
        throw new Error("expected JSON colon");
      }
      cursor += 1;
      parseValue();
      skipWhitespace();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ",") {
        throw new Error("expected JSON object separator");
      }
      cursor += 1;
    }
    throw new Error("unterminated JSON object");
  };

  const parseArray = (): void => {
    cursor += 1;
    skipWhitespace();
    if (text[cursor] === "]") {
      cursor += 1;
      return;
    }
    while (cursor < text.length) {
      parseValue();
      skipWhitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ",") {
        throw new Error("expected JSON array separator");
      }
      cursor += 1;
    }
    throw new Error("unterminated JSON array");
  };

  skipWhitespace();
  parseValue();
  skipWhitespace();
  if (cursor !== text.length) {
    throw new Error("trailing JSON content");
  }
}

function releaseVersionFromExactOutput(value: string): string {
  const prefix = "codex-cli ";
  if (!value.startsWith(prefix)) {
    throw new CodexRuntimeOwnershipError("INVALID_RUNTIME_SELECTION");
  }
  const releaseVersion = value.slice(prefix.length);
  if (!RELEASE_VERSION_PATTERN.test(releaseVersion)) {
    throw new CodexRuntimeOwnershipError("INVALID_RUNTIME_SELECTION");
  }
  return releaseVersion;
}

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}

function isRuntimeTarget(value: unknown): value is CodexRuntimeTarget {
  return (
    typeof value === "string" &&
    (CODEX_RUNTIME_TARGETS as readonly string[]).includes(value)
  );
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isStrictDescendant(candidate: string, parent: string): boolean {
  const childPath = relative(parent, candidate);
  return childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath);
}

function sameSelection(
  left: CodexRuntimeSelection | null,
  right: CodexRuntimeSelection,
): boolean {
  return left?.target === right.target && left.version === right.version;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
