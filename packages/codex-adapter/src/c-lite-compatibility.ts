import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

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
const MAX_GENERATED_JSON_FILES = 1_024;
const MAX_GENERATED_JSON_FILE_BYTES = 32 * 1024 * 1024;
const MAX_GENERATED_JSON_TOTAL_BYTES = 128 * 1024 * 1024;
const PRIVATE_DIRECTORY_FORBIDDEN_MODE = 0o077;
const TESTED_RELEASE_VERSION = TESTED_CODEX_VERSION.replace("codex-cli ", "");
const V2_SCHEMA_BUNDLE_NAME = "codex_app_server_protocol.v2.schemas.json";

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

const REQUIRED_OBJECT_CONTRACTS = [
  {
    properties: ["codexHome", "platformFamily", "platformOs", "userAgent"],
    required: ["codexHome", "platformFamily", "platformOs", "userAgent"],
  },
  {
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
    properties: ["id", "items", "status"],
    required: ["id", "items", "status"],
  },
  {
    properties: ["last", "modelContextWindow", "total"],
    required: ["last", "total"],
  },
  {
    properties: [
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

const REQUIRED_METHOD_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "thread/start": [
    "baseInstructions",
    "developerInstructions",
    "model",
    "modelProvider",
  ],
  "turn/start": ["input", "model", "threadId"],
};

const REQUIRED_APPROVAL_PARAMS = ["itemId", "startedAtMs", "threadId", "turnId"];
const SUPPORTED_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "cancel",
  "decline",
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

interface SchemaDocument {
  readonly absolutePath: string;
  readonly value: SchemaObject;
}

interface SchemaLocation {
  readonly document: SchemaDocument;
  readonly node: SchemaObject;
}

interface SchemaObject {
  readonly [key: string]: unknown;
}

interface ObjectSignature {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

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
): void {
  const child = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: childEnvironment,
    maxBuffer: GENERATOR_OUTPUT_MAX_BYTES,
    shell: false,
    stdio: "pipe",
    timeout: GENERATOR_TIMEOUT_MILLISECONDS,
  });

  if (child.signal !== null) {
    throw new CLiteCompatibilityFailure("SCHEMA_GENERATOR_SIGNALED");
  }
  if (child.error !== undefined) {
    const code = (child.error as NodeJS.ErrnoException).code;
    throw new CLiteCompatibilityFailure(
      code === "ENOENT"
        ? "SCHEMA_GENERATOR_START_FAILED"
        : "SCHEMA_GENERATOR_FAILED",
    );
  }
  if (child.status !== 0) {
    throw new CLiteCompatibilityFailure("SCHEMA_GENERATOR_FAILED");
  }
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
): ValidationSuccess {
  const typescriptDirectory = join(outputDirectory, "typescript");
  const jsonSchemaDirectory = join(outputDirectory, "json-schema");
  if (!containsGeneratedFile(typescriptDirectory, ".ts")) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }

  const documents = readSchemaDocuments(jsonSchemaDirectory);
  const bundle = documents.find(
    (document) => document.absolutePath === join(jsonSchemaDirectory, V2_SCHEMA_BUNDLE_NAME),
  );
  if (bundle === undefined) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }

  validateConsumedProtocolContract(documents);
  const bundleText = readFileSync(bundle.absolutePath, "utf8");
  return {
    provenanceSha256: createHash("sha256").update(bundleText).digest("hex"),
  };
}

function containsGeneratedFile(root: string, extension: string): boolean {
  let found = false;
  walkRegularFiles(root, (path) => {
    if (extname(path) === extension) {
      found = true;
    }
  });
  return found;
}

function readSchemaDocuments(root: string): readonly SchemaDocument[] {
  const documents: SchemaDocument[] = [];
  let totalBytes = 0;
  walkRegularFiles(root, (path) => {
    if (extname(path) !== ".json") {
      return;
    }
    if (documents.length >= MAX_GENERATED_JSON_FILES) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    const stats = lstatSync(path);
    if (stats.size > MAX_GENERATED_JSON_FILE_BYTES) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_GENERATED_JSON_TOTAL_BYTES) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    if (!isSchemaObject(parsed)) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    documents.push({ absolutePath: path, value: parsed });
  });
  if (documents.length === 0) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }
  return documents;
}

function walkRegularFiles(root: string, visit: (path: string) => void): void {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MISSING");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
  }

  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
    if (stats.isDirectory()) {
      walkRegularFiles(path, visit);
    } else if (stats.isFile()) {
      visit(path);
    } else {
      throw new CLiteCompatibilityFailure("SCHEMA_OUTPUT_MALFORMED");
    }
  }
}

function validateConsumedProtocolContract(documents: readonly SchemaDocument[]): void {
  const expectedMethods = [
    ...SUPPORTED_CLIENT_REQUEST_METHODS,
    ...SUPPORTED_CLIENT_NOTIFICATION_METHODS,
    ...SUPPORTED_SERVER_NOTIFICATION_METHODS,
    ...SUPPORTED_SERVER_REQUEST_METHODS,
  ];
  for (const method of expectedMethods) {
    if (findMethodLocations(documents, method).length === 0) {
      throw new CLiteCompatibilityFailure("PROTOCOL_METHOD_MISSING");
    }
  }

  for (const [method, required] of Object.entries(REQUIRED_REQUEST_PARAMS)) {
    if (!methodParamsMatch(documents, method, required, required)) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }
  for (const [method, properties] of Object.entries(REQUIRED_METHOD_PROPERTIES)) {
    const required = REQUIRED_REQUEST_PARAMS[method] ?? [];
    if (!methodParamsMatch(documents, method, required, properties)) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }
  for (const method of SUPPORTED_SERVER_REQUEST_METHODS) {
    if (!methodParamsMatch(documents, method, REQUIRED_APPROVAL_PARAMS, REQUIRED_APPROVAL_PARAMS)) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }

  for (const contract of REQUIRED_OBJECT_CONTRACTS) {
    if (!findObjectContract(documents, contract.required, contract.properties)) {
      throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
    }
  }
  if (!findTextInputContract(documents) || !findProperty(documents, "text_elements")) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
  if (!findAllowedLiterals(documents, SUPPORTED_APPROVAL_DECISIONS)) {
    throw new CLiteCompatibilityFailure("PROTOCOL_SHAPE_INCOMPATIBLE");
  }
}

function findMethodLocations(
  documents: readonly SchemaDocument[],
  method: string,
): readonly SchemaLocation[] {
  const locations: SchemaLocation[] = [];
  for (const document of documents) {
    walkSchemaObjects(document.value, (node) => {
      const properties = schemaRecord(node.properties);
      const methodSchema = properties?.method;
      if (
        isSchemaObject(methodSchema) &&
        schemaAllowsLiteral({ document, node: methodSchema }, method, documents, new Set())
      ) {
        locations.push({ document, node });
      }
    });
  }
  return locations;
}

function methodParamsMatch(
  documents: readonly SchemaDocument[],
  method: string,
  required: readonly string[],
  properties: readonly string[],
): boolean {
  return findMethodLocations(documents, method).some((location) => {
    const params = schemaRecord(location.node.properties)?.params;
    return (
      isSchemaObject(params) &&
      schemaHasObjectContract(
        { document: location.document, node: params },
        required,
        properties,
        documents,
        new Set(),
      )
    );
  });
}

function findObjectContract(
  documents: readonly SchemaDocument[],
  required: readonly string[],
  properties: readonly string[],
): boolean {
  for (const document of documents) {
    let found = false;
    walkSchemaObjects(document.value, (node) => {
      if (
        !found &&
        schemaHasObjectContract(
          { document, node },
          required,
          properties,
          documents,
          new Set(),
        )
      ) {
        found = true;
      }
    });
    if (found) {
      return true;
    }
  }
  return false;
}

function findTextInputContract(documents: readonly SchemaDocument[]): boolean {
  for (const document of documents) {
    let found = false;
    walkSchemaObjects(document.value, (node) => {
      const properties = schemaRecord(node.properties);
      const typeSchema = properties?.type;
      if (
        !found &&
        isSchemaObject(typeSchema) &&
        schemaAllowsLiteral(
          { document, node: typeSchema },
          "text",
          documents,
          new Set(),
        ) &&
        schemaHasObjectContract(
          { document, node },
          ["text", "type"],
          ["text", "type"],
          documents,
          new Set(),
        )
      ) {
        found = true;
      }
    });
    if (found) {
      return true;
    }
  }
  return false;
}

function findProperty(documents: readonly SchemaDocument[], property: string): boolean {
  return documents.some((document) => {
    let found = false;
    walkSchemaObjects(document.value, (node) => {
      if (!found && Object.hasOwn(schemaRecord(node.properties) ?? {}, property)) {
        found = true;
      }
    });
    return found;
  });
}

function findAllowedLiterals(
  documents: readonly SchemaDocument[],
  expected: readonly string[],
): boolean {
  for (const document of documents) {
    let found = false;
    walkSchemaObjects(document.value, (node) => {
      if (found) {
        return;
      }
      const values = collectAllowedLiterals(
        { document, node },
        documents,
        new Set(),
      );
      if (expected.every((value) => values.has(value))) {
        found = true;
      }
    });
    if (found) {
      return true;
    }
  }
  return false;
}

function schemaHasObjectContract(
  location: SchemaLocation,
  required: readonly string[],
  properties: readonly string[],
  documents: readonly SchemaDocument[],
  visited: ReadonlySet<string>,
): boolean {
  return objectSignatures(location, documents, visited).some(
    (signature) =>
      required.every((field) => signature.required.has(field)) &&
      properties.every((field) => signature.properties.has(field)),
  );
}

function objectSignatures(
  location: SchemaLocation,
  documents: readonly SchemaDocument[],
  visited: ReadonlySet<string>,
): readonly ObjectSignature[] {
  const direct: ObjectSignature = {
    properties: new Set(Object.keys(schemaRecord(location.node.properties) ?? {})),
    required: new Set(stringArray(location.node.required)),
  };
  let signatures: readonly ObjectSignature[] = [direct];

  const reference = location.node.$ref;
  if (typeof reference === "string") {
    const resolved = resolveReference(location.document, reference, documents);
    if (resolved === null) {
      return [];
    }
    const key = `${resolved.document.absolutePath}#${reference}`;
    if (visited.has(key)) {
      return [direct];
    }
    const nextVisited = new Set(visited);
    nextVisited.add(key);
    signatures = mergeSignatureLists(
      signatures,
      objectSignatures(resolved, documents, nextVisited),
    );
  }

  const allOf = schemaObjectArray(location.node.allOf);
  for (const schema of allOf) {
    signatures = mergeSignatureLists(
      signatures,
      objectSignatures(
        { document: location.document, node: schema },
        documents,
        visited,
      ),
    );
  }

  const alternatives = [
    ...schemaObjectArray(location.node.oneOf),
    ...schemaObjectArray(location.node.anyOf),
  ];
  if (alternatives.length > 0) {
    const alternativeSignatures = alternatives.flatMap((schema) =>
      objectSignatures(
        { document: location.document, node: schema },
        documents,
        visited,
      ),
    );
    signatures = mergeSignatureLists(signatures, alternativeSignatures);
  }
  return signatures;
}

function mergeSignatureLists(
  left: readonly ObjectSignature[],
  right: readonly ObjectSignature[],
): readonly ObjectSignature[] {
  if (right.length === 0) {
    return [];
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

function schemaAllowsLiteral(
  location: SchemaLocation,
  expected: string,
  documents: readonly SchemaDocument[],
  visited: ReadonlySet<string>,
): boolean {
  return collectAllowedLiterals(location, documents, visited).has(expected);
}

function collectAllowedLiterals(
  location: SchemaLocation,
  documents: readonly SchemaDocument[],
  visited: ReadonlySet<string>,
): ReadonlySet<string> {
  const values = new Set<string>();
  if (typeof location.node.const === "string") {
    values.add(location.node.const);
  }
  for (const value of stringArray(location.node.enum)) {
    values.add(value);
  }

  const reference = location.node.$ref;
  if (typeof reference === "string") {
    const resolved = resolveReference(location.document, reference, documents);
    if (resolved !== null) {
      const key = `${resolved.document.absolutePath}#${reference}`;
      if (!visited.has(key)) {
        const nextVisited = new Set(visited);
        nextVisited.add(key);
        for (const value of collectAllowedLiterals(resolved, documents, nextVisited)) {
          values.add(value);
        }
      }
    }
  }
  for (const schema of [
    ...schemaObjectArray(location.node.oneOf),
    ...schemaObjectArray(location.node.anyOf),
  ]) {
    for (const value of collectAllowedLiterals(
      { document: location.document, node: schema },
      documents,
      visited,
    )) {
      values.add(value);
    }
  }
  return values;
}

function resolveReference(
  currentDocument: SchemaDocument,
  reference: string,
  documents: readonly SchemaDocument[],
): SchemaLocation | null {
  const hashIndex = reference.indexOf("#");
  const filePart = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const pointer = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
  let document = currentDocument;
  if (filePart !== "") {
    let decodedFilePart: string;
    try {
      decodedFilePart = decodeURIComponent(filePart);
    } catch {
      return null;
    }
    const referencedPath = resolve(dirname(currentDocument.absolutePath), decodedFilePart);
    document = documents.find((candidate) => candidate.absolutePath === referencedPath) ?? document;
    if (document.absolutePath !== referencedPath) {
      return null;
    }
  }
  if (pointer === "") {
    return { document, node: document.value };
  }
  if (!pointer.startsWith("/")) {
    return null;
  }
  let current: unknown = document.value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isSchemaObject(current) || !Object.hasOwn(current, segment)) {
      return null;
    }
    current = current[segment];
  }
  return isSchemaObject(current) ? { document, node: current } : null;
}

function walkSchemaObjects(value: unknown, visit: (node: SchemaObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkSchemaObjects(item, visit);
    }
    return;
  }
  if (!isSchemaObject(value)) {
    return;
  }
  visit(value);
  for (const child of Object.values(value)) {
    walkSchemaObjects(child, visit);
  }
}

function schemaRecord(value: unknown): SchemaObject | undefined {
  return isSchemaObject(value) ? value : undefined;
}

function schemaObjectArray(value: unknown): readonly SchemaObject[] {
  return Array.isArray(value) ? value.filter(isSchemaObject) : [];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isSchemaObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
