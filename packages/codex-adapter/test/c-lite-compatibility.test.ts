import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TESTED_CODEX_VERSION,
  checkOwnedCodexCompatibility,
  deriveOwnedCodexExecutablePath,
  getCodexRuntimeTarget,
  type CLiteCompatibilityCheckOptions,
  type CodexRuntimeSelection,
} from "../src/index.js";
import { checkOwnedCodexCompatibilityWithCleanupForTest } from "../src/c-lite-compatibility.js";

const PROBE_PREFIX = "ctc-codex-c-lite-";

type BundleScenario =
  | "incompatible-approval"
  | "incompatible-text-input"
  | "incompatible-usage"
  | "missing-method"
  | "missing-required-field"
  | "valid";

type GeneratorBehavior = "malformed" | "missing" | "nonzero" | "signal" | "valid";

let fixtureRoot: string;
let runtimeRoot: string;
let capturePath: string;
let options: CLiteCompatibilityCheckOptions;
let originalCodexHome: string | undefined;
let originalHome: string | undefined;
let originalNodeEnvironment: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "ctc-c-lite-test-"));
  runtimeRoot = join(fixtureRoot, "runtime");
  capturePath = join(fixtureRoot, "capture.txt");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  options = { runtimeOwnership: { trustedRuntimeRoot: runtimeRoot } };
  originalCodexHome = process.env.CODEX_HOME;
  originalHome = process.env.HOME;
  originalNodeEnvironment = process.env.NODE_ENV;
  originalPath = process.env.PATH;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  restoreEnvironmentVariable("CODEX_HOME", originalCodexHome);
  restoreEnvironmentVariable("HOME", originalHome);
  restoreEnvironmentVariable("NODE_ENV", originalNodeEnvironment);
  restoreEnvironmentVariable("PATH", originalPath);
  rmSync(fixtureRoot, { force: true, recursive: true });
});

describe("C-lite trusted owned-candidate compatibility", () => {
  it("uses only the canonical owned binary and confines both generators to cleaned isolation", () => {
    const ambient = createAmbientFixture();
    const ambientSentinel = join(ambient.pathDirectory, "ambient-codex-used");
    writeExecutable(
      join(ambient.pathDirectory, "codex"),
      `printf '%s\n' used > ${shellSingleQuote(ambientSentinel)}`,
    );
    process.env.HOME = ambient.home;
    process.env.CODEX_HOME = ambient.codexHome;
    process.env.PATH = ambient.pathDirectory;

    const canonicalCandidate = installCandidate("valid", "valid");
    const leftoversBefore = compatibilityProbeNames();
    const result = checkOwnedCodexCompatibility(options);
    const leftoversAfter = compatibilityProbeNames();

    expect(result).toMatchObject({
      compatible: true,
      consumedProtocolContractPassed: true,
      exactTestedCodexVersion: TESTED_CODEX_VERSION,
      experimentalCapabilitiesActivated: false,
      failure: null,
      runtimeTarget: getCodexRuntimeTarget(),
      schemaGenerationSucceeded: true,
      trustedOwnedCandidateUsed: true,
    });
    expect(result.provenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(leftoversAfter).toEqual(leftoversBefore);
    expect(existsSync(ambientSentinel)).toBe(false);
    expect(existsSync(join(ambient.home, "arg0-sentinel"))).toBe(false);
    expect(existsSync(join(ambient.codexHome, "arg0-sentinel"))).toBe(false);

    const captures = readFileSync(capturePath, "utf8").trimEnd().split("\n");
    expect(captures).toHaveLength(12);
    const first = captures.slice(0, 6);
    const second = captures.slice(6, 12);
    expect(first[0]).toBe(canonicalCandidate);
    expect(second[0]).toBe(canonicalCandidate);
    expect(first[5]).toContain("app-server generate-ts --out");
    expect(second[5]).toContain("app-server generate-json-schema --out");
    expect(captures.join(" ")).not.toContain("--experimental");

    for (const group of [first, second]) {
      const home = group[1] as string;
      const codexHome = group[2] as string;
      const temporaryDirectory = group[3] as string;
      const pathDirectory = group[4] as string;
      const probeRoot = dirname(home);
      expect(home).toBe(join(probeRoot, "home"));
      expect(codexHome).toBe(join(probeRoot, "codex-home"));
      expect(temporaryDirectory).toBe(join(probeRoot, "tmp"));
      expect(pathDirectory).toBe(join(probeRoot, "bin"));
      expect(home).not.toBe(ambient.home);
      expect(codexHome).not.toBe(ambient.codexHome);
      expect(pathDirectory).not.toBe(ambient.pathDirectory);
      const generatedOutput = group[5]?.split(" ").at(-1);
      expect(generatedOutput).toBeDefined();
      expect(generatedOutput?.startsWith(`${probeRoot}/schemas/`)).toBe(true);
      expect(existsSync(probeRoot)).toBe(false);
    }
  });

  it("fails closed for an untested owned binary without running a generator", () => {
    installCandidate("valid", "valid", "codex-cli 0.148.0-alpha.8");
    expect(checkOwnedCodexCompatibility(options)).toMatchObject({
      compatible: false,
      failure: "UNTESTED_CODEX_VERSION",
      schemaGenerationSucceeded: false,
      trustedOwnedCandidateUsed: false,
    });
    expect(existsSync(capturePath)).toBe(false);
  });

  it("does not substitute an ambient PATH binary when the owned candidate is absent", () => {
    const ambient = createAmbientFixture();
    const ambientSentinel = join(ambient.pathDirectory, "ambient-codex-used");
    writeExecutable(
      join(ambient.pathDirectory, "codex"),
      [
        `printf '%s\\n' used > ${shellSingleQuote(ambientSentinel)}`,
        `printf '%s\\n' ${shellSingleQuote(TESTED_CODEX_VERSION)}`,
      ].join("\n"),
    );
    process.env.PATH = ambient.pathDirectory;

    expect(checkOwnedCodexCompatibility(options)).toMatchObject({
      compatible: false,
      failure: "RUNTIME_RESOLUTION_FAILED",
      schemaGenerationSucceeded: false,
      trustedOwnedCandidateUsed: false,
    });
    expect(existsSync(ambientSentinel)).toBe(false);
  });

  it.each([
    ["missing-method", "PROTOCOL_METHOD_MISSING"],
    ["missing-required-field", "PROTOCOL_SHAPE_INCOMPATIBLE"],
    ["incompatible-approval", "PROTOCOL_SHAPE_INCOMPATIBLE"],
    ["incompatible-usage", "PROTOCOL_SHAPE_INCOMPATIBLE"],
    ["incompatible-text-input", "PROTOCOL_SHAPE_INCOMPATIBLE"],
  ] as const)("fails the consumed contract for %s", (scenario, failure) => {
    installCandidate(scenario, "valid");
    const result = checkOwnedCodexCompatibility(options);
    expect(result).toMatchObject({
      compatible: false,
      consumedProtocolContractPassed: false,
      failure,
      schemaGenerationSucceeded: true,
      trustedOwnedCandidateUsed: true,
    });
    expect(compatibilityProbeNames()).toEqual([]);
  });

  it.each([
    ["nonzero", "SCHEMA_GENERATOR_FAILED"],
    ["signal", "SCHEMA_GENERATOR_SIGNALED"],
    ["missing", "SCHEMA_OUTPUT_MISSING"],
    ["malformed", "SCHEMA_OUTPUT_MALFORMED"],
  ] as const)("sanitizes %s generator/output failure and cleans isolation", (behavior, failure) => {
    installCandidate("valid", behavior);
    const result = checkOwnedCodexCompatibility(options);
    expect(result).toMatchObject({ compatible: false, failure });
    expect(JSON.stringify(result)).not.toContain("private generator diagnostic");
    expect(JSON.stringify(result)).not.toContain(runtimeRoot);
    expect(compatibilityProbeNames()).toEqual([]);
  });

  it("fails closed when successful validation cannot clean its disposable root", () => {
    installCandidate("valid", "valid");
    let retainedRoot: string | undefined;
    const result = checkOwnedCodexCompatibilityWithCleanupForTest(options, (root) => {
      retainedRoot = root;
      throw new Error("private cleanup diagnostic");
    });
    try {
      expect(result).toMatchObject({
        compatible: false,
        consumedProtocolContractPassed: true,
        failure: "CLEANUP_FAILED",
        schemaGenerationSucceeded: true,
        trustedOwnedCandidateUsed: true,
      });
      expect(JSON.stringify(result)).not.toContain("private cleanup diagnostic");
      expect(retainedRoot).toBeDefined();
      expect(existsSync(retainedRoot as string)).toBe(true);
    } finally {
      if (retainedRoot !== undefined) {
        rmSync(retainedRoot, { force: true, recursive: true });
      }
    }
  });
});

function installCandidate(
  scenario: BundleScenario,
  behavior: GeneratorBehavior,
  versionOutput: string = TESTED_CODEX_VERSION,
): string {
  const selection = {
    target: getCodexRuntimeTarget(),
    version: "0.148.0-alpha.9",
  } as const satisfies CodexRuntimeSelection;
  const executablePath = deriveOwnedCodexExecutablePath(
    selection,
    options.runtimeOwnership,
  );
  mkdirSync(dirname(executablePath), { recursive: true });
  writeExecutable(
    executablePath,
    fakeCandidateBody(JSON.stringify(buildCompatibilityBundle(scenario)), behavior, versionOutput),
  );
  return realpathSync(executablePath);
}

function fakeCandidateBody(
  bundle: string,
  behavior: GeneratorBehavior,
  versionOutput: string,
): string {
  const jsonBody =
    behavior === "missing"
      ? "exit 0"
      : behavior === "malformed"
        ? 'printf \'%s\' \'{\' > "$out/codex_app_server_protocol.v2.schemas.json"'
        : `printf '%s' ${shellSingleQuote(bundle)} > "$out/codex_app_server_protocol.v2.schemas.json"`;
  const behaviorGuard =
    behavior === "nonzero"
      ? "printf '%s\\n' 'private generator diagnostic' >&2; exit 17"
      : behavior === "signal"
        ? "kill -TERM $$"
        : "";
  return [
    'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
    `  printf '%s\\n' ${shellSingleQuote(versionOutput)}`,
    "  exit 0",
    "fi",
    '[ "$#" -eq 4 ] || exit 9',
    '[ "$1" = "app-server" ] || exit 9',
    '[ "$3" = "--out" ] || exit 9',
    `printf '%s\\n' "$0" "$HOME" "$CODEX_HOME" "$TMPDIR" "$PATH" "$*" >> ${shellSingleQuote(capturePath)}`,
    '/bin/mkdir -p "$HOME" "$CODEX_HOME" "$TMPDIR" "$PATH"',
    `printf '%s\\n' isolated > "$HOME/arg0-sentinel"`,
    `printf '%s\\n' isolated > "$CODEX_HOME/arg0-sentinel"`,
    `printf '%s\\n' isolated > "$TMPDIR/arg0-sentinel"`,
    `printf '%s\\n' isolated > "$PATH/arg0-sentinel"`,
    'out="$4"',
    '/bin/mkdir -p "$out"',
    'if [ "$2" = "generate-ts" ]; then',
    `  printf '%s\\n' 'export type Generated = true;' > "$out/protocol.ts"`,
    "  exit 0",
    "fi",
    '[ "$2" = "generate-json-schema" ] || exit 9',
    behaviorGuard,
    jsonBody,
  ].join("\n");
}

function buildCompatibilityBundle(scenario: BundleScenario): Record<string, unknown> {
  const methodSchemas = [
    methodSchema("initialize", "InitializeParams"),
    methodSchema("thread/start", "ThreadStartParams"),
    methodSchema("thread/resume", "ThreadResumeParams"),
    methodSchema("turn/start", "TurnStartParams"),
    methodSchema("turn/interrupt", "TurnInterruptParams"),
    methodSchema("thread/goal/set", "ThreadGoalSetParams"),
    methodSchema("thread/goal/get", "ThreadGoalGetParams"),
    methodSchema("skills/list", "SkillsListParams"),
    methodSchema("initialized", "EmptyParams"),
    methodSchema("thread/started", "EmptyParams"),
    methodSchema("thread/goal/updated", "EmptyParams"),
    methodSchema("turn/started", "EmptyParams"),
    methodSchema("item/started", "EmptyParams"),
    methodSchema("item/agentMessage/delta", "EmptyParams"),
    methodSchema("item/completed", "EmptyParams"),
    methodSchema("thread/tokenUsage/updated", "EmptyParams"),
    methodSchema("turn/completed", "EmptyParams"),
    methodSchema("serverRequest/resolved", "EmptyParams"),
    methodSchema(
      "item/commandExecution/requestApproval",
      "CommandExecutionApprovalParams",
    ),
    methodSchema("item/fileChange/requestApproval", "FileChangeApprovalParams"),
    methodSchema("model/list", "EmptyParams"),
  ].filter(
    (schema) =>
      scenario !== "missing-method" ||
      ((schema.properties as Record<string, Record<string, string>>).method?.const !==
        "skills/list"),
  );

  const approvalRequired =
    scenario === "incompatible-approval"
      ? ["itemId", "threadId", "turnId"]
      : ["itemId", "startedAtMs", "threadId", "turnId"];
  const tokenRequired =
    scenario === "incompatible-usage"
      ? [
          "cachedInputTokens",
          "inputTokens",
          "outputTokens",
          "reasoningOutputTokens",
        ]
      : [
          "cachedInputTokens",
          "inputTokens",
          "outputTokens",
          "reasoningOutputTokens",
          "totalTokens",
        ];
  const textRequired =
    scenario === "incompatible-text-input" ? ["type"] : ["text", "type"];

  return {
    $defs: {
      ApprovalDecision: {
        enum: ["accept", "acceptForSession", "cancel", "decline"],
      },
      CommandExecutionApprovalParams: objectSchema(
        ["itemId", "startedAtMs", "threadId", "turnId"],
        approvalRequired,
      ),
      EmptyParams: objectSchema([], []),
      FileChangeApprovalParams: objectSchema(
        ["itemId", "startedAtMs", "threadId", "turnId"],
        ["itemId", "startedAtMs", "threadId", "turnId"],
      ),
      InitializeParams: objectSchema(["clientInfo"], ["clientInfo"]),
      InitializeResponse: objectSchema(
        ["codexHome", "platformFamily", "platformOs", "userAgent"],
        ["codexHome", "platformFamily", "platformOs", "userAgent"],
      ),
      RequestsAndNotifications: { oneOf: methodSchemas },
      SkillsListParams: objectSchema([], []),
      TextInput: {
        properties: {
          text: {},
          text_elements: {},
          type: { const: "text" },
        },
        required: textRequired,
        type: "object",
      },
      Thread: objectSchema(
        [
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
        [
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
      ),
      ThreadGoalGetParams: objectSchema(["threadId"], ["threadId"]),
      ThreadGoalSetParams: objectSchema(["threadId"], ["threadId"]),
      ThreadResumeParams: objectSchema(
        ["threadId"],
        scenario === "missing-required-field" ? [] : ["threadId"],
      ),
      ThreadStartParams: objectSchema(
        ["baseInstructions", "developerInstructions", "model", "modelProvider"],
        [],
      ),
      ThreadStartResponse: objectSchema(
        [
          "approvalPolicy",
          "approvalsReviewer",
          "cwd",
          "model",
          "modelProvider",
          "sandbox",
          "thread",
        ],
        [
          "approvalPolicy",
          "approvalsReviewer",
          "cwd",
          "model",
          "modelProvider",
          "sandbox",
          "thread",
        ],
      ),
      ThreadTokenUsage: objectSchema(
        ["last", "modelContextWindow", "total"],
        ["last", "total"],
      ),
      TokenUsage: objectSchema(
        [
          "cachedInputTokens",
          "inputTokens",
          "outputTokens",
          "reasoningOutputTokens",
          "totalTokens",
        ],
        tokenRequired,
      ),
      Turn: objectSchema(["id", "items", "status"], ["id", "items", "status"]),
      TurnInterruptParams: objectSchema(
        ["threadId", "turnId"],
        ["threadId", "turnId"],
      ),
      TurnStartParams: objectSchema(
        ["input", "model", "threadId"],
        ["input", "threadId"],
      ),
    },
  };
}

function methodSchema(method: string, paramsDefinition: string): Record<string, unknown> {
  return {
    properties: {
      method: { const: method },
      params: { $ref: `#/$defs/${paramsDefinition}` },
    },
    required: ["method", "params"],
    type: "object",
  };
}

function objectSchema(
  propertyNames: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  return {
    properties: Object.fromEntries(propertyNames.map((property) => [property, {}])),
    required,
    type: "object",
  };
}

function createAmbientFixture(): {
  readonly codexHome: string;
  readonly home: string;
  readonly pathDirectory: string;
} {
  const ambient = {
    codexHome: join(fixtureRoot, "ambient-codex-home"),
    home: join(fixtureRoot, "ambient-home"),
    pathDirectory: join(fixtureRoot, "ambient-bin"),
  };
  mkdirSync(ambient.codexHome);
  mkdirSync(ambient.home);
  mkdirSync(ambient.pathDirectory);
  return ambient;
}

function compatibilityProbeNames(): readonly string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(PROBE_PREFIX))
    .sort();
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ["#!/bin/sh", body, ""].join("\n"), {
    encoding: "utf8",
    mode: 0o700,
  });
  chmodSync(path, 0o700);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
