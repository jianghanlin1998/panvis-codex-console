import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SUPPORTED_CLIENT_NOTIFICATION_METHODS,
  SUPPORTED_CLIENT_REQUEST_METHODS,
  SUPPORTED_SERVER_NOTIFICATION_METHODS,
  SUPPORTED_SERVER_REQUEST_METHODS,
  TESTED_CODEX_VERSION,
  checkOwnedCodexCompatibility,
  deriveOwnedCodexExecutablePath,
  getCodexRuntimeTarget,
  type CLiteCompatibilityCheckOptions,
  type CodexRuntimeSelection,
} from "../src/index.js";
import {
  checkOwnedCodexCompatibilityWithCleanupForTest,
  runSchemaGeneratorForTest,
  validateGeneratedCompatibilityOutputForTest,
} from "../src/c-lite-compatibility.js";

const PROBE_PREFIX = "ctc-codex-c-lite-";
const AUTHORITATIVE_BUNDLE = "codex_app_server_protocol.schemas.json";

type MutableSchema = Record<string, unknown>;
type GeneratorBehavior =
  | "first-nonzero"
  | "malformed"
  | "missing"
  | "nonzero"
  | "partial"
  | "signal"
  | "unexpected-output"
  | "valid";

interface MethodCase {
  readonly method: string;
  readonly root: "ClientNotification" | "ClientRequest" | "ServerNotification" | "ServerRequest";
}

const METHOD_CASES: readonly MethodCase[] = [
  ...SUPPORTED_CLIENT_REQUEST_METHODS.map((method) => ({
    method,
    root: "ClientRequest" as const,
  })),
  ...SUPPORTED_CLIENT_NOTIFICATION_METHODS.map((method) => ({
    method,
    root: "ClientNotification" as const,
  })),
  ...SUPPORTED_SERVER_NOTIFICATION_METHODS.map((method) => ({
    method,
    root: "ServerNotification" as const,
  })),
  ...SUPPORTED_SERVER_REQUEST_METHODS.map((method) => ({
    method,
    root: "ServerRequest" as const,
  })),
];

const REQUIRED_FIELD_CASES = [
  { fields: ["clientInfo"], path: ["definitions", "InitializeParams"] },
  { fields: ["threadId"], path: ["definitions", "v2", "ThreadResumeParams"] },
  { fields: ["input", "threadId"], path: ["definitions", "v2", "TurnStartParams"] },
  { fields: ["threadId", "turnId"], path: ["definitions", "v2", "TurnInterruptParams"] },
  { fields: ["threadId"], path: ["definitions", "v2", "ThreadGoalSetParams"] },
  { fields: ["threadId"], path: ["definitions", "v2", "ThreadGoalGetParams"] },
  {
    fields: ["itemId", "startedAtMs", "threadId", "turnId"],
    path: ["definitions", "CommandExecutionRequestApprovalParams"],
  },
  {
    fields: ["itemId", "startedAtMs", "threadId", "turnId"],
    path: ["definitions", "FileChangeRequestApprovalParams"],
  },
] as const;

const METHOD_PROPERTY_CASES = [
  {
    fields: [
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
    path: ["definitions", "v2", "ThreadStartParams"],
  },
  {
    fields: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "input",
      "model",
      "sandboxPolicy",
      "threadId",
    ],
    path: ["definitions", "v2", "TurnStartParams"],
  },
] as const;

const NAMED_OBJECT_CASES = [
  {
    fields: ["codexHome", "platformFamily", "platformOs", "userAgent"],
    path: ["definitions", "InitializeResponse"],
  },
  {
    fields: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ],
    path: ["definitions", "v2", "ThreadStartResponse"],
  },
  {
    fields: [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ],
    path: ["definitions", "v2", "ThreadResumeResponse"],
  },
  { fields: ["turn"], path: ["definitions", "v2", "TurnStartResponse"] },
  {
    fields: [
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
    path: ["definitions", "v2", "Thread"],
  },
  { fields: ["id", "items", "status"], path: ["definitions", "v2", "Turn"] },
  {
    fields: ["delta", "itemId", "threadId", "turnId"],
    path: ["definitions", "v2", "CommandExecutionOutputDeltaNotification"],
  },
  {
    fields: ["delta", "itemId", "threadId", "turnId"],
    path: ["definitions", "v2", "FileChangeOutputDeltaNotification"],
  },
  {
    fields: ["changes", "itemId", "threadId", "turnId"],
    path: ["definitions", "v2", "FileChangePatchUpdatedNotification"],
  },
  { fields: ["last", "total"], path: ["definitions", "v2", "ThreadTokenUsage"] },
  {
    fields: [
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ],
    path: ["definitions", "v2", "TokenUsageBreakdown"],
  },
] as const;

let fixtureRoot: string;
let runtimeRoot: string;
let capturePath: string;
let options: CLiteCompatibilityCheckOptions;
let outputSequence: number;
let originalAmbientSecret: string | undefined;
let originalCodexHome: string | undefined;
let originalHome: string | undefined;
let originalNodeEnvironment: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "ctc-c-lite-test-"));
  runtimeRoot = join(fixtureRoot, "runtime");
  capturePath = join(fixtureRoot, "capture.txt");
  outputSequence = 0;
  mkdirSync(runtimeRoot, { mode: 0o700 });
  options = { runtimeOwnership: { trustedRuntimeRoot: runtimeRoot } };
  originalAmbientSecret = process.env.CTC_C_LITE_AMBIENT_SECRET;
  originalCodexHome = process.env.CODEX_HOME;
  originalHome = process.env.HOME;
  originalNodeEnvironment = process.env.NODE_ENV;
  originalPath = process.env.PATH;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  restoreEnvironmentVariable("CTC_C_LITE_AMBIENT_SECRET", originalAmbientSecret);
  restoreEnvironmentVariable("CODEX_HOME", originalCodexHome);
  restoreEnvironmentVariable("HOME", originalHome);
  restoreEnvironmentVariable("NODE_ENV", originalNodeEnvironment);
  restoreEnvironmentVariable("PATH", originalPath);
  rmSync(fixtureRoot, { force: true, recursive: true });
});

describe("C-lite trusted owned-candidate compatibility", () => {
  it("uses only the canonical candidate and confines both generators to cleaned isolation", () => {
    const ambient = createAmbientFixture();
    const ambientSentinel = join(ambient.pathDirectory, "ambient-codex-used");
    writeExecutable(
      join(ambient.pathDirectory, "codex"),
      `printf '%s\n' used > ${shellSingleQuote(ambientSentinel)}`,
    );
    process.env.HOME = ambient.home;
    process.env.CODEX_HOME = ambient.codexHome;
    process.env.PATH = ambient.pathDirectory;
    process.env.CTC_C_LITE_AMBIENT_SECRET = "private-sentinel";

    const canonicalCandidate = installCandidate("valid");
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
    expect(existsSync(`${capturePath}.ambient-leak`)).toBe(false);
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
      expect(group[5]?.split(" ").at(-1)?.startsWith(`${probeRoot}/schemas/`)).toBe(
        true,
      );
      expect(existsSync(probeRoot)).toBe(false);
    }
  });

  it("discards bounded unexpected generator output", () => {
    installCandidate("unexpected-output");
    expect(checkOwnedCodexCompatibility(options)).toMatchObject({
      compatible: true,
      failure: null,
    });
  });

  it("fails closed for an untested owned binary without running a generator", () => {
    installCandidate("valid", "codex-cli 0.148.0-alpha.8");
    expect(checkOwnedCodexCompatibility(options)).toMatchObject({
      compatible: false,
      failure: "UNTESTED_CODEX_VERSION",
      schemaGenerationSucceeded: false,
      trustedOwnedCandidateUsed: false,
    });
    expect(existsSync(capturePath)).toBe(false);
  });

  it("does not substitute an ambient PATH binary when the candidate is absent", () => {
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
    ["first-nonzero", "SCHEMA_GENERATOR_FAILED"],
    ["nonzero", "SCHEMA_GENERATOR_FAILED"],
    ["partial", "SCHEMA_GENERATOR_FAILED"],
    ["signal", "SCHEMA_GENERATOR_SIGNALED"],
    ["missing", "SCHEMA_OUTPUT_MISSING"],
    ["malformed", "SCHEMA_OUTPUT_MALFORMED"],
  ] as const)("sanitizes %s generator/output failure and cleans isolation", (behavior, failure) => {
    installCandidate(behavior);
    const result = checkOwnedCodexCompatibility(options);
    expect(result).toMatchObject({ compatible: false, failure });
    expect(JSON.stringify(result)).not.toContain("private generator diagnostic");
    expect(JSON.stringify(result)).not.toContain(runtimeRoot);
    expect(compatibilityProbeNames()).toEqual([]);
  });

  it("fails closed when successful validation cannot clean its disposable root", () => {
    installCandidate("valid");
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

describe("association-correct semantic validation", () => {
  it("accepts the compact authoritative aggregate", () => {
    expect(validateBundle(buildCompatibilityBundle()).provenanceSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it.each(METHOD_CASES)("fails when the authoritative $root variant for $method is removed", ({ method, root }) => {
    const bundle = buildCompatibilityBundle();
    removeMethodVariant(bundle, root, method);
    expectBundleFailure(bundle, "PROTOCOL_METHOD_MISSING");
  });

  it("rejects a string method enum contradicted by a numeric type", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecord(methodVariant(bundle, "ClientRequest", "initialize").properties).method = {
      enum: ["initialize"],
      type: "number",
    };
    expectBundleFailure(bundle, "PROTOCOL_METHOD_MISSING");
  });

  it("rejects a composed method literal contradicted through allOf", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions"]).ThreadStartMethod = {
      const: "thread/start",
      type: "string",
    };
    schemaRecord(methodVariant(bundle, "ClientRequest", "thread/start").properties).method = {
      allOf: [
        { $ref: "#/definitions/ThreadStartMethod" },
        { type: "object" },
      ],
    };
    expectBundleFailure(bundle, "PROTOCOL_METHOD_MISSING");
  });

  it("rejects method type contradictions split across object allOf branches", () => {
    const bundle = buildCompatibilityBundle();
    const variant = methodVariant(bundle, "ClientRequest", "thread/resume");
    const original = structuredClone(variant);
    for (const key of Object.keys(variant)) {
      delete variant[key];
    }
    variant.allOf = [
      original,
      { properties: { method: { type: "number" } }, type: "object" },
    ];
    expectBundleFailure(bundle, "PROTOCOL_METHOD_MISSING");
  });

  it("fails closed for unsupported method string constraints", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecord(methodVariant(bundle, "ClientRequest", "skills/list").properties).method = {
      enum: ["skills/list"],
      pattern: "^unrelated$",
      type: "string",
    };
    expectBundleFailure(bundle, "PROTOCOL_METHOD_MISSING");
  });

  it.each(
    REQUIRED_FIELD_CASES.flatMap(({ fields, path }) =>
      fields.map((field) => ({ field, path })),
    ),
  )("fails when required field $field is removed from $path", ({ field, path }) => {
    const bundle = buildCompatibilityBundle();
    removeRequiredField(bundle, path, field);
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it.each(
    METHOD_PROPERTY_CASES.flatMap(({ fields, path }) =>
      fields.map((field) => ({ field, path })),
    ),
  )("fails when consumed optional field $field is absent from $path", ({ field, path }) => {
    const bundle = buildCompatibilityBundle();
    delete schemaRecordAt(bundle, [...path, "properties"])[field];
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it.each(
    NAMED_OBJECT_CASES.flatMap(({ fields, path }) =>
      fields.map((field) => ({ field, path })),
    ),
  )("fails when named contract $path loses required field $field", ({ field, path }) => {
    const bundle = buildCompatibilityBundle();
    removeRequiredField(bundle, path, field);
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects an authoritative Thread shape whose type excludes objects", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2", "Thread"]).type = "string";
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a params object contradicted through a reference and allOf", () => {
    const bundle = buildCompatibilityBundle();
    const v2 = schemaRecordAt(bundle, ["definitions", "v2"]);
    v2.ThreadStartParamsShape = structuredClone(v2.ThreadStartParams);
    v2.ThreadStartParams = {
      allOf: [
        { $ref: "#/definitions/v2/ThreadStartParamsShape" },
        { type: "array" },
      ],
    };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("requires cacheWriteInputTokens to remain present in TokenUsageBreakdown", () => {
    const bundle = buildCompatibilityBundle();
    delete schemaRecordAt(bundle, [
      "definitions",
      "v2",
      "TokenUsageBreakdown",
      "properties",
    ]).cacheWriteInputTokens;
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it.each([
    ["CommandExecutionApprovalDecision", "accept"],
    ["CommandExecutionApprovalDecision", "acceptForSession"],
    ["CommandExecutionApprovalDecision", "cancel"],
    ["CommandExecutionApprovalDecision", "decline"],
    ["FileChangeApprovalDecision", "accept"],
    ["FileChangeApprovalDecision", "acceptForSession"],
    ["FileChangeApprovalDecision", "cancel"],
    ["FileChangeApprovalDecision", "decline"],
  ] as const)("fails when %s loses supported decision %s", (definition, decision) => {
    const bundle = buildCompatibilityBundle();
    const variants = schemaArrayAt(bundle, ["definitions", definition, "oneOf"]);
    const variant = variants.find((candidate) => stringArray(candidate.enum).includes(decision));
    schemaRecord(variant).enum = ["unrelated"];
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects disjoint allOf approval decision enums", () => {
    const bundle = buildCompatibilityBundle();
    const decision = schemaRecordAt(bundle, [
      "definitions",
      "CommandExecutionApprovalDecision",
    ]);
    delete decision.oneOf;
    decision.allOf = [
      {
        enum: ["accept", "acceptForSession", "cancel", "decline"],
        type: "string",
      },
      { enum: ["unrelated"], type: "string" },
    ];
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a nested ref/allOf approval intersection with no strings", () => {
    const bundle = buildCompatibilityBundle();
    const definitions = schemaRecordAt(bundle, ["definitions"]);
    definitions.ApprovalBase = {
      enum: ["accept", "acceptForSession", "cancel", "decline"],
      type: "string",
    };
    definitions.ApprovalIntersection = {
      allOf: [
        { $ref: "#/definitions/ApprovalBase" },
        { enum: ["unrelated"], type: "string" },
      ],
    };
    definitions.FileChangeApprovalDecision = {
      allOf: [{ $ref: "#/definitions/ApprovalIntersection" }],
    };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("accepts overlapping allOf approval constraints", () => {
    const bundle = buildCompatibilityBundle();
    const definitions = schemaRecordAt(bundle, ["definitions"]);
    definitions.RequiredApprovalDecisions = {
      enum: ["accept", "acceptForSession", "cancel", "decline"],
      type: "string",
    };
    definitions.CommandExecutionApprovalDecision = {
      allOf: [
        {
          enum: [
            "accept",
            "acceptForSession",
            "cancel",
            "decline",
            "futureDecision",
          ],
          type: "string",
        },
        { $ref: "#/definitions/RequiredApprovalDecisions" },
      ],
    };
    expect(validateBundle(bundle)).toBeDefined();
  });

  it("accepts anyOf approval alternatives for the supported literals", () => {
    const bundle = buildCompatibilityBundle();
    const decision = schemaRecordAt(bundle, [
      "definitions",
      "FileChangeApprovalDecision",
    ]);
    delete decision.oneOf;
    decision.anyOf = ["accept", "acceptForSession", "cancel", "decline"].map(
      (value) => ({ const: value, type: "string" }),
    );
    expect(validateBundle(bundle)).toBeDefined();
  });

  it("rejects overlapping oneOf approval alternatives that exclude a required literal", () => {
    const bundle = buildCompatibilityBundle();
    const decision = schemaRecordAt(bundle, [
      "definitions",
      "CommandExecutionApprovalDecision",
    ]);
    decision.oneOf = [
      {
        enum: ["accept", "acceptForSession", "cancel", "decline"],
        type: "string",
      },
      { const: "accept", type: "string" },
    ];
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a valid object decoy when the authoritative Thread is broken", () => {
    const bundle = buildCompatibilityBundle();
    const original = structuredClone(schemaRecordAt(bundle, ["definitions", "v2", "Thread"]));
    removeRequiredField(bundle, ["definitions", "v2", "Thread"], "id");
    schemaRecordAt(bundle, ["definitions"]).UnrelatedThreadDecoy = original;
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects an unrelated approval enum decoy", () => {
    const bundle = buildCompatibilityBundle();
    const decision = schemaRecordAt(bundle, [
      "definitions",
      "CommandExecutionApprovalDecision",
    ]);
    decision.oneOf = schemaArrayAt(bundle, [
      "definitions",
      "CommandExecutionApprovalDecision",
      "oneOf",
    ]).filter((variant) => !stringArray(variant.enum).includes("cancel"));
    schemaRecordAt(bundle, ["definitions"]).ApprovalDecoy = {
      enum: ["accept", "acceptForSession", "cancel", "decline"],
    };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects an unrelated text_elements decoy", () => {
    const bundle = buildCompatibilityBundle();
    const text = textInputVariant(bundle);
    delete schemaRecord(text.properties).text_elements;
    schemaRecordAt(bundle, ["definitions"]).TextDecoy = objectSchema(
      ["text_elements"],
      [],
    );
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects removal of the consumed workspace-write sandbox mode", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2", "SandboxMode"]).enum = [
      "read-only",
      "danger-full-access",
    ];
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a workspaceWrite policy without writableRoots", () => {
    const bundle = buildCompatibilityBundle();
    const variant = schemaArrayAt(bundle, [
      "definitions",
      "v2",
      "SandboxPolicy",
      "oneOf",
    ]).find((candidate) =>
      stringArray(schemaRecord(schemaRecord(candidate.properties).type).enum).includes(
        "workspaceWrite",
      ),
    );
    if (variant === undefined) {
      throw new Error("Expected the workspaceWrite fixture variant.");
    }
    delete schemaRecord(variant.properties).writableRoots;
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it.each(["excludeSlashTmp", "excludeTmpdirEnvVar"])(
    "rejects a workspaceWrite policy without required temp control %s",
    (property) => {
      const bundle = buildCompatibilityBundle();
      const variant = schemaArrayAt(bundle, [
        "definitions",
        "v2",
        "SandboxPolicy",
        "oneOf",
      ]).find((candidate) =>
        stringArray(
          schemaRecord(schemaRecord(candidate.properties).type).enum,
        ).includes("workspaceWrite"),
      );
      if (variant === undefined) {
        throw new Error("Expected the workspaceWrite fixture variant.");
      }
      delete schemaRecord(variant.properties)[property];
      expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
    },
  );

  it("rejects a malformed consumed commandExecution item shape", () => {
    const bundle = buildCompatibilityBundle();
    const variant = schemaArrayAt(bundle, [
      "definitions",
      "v2",
      "ThreadItem",
      "oneOf",
    ]).find((candidate) =>
      stringArray(schemaRecord(schemaRecord(candidate.properties).type).enum).includes(
        "commandExecution",
      ),
    );
    if (variant === undefined) {
      throw new Error("Expected the commandExecution fixture variant.");
    }
    variant.required = stringArray(variant.required).filter(
      (field) => field !== "commandActions",
    );
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects FileUpdateChange when path is not required", () => {
    const bundle = buildCompatibilityBundle();
    removeRequiredField(
      bundle,
      ["definitions", "v2", "FileUpdateChange"],
      "path",
    );
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects FileUpdateChange when path is absent", () => {
    const bundle = buildCompatibilityBundle();
    delete schemaRecordAt(bundle, [
      "definitions",
      "v2",
      "FileUpdateChange",
      "properties",
    ]).path;
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects FileUpdateChange when path has the wrong type", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, [
      "definitions",
      "v2",
      "FileUpdateChange",
      "properties",
    ]).path = { type: "number" };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("does not accept an unrelated path definition when FileUpdateChange loses path", () => {
    const bundle = buildCompatibilityBundle();
    delete schemaRecordAt(bundle, [
      "definitions",
      "v2",
      "FileUpdateChange",
      "properties",
    ]).path;
    schemaRecordAt(bundle, ["definitions", "v2"]).PathDecoy = objectSchema(
      ["path"],
      ["path"],
    );
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a fileChange ThreadItem redirected to a shape-compatible change decoy", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).FileUpdateChangeDecoy =
      structuredClone(
        schemaRecordAt(bundle, ["definitions", "v2", "FileUpdateChange"]),
      );
    schemaRecord(
      schemaRecord(fileChangeItemVariant(bundle).properties).changes,
    ).items = { $ref: "#/definitions/v2/FileUpdateChangeDecoy" };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects patchUpdated changes redirected away from FileUpdateChange", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).FileUpdateChangeDecoy =
      structuredClone(
        schemaRecordAt(bundle, ["definitions", "v2", "FileUpdateChange"]),
      );
    schemaRecordAt(bundle, [
      "definitions",
      "v2",
      "FileChangePatchUpdatedNotification",
      "properties",
      "changes",
    ]).items = { $ref: "#/definitions/v2/FileUpdateChangeDecoy" };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects FileUpdateChange kind redirected away from PatchChangeKind", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).PatchChangeKindDecoy =
      structuredClone(
        schemaRecordAt(bundle, ["definitions", "v2", "PatchChangeKind"]),
      );
    schemaRecordAt(bundle, [
      "definitions",
      "v2",
      "FileUpdateChange",
      "properties",
    ]).kind = { $ref: "#/definitions/v2/PatchChangeKindDecoy" };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects removal of the consumed update move_path field", () => {
    const bundle = buildCompatibilityBundle();
    delete schemaRecord(patchChangeKindVariant(bundle, "update").properties)
      .move_path;
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a consumed update move_path field with the wrong type", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecord(patchChangeKindVariant(bundle, "update").properties).move_path = {
      type: "number",
    };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a duplicate-method decoy outside the authoritative message root", () => {
    const bundle = buildCompatibilityBundle();
    const actual = methodVariant(bundle, "ClientRequest", "thread/start");
    actual.required = ["method", "params"];
    schemaRecordAt(bundle, ["definitions"]).MethodDecoy = requestSchema(
      "thread/start",
      "#/definitions/v2/ThreadStartParams",
    );
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects duplicate supported variants inside an authoritative message root", () => {
    const bundle = buildCompatibilityBundle();
    schemaArrayAt(bundle, ["definitions", "ClientRequest", "oneOf"]).push(
      structuredClone(methodVariant(bundle, "ClientRequest", "thread/start")),
    );
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a valid secondary-document copy when the authoritative aggregate is broken", () => {
    const bundle = buildCompatibilityBundle();
    const decoy = structuredClone(bundle);
    removeRequiredField(bundle, ["definitions", "v2", "Thread"], "id");
    const output = writeValidationOutput(bundle, {
      "codex_app_server_protocol.v2.schemas.json": decoy,
    });
    expectValidationFailure(output, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("rejects a method params schema redirected to a shape-compatible decoy", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).ThreadStartParamsDecoy = structuredClone(
      schemaRecordAt(bundle, ["definitions", "v2", "ThreadStartParams"]),
    );
    schemaRecord(methodVariant(bundle, "ClientRequest", "thread/start").properties).params = {
      $ref: "#/definitions/v2/ThreadStartParamsDecoy",
    };
    expectBundleFailure(bundle, "PROTOCOL_SHAPE_INCOMPATIBLE");
  });

  it("accepts unrelated additive methods, fields, definitions, enum members, and documents", () => {
    const bundle = buildCompatibilityBundle();
    schemaArrayAt(bundle, ["definitions", "ClientRequest", "oneOf"]).push(
      requestSchema("unrelated/additive", "#/definitions/v2/EmptyParams"),
    );
    schemaRecordAt(bundle, ["definitions", "v2", "Thread", "properties"]).additive = {};
    schemaRecordAt(bundle, ["definitions"]).AdditiveDefinition = objectSchema(
      ["value"],
      [],
    );
    schemaArrayAt(bundle, [
      "definitions",
      "FileChangeApprovalDecision",
      "oneOf",
    ]).push({ enum: ["futureDecision"] });
    const output = writeValidationOutput(bundle, {
      "unrelated-additive.json": { title: "Additive", type: "object" },
    });
    expect(validateGeneratedCompatibilityOutputForTest(output)).toBeDefined();
  });
});

describe("local reference and path hardening", () => {
  it("resolves percent-encoded local pointer fragments", () => {
    const bundle = buildCompatibilityBundle();
    const v2 = schemaRecordAt(bundle, ["definitions", "v2"]);
    v2["Thread Contract"] = v2.Thread;
    v2.Thread = { $ref: "#/definitions/v2/Thread%20Contract" };
    expect(validateBundle(bundle)).toBeDefined();
  });

  it("decodes ~0 and ~1 in local JSON Pointer segments", () => {
    const bundle = buildCompatibilityBundle();
    const v2 = schemaRecordAt(bundle, ["definitions", "v2"]);
    v2["Thread~Contract/Primary"] = v2.Thread;
    v2.Thread = { $ref: "#/definitions/v2/Thread~0Contract~1Primary" };
    expect(validateBundle(bundle)).toBeDefined();
  });

  it("accepts bounded nested allOf object composition", () => {
    const bundle = buildCompatibilityBundle();
    const thread = schemaRecordAt(bundle, ["definitions", "v2", "Thread"]);
    const properties = schemaRecord(thread.properties);
    const required = stringArray(thread.required);
    const midpoint = Math.floor(required.length / 2);
    schemaRecordAt(bundle, ["definitions", "v2"]).Thread = {
      allOf: [
        objectSchema(required.slice(0, midpoint), required.slice(0, midpoint)),
        {
          allOf: [
            objectSchema(required.slice(midpoint), required.slice(midpoint)),
            { properties },
          ],
        },
      ],
    };
    expect(validateBundle(bundle)).toBeDefined();
  });

  it("accepts a bounded anyOf wrapper for an exact method literal", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecord(methodVariant(bundle, "ClientRequest", "initialize").properties).method = {
      anyOf: [{ enum: ["initialize"] }],
    };
    expect(validateBundle(bundle)).toBeDefined();
  });

  it.each([
    ["missing local", "#/definitions/v2/Missing"],
    ["malformed percent", "#/definitions/v2/%ZZ"],
    ["malformed pointer escape", "#/definitions/v2/Thread~2"],
    ["percent-encoded external file", "decoy%2Ejson#/definitions/Thread"],
    ["parent traversal", "../decoy.json#/definitions/Thread"],
    ["absolute file", "file:///tmp/decoy.json#/definitions/Thread"],
    ["HTTP", "https://example.invalid/schema.json#/definitions/Thread"],
  ] as const)("fails closed for %s reference", (_label, reference) => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).Thread = { $ref: reference };
    const output = writeValidationOutput(bundle, {
      "decoy.json": { definitions: { Thread: validThreadSchema() } },
    });
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("fails closed for a cyclic consumed reference", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).Thread = {
      $ref: "#/definitions/v2/Thread",
    };
    expectBundleFailure(bundle, "SCHEMA_OUTPUT_MALFORMED");
  });
});

describe("generated filesystem and resource bounds", () => {
  it("requires generated TypeScript output", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    rmSync(join(output, "typescript", "protocol.ts"));
    expectValidationFailure(output, "SCHEMA_OUTPUT_MISSING");
  });

  it("requires the authoritative aggregate root", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    rmSync(join(output, "json-schema", AUTHORITATIVE_BUNDLE));
    expectValidationFailure(output, "SCHEMA_OUTPUT_MISSING");
  });

  it("rejects malformed authoritative JSON", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    writeFileSync(join(output, "json-schema", AUTHORITATIVE_BUNDLE), "{", "utf8");
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("rejects malformed secondary JSON without treating it as contract authority", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    writeFileSync(join(output, "json-schema", "secondary.json"), "{", "utf8");
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("rejects a symlinked authoritative JSON file", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    const bundlePath = join(output, "json-schema", AUTHORITATIVE_BUNDLE);
    const target = join(fixtureRoot, "bundle-target.json");
    renameSync(bundlePath, target);
    symlinkSync(target, bundlePath);
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("rejects a symlinked JSON schema root", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    const root = join(output, "json-schema");
    const target = join(fixtureRoot, "json-target");
    renameSync(root, target);
    symlinkSync(target, root);
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("rejects a nested generated-directory symlink", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    const target = join(fixtureRoot, "nested-target");
    mkdirSync(target);
    symlinkSync(target, join(output, "json-schema", "nested"));
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("rejects a non-regular generated file", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    const fifo = join(output, "json-schema", "generated.fifo");
    const created = spawnSync("/usr/bin/mkfifo", [fifo]);
    expect(created.status).toBe(0);
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("bounds generated directory depth", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    mkdirSync(join(output, "typescript", "a", "b"), { recursive: true });
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxGeneratedTreeDepth: 1,
    });
  });

  it("bounds directory entry counts", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxDirectoryEntries: 0,
    });
  });

  it("bounds total directory and file entries", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    mkdirSync(join(output, "typescript", "a", "b"), { recursive: true });
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxGeneratedEntries: 2,
    });
  });

  it("counts non-JSON files against the generated file limit", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    writeFileSync(join(output, "json-schema", "one.txt"), "one", "utf8");
    writeFileSync(join(output, "json-schema", "two.txt"), "two", "utf8");
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxGeneratedFiles: 2,
    });
  });

  it("bounds individual and aggregate generated bytes", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxGeneratedFileBytes: 64,
    });
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxGeneratedTotalBytes: 64,
    });
  });

  it("bounds parsed JSON depth", () => {
    const bundle = buildCompatibilityBundle();
    let current: MutableSchema = bundle;
    for (let index = 0; index < 70; index += 1) {
      const next: MutableSchema = {};
      current.deep = next;
      current = next;
    }
    expectBundleFailure(bundle, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("bounds parsed JSON container counts", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxSchemaContainers: 10,
    });
  });

  it("bounds schema branch signature expansion", () => {
    const bundle = buildCompatibilityBundle();
    schemaRecordAt(bundle, ["definitions", "v2"]).Thread = {
      anyOf: Array.from({ length: 129 }, () => validThreadSchema()),
    };
    expectBundleFailure(bundle, "SCHEMA_OUTPUT_MALFORMED");
  });

  it("bounds total consumed-graph validation work", () => {
    const output = writeValidationOutput(buildCompatibilityBundle());
    expectValidationFailure(output, "SCHEMA_OUTPUT_MALFORMED", {
      maxSchemaOperations: 10,
    });
  });
});

describe("generator process boundaries", () => {
  it("classifies spawn start failure", () => {
    expectGeneratorFailure(
      "/definitely/missing/ctc-generator",
      [],
      100,
      1_024,
      "SCHEMA_GENERATOR_START_FAILED",
    );
  });

  it("classifies nonzero exit", () => {
    expectGeneratorFailure(
      "/bin/sh",
      ["-c", "exit 17"],
      100,
      1_024,
      "SCHEMA_GENERATOR_FAILED",
    );
  });

  it("classifies an independent signal", () => {
    expectGeneratorFailure(
      "/bin/sh",
      ["-c", "kill -TERM $$"],
      100,
      1_024,
      "SCHEMA_GENERATOR_SIGNALED",
    );
  });

  it("bounds generator timeout", () => {
    expectGeneratorFailure(
      "/bin/sh",
      ["-c", "while :; do :; done"],
      20,
      1_024,
      "SCHEMA_GENERATOR_FAILED",
    );
  });

  it("bounds generator stdout and stderr", () => {
    expectGeneratorFailure(
      "/bin/sh",
      ["-c", "while :; do printf x; printf y >&2; done"],
      1_000,
      128,
      "SCHEMA_GENERATOR_FAILED",
    );
  });

  it("permits bounded diagnostic output without exposing it", () => {
    expect(() =>
      runSchemaGeneratorForTest(
        "/bin/sh",
        ["-c", "printf private; printf diagnostic >&2"],
        isolatedChildEnvironment(),
        { maxBufferBytes: 1_024, timeoutMilliseconds: 100 },
      ),
    ).not.toThrow();
  });
});

function installCandidate(
  behavior: GeneratorBehavior,
  versionOutput: string = TESTED_CODEX_VERSION,
  bundle: MutableSchema = buildCompatibilityBundle(),
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
    fakeCandidateBody(JSON.stringify(bundle), behavior, versionOutput),
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
        ? `printf '%s' '{' > "$out/${AUTHORITATIVE_BUNDLE}"`
        : behavior === "partial"
          ? `printf '%s' '{}' > "$out/${AUTHORITATIVE_BUNDLE}"; printf '%s\\n' 'private generator diagnostic' >&2; exit 17`
          : `printf '%s' ${shellSingleQuote(bundle)} > "$out/${AUTHORITATIVE_BUNDLE}"`;
  const secondGeneratorGuard =
    behavior === "nonzero"
      ? "printf '%s\\n' 'private generator diagnostic' >&2; exit 17"
      : behavior === "signal"
        ? "kill -TERM $$"
        : "";
  const boundedDiagnostics =
    behavior === "unexpected-output"
      ? "printf '%s\\n' 'private stdout'; printf '%s\\n' 'private stderr' >&2"
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
    'if [ "${CTC_C_LITE_AMBIENT_SECRET+x}" = x ]; then',
    `  printf '%s\\n' leaked > ${shellSingleQuote(`${capturePath}.ambient-leak`)}`,
    "fi",
    '/bin/mkdir -p "$HOME" "$CODEX_HOME" "$TMPDIR" "$PATH"',
    `printf '%s\\n' isolated > "$HOME/arg0-sentinel"`,
    `printf '%s\\n' isolated > "$CODEX_HOME/arg0-sentinel"`,
    `printf '%s\\n' isolated > "$TMPDIR/arg0-sentinel"`,
    `printf '%s\\n' isolated > "$PATH/arg0-sentinel"`,
    'out="$4"',
    '/bin/mkdir -p "$out"',
    'if [ "$2" = "generate-ts" ]; then',
    behavior === "first-nonzero"
      ? "  printf '%s\\n' 'private generator diagnostic' >&2; exit 17"
      : "",
    `  printf '%s\\n' 'export type Generated = true;' > "$out/protocol.ts"`,
    `  ${boundedDiagnostics}`,
    "  exit 0",
    "fi",
    '[ "$2" = "generate-json-schema" ] || exit 9',
    secondGeneratorGuard,
    boundedDiagnostics,
    jsonBody,
  ].join("\n");
}

function buildCompatibilityBundle(): MutableSchema {
  const v2: MutableSchema = {
    AbsolutePathBuf: { type: "string" },
    AgentMessageDeltaNotification: objectSchema([], []),
    CommandExecutionOutputDeltaNotification: objectSchema(
      ["delta", "itemId", "threadId", "turnId"],
      ["delta", "itemId", "threadId", "turnId"],
    ),
    EmptyParams: objectSchema([], []),
    FileChangeOutputDeltaNotification: objectSchema(
      ["delta", "itemId", "threadId", "turnId"],
      ["delta", "itemId", "threadId", "turnId"],
    ),
    FileChangePatchUpdatedNotification:
      fileChangePatchUpdatedNotificationSchema(),
    FileUpdateChange: {
      properties: {
        diff: { type: "string" },
        kind: { $ref: "#/definitions/v2/PatchChangeKind" },
        path: { type: "string" },
      },
      required: ["diff", "kind", "path"],
      type: "object",
    },
    ItemCompletedNotification: referencedObjectSchema(
      "item",
      "#/definitions/v2/ThreadItem",
    ),
    ItemStartedNotification: referencedObjectSchema(
      "item",
      "#/definitions/v2/ThreadItem",
    ),
    SandboxMode: {
      enum: ["read-only", "workspace-write", "danger-full-access"],
      type: "string",
    },
    SandboxPolicy: {
      oneOf: [
        {
          properties: {
            networkAccess: { type: "boolean" },
            type: { enum: ["readOnly"] },
          },
          required: ["type"],
          type: "object",
        },
        {
          properties: {
            excludeSlashTmp: { type: "boolean" },
            excludeTmpdirEnvVar: { type: "boolean" },
            networkAccess: { type: "boolean" },
            type: { enum: ["workspaceWrite"] },
            writableRoots: {
              items: { $ref: "#/definitions/v2/AbsolutePathBuf" },
              type: "array",
            },
          },
          required: ["type"],
          type: "object",
        },
      ],
    },
    PatchChangeKind: {
      oneOf: [
        typedObjectSchema("add", ["type"], ["type"]),
        typedObjectSchema("delete", ["type"], ["type"]),
        {
          properties: {
            move_path: { type: ["string", "null"] },
            type: { enum: ["update"], type: "string" },
          },
          required: ["type"],
          type: "object",
        },
      ],
    },
    ServerRequestResolvedNotification: objectSchema([], []),
    SkillsListParams: objectSchema([], []),
    TextElement: objectSchema([], []),
    Thread: validThreadSchema(),
    ThreadGoalGetParams: objectSchema(["threadId"], ["threadId"]),
    ThreadGoalSetParams: objectSchema(["threadId"], ["threadId"]),
    ThreadGoalUpdatedNotification: objectSchema([], []),
    ThreadResumeParams: objectSchema(["threadId"], ["threadId"]),
    ThreadStartParams: threadStartParamsSchema(),
    ThreadStartResponse: threadResponseSchema(),
    ThreadResumeResponse: threadResponseSchema(),
    ThreadStartedNotification: referencedObjectSchema(
      "thread",
      "#/definitions/v2/Thread",
    ),
    ThreadTokenUsage: {
      properties: {
        last: { $ref: "#/definitions/v2/TokenUsageBreakdown" },
        modelContextWindow: {},
        total: { $ref: "#/definitions/v2/TokenUsageBreakdown" },
      },
      required: ["last", "total"],
      type: "object",
    },
    ThreadTokenUsageUpdatedNotification: referencedObjectSchema(
      "tokenUsage",
      "#/definitions/v2/ThreadTokenUsage",
    ),
    ThreadItem: {
      oneOf: [
        typedObjectSchema(
          "commandExecution",
          ["command", "commandActions", "cwd", "id", "status", "type"],
          ["command", "commandActions", "cwd", "id", "status", "type"],
        ),
        fileChangeThreadItemSchema(),
      ],
    },
    TokenUsageBreakdown: objectSchema(
      [
        "cacheWriteInputTokens",
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ],
      [
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ],
    ),
    Turn: objectSchema(["id", "items", "status"], ["id", "items", "status"]),
    TurnCompletedNotification: referencedObjectSchema(
      "turn",
      "#/definitions/v2/Turn",
    ),
    TurnInterruptParams: objectSchema(
      ["threadId", "turnId"],
      ["threadId", "turnId"],
    ),
    TurnStartParams: turnStartParamsSchema(),
    TurnStartResponse: referencedObjectSchema("turn", "#/definitions/v2/Turn"),
    TurnStartedNotification: referencedObjectSchema(
      "turn",
      "#/definitions/v2/Turn",
    ),
    UserInput: {
      oneOf: [
        {
          properties: {
            text: {},
            text_elements: {
              items: { $ref: "#/definitions/v2/TextElement" },
              type: "array",
            },
            type: { enum: ["text"] },
          },
          required: ["text", "type"],
          type: "object",
        },
        {
          properties: { type: { enum: ["image"] }, url: {} },
          required: ["type", "url"],
          type: "object",
        },
      ],
    },
  };

  const clientRequestParams: Readonly<Record<string, string>> = {
    initialize: "#/definitions/InitializeParams",
    "skills/list": "#/definitions/v2/SkillsListParams",
    "thread/goal/get": "#/definitions/v2/ThreadGoalGetParams",
    "thread/goal/set": "#/definitions/v2/ThreadGoalSetParams",
    "thread/resume": "#/definitions/v2/ThreadResumeParams",
    "thread/start": "#/definitions/v2/ThreadStartParams",
    "turn/interrupt": "#/definitions/v2/TurnInterruptParams",
    "turn/start": "#/definitions/v2/TurnStartParams",
  };
  const serverNotificationParams: Readonly<Record<string, string>> = {
    "item/agentMessage/delta": "#/definitions/v2/AgentMessageDeltaNotification",
    "item/commandExecution/outputDelta":
      "#/definitions/v2/CommandExecutionOutputDeltaNotification",
    "item/completed": "#/definitions/v2/ItemCompletedNotification",
    "item/fileChange/outputDelta":
      "#/definitions/v2/FileChangeOutputDeltaNotification",
    "item/fileChange/patchUpdated":
      "#/definitions/v2/FileChangePatchUpdatedNotification",
    "item/started": "#/definitions/v2/ItemStartedNotification",
    "serverRequest/resolved": "#/definitions/v2/ServerRequestResolvedNotification",
    "thread/goal/updated": "#/definitions/v2/ThreadGoalUpdatedNotification",
    "thread/started": "#/definitions/v2/ThreadStartedNotification",
    "thread/tokenUsage/updated": "#/definitions/v2/ThreadTokenUsageUpdatedNotification",
    "turn/completed": "#/definitions/v2/TurnCompletedNotification",
    "turn/started": "#/definitions/v2/TurnStartedNotification",
  };

  return {
    definitions: {
      ClientNotification: {
        oneOf: SUPPORTED_CLIENT_NOTIFICATION_METHODS.map((method) =>
          notificationSchema(method),
        ),
      },
      ClientRequest: {
        oneOf: SUPPORTED_CLIENT_REQUEST_METHODS.map((method) =>
          requestSchema(method, clientRequestParams[method] as string),
        ),
      },
      CommandExecutionApprovalDecision: approvalDecisionSchema(),
      CommandExecutionRequestApprovalParams: objectSchema(
        ["itemId", "startedAtMs", "threadId", "turnId"],
        ["itemId", "startedAtMs", "threadId", "turnId"],
      ),
      CommandExecutionRequestApprovalResponse: approvalResponseSchema(
        "#/definitions/CommandExecutionApprovalDecision",
      ),
      FileChangeApprovalDecision: approvalDecisionSchema(),
      FileChangeRequestApprovalParams: objectSchema(
        ["itemId", "startedAtMs", "threadId", "turnId"],
        ["itemId", "startedAtMs", "threadId", "turnId"],
      ),
      FileChangeRequestApprovalResponse: approvalResponseSchema(
        "#/definitions/FileChangeApprovalDecision",
      ),
      InitializeParams: objectSchema(["clientInfo"], ["clientInfo"]),
      InitializeResponse: objectSchema(
        ["codexHome", "platformFamily", "platformOs", "userAgent"],
        ["codexHome", "platformFamily", "platformOs", "userAgent"],
      ),
      ServerNotification: {
        oneOf: SUPPORTED_SERVER_NOTIFICATION_METHODS.map((method) =>
          notificationSchema(method, serverNotificationParams[method] as string),
        ),
      },
      ServerRequest: {
        oneOf: [
          requestSchema(
            "item/commandExecution/requestApproval",
            "#/definitions/CommandExecutionRequestApprovalParams",
          ),
          requestSchema(
            "item/fileChange/requestApproval",
            "#/definitions/FileChangeRequestApprovalParams",
          ),
        ],
      },
      v2,
    },
    title: "CodexAppServerProtocol",
    type: "object",
  };
}

function validThreadSchema(): MutableSchema {
  const fields = [
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
  ];
  return objectSchema(fields, fields);
}

function threadResponseSchema(): MutableSchema {
  const fields = [
    "approvalPolicy",
    "approvalsReviewer",
    "cwd",
    "model",
    "modelProvider",
    "sandbox",
    "thread",
  ];
  const schema = objectSchema(fields, fields);
  schemaRecord(schema.properties).thread = { $ref: "#/definitions/v2/Thread" };
  schemaRecord(schema.properties).sandbox = {
    $ref: "#/definitions/v2/SandboxPolicy",
  };
  return schema;
}

function threadStartParamsSchema(): MutableSchema {
  const schema = objectSchema(
    [
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
    [],
  );
  schemaRecord(schema.properties).sandbox = {
    $ref: "#/definitions/v2/SandboxMode",
  };
  return schema;
}

function turnStartParamsSchema(): MutableSchema {
  const schema = objectSchema(
    [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "input",
      "model",
      "sandboxPolicy",
      "threadId",
    ],
    ["input", "threadId"],
  );
  schemaRecord(schema.properties).sandboxPolicy = {
    $ref: "#/definitions/v2/SandboxPolicy",
  };
  return schema;
}

function approvalDecisionSchema(): MutableSchema {
  return {
    oneOf: ["accept", "acceptForSession", "decline", "cancel"].map((value) => ({
      enum: [value],
      type: "string",
    })),
  };
}

function approvalResponseSchema(decisionReference: string): MutableSchema {
  return {
    properties: { decision: { $ref: decisionReference } },
    required: ["decision"],
    type: "object",
  };
}

function referencedObjectSchema(property: string, reference: string): MutableSchema {
  return {
    properties: { [property]: { $ref: reference } },
    required: [property],
    type: "object",
  };
}

function fileChangePatchUpdatedNotificationSchema(): MutableSchema {
  const schema = objectSchema(
    ["changes", "itemId", "threadId", "turnId"],
    ["changes", "itemId", "threadId", "turnId"],
  );
  schemaRecord(schema.properties).changes = {
    items: { $ref: "#/definitions/v2/FileUpdateChange" },
    type: "array",
  };
  return schema;
}

function fileChangeThreadItemSchema(): MutableSchema {
  const schema = typedObjectSchema(
    "fileChange",
    ["changes", "id", "status", "type"],
    ["changes", "id", "status", "type"],
  );
  schemaRecord(schema.properties).changes = {
    items: { $ref: "#/definitions/v2/FileUpdateChange" },
    type: "array",
  };
  return schema;
}

function requestSchema(method: string, paramsReference: string): MutableSchema {
  return {
    properties: {
      id: {},
      method: { enum: [method] },
      params: { $ref: paramsReference },
    },
    required: ["id", "method", "params"],
    type: "object",
  };
}

function notificationSchema(method: string, paramsReference?: string): MutableSchema {
  return paramsReference === undefined
    ? {
        properties: { method: { enum: [method] } },
        required: ["method"],
        type: "object",
      }
    : {
        properties: {
          method: { enum: [method] },
          params: { $ref: paramsReference },
        },
        required: ["method", "params"],
        type: "object",
      };
}

function objectSchema(
  propertyNames: readonly string[],
  required: readonly string[],
): MutableSchema {
  return {
    properties: Object.fromEntries(propertyNames.map((property) => [property, {}])),
    required: [...required],
    type: "object",
  };
}

function typedObjectSchema(
  type: string,
  propertyNames: readonly string[],
  required: readonly string[],
): MutableSchema {
  const schema = objectSchema(propertyNames, required);
  schemaRecord(schema.properties).type = { enum: [type] };
  return schema;
}

function validateBundle(bundle: MutableSchema): { readonly provenanceSha256: string } {
  return validateGeneratedCompatibilityOutputForTest(writeValidationOutput(bundle));
}

function expectBundleFailure(bundle: MutableSchema, code: string): void {
  expectValidationFailure(writeValidationOutput(bundle), code);
}

function expectValidationFailure(
  output: string,
  code: string,
  limits: Record<string, number> = {},
): void {
  expect(() =>
    validateGeneratedCompatibilityOutputForTest(output, limits),
  ).toThrowError(expect.objectContaining({ code }));
}

function writeValidationOutput(
  bundle: MutableSchema,
  extraJson: Readonly<Record<string, MutableSchema>> = {},
): string {
  const output = join(fixtureRoot, `output-${outputSequence++}`);
  const typescript = join(output, "typescript");
  const jsonSchema = join(output, "json-schema");
  mkdirSync(typescript, { recursive: true });
  mkdirSync(jsonSchema, { recursive: true });
  writeFileSync(join(typescript, "protocol.ts"), "export type Generated = true;\n", "utf8");
  writeFileSync(
    join(jsonSchema, AUTHORITATIVE_BUNDLE),
    JSON.stringify(bundle),
    "utf8",
  );
  for (const [name, value] of Object.entries(extraJson)) {
    writeFileSync(join(jsonSchema, name), JSON.stringify(value), "utf8");
  }
  return output;
}

function methodVariant(
  bundle: MutableSchema,
  root: MethodCase["root"],
  method: string,
): MutableSchema {
  const variant = schemaArrayAt(bundle, ["definitions", root, "oneOf"]).find(
    (candidate) =>
      stringArray(schemaRecord(schemaRecord(candidate.properties).method).enum).includes(
        method,
      ),
  );
  if (variant === undefined) {
    throw new Error(`Missing method fixture: ${method}`);
  }
  return variant;
}

function removeMethodVariant(
  bundle: MutableSchema,
  root: MethodCase["root"],
  method: string,
): void {
  const definition = schemaRecordAt(bundle, ["definitions", root]);
  definition.oneOf = schemaArrayAt(bundle, ["definitions", root, "oneOf"]).filter(
    (candidate) =>
      !stringArray(schemaRecord(schemaRecord(candidate.properties).method).enum).includes(
        method,
      ),
  );
}

function removeRequiredField(
  bundle: MutableSchema,
  path: readonly string[],
  field: string,
): void {
  const schema = schemaRecordAt(bundle, path);
  schema.required = stringArray(schema.required).filter((candidate) => candidate !== field);
}

function textInputVariant(bundle: MutableSchema): MutableSchema {
  const variant = schemaArrayAt(bundle, ["definitions", "v2", "UserInput", "oneOf"]).find(
    (candidate) =>
      stringArray(schemaRecord(schemaRecord(candidate.properties).type).enum).includes(
        "text",
      ),
  );
  if (variant === undefined) {
    throw new Error("Missing text input fixture.");
  }
  return variant;
}

function fileChangeItemVariant(bundle: MutableSchema): MutableSchema {
  const variant = schemaArrayAt(bundle, [
    "definitions",
    "v2",
    "ThreadItem",
    "oneOf",
  ]).find((candidate) =>
    stringArray(schemaRecord(schemaRecord(candidate.properties).type).enum).includes(
      "fileChange",
    ),
  );
  if (variant === undefined) {
    throw new Error("Missing fileChange fixture variant.");
  }
  return variant;
}

function patchChangeKindVariant(
  bundle: MutableSchema,
  type: "add" | "delete" | "update",
): MutableSchema {
  const variant = schemaArrayAt(bundle, [
    "definitions",
    "v2",
    "PatchChangeKind",
    "oneOf",
  ]).find((candidate) =>
    stringArray(schemaRecord(schemaRecord(candidate.properties).type).enum).includes(
      type,
    ),
  );
  if (variant === undefined) {
    throw new Error(`Missing PatchChangeKind fixture variant: ${type}`);
  }
  return variant;
}

function schemaRecordAt(value: unknown, path: readonly string[]): MutableSchema {
  let current = value;
  for (const segment of path) {
    current = schemaRecord(current)[segment];
  }
  return schemaRecord(current);
}

function schemaArrayAt(value: unknown, path: readonly string[]): MutableSchema[] {
  let current = value;
  for (const segment of path) {
    current = schemaRecord(current)[segment];
  }
  if (!Array.isArray(current) || !current.every(isSchemaRecord)) {
    throw new Error(`Expected schema array at ${path.join(".")}`);
  }
  return current;
}

function schemaRecord(value: unknown): MutableSchema {
  if (!isSchemaRecord(value)) {
    throw new Error("Expected schema object.");
  }
  return value;
}

function isSchemaRecord(value: unknown): value is MutableSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected string array.");
  }
  return value;
}

function expectGeneratorFailure(
  command: string,
  arguments_: readonly string[],
  timeoutMilliseconds: number,
  maxBufferBytes: number,
  code: string,
): void {
  expect(() =>
    runSchemaGeneratorForTest(command, arguments_, isolatedChildEnvironment(), {
      maxBufferBytes,
      timeoutMilliseconds,
    }),
  ).toThrowError(expect.objectContaining({ code }));
}

function isolatedChildEnvironment(): NodeJS.ProcessEnv {
  const root = join(fixtureRoot, `generator-environment-${outputSequence++}`);
  const environment = {
    CODEX_HOME: join(root, "codex-home"),
    HOME: join(root, "home"),
    PATH: join(root, "bin"),
    TMPDIR: join(root, "tmp"),
  };
  for (const path of Object.values(environment)) {
    mkdirSync(path, { recursive: true });
  }
  return environment;
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
