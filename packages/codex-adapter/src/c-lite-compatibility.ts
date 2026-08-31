import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import {
  EXCLUDED_EXPERIMENTAL_CAPABILITIES,
  TESTED_CODEX_VERSION,
} from "./compatibility.js";
import {
  SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  SUPPORTED_CLIENT_REQUEST_METHODS,
  SUPPORTED_SERVER_NOTIFICATION_METHODS,
  SUPPORTED_SERVER_REQUEST_METHODS,
} from "./protocol.js";
import {
  CodexRuntimeOwnershipError,
  getCodexRuntimeTarget,
  resolveOwnedCodexCandidate,
} from "./runtime-ownership.js";
import type {
  CodexRuntimeOwnershipOptions,
  CodexRuntimeTarget,
} from "./runtime-ownership.js";

const COMPATIBILITY_DIRECTORY_PREFIX = "ctc-codex-c-lite-";
const GENERATOR_TIMEOUT_MILLISECONDS = 30_000;
const GENERATOR_OUTPUT_MAX_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_FORBIDDEN_MODE = 0o077;
const TESTED_RELEASE_VERSION = TESTED_CODEX_VERSION.replace("codex-cli ", "");
const AUTHORITATIVE_SCHEMA_BUNDLE_NAME = "codex_app_server_protocol.schemas.json";

interface CompatibilityValidationLimits {
  readonly maxDirectoryEntries: number;
  readonly maxGeneratedEntries: number;
  readonly maxGeneratedFileBytes: number;
  readonly maxGeneratedFiles: number;
  readonly maxGeneratedTotalBytes: number;
  readonly maxGeneratedTreeDepth: number;
  readonly maxSchemaContainers: number;
  readonly maxSchemaDepth: number;
  readonly maxSchemaOperations: number;
  readonly maxSchemaSignatures: number;
}

const DEFAULT_VALIDATION_LIMITS: CompatibilityValidationLimits = {
  maxDirectoryEntries: 1_024,
  maxGeneratedEntries: 4_096,
  maxGeneratedFileBytes: 8 * 1024 * 1024,
  maxGeneratedFiles: 2_048,
  maxGeneratedTotalBytes: 64 * 1024 * 1024,
  maxGeneratedTreeDepth: 16,
  maxSchemaContainers: 50_000,
  maxSchemaDepth: 64,
  maxSchemaOperations: 50_000,
  maxSchemaSignatures: 128,
};

const REQUIRED_REQUEST_PARAMS: Readonly<Record<string, readonly string[]>> = {
  initialize: ["clientInfo"],
  "skills/list": [],
  "thread/goal/get": ["threadId"],
  "thread/goal/set": ["threadId"],
  "thread/resume": ["threadId"],
  "thread/start": [],
  "turn/interrupt": ["threadId", "turnId"],
  "turn/start": ["input", "threadId"],
};

const REQUIRED_METHOD_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "thread/start": [
    "approvalPolicy",
    "approvalsReviewer",
    "baseInstructions",
    "cwd",
    "developerInstructions",
    "ephemeral",
    "model",
    "modelProvider",
    "sandbox",
    "serviceName",
  ],
  "turn/start": [
    "approvalPolicy",
    "approvalsReviewer",
    "cwd",
    "input",
    "model",
    "sandboxPolicy",
    "threadId",
  ],
};

const REQUIRED_APPROVAL_PARAMS = ["itemId", "startedAtMs", "threadId", "turnId"];
const SUPPORTED_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "cancel",
  "decline",
] as const;

const METHOD_ROOTS = [
  {
    definitionPath: ["definitions", "ClientRequest"],
    methods: SUPPORTED_CLIENT_REQUEST_METHODS,
    requiredEnvelope: ["id", "method", "params"],
  },
  {
    definitionPath: ["definitions", "ClientNotification"],
    methods: SUPPORTED_CLIENT_NOTIFICATION_METHODS,
    requiredEnvelope: ["method"],
  },
  {
    definitionPath: ["definitions", "ServerNotification"],
    methods: SUPPORTED_SERVER_NOTIFICATION_METHODS,
    requiredEnvelope: ["method", "params"],
  },
  {
    definitionPath: ["definitions", "ServerRequest"],
    methods: SUPPORTED_SERVER_REQUEST_METHODS,
    requiredEnvelope: ["id", "method", "params"],
  },
] as const;

const METHOD_PARAMS_DEFINITIONS: Readonly<
  Record<string, readonly string[]>
> = {
  initialize: ["definitions", "InitializeParams"],
  "item/commandExecution/requestApproval": [
    "definitions",
    "CommandExecutionRequestApprovalParams",
  ],
  "item/fileChange/requestApproval": [
    "definitions",
    "FileChangeRequestApprovalParams",
  ],
  "item/agentMessage/delta": [
    "definitions",
    "v2",
    "AgentMessageDeltaNotification",
  ],
  "item/completed": ["definitions", "v2", "ItemCompletedNotification"],
  "item/commandExecution/outputDelta": [
    "definitions",
    "v2",
    "CommandExecutionOutputDeltaNotification",
  ],
  "item/fileChange/outputDelta": [
    "definitions",
    "v2",
    "FileChangeOutputDeltaNotification",
  ],
  "item/fileChange/patchUpdated": [
    "definitions",
    "v2",
    "FileChangePatchUpdatedNotification",
  ],
  "item/started": ["definitions", "v2", "ItemStartedNotification"],
  "serverRequest/resolved": [
    "definitions",
    "v2",
    "ServerRequestResolvedNotification",
  ],
  "skills/list": ["definitions", "v2", "SkillsListParams"],
  "thread/goal/get": ["definitions", "v2", "ThreadGoalGetParams"],
  "thread/goal/set": ["definitions", "v2", "ThreadGoalSetParams"],
  "thread/goal/updated": [
    "definitions",
    "v2",
    "ThreadGoalUpdatedNotification",
  ],
  "thread/resume": ["definitions", "v2", "ThreadResumeParams"],
  "thread/start": ["definitions", "v2", "ThreadStartParams"],
  "thread/started": ["definitions", "v2", "ThreadStartedNotification"],
  "thread/tokenUsage/updated": [
    "definitions",
    "v2",
    "ThreadTokenUsageUpdatedNotification",
  ],
  "turn/completed": ["definitions", "v2", "TurnCompletedNotification"],
  "turn/interrupt": ["definitions", "v2", "TurnInterruptParams"],
  "turn/start": ["definitions", "v2", "TurnStartParams"],
  "turn/started": ["definitions", "v2", "TurnStartedNotification"],
};

const NAMED_OBJECT_CONTRACTS = [
  {
    definitionPath: ["definitions", "InitializeResponse"],
    properties: ["codexHome", "platformFamily", "platformOs", "userAgent"],
    required: ["codexHome", "platformFamily", "platformOs", "userAgent"],
  },
  {
    definitionPath: ["definitions", "v2", "ThreadStartResponse"],
    properties: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ],
    required: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ],
  },
  {
    definitionPath: ["definitions", "v2", "ThreadResumeResponse"],
    properties: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ],
    required: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ],
  },
  {
    definitionPath: ["definitions", "v2", "TurnStartResponse"],
    properties: ["turn"],
    required: ["turn"],
  },
  {
    definitionPath: ["definitions", "v2", "Thread"],
    properties: [
      "cliVersion",
      "createdAt",
      "cwd",
      "ephemeral",
      "id",
      "modelProvider",
      "preview",
      "sessionId",
      "source",
      "status",
      "turns",
      "updatedAt",
    ],
    required: [
      "cliVersion",
      "createdAt",
      "cwd",
      "ephemeral",
      "id",
      "modelProvider",
      "preview",
      "sessionId",
      "source",
      "status",
      "turns",
      "updatedAt",
    ],
  },
  {
    definitionPath: ["definitions", "v2", "Turn"],
    properties: ["id", "items", "status"],
    required: ["id", "items", "status"],
  },
  {
    definitionPath: [
      "definitions",
      "v2",
      "CommandExecutionOutputDeltaNotification",
    ],
    properties: ["delta", "itemId", "threadId", "turnId"],
    required: ["delta", "itemId", "threadId", "turnId"],
  },
  {
    definitionPath: [
      "definitions",
      "v2",
      "FileChangeOutputDeltaNotification",
    ],
    properties: ["delta", "itemId", "threadId", "turnId"],
    required: ["delta", "itemId", "threadId", "turnId"],
  },
  {
    definitionPath: [
      "definitions",
      "v2",
      "FileChangePatchUpdatedNotification",
    ],
    properties: ["changes", "itemId", "threadId", "turnId"],
    required: ["changes", "itemId", "threadId", "turnId"],
  },
  {
    definitionPath: ["definitions", "v2", "ThreadTokenUsage"],
    properties: ["last", "modelContextWindow", "total"],
    required: ["last", "total"],
  },
  {
    definitionPath: ["definitions", "v2", "TokenUsageBreakdown"],
    properties: [
      "cacheWriteInputTokens",
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ],
    required: [
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ],
  },
] as const;

export const C_LITE_COMPATIBILITY_FAILURE_CODES = [
  "RUNTIME_RESOLUTION_FAILED",
  "UNTESTED_CODEX_VERSION",
  "ISOLATION_SETUP_FAILED",
  "SCHEMA_GENERATOR_START_FAILED",
  "SCHEMA_GENERATOR_FAILED",
  "SCHEMA_GENERATOR_SIGNALED",
  "SCHEMA_OUTPUT_MISSING",
  "SCHEMA_OUTPUT_MALFORMED",
  "PROTOCOL_METHOD_MISSING",
  "PROTOCOL_SHAPE_INCOMPATIBLE",
  "CLEANUP_FAILED",
] as const;

export type CLiteCompatibilityFailureCode =
  (typeof C_LITE_COMPATIBILITY_FAILURE_CODES)[number];

export interface CLiteCompatibilityCheckOptions {
  readonly runtimeOwnership?: CodexRuntimeOwnershipOptions;
}

interface CLiteCompatibilityEvidenceBase {
  readonly consumedProtocolContractPassed: boolean;
  readonly exactTestedCodexVersion: typeof TESTED_CODEX_VERSION;
  readonly excludedExperimentalCapabilities: typeof EXCLUDED_EXPERIMENTAL_CAPABILITIES;
  readonly experimentalCapabilitiesActivated: false;
  readonly provenanceSha256: string | null;
  readonly runtimeTarget: CodexRuntimeTarget | null;
  readonly schemaGenerationSucceeded: boolean;
  readonly trustedOwnedCandidateUsed: boolean;
}

export type CLiteCompatibilityResult =
  | (CLiteCompatibilityEvidenceBase & {
      readonly compatible: true;
      readonly failure: null;
    })
  | (CLiteCompatibilityEvidenceBase & {
      readonly compatible: false;
      readonly failure: CLiteCompatibilityFailureCode;
    });

interface CompatibilityProbeEnvironment {
  readonly childEnvironment: NodeJS.ProcessEnv;
  readonly outputDirectory: string;
  readonly root: string;
}

interface SchemaLocation {
  readonly node: SchemaObject;
  readonly path: readonly string[];
}

interface SchemaValidationContext {
  operations: number;
  readonly root: SchemaObject;
  readonly limits: CompatibilityValidationLimits;
}

interface GeneratedTreeScan {
  readonly files: readonly string[];
  readonly totalBytes: number;
}

interface SchemaGeneratorLimits {
  readonly maxBufferBytes: number;
  readonly timeoutMilliseconds: number;
}

interface StableTextFile {
  readonly text: string;
  readonly size: number;
}

interface SchemaReferenceState {
  readonly activePaths: ReadonlySet<string>;
}

interface MethodVariant {
  readonly node: SchemaObject;
  readonly path: readonly string[];
}

interface BigIntFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

interface SchemaObject {
  readonly [key: string]: unknown;
}

interface ObjectSignature {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

type BoundedStringSet =
  | { readonly kind: "all" }
  | { readonly kind: "finite"; readonly values: ReadonlySet<string> };

interface ValidationSuccess {
  readonly provenanceSha256: string;
}

class CLiteCompatibilityFailure extends Error {
  public readonly code: CLiteCompatibilityFailureCode;

  public constructor(code: CLiteCompatibilityFailureCode) {
    super(code);
    this.name = "CLiteCompatibilityFailure";
    this.code = code;
  }
}

type DisposableRootRemover = (root: string) => void;

export function checkOwnedCodexCompatibility(
  options: CLiteCompatibilityCheckOptions = {},
): CLiteCompatibilityResult {
  return runOwnedCodexCompatibilityCheck(options, removeDisposableRoot);
}

/** Internal deterministic-test hook; not exported from the package root. */
export function checkOwnedCodexCompatibilityWithCleanupForTest(
  options: CLiteCompatibilityCheckOptions,
  removeRoot: DisposableRootRemover,
): CLiteCompatibilityResult {
  if (process.env.NODE_ENV !== "test") {
    return failureResult("ISOLATION_SETUP_FAILED", null);
  }
  return runOwnedCodexCompatibilityCheck(options, removeRoot);
}

function runOwnedCodexCompatibilityCheck(
  options: CLiteCompatibilityCheckOptions,
  removeRoot: DisposableRootRemover,
): CLiteCompatibilityResult {
  let runtimeTarget: CodexRuntimeTarget | null = null;
  let trustedOwnedCandidateUsed = false;
  let schemaGenerationSucceeded = false;
  let consumedProtocolContractPassed = false;
  let provenanceSha256: string | null = null;
  let probe: CompatibilityProbeEnvironment | undefined;
  let result: CLiteCompatibilityResult;

  try {
    runtimeTarget = getCodexRuntimeTarget();
    const runtime = resolveOwnedCodexCandidate(
      { target: runtimeTarget, version: TESTED_RELEASE_VERSION },
      options.runtimeOwnership,
    );
    if (runtime.source !== "OWNED_RELEASE") {
      return failureResult("RUNTIME_RESOLUTION_FAILED", runtimeTarget);
    }
    trustedOwnedCandidateUsed = true;
    if (runtime.exactVersionOutput !== TESTED_CODEX_VERSION) {
      return failureResult("UNTESTED_CODEX_VERSION", runtimeTarget, {
        trustedOwnedCandidateUsed,
      });
    }

    probe = createCompatibilityProbeEnvironment();
    const commands = buildOwnedSchemaGenerationCommands(
      runtime.canonicalExecutablePath,
      probe.outputDirectory,
    );
    for (const command of commands) {
      if (
        command.command !== runtime.canonicalExecutablePath ||
        command.arguments.includes("--experimental")
      ) {
        throw new CLiteCompatibilityFailure("SCHEMA_GENERATOR_START_FAILED");
      }
      runSchemaGenerator(command.command, command.arguments, probe.childEnvironment);
    }
    schemaGenerationSucceeded = true;

    const validation = validateGeneratedCompatibilityOutput(probe.outputDirectory);
    provenanceSha256 = validation.provenanceSha256;
    consumedProtocolContractPassed = true;
    result = successResult(runtimeTarget, provenanceSha256);
  } catch (error: unknown) {
    const code =
      error instanceof CLiteCompatibilityFailure
        ? error.code
        : error instanceof CodexRuntimeOwnershipError &&
            error.code === "RUNTIME_VERSION_MISMATCH"
          ? "UNTESTED_CODEX_VERSION"
          : probe !== undefined
            ? "SCHEMA_OUTPUT_MALFORMED"
            : trustedOwnedCandidateUsed
              ? "ISOLATION_SETUP_FAILED"
              : "RUNTIME_RESOLUTION_FAILED";
    result = failureResult(code, runtimeTarget, {
      consumedProtocolContractPassed,
      provenanceSha256,
      schemaGenerationSucceeded,
      trustedOwnedCandidateUsed,
    });
  }

  if (probe !== undefined) {
    try {
      removeRoot(probe.root);
    } catch {
      result = failureResult("CLEANUP_FAILED", runtimeTarget, {
        consumedProtocolContractPassed,
        provenanceSha256,
        schemaGenerationSucceeded,
        trustedOwnedCandidateUsed,
      });
    }
  }

  return result;
}

function successResult(
  runtimeTarget: CodexRuntimeTarget,
  provenanceSha256: string,
): CLiteCompatibilityResult {
  return {
    compatible: true,
    consumedProtocolContractPassed: true,
    exactTestedCodexVersion: TESTED_CODEX_VERSION,
    excludedExperimentalCapabilities: EXCLUDED_EXPERIMENTAL_CAPABILITIES,
    experimentalCapabilitiesActivated: false,
    failure: null,
    provenanceSha256,
    runtimeTarget,
    schemaGenerationSucceeded: true,
    trustedOwnedCandidateUsed: true,
  };
}

function failureResult(
  failure: CLiteCompatibilityFailureCode,
  runtimeTarget: CodexRuntimeTarget | null,
  evidence: Partial<
    Pick<
      CLiteCompatibilityEvidenceBase,
      | "consumedProtocolContractPassed"
      | "provenanceSha256"
      | "schemaGenerationSucceeded"
      | "trustedOwnedCandidateUsed"
    >
  > = {},
): CLiteCompatibilityResult {
  return {
    compatible: false,
    consumedProtocolContractPassed:
      evidence.consumedProtocolContractPassed ?? false,
    exactTestedCodexVersion: TESTED_CODEX_VERSION,
    excludedExperimentalCapabilities: EXCLUDED_EXPERIMENTAL_CAPABILITIES,
    experimentalCapabilitiesActivated: false,
    failure,
    provenanceSha256: evidence.provenanceSha256 ?? null,
    runtimeTarget,
    schemaGenerationSucceeded: evidence.schemaGenerationSucceeded ?? false,
    trustedOwnedCandidateUsed: evidence.trustedOwnedCandidateUsed ?? false,
  };
}

function createCompatibilityProbeEnvironment(): CompatibilityProbeEnvironment {
  let disposableRoot: string | undefined;
  try {
    const canonicalTemporaryRoot = realpathSync(tmpdir());
    disposableRoot = mkdtempSync(
      join(canonicalTemporaryRoot, COMPATIBILITY_DIRECTORY_PREFIX),
    );
    chmodSync(disposableRoot, 0o700);
    const canonicalDisposableRoot = realpathSync(disposableRoot);
    const rootStat = lstatSync(disposableRoot);
    if (
      canonicalDisposableRoot !== disposableRoot ||
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (rootStat.mode & PRIVATE_DIRECTORY_FORBIDDEN_MODE) !== 0
    ) {
      throw new Error("invalid compatibility root");
    }

    const homeDirectory = join(disposableRoot, "home");
    const codexHomeDirectory = join(disposableRoot, "codex-home");
    const temporaryDirectory = join(disposableRoot, "tmp");
    const pathDirectory = join(disposableRoot, "bin");
    const outputDirectory = join(disposableRoot, "schemas");
    for (const directory of [
      homeDirectory,
      codexHomeDirectory,
      temporaryDirectory,
      pathDirectory,
      outputDirectory,
    ]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }

    return {
      childEnvironment: {
        CODEX_HOME: codexHomeDirectory,
        HOME: homeDirectory,
        PATH: pathDirectory,
        TMPDIR: temporaryDirectory,
      },
      outputDirectory,
      root: disposableRoot,
    };
  } catch {
    if (disposableRoot !== undefined) {
      try {
        removeDisposableRoot(disposableRoot);
      } catch {
        // Preserve the sanitized isolation failure.
      }
    }
    throw new CLiteCompatibilityFailure("ISOLATION_SETUP_FAILED");
  }
}

function removeDisposableRoot(root: string): void {
  rmSync(root, {
    force: true,
    maxRetries: 2,
    recursive: true,
    retryDelay: 10,
  });
}

function runSchemaGenerator(
  command: string,
  arguments_: readonly string[],
  childEnvironment: NodeJS.ProcessEnv,
  limits: SchemaGeneratorLimits = {
    maxBufferBytes: GENERATOR_OUTPUT_MAX_BYTES,
    timeoutMilliseconds: GENERATOR_TIMEOUT_MILLISECONDS,
  },
): void {
  const child = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: childEnvironment,
    maxBuffer: limits.maxBufferBytes,
    shell: false,
    stdio: "pipe",
    timeout: limits.timeoutMilliseconds,
  });

  if (child.error !== undefined) {
    const code = (child.error as NodeJS.ErrnoException).code;
    throw new CLiteCompatibilityFailure(
      code === "ENOENT"
        ? "SCHEMA_GENERATOR_START_FAILED"
        : "SCHEMA_GENERATOR_FAILED",
    );
  }
  if (child.signal !== null) {
    throw new CLiteCompatibilityFailure("SCHEMA_GENERATOR_SIGNALED");
  }
  if (child.status !== 0) {
    throw new CLiteCompatibilityFailure("SCHEMA_GENERATOR_FAILED");
  }
}

/** Internal deterministic-test hook; not exported from the package root. */
export function runSchemaGeneratorForTest(
  command: string,
  arguments_: readonly string[],
  childEnvironment: NodeJS.ProcessEnv,
  limits: SchemaGeneratorLimits,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new CLiteCompatibilityFailure("SCHEMA_GENERATOR_START_FAILED");
  }
  runSchemaGenerator(command, arguments_, childEnvironment, limits);
}

function buildOwnedSchemaGenerationCommands(
  canonicalExecutablePath: string,
  outputDirectory: string,
): readonly {
  readonly arguments: readonly string[];
  readonly command: string;
}[] {
  return [
    {
      arguments: [
        "app-server",
        "generate-ts",
        "--out",
        join(outputDirectory, "typescript"),
      ],
      command: canonicalExecutablePath,
    },
    {
      arguments: [
        "app-server",
        "generate-json-schema",
        "--out",
        join(outputDirectory, "json-schema"),
      ],
      command: canonicalExecutablePath,
    },
  ];
}

function validateGeneratedCompatibilityOutput(
  outputDirectory: string,
  limits: CompatibilityValidationLimits = DEFAULT_VALIDATION_LIMITS,
): ValidationSuccess {
  const typescriptDirectory = join(outputDirectory, "typescript");
  const jsonSchemaDirectory = join(outputDirectory, "json-schema");
  const typescriptTree = scanGeneratedTree(typescriptDirectory, limits);
  if (!typescriptTree.files.some((path) => extname(path) === ".ts")) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }

  const jsonTree = scanGeneratedTree(jsonSchemaDirectory, limits);
  const bundlePath = join(
    jsonSchemaDirectory,
    AUTHORITATIVE_SCHEMA_BUNDLE_NAME,
  );
  if (!jsonTree.files.includes(bundlePath)) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }

  let bundleText: string | undefined;
  let authoritativeRoot: SchemaObject | undefined;
  for (const path of jsonTree.files.filter((candidate) => extname(candidate) === ".json")) {
    const text = readStableTextFile(path, limits).text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    if (!isSchemaObject(parsed)) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    assertBoundedSchemaStructure(parsed, limits);
    if (path === bundlePath) {
      bundleText = text;
      authoritativeRoot = parsed;
    }
  }
  if (bundleText === undefined || authoritativeRoot === undefined) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }
  validateConsumedProtocolContract(authoritativeRoot, limits);
  return {
    provenanceSha256: createHash("sha256").update(bundleText).digest("hex"),
  };
}

/** Internal deterministic-test hook; not exported from the package root. */
export function validateGeneratedCompatibilityOutputForTest(
  outputDirectory: string,
  limits: Partial<CompatibilityValidationLimits> = {},
): ValidationSuccess {
  if (process.env.NODE_ENV !== "test") {
    throw new CLiteCompatibilityFailure("ISOLATION_SETUP_FAILED");
  }
  return validateGeneratedCompatibilityOutput(outputDirectory, {
    ...DEFAULT_VALIDATION_LIMITS,
    ...limits,
  });
}

function scanGeneratedTree(
  root: string,
  limits: CompatibilityValidationLimits,
): GeneratedTreeScan {
  const files: string[] = [];
  let totalBytes = 0;
  let totalEntries = 0;
  const directories: { readonly depth: number; readonly path: string }[] = [];
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  directories.push({ depth: 0, path: root });

  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) {
      break;
    }
    let entries;
    try {
      entries = readdirSync(directory.path, { withFileTypes: true });
    } catch {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    if (entries.length > limits.maxDirectoryEntries) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > limits.maxGeneratedEntries) {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      const path = join(directory.path, entry.name);
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      if (stats.isSymbolicLink()) {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      if (stats.isDirectory()) {
        if (directory.depth >= limits.maxGeneratedTreeDepth) {
          throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
        }
        directories.push({ depth: directory.depth + 1, path });
        continue;
      }
      if (!stats.isFile()) {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      if (
        files.length >= limits.maxGeneratedFiles ||
        stats.size > limits.maxGeneratedFileBytes
      ) {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      totalBytes += stats.size;
      if (totalBytes > limits.maxGeneratedTotalBytes) {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      files.push(path);
    }
  }
  return { files, totalBytes };
}

function readStableTextFile(
  path: string,
  limits: CompatibilityValidationLimits,
): StableTextFile {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(limits.maxGeneratedFileBytes)
    ) {
      throw new Error("invalid generated file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(before, pathAfter) ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error("generated file changed");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("invalid UTF-8");
    }
    return { size: bytes.byteLength, text };
  } catch {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the sanitized validation outcome.
      }
    }
  }
}

function sameFileIdentity(
  left: BigIntFileIdentity,
  right: BigIntFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertBoundedSchemaStructure(
  root: SchemaObject,
  limits: CompatibilityValidationLimits,
): void {
  const pending: { readonly depth: number; readonly value: unknown }[] = [
    { depth: 0, value: root },
  ];
  let containers = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    if (!Array.isArray(current.value) && !isSchemaObject(current.value)) {
      continue;
    }
    if (
      current.depth > limits.maxSchemaDepth ||
      ++containers > limits.maxSchemaContainers
    ) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      if (Array.isArray(child) || isSchemaObject(child)) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
}

function validateConsumedProtocolContract(
  root: SchemaObject,
  limits: CompatibilityValidationLimits,
): void {
  if (root.title !== "CodexAppServerProtocol" || root.type !== "object") {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  const context: SchemaValidationContext = { limits, operations: 0, root };

  const methodVariants = new Map<string, MethodVariant>();
  for (const methodRoot of METHOD_ROOTS) {
    const rootLocation = requireLocation(context, methodRoot.definitionPath);
    const alternatives = schemaAlternatives(rootLocation, context);
    for (const method of methodRoot.methods) {
      const matching = alternatives.filter((alternative) =>
        variantHasExactMethod(alternative, method, context),
      );
      if (matching.length === 0) {
        throw new CLiteCompatibilityFailure("PROTOCOL_METHOD_MISSING");
      }
      if (matching.length !== 1) {
        throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
      }
      const variant = matching[0];
      if (
        variant === undefined ||
        !schemaHasObjectContract(
          variant,
          methodRoot.requiredEnvelope,
          methodRoot.requiredEnvelope,
          context,
        )
      ) {
        throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
      }
      methodVariants.set(method, variant);
    }
  }

  for (const [method, definitionPath] of Object.entries(
    METHOD_PARAMS_DEFINITIONS,
  )) {
    const variant = methodVariants.get(method);
    if (variant === undefined) {
      throw new CLiteCompatibilityFailure("PROTOCOL_METHOD_MISSING");
    }
    const paramsLocations = objectPropertyLocations(
      variant,
      "params",
      context,
      { activePaths: new Set() },
    );
    const target = requireLocation(context, definitionPath);
    if (
      paramsLocations.length === 0 ||
      !paramsLocations.some((location) =>
        schemaTargetsLocation(
          location,
          target,
          context,
          { activePaths: new Set() },
        ),
      )
    ) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }

    const required = SUPPORTED_SERVER_REQUEST_METHODS.includes(
      method as (typeof SUPPORTED_SERVER_REQUEST_METHODS)[number],
    )
      ? REQUIRED_APPROVAL_PARAMS
      : (REQUIRED_REQUEST_PARAMS[method] ?? []);
    const properties = REQUIRED_METHOD_PROPERTIES[method] ?? required;
    if (
      !paramsLocations.some((location) =>
        schemaHasObjectContract(
          location,
          required,
          properties,
          context,
        ),
      )
    ) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }

  for (const contract of NAMED_OBJECT_CONTRACTS) {
    if (
      !schemaHasObjectContract(
        requireLocation(context, contract.definitionPath),
        contract.required,
        contract.properties,
        context,
      )
    ) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }

  assertPropertyTargets(
    context,
    ["definitions", "v2", "ThreadStartResponse"],
    "thread",
    ["definitions", "v2", "Thread"],
  );
  assertPropertyTargets(
    context,
    ["definitions", "v2", "ThreadResumeResponse"],
    "thread",
    ["definitions", "v2", "Thread"],
  );
  assertPropertyTargets(
    context,
    ["definitions", "v2", "TurnStartResponse"],
    "turn",
    ["definitions", "v2", "Turn"],
  );
  for (const notificationPath of [
    ["definitions", "v2", "ThreadStartedNotification"],
  ] as const) {
    assertPropertyTargets(
      context,
      notificationPath,
      "thread",
      ["definitions", "v2", "Thread"],
    );
  }
  for (const notificationPath of [
    ["definitions", "v2", "TurnStartedNotification"],
    ["definitions", "v2", "TurnCompletedNotification"],
  ] as const) {
    assertPropertyTargets(
      context,
      notificationPath,
      "turn",
      ["definitions", "v2", "Turn"],
    );
  }
  assertPropertyTargets(
    context,
    ["definitions", "v2", "ThreadTokenUsageUpdatedNotification"],
    "tokenUsage",
    ["definitions", "v2", "ThreadTokenUsage"],
  );
  for (const property of ["last", "total"] as const) {
    assertPropertyTargets(
      context,
      ["definitions", "v2", "ThreadTokenUsage"],
      property,
      ["definitions", "v2", "TokenUsageBreakdown"],
    );
  }

  validateTextInput(context);
  validateWriteSandboxContract(context);
  validateWriteToolItemContract(context);
  validateApprovalContract(
    context,
    ["definitions", "CommandExecutionRequestApprovalResponse"],
    ["definitions", "CommandExecutionApprovalDecision"],
  );
  validateApprovalContract(
    context,
    ["definitions", "FileChangeRequestApprovalResponse"],
    ["definitions", "FileChangeApprovalDecision"],
  );
}

function validateWriteToolItemContract(context: SchemaValidationContext): void {
  const threadItems = schemaAlternatives(
    requireLocation(context, ["definitions", "v2", "ThreadItem"]),
    context,
  );
  const commandItems = threadItems.filter((variant) =>
    schemaAllowsExactlyObjectPropertyLiteral(
      variant,
      "type",
      "commandExecution",
      context,
      { activePaths: new Set() },
    ),
  );
  const fileItems = threadItems.filter((variant) =>
    schemaAllowsExactlyObjectPropertyLiteral(
      variant,
      "type",
      "fileChange",
      context,
      { activePaths: new Set() },
    ),
  );
  if (
    commandItems.length !== 1 ||
    fileItems.length !== 1 ||
    commandItems[0] === undefined ||
    fileItems[0] === undefined ||
    !schemaHasObjectContract(
      commandItems[0],
      ["command", "commandActions", "cwd", "id", "status", "type"],
      ["command", "commandActions", "cwd", "id", "status", "type"],
      context,
    ) ||
    !schemaHasObjectContract(
      fileItems[0],
      ["changes", "id", "status", "type"],
      ["changes", "id", "status", "type"],
      context,
    )
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
  for (const notification of [
    ["definitions", "v2", "ItemStartedNotification"],
    ["definitions", "v2", "ItemCompletedNotification"],
  ] as const) {
    assertPropertyTargets(
      context,
      notification,
      "item",
      ["definitions", "v2", "ThreadItem"],
    );
  }
}

function validateWriteSandboxContract(context: SchemaValidationContext): void {
  const sandboxModes = evaluateBoundedStringSet(
    requireLocation(context, ["definitions", "v2", "SandboxMode"]),
    context,
    { activePaths: new Set() },
  );
  if (
    sandboxModes === null ||
    !boundedStringSetHas(sandboxModes, "read-only") ||
    !boundedStringSetHas(sandboxModes, "workspace-write")
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }

  const sandboxPolicy = requireLocation(context, [
    "definitions",
    "v2",
    "SandboxPolicy",
  ]);
  const workspaceWriteVariants = schemaAlternatives(
    sandboxPolicy,
    context,
  ).filter((variant) =>
    schemaAllowsExactlyObjectPropertyLiteral(
      variant,
      "type",
      "workspaceWrite",
      context,
      { activePaths: new Set() },
    ),
  );
  const workspaceWrite = workspaceWriteVariants[0];
  if (
    workspaceWriteVariants.length !== 1 ||
    workspaceWrite === undefined ||
    !schemaHasObjectContract(
      workspaceWrite,
      ["type"],
      [
        "excludeSlashTmp",
        "excludeTmpdirEnvVar",
        "networkAccess",
        "type",
        "writableRoots",
      ],
      context,
    )
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }

  const networkLocations = objectPropertyLocations(
    workspaceWrite,
    "networkAccess",
    context,
    { activePaths: new Set() },
  );
  if (
    !networkLocations.some((location) =>
      schemaTypeAllows(location.node, "boolean"),
    )
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }

  for (const property of ["excludeSlashTmp", "excludeTmpdirEnvVar"]) {
    const locations = objectPropertyLocations(
      workspaceWrite,
      property,
      context,
      { activePaths: new Set() },
    );
    if (
      !locations.some((location) =>
        schemaTypeAllows(location.node, "boolean"),
      )
    ) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }

  const writableRoots = objectPropertyLocations(
    workspaceWrite,
    "writableRoots",
    context,
    { activePaths: new Set() },
  );
  const absolutePath = requireLocation(context, [
    "definitions",
    "v2",
    "AbsolutePathBuf",
  ]);
  if (
    !writableRoots.some((location) => {
      const items = schemaRecord(location.node.items);
      return (
        location.node.type === "array" &&
        items !== undefined &&
        schemaTargetsLocation(
          { node: items, path: [...location.path, "items"] },
          absolutePath,
          context,
          { activePaths: new Set() },
        )
      );
    })
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }

  assertPropertyTargets(
    context,
    ["definitions", "v2", "ThreadStartParams"],
    "sandbox",
    ["definitions", "v2", "SandboxMode"],
  );
  assertPropertyTargets(
    context,
    ["definitions", "v2", "TurnStartParams"],
    "sandboxPolicy",
    ["definitions", "v2", "SandboxPolicy"],
  );
  assertPropertyTargets(
    context,
    ["definitions", "v2", "ThreadStartResponse"],
    "sandbox",
    ["definitions", "v2", "SandboxPolicy"],
  );
}

function validateTextInput(context: SchemaValidationContext): void {
  const input = requireLocation(context, ["definitions", "v2", "UserInput"]);
  const textVariants = schemaAlternatives(input, context).filter((variant) =>
    schemaAllowsExactlyObjectPropertyLiteral(
      variant,
      "type",
      "text",
      context,
      { activePaths: new Set() },
    ),
  );
  if (textVariants.length !== 1) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
  const textVariant = textVariants[0];
  if (
    textVariant === undefined ||
    !schemaHasObjectContract(
      textVariant,
      ["text", "type"],
      ["text", "text_elements", "type"],
      context,
    )
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
  const textElements = objectPropertyLocations(
    textVariant,
    "text_elements",
    context,
    { activePaths: new Set() },
  );
  const target = requireLocation(context, ["definitions", "v2", "TextElement"]);
  if (
    !textElements.some((location) => {
      const items = schemaRecord(location.node.items);
      return (
        location.node.type === "array" &&
        items !== undefined &&
        schemaTargetsLocation(
          { node: items, path: [...location.path, "items"] },
          target,
          context,
          { activePaths: new Set() },
        )
      );
    })
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
}

function validateApprovalContract(
  context: SchemaValidationContext,
  responsePath: readonly string[],
  decisionPath: readonly string[],
): void {
  const response = requireLocation(context, responsePath);
  if (!schemaHasObjectContract(response, ["decision"], ["decision"], context)) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
  assertPropertyTargets(context, responsePath, "decision", decisionPath);
  const values = evaluateBoundedStringSet(
    requireLocation(context, decisionPath),
    context,
    { activePaths: new Set() },
  );
  if (
    values === null ||
    !SUPPORTED_APPROVAL_DECISIONS.every((value) =>
      boundedStringSetHas(values, value),
    )
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
}

function assertPropertyTargets(
  context: SchemaValidationContext,
  sourcePath: readonly string[],
  property: string,
  targetPath: readonly string[],
): void {
  const source = requireLocation(context, sourcePath);
  const target = requireLocation(context, targetPath);
  const locations = objectPropertyLocations(
    source,
    property,
    context,
    { activePaths: new Set() },
  );
  if (
    locations.length === 0 ||
    !locations.some((location) =>
      schemaTargetsLocation(
        location,
        target,
        context,
        { activePaths: new Set() },
      ),
    )
  ) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
}

function schemaAlternatives(
  location: SchemaLocation,
  context: SchemaValidationContext,
): readonly SchemaLocation[] {
  consumeSchemaOperation(context);
  if (location.node.oneOf === undefined) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  const oneOf = strictSchemaObjectArray(location.node.oneOf);
  if (oneOf.length > context.limits.maxSchemaSignatures) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return oneOf.map((node, index) => ({
    node,
    path: [...location.path, "oneOf", String(index)],
  }));
}

function variantHasExactMethod(
  variant: SchemaLocation,
  method: string,
  context: SchemaValidationContext,
): boolean {
  return schemaAllowsExactlyObjectPropertyLiteral(
    variant,
    "method",
    method,
    context,
    { activePaths: new Set() },
  );
}

function schemaAllowsExactlyObjectPropertyLiteral(
  location: SchemaLocation,
  property: string,
  expected: string,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): boolean {
  const values = evaluateObjectPropertyBoundedStringSet(
    location,
    property,
    context,
    state,
  );
  return (
    values !== null &&
    values.kind === "finite" &&
    values.values.size === 1 &&
    values.values.has(expected)
  );
}

function evaluateObjectPropertyBoundedStringSet(
  location: SchemaLocation,
  property: string,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): BoundedStringSet | null {
  consumeSchemaOperation(context);
  let allowed = allBoundedStrings();
  const properties = strictSchemaRecord(location.node.properties);
  const direct = properties[property];
  if (isSchemaObject(direct)) {
    const values = evaluateBoundedStringSet(
      {
        node: direct,
        path: [...location.path, "properties", property],
      },
      context,
      state,
    );
    if (values === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, values, context);
  } else if (direct !== undefined) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }

  const referenced = referencedLocation(location, context, state);
  if (referenced !== null) {
    const values = evaluateObjectPropertyBoundedStringSet(
      referenced.location,
      property,
      context,
      referenced.state,
    );
    if (values === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, values, context);
  }

  for (const [index, schema] of strictSchemaObjectArray(
    location.node.allOf,
  ).entries()) {
    const values = evaluateObjectPropertyBoundedStringSet(
      { node: schema, path: [...location.path, "allOf", String(index)] },
      property,
      context,
      state,
    );
    if (values === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, values, context);
  }

  for (const keyword of ["oneOf", "anyOf"] as const) {
    if (location.node[keyword] === undefined) {
      continue;
    }
    const alternatives = strictSchemaObjectArray(location.node[keyword]);
    if (alternatives.length > context.limits.maxSchemaSignatures) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    const alternativeSets: BoundedStringSet[] = [];
    for (const [index, schema] of alternatives.entries()) {
      const values = evaluateObjectPropertyBoundedStringSet(
        { node: schema, path: [...location.path, keyword, String(index)] },
        property,
        context,
        state,
      );
      if (values === null) {
        return null;
      }
      alternativeSets.push(values);
    }
    const combined =
      keyword === "anyOf"
        ? unionBoundedStringSets(alternativeSets, context)
        : exactlyOneBoundedStringSet(alternativeSets, context);
    if (combined === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, combined, context);
  }

  return allowed;
}

function evaluateBoundedStringSet(
  location: SchemaLocation,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): BoundedStringSet | null {
  consumeSchemaOperation(context);
  if (hasUnsupportedStringConstraint(location.node)) {
    return null;
  }

  let allowed = schemaTypeAllows(location.node, "string")
    ? allBoundedStrings()
    : finiteBoundedStrings([], context);

  if (Object.hasOwn(location.node, "const")) {
    allowed = intersectBoundedStringSets(
      allowed,
      finiteBoundedStrings(
        typeof location.node.const === "string" ? [location.node.const] : [],
        context,
      ),
      context,
    );
  }

  if (location.node.enum !== undefined) {
    if (!Array.isArray(location.node.enum)) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    allowed = intersectBoundedStringSets(
      allowed,
      finiteBoundedStrings(
        location.node.enum.filter(
          (value): value is string => typeof value === "string",
        ),
        context,
      ),
      context,
    );
  }

  const referenced = referencedLocation(location, context, state);
  if (referenced !== null) {
    const values = evaluateBoundedStringSet(
      referenced.location,
      context,
      referenced.state,
    );
    if (values === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, values, context);
  }

  for (const [index, schema] of strictSchemaObjectArray(
    location.node.allOf,
  ).entries()) {
    const values = evaluateBoundedStringSet(
      { node: schema, path: [...location.path, "allOf", String(index)] },
      context,
      state,
    );
    if (values === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, values, context);
  }

  for (const keyword of ["oneOf", "anyOf"] as const) {
    if (location.node[keyword] === undefined) {
      continue;
    }
    const alternatives = strictSchemaObjectArray(location.node[keyword]);
    if (alternatives.length > context.limits.maxSchemaSignatures) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    const alternativeSets: BoundedStringSet[] = [];
    for (const [index, schema] of alternatives.entries()) {
      const values = evaluateBoundedStringSet(
        { node: schema, path: [...location.path, keyword, String(index)] },
        context,
        state,
      );
      if (values === null) {
        return null;
      }
      alternativeSets.push(values);
    }
    const combined =
      keyword === "anyOf"
        ? unionBoundedStringSets(alternativeSets, context)
        : exactlyOneBoundedStringSet(alternativeSets, context);
    if (combined === null) {
      return null;
    }
    allowed = intersectBoundedStringSets(allowed, combined, context);
  }

  return allowed;
}

function hasUnsupportedStringConstraint(node: SchemaObject): boolean {
  return [
    "$dynamicRef",
    "$recursiveRef",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
    "else",
    "format",
    "if",
    "maxLength",
    "minLength",
    "not",
    "pattern",
    "then",
  ].some((keyword) => Object.hasOwn(node, keyword));
}

function allBoundedStrings(): BoundedStringSet {
  return { kind: "all" };
}

function finiteBoundedStrings(
  values: Iterable<string>,
  context: SchemaValidationContext,
): BoundedStringSet {
  const set = new Set(values);
  assertBoundedStringSetSize(set, context);
  return { kind: "finite", values: set };
}

function boundedStringSetHas(values: BoundedStringSet, value: string): boolean {
  return values.kind === "all" || values.values.has(value);
}

function intersectBoundedStringSets(
  left: BoundedStringSet,
  right: BoundedStringSet,
  context: SchemaValidationContext,
): BoundedStringSet {
  if (left.kind === "all") {
    return right;
  }
  if (right.kind === "all") {
    return left;
  }
  return finiteBoundedStrings(
    [...left.values].filter((value) => right.values.has(value)),
    context,
  );
}

function unionBoundedStringSets(
  sets: readonly BoundedStringSet[],
  context: SchemaValidationContext,
): BoundedStringSet {
  let union = finiteBoundedStrings([], context);
  for (const values of sets) {
    if (union.kind === "all" || values.kind === "all") {
      return allBoundedStrings();
    }
    union = finiteBoundedStrings([...union.values, ...values.values], context);
  }
  return union;
}

function exactlyOneBoundedStringSet(
  sets: readonly BoundedStringSet[],
  context: SchemaValidationContext,
): BoundedStringSet | null {
  const unboundedCount = sets.filter((values) => values.kind === "all").length;
  const finite = sets.filter(
    (values): values is Extract<BoundedStringSet, { readonly kind: "finite" }> =>
      values.kind === "finite",
  );
  if (unboundedCount > 1) {
    return finiteBoundedStrings([], context);
  }
  if (unboundedCount === 1) {
    return finite.every((values) => values.values.size === 0)
      ? allBoundedStrings()
      : null;
  }
  const boundary = new Set(finite.flatMap((values) => [...values.values]));
  assertBoundedStringSetSize(boundary, context);
  const allowed = new Set<string>();
  for (const value of boundary) {
    if (
      finite.filter((candidate) => candidate.values.has(value)).length === 1
    ) {
      allowed.add(value);
    }
  }
  return finiteBoundedStrings(allowed, context);
}

function assertBoundedStringSetSize(
  values: ReadonlySet<string>,
  context: SchemaValidationContext,
): void {
  if (values.size > context.limits.maxSchemaSignatures) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
}

function schemaHasObjectContract(
  location: SchemaLocation,
  required: readonly string[],
  properties: readonly string[],
  context: SchemaValidationContext,
): boolean {
  const signatures = objectSignatures(
    location,
    context,
    { activePaths: new Set() },
  );
  return signatures.length > 0 && signatures.every(
    (signature) =>
      required.every((field) => signature.required.has(field)) &&
      properties.every((field) => signature.properties.has(field)),
  );
}

function objectSignatures(
  location: SchemaLocation,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): readonly ObjectSignature[] {
  consumeSchemaOperation(context);
  const direct: ObjectSignature = {
    properties: new Set(Object.keys(strictSchemaRecord(location.node.properties))),
    required: new Set(strictStringArray(location.node.required)),
  };
  let signatures: readonly ObjectSignature[] = schemaTypeAllows(
    location.node,
    "object",
  )
    ? [direct]
    : [];

  const referenced = referencedLocation(location, context, state);
  if (referenced !== null) {
    signatures = mergeSignatureLists(
      signatures,
      objectSignatures(referenced.location, context, referenced.state),
      context,
    );
  }

  for (const [index, schema] of strictSchemaObjectArray(
    location.node.allOf,
  ).entries()) {
    signatures = mergeSignatureLists(
      signatures,
      objectSignatures(
        { node: schema, path: [...location.path, "allOf", String(index)] },
        context,
        state,
      ),
      context,
    );
  }

  for (const keyword of ["oneOf", "anyOf"] as const) {
    if (location.node[keyword] === undefined) {
      continue;
    }
    const alternatives = strictSchemaObjectArray(location.node[keyword]);
    if (alternatives.length === 0) {
      signatures = [];
      continue;
    }
    if (alternatives.length > context.limits.maxSchemaSignatures) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    const alternativeSignatures = alternatives.flatMap((schema, index) =>
      objectSignatures(
        { node: schema, path: [...location.path, keyword, String(index)] },
        context,
        state,
      ),
    );
    signatures = mergeSignatureLists(
      signatures,
      alternativeSignatures,
      context,
    );
  }
  return signatures;
}

function mergeSignatureLists(
  left: readonly ObjectSignature[],
  right: readonly ObjectSignature[],
  context: SchemaValidationContext,
): readonly ObjectSignature[] {
  if (left.length === 0 || right.length === 0) {
    return [];
  }
  if (left.length * right.length > context.limits.maxSchemaSignatures) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return left.flatMap((leftSignature) =>
    right.map((rightSignature) => ({
      properties: new Set([
        ...leftSignature.properties,
        ...rightSignature.properties,
      ]),
      required: new Set([...leftSignature.required, ...rightSignature.required]),
    })),
  );
}

function schemaTypeAllows(node: SchemaObject, expected: string): boolean {
  if (node.type === undefined) {
    return true;
  }
  const types = typeof node.type === "string" ? [node.type] : node.type;
  const knownTypes = new Set([
    "array",
    "boolean",
    "integer",
    "null",
    "number",
    "object",
    "string",
  ]);
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    !types.every((value) => typeof value === "string" && knownTypes.has(value)) ||
    new Set(types).size !== types.length
  ) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return types.includes(expected);
}

function objectPropertyLocations(
  location: SchemaLocation,
  property: string,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): readonly SchemaLocation[] {
  consumeSchemaOperation(context);
  const locations: SchemaLocation[] = [];
  const properties = strictSchemaRecord(location.node.properties);
  const direct = properties[property];
  if (isSchemaObject(direct)) {
    locations.push({
      node: direct,
      path: [...location.path, "properties", property],
    });
  } else if (direct !== undefined) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }

  const referenced = referencedLocation(location, context, state);
  if (referenced !== null) {
    locations.push(
      ...objectPropertyLocations(
        referenced.location,
        property,
        context,
        referenced.state,
      ),
    );
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    for (const [index, schema] of strictSchemaObjectArray(
      location.node[keyword],
    ).entries()) {
      locations.push(
        ...objectPropertyLocations(
          { node: schema, path: [...location.path, keyword, String(index)] },
          property,
          context,
          state,
        ),
      );
    }
  }
  if (locations.length > context.limits.maxSchemaSignatures) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return locations;
}

function schemaTargetsLocation(
  location: SchemaLocation,
  target: SchemaLocation,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): boolean {
  consumeSchemaOperation(context);
  if (location.node === target.node) {
    return true;
  }
  const referenced = referencedLocation(location, context, state);
  if (
    referenced !== null &&
    schemaTargetsLocation(
      referenced.location,
      target,
      context,
      referenced.state,
    )
  ) {
    return true;
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    for (const [index, schema] of strictSchemaObjectArray(
      location.node[keyword],
    ).entries()) {
      if (
        schemaTargetsLocation(
          { node: schema, path: [...location.path, keyword, String(index)] },
          target,
          context,
          state,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function referencedLocation(
  location: SchemaLocation,
  context: SchemaValidationContext,
  state: SchemaReferenceState,
): { readonly location: SchemaLocation; readonly state: SchemaReferenceState } | null {
  if (location.node.$ref === undefined) {
    return null;
  }
  if (typeof location.node.$ref !== "string") {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  const resolved = resolveLocalReference(context, location.node.$ref);
  const key = JSON.stringify(resolved.path);
  if (state.activePaths.has(key)) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return {
    location: resolved,
    state: {
      activePaths: new Set([...state.activePaths, key]),
    },
  };
}

function resolveLocalReference(
  context: SchemaValidationContext,
  reference: string,
): SchemaLocation {
  consumeSchemaOperation(context);
  if (!reference.startsWith("#")) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  if (pointer === "") {
    return { node: context.root, path: [] };
  }
  if (!pointer.startsWith("/")) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  const path = pointer
    .slice(1)
    .split("/")
    .map(decodePointerSegment);
  let current: unknown = context.root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
      }
      current = current[Number(segment)];
    } else if (isSchemaObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
  }
  if (!isSchemaObject(current)) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return { node: current, path };
}

function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function requireLocation(
  context: SchemaValidationContext,
  path: readonly string[],
): SchemaLocation {
  consumeSchemaOperation(context);
  let current: unknown = context.root;
  for (const segment of path) {
    if (!isSchemaObject(current) || !Object.hasOwn(current, segment)) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
    current = current[segment];
  }
  if (!isSchemaObject(current)) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
  return { node: current, path };
}

function consumeSchemaOperation(context: SchemaValidationContext): void {
  context.operations += 1;
  if (context.operations > context.limits.maxSchemaOperations) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
}

function schemaRecord(value: unknown): SchemaObject | undefined {
  return isSchemaObject(value) ? value : undefined;
}

function strictSchemaRecord(value: unknown): SchemaObject {
  if (value === undefined) {
    return {};
  }
  if (!isSchemaObject(value)) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return value;
}

function strictSchemaObjectArray(value: unknown): readonly SchemaObject[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isSchemaObject)) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return value;
}

function strictStringArray(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }
  return value;
}

function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
