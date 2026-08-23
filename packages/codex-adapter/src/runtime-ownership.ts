import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { TESTED_CODEX_VERSION } from "./compatibility.js";

const RELEASE_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha(?:\.[0-9]+){0,2}|beta(?:\.[0-9]+)?))?$/;
const VERSION_CHECK_TIMEOUT_MILLISECONDS = 5_000;
const VERSION_OUTPUT_MAX_BYTES = 4_096;
const SELECTOR_MAX_BYTES = 4_096;

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
  "SELECTOR_WRITE_FAILED",
  "UNSUPPORTED_RUNTIME_PLATFORM",
] as const;

export type CodexRuntimeOwnershipErrorCode =
  (typeof CODEX_RUNTIME_OWNERSHIP_ERROR_CODES)[number];

const ERROR_MESSAGES: Readonly<Record<CodexRuntimeOwnershipErrorCode, string>> = {
  ACTIVE_RUNTIME_VERSION_MISMATCH:
    "The active owned Codex runtime is not the exact tested version.",
  DEVELOPMENT_OVERRIDE_INVALID:
    "CTC_CODEX_BINARY must name an absolute, executable Codex binary with the exact tested version.",
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
  const executablePath = deriveOwnedCodexExecutablePath(selection, options);

  let canonicalRuntimeRoot: string;
  let canonicalReleasesRoot: string;
  let canonicalExecutablePath: string;
  try {
    canonicalRuntimeRoot = realpathSync(runtimeRoot);
    canonicalReleasesRoot = realpathSync(ownedReleasesRoot);
    canonicalExecutablePath = realpathSync(executablePath);
  } catch {
    throw new CodexRuntimeOwnershipError("RUNTIME_CANDIDATE_UNAVAILABLE");
  }

  if (
    !isStrictDescendant(canonicalReleasesRoot, canonicalRuntimeRoot) ||
    !isStrictDescendant(canonicalExecutablePath, canonicalReleasesRoot)
  ) {
    throw new CodexRuntimeOwnershipError("RUNTIME_PATH_ESCAPE");
  }

  return verifyExecutable(
    canonicalExecutablePath,
    selection.version,
    selection.target,
    "OWNED_RELEASE",
  );
}

export function readOwnedCodexRuntimeSelector(
  options: CodexRuntimeOwnershipOptions = {},
): CodexRuntimeSelector {
  const selectorPath = join(resolveRuntimeRoot(options), "active.json");
  let selectorStat;
  try {
    selectorStat = lstatSync(selectorPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { active: null, previous: null, schemaVersion: 1 };
    }
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }

  if (!selectorStat.isFile() || selectorStat.isSymbolicLink() || selectorStat.size > SELECTOR_MAX_BYTES) {
    throw new CodexRuntimeOwnershipError("INVALID_SELECTOR");
  }

  let value: unknown;
  try {
    const bytes = readFileSync(selectorPath);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
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
  return { active, previous, schemaVersion: 1 };
}

export function activateOwnedCodexRuntime(
  selection: CodexRuntimeSelection,
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
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
    options,
  );
  return candidate;
}

export function rollbackOwnedCodexRuntime(
  options: CodexRuntimeOwnershipOptions = {},
): ResolvedCodexRuntime {
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
    options,
  );
  return previousRuntime;
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
  try {
    if (!statSync(canonicalExecutablePath).isFile()) {
      throw new CodexRuntimeOwnershipError("RUNTIME_NOT_EXECUTABLE");
    }
    accessSync(canonicalExecutablePath, constants.R_OK | constants.X_OK);
  } catch (error: unknown) {
    if (error instanceof CodexRuntimeOwnershipError) {
      throw error;
    }
    throw new CodexRuntimeOwnershipError("RUNTIME_NOT_EXECUTABLE");
  }

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

  const exactVersionOutput = removeOneTrailingLineEnding(result.stdout);
  const expectedOutput = `codex-cli ${expectedReleaseVersion}`;
  if (exactVersionOutput !== expectedOutput) {
    throw new CodexRuntimeOwnershipError("RUNTIME_VERSION_MISMATCH");
  }

  return {
    canonicalExecutablePath,
    exactVersionOutput,
    executable: true,
    readable: true,
    releaseVersion: expectedReleaseVersion,
    source,
    target,
  };
}

function writeSelector(
  selector: CodexRuntimeSelector,
  options: CodexRuntimeOwnershipOptions,
): void {
  const runtimeRoot = resolveRuntimeRoot(options);
  const selectorPath = join(runtimeRoot, "active.json");
  selectorWriteSequence += 1;
  const temporaryPath = join(
    runtimeRoot,
    `.active.json.${process.pid}.${selectorWriteSequence}.tmp`,
  );
  let descriptor: number | undefined;

  try {
    mkdirSync(runtimeRoot, { mode: 0o700, recursive: true });
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(selector, null, 2)}\n`, {
      encoding: "utf8",
    });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, selectorPath);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the sanitized selector-write failure.
      }
    }
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
    throw new CodexRuntimeOwnershipError("SELECTOR_WRITE_FAILED");
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
