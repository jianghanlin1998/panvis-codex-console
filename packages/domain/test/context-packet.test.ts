import { describe, expect, it } from "vitest";

import {
  AcceptedPromotedContextSnapshotDataSchema,
  BigTaskSchema,
  ContextItemSchema,
  DeterministicEngineeringFactDataSchema,
  JitContextPacketCompilationInputSchema,
  JitContextPacketCompilationReasonSchema,
  JitContextPacketProfileKindSchema,
  JitContextPacketSchema,
  ProjectSchema,
  SubtaskSchema,
  compileJitContextPacket,
} from "../src/index.js";
import type {
  ContextItem,
  JitContextPacket,
  JitContextPacketCompilationInput,
} from "../src/index.js";

type StandardInput = Extract<
  JitContextPacketCompilationInput,
  { profile: "STANDARD_SUBTASK_EXECUTION" }
>;
type FreshQaInput = Extract<
  JitContextPacketCompilationInput,
  { profile: "FRESH_INDEPENDENT_QA" }
>;
type FocusedReQaInput = Extract<
  JitContextPacketCompilationInput,
  { profile: "FOCUSED_RE_QA" }
>;

const makeProject = () =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id: "prj_console",
    name: "Codex Task Console",
    slug: "codex-task-console",
    repository: { kind: "PATH", path: "/workspace/panvis-codex-console" },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });

const makeBigTask = () =>
  BigTaskSchema.parse({
    recordType: "BIG_TASK",
    id: "bt_context_packet",
    projectId: "prj_console",
    title: "JIT Context Packet / Compiler",
    goal: "Compile a structured deterministic packet.",
    rationale: "Keep model injection inputs explicit.",
    scopeIn: ["Structured packet", "Deterministic order"],
    scopeOut: ["Provider serialization", "Token enforcement"],
    acceptanceCriteria: ["Big criterion B", "Big criterion A"],
    status: "IN_PROGRESS",
  });

const makeSubtask = () =>
  SubtaskSchema.parse({
    recordType: "SUBTASK",
    id: "st_context_packet_core",
    bigTaskId: "bt_context_packet",
    title: "Context Packet Core Contract",
    goal: "Define the pure packet boundary.",
    scopeIn: ["Domain schema", "Compiler"],
    scopeOut: ["Persistence", "Execution"],
    acceptanceCriteria: ["Subtask criterion Z", "Subtask criterion A"],
    untouchedAreas: ["Storage", "Codex adapter"],
    status: "TODO",
    maturity: "NOT_STARTED",
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
    promptSeed: "Implement only the approved packet core.",
  });

const block = (sourceReference: string, body = `Body for ${sourceReference}.`) => ({
  sourceReference,
  title: `Title for ${sourceReference}`,
  body,
});

const makeContextItem = (
  id: string,
  scope: "PROJECT" | "BIG_TASK" | "SUBTASK",
  body = `Context body for ${id}.`,
  status: "ACTIVE" | "PROPOSED" = "ACTIVE",
): ContextItem =>
  ContextItemSchema.parse({
    id,
    projectId: "prj_console",
    ...(scope === "PROJECT" ? {} : { bigTaskId: "bt_context_packet" }),
    ...(scope === "SUBTASK" ? { subtaskId: "st_context_packet_core" } : {}),
    kind: "REQUIREMENT",
    status,
    authority: "HUMAN",
    title: `Context ${id}`,
    body,
    provenance: {
      sourceType: "MANUAL",
      sourceReference: `decision://${id}`,
      effectiveAt: "2026-08-16T00:00:00Z",
    },
  });

const retestTarget = () => ({
  sourceReference: "finding://CTC-JIT-001",
  retestTarget: {
    findingId: "CTC-JIT-001",
    violatedInvariant: "The packet must remain structured.",
    affectedContract: "JIT Context Packet Core",
    repairedSha: "a".repeat(40),
  },
});

const makeStandardInput = (): StandardInput =>
  JitContextPacketCompilationInputSchema.parse({
    profile: "STANDARD_SUBTASK_EXECUTION",
    project: makeProject(),
    bigTask: makeBigTask(),
    subtask: makeSubtask(),
    canonicalProjectRules: [block("project-rule://2"), block("project-rule://1")],
    repositoryRuntimeEvidence: [block("repo://head"), block("runtime://node")],
    activeContext: {
      project: [makeContextItem("ctx_project_second", "PROJECT")],
      bigTask: [makeContextItem("ctx_big_task_first", "BIG_TASK")],
      subtask: [makeContextItem("ctx_subtask_third", "SUBTASK")],
    },
  }) as StandardInput;

const makeFreshQaInput = (): FreshQaInput =>
  JitContextPacketCompilationInputSchema.parse({
    profile: "FRESH_INDEPENDENT_QA",
    project: makeProject(),
    bigTask: makeBigTask(),
    subtask: makeSubtask(),
    canonicalProjectRules: [block("project-rule://qa")],
    repositoryRuntimeEvidence: [block("repo://qa")],
    lockedInvariants: [block("invariant://1")],
    qaInstructions: [block("qa://instruction")],
    boundedRetestTargets: [],
  }) as FreshQaInput;

const makeFocusedReQaInput = (): FocusedReQaInput =>
  JitContextPacketCompilationInputSchema.parse({
    ...makeFreshQaInput(),
    profile: "FOCUSED_RE_QA",
    boundedRetestTargets: [retestTarget()],
  }) as FocusedReQaInput;

const requirePacket = (
  input: JitContextPacketCompilationInput,
): JitContextPacket => {
  const result = compileJitContextPacket(input);
  expect(result.compiled).toBe(true);
  if (!result.compiled) {
    throw new Error(`Unexpected compile failure: ${result.reason}`);
  }
  return result.packet;
};

const requireStandardPacket = (
  input: StandardInput,
): Extract<JitContextPacket, { profile: "STANDARD_SUBTASK_EXECUTION" }> => {
  const packet = requirePacket(input);
  if (packet.profile !== "STANDARD_SUBTASK_EXECUTION") {
    throw new Error("Expected a standard packet.");
  }
  return packet;
};

const requireFreshQaPacket = (
  input: FreshQaInput,
): Extract<JitContextPacket, { profile: "FRESH_INDEPENDENT_QA" }> => {
  const packet = requirePacket(input);
  if (packet.profile !== "FRESH_INDEPENDENT_QA") {
    throw new Error("Expected a Fresh QA packet.");
  }
  return packet;
};

const sectionTypes = (packet: JitContextPacket) =>
  packet.sections.map(({ sectionType }) => sectionType);

const expectDeeplyFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      expectDeeplyFrozen(descriptor.value);
    }
  }
};

describe("JIT Context Packet closed profile and section contracts", () => {
  it("supports exactly the approved profiles and bounded failure reasons", () => {
    expect(JitContextPacketProfileKindSchema.options).toEqual([
      "STANDARD_SUBTASK_EXECUTION",
      "FRESH_INDEPENDENT_QA",
      "FOCUSED_RE_QA",
    ]);
    expect(JitContextPacketProfileKindSchema.safeParse("CUSTOM").success).toBe(false);
    expect(JitContextPacketCompilationReasonSchema.options).toEqual([
      "INVALID_CONTEXT_PACKET_INPUT",
      "INCONSISTENT_TASK_HIERARCHY",
      "INVALID_ACTIVE_CONTEXT",
    ]);
    expect(
      compileJitContextPacket({
        ...makeStandardInput(),
        profile: "CUSTOM",
      } as unknown as StandardInput),
    ).toEqual({ compiled: false, reason: "INVALID_CONTEXT_PACKET_INPUT" });
  });

  it("emits exactly the ten standard sections in fixed structural order", () => {
    const packet = requirePacket(makeStandardInput());
    expect(sectionTypes(packet)).toEqual([
      "CANONICAL_PROJECT_RULES",
      "REPOSITORY_RUNTIME_EVIDENCE",
      "PROJECT_CORE",
      "BIG_TASK_CONTRACT",
      "SUBTASK_CONTRACT",
      "ACCEPTANCE_CRITERIA",
      "EXECUTION_INTENT",
      "ACTIVE_PROJECT_CONTEXT",
      "ACTIVE_BIG_TASK_CONTEXT",
      "ACTIVE_SUBTASK_CONTEXT",
    ]);
    expect(JitContextPacketSchema.safeParse(packet).success).toBe(true);
  });

  it.each([makeFreshQaInput, makeFocusedReQaInput])(
    "emits exactly the nine clean-context QA sections",
    (inputFactory) => {
      const packet = requirePacket(inputFactory());
      expect(sectionTypes(packet)).toEqual([
        "CANONICAL_PROJECT_RULES",
        "REPOSITORY_RUNTIME_EVIDENCE",
        "PROJECT_CORE",
        "BIG_TASK_CONTRACT",
        "SUBTASK_CONTRACT",
        "ACCEPTANCE_CRITERIA",
        "LOCKED_INVARIANTS",
        "QA_INSTRUCTIONS",
        "BOUNDED_RETEST_TARGETS",
      ]);
      expect(JSON.stringify(packet)).not.toMatch(
        /EXECUTION_INTENT|ACTIVE_.*_CONTEXT|DIGEST|PROMOTED_CONTEXT|RAW_HISTORY|PRIOR_/,
      );
    },
  );

  it("keeps empty list sections rather than changing the standard layout", () => {
    const input = makeStandardInput();
    input.canonicalProjectRules = [];
    input.repositoryRuntimeEvidence = [];
    input.activeContext.project = [];
    input.activeContext.bigTask = [];
    input.activeContext.subtask = [];
    const packet = requireStandardPacket(input);
    expect(packet.sections).toHaveLength(10);
    expect(sectionTypes(packet)).toHaveLength(10);
  });
});

describe("task hierarchy, projection, intent, and acceptance criteria", () => {
  it.each([
    ["Big Task ownership", (input: StandardInput) => {
      input.bigTask.projectId = "prj_other" as StandardInput["bigTask"]["projectId"];
    }],
    ["Subtask ownership", (input: StandardInput) => {
      input.subtask.bigTaskId = "bt_other" as StandardInput["subtask"]["bigTaskId"];
    }],
  ] as const)("fails closed for inconsistent %s IDs", (_label, mutate) => {
    const input = makeStandardInput();
    mutate(input);
    expect(compileJitContextPacket(input)).toEqual({
      compiled: false,
      reason: "INCONSISTENT_TASK_HIERARCHY",
    });
  });

  it("projects only approved stable task fields", () => {
    const packet = requirePacket(makeStandardInput());
    const project = packet.sections[2];
    const bigTask = packet.sections[3];
    const subtask = packet.sections[4];
    expect(Object.keys(project.project)).toEqual([
      "id",
      "name",
      "slug",
      "repository",
      "defaultBranch",
    ]);
    expect(Object.keys(bigTask.bigTask)).toEqual([
      "id",
      "projectId",
      "title",
      "goal",
      "rationale",
      "scopeIn",
      "scopeOut",
    ]);
    expect(Object.keys(subtask.subtask)).toEqual([
      "id",
      "bigTaskId",
      "title",
      "goal",
      "scopeIn",
      "scopeOut",
      "untouchedAreas",
    ]);
    expect(JSON.stringify([project, bigTask, subtask])).not.toMatch(
      /acceptanceCriteria|status|maturity|startPolicy|delegationPolicy|promptSeed|recommendedReasoningLevel|maxActiveCodingSubtasks/,
    );
  });

  it("preserves Big Task and Subtask acceptance criteria separately and in order", () => {
    const packet = requirePacket(makeStandardInput());
    expect(packet.sections[5].acceptanceCriteria).toEqual({
      bigTask: {
        bigTaskId: "bt_context_packet",
        criteria: ["Big criterion B", "Big criterion A"],
      },
      subtask: {
        subtaskId: "st_context_packet_core",
        criteria: ["Subtask criterion Z", "Subtask criterion A"],
      },
    });
  });

  it("derives standard execution intent only from the canonical Subtask", () => {
    const packet = requirePacket(makeStandardInput());
    expect(packet.sections[6]).toEqual({
      sectionType: "EXECUTION_INTENT",
      reasonIncluded: "STANDARD_EXECUTION_INTENT",
      executionIntent: {
        recommendedReasoningLevel: "HIGH",
        promptSeed: "Implement only the approved packet core.",
      },
    });
    expect(
      JitContextPacketCompilationInputSchema.safeParse({
        ...makeStandardInput(),
        promptSeed: "caller override",
      }).success,
    ).toBe(false);
  });
});

describe("strict classified blocks and clean QA inputs", () => {
  it("preserves canonical Project rules and repository/runtime evidence in supplied order", () => {
    const packet = requirePacket(makeStandardInput());
    expect(packet.sections[0]).toMatchObject({
      reasonIncluded: "CANONICAL_PROJECT_RULES",
      blocks: [
        { sourceReference: "project-rule://2" },
        { sourceReference: "project-rule://1" },
      ],
    });
    expect(packet.sections[1]).toMatchObject({
      reasonIncluded: "REPOSITORY_RUNTIME_EVIDENCE",
      blocks: [
        { sourceReference: "repo://head" },
        { sourceReference: "runtime://node" },
      ],
    });
  });

  it("enforces strict bounded text blocks and rejects caller reasons", () => {
    const valid = block("x".repeat(2_048), "x".repeat(4_000));
    valid.title = "x".repeat(256);
    expect(
      JitContextPacketCompilationInputSchema.safeParse({
        ...makeStandardInput(),
        canonicalProjectRules: [valid],
      }).success,
    ).toBe(true);
    for (const invalidBlock of [
      { ...block("rule://1"), reasonIncluded: "CALLER_REASON" },
      { ...block("rule://1"), sourceReference: "x".repeat(2_049) },
      { ...block("rule://1"), title: "x".repeat(257) },
      { ...block("rule://1"), body: "x".repeat(4_001) },
    ]) {
      expect(
        JitContextPacketCompilationInputSchema.safeParse({
          ...makeStandardInput(),
          canonicalProjectRules: [invalidBlock],
        }).success,
      ).toBe(false);
    }
  });

  it("treats structurally valid evidence as DATA without asserting trust", () => {
    const input = makeStandardInput();
    input.repositoryRuntimeEvidence = [
      block("caller://claimed-repository-observation", "A caller supplied this text."),
    ];
    const packet = requirePacket(input);
    expect(packet.sections[1].blocks).toEqual(input.repositoryRuntimeEvidence);
    expect(JSON.stringify(packet.sections[1])).not.toMatch(
      /"(trusted|verified|authorized|accepted|authority)"\s*:/,
    );
  });

  it.each([
    "activeContext",
    "promptSeed",
    "digest",
    "promotedContext",
    "rawHistory",
    "priorHandoff",
    "priorReasoning",
    "priorRawChat",
    "priorSelfAssessment",
  ])("strictly rejects forbidden QA input field %s", (field) => {
    expect(
      JitContextPacketCompilationInputSchema.safeParse({
        ...makeFreshQaInput(),
        [field]: field === "activeContext" ? makeStandardInput().activeContext : "forbidden",
      }).success,
    ).toBe(false);
  });

  it("does not bridge S2D5a snapshot DATA or S2D6a fact DATA into packet authority", () => {
    const acceptedSnapshot = AcceptedPromotedContextSnapshotDataSchema.parse({
      candidate: {
        route: {
          sourceSubtaskId: "st_context_packet_core",
          audienceKind: "PARENT_BIG_TASK",
          targetBigTaskId: "bt_context_packet",
        },
        kind: "DECISION",
        title: "Caller-shaped accepted snapshot",
        body: "Shape does not establish accepted authority.",
        provenance: {
          sourceType: "MANUAL",
          sourceReference: "caller://snapshot",
          evidenceReferences: [],
        },
      },
      acceptance: {
        method: "HUMAN_CONFIRMATION",
        evidence: {
          evidenceType: "HUMAN_CONFIRMATION",
          sourceReference: "caller://confirmation",
          occurredAt: "2026-08-16T00:00:00Z",
        },
      },
    });
    expect(
      compileJitContextPacket({
        ...makeStandardInput(),
        promotedContext: acceptedSnapshot,
      } as unknown as StandardInput),
    ).toEqual({ compiled: false, reason: "INVALID_CONTEXT_PACKET_INPUT" });

    const deterministicFact = DeterministicEngineeringFactDataSchema.parse({
      factType: "REPOSITORY_COMMIT",
      repository: { kind: "PATH", path: "/workspace/panvis-codex-console" },
      observedRef: "main",
      commitSha: "b".repeat(40),
    });
    expect(
      compileJitContextPacket({
        ...makeStandardInput(),
        repositoryRuntimeEvidence: [deterministicFact],
      } as unknown as StandardInput),
    ).toEqual({ compiled: false, reason: "INVALID_CONTEXT_PACKET_INPUT" });
  });
});

describe("ACTIVE Context Item validation and semantic neutrality", () => {
  const expectInvalidActive = (input: StandardInput): void => {
    expect(compileJitContextPacket(input)).toEqual({
      compiled: false,
      reason: "INVALID_ACTIVE_CONTEXT",
    });
  };

  it.each([
    ["non-ACTIVE", (input: StandardInput) => {
      input.activeContext.project = [makeContextItem("ctx_bad", "PROJECT", "body", "PROPOSED")];
    }],
    ["wrong Project", (input: StandardInput) => {
      input.activeContext.project[0]!.projectId = "prj_other" as ContextItem["projectId"];
    }],
    ["Big Task scope in Project bucket", (input: StandardInput) => {
      input.activeContext.project = [makeContextItem("ctx_bad", "BIG_TASK")];
    }],
    ["Subtask scope in Project bucket", (input: StandardInput) => {
      input.activeContext.project = [makeContextItem("ctx_bad", "SUBTASK")];
    }],
    ["malformed Project item", (input: StandardInput) => {
      input.activeContext.project = [{ id: "ctx_bad" } as ContextItem];
    }],
  ] as const)("rejects %s", (_label, mutate) => {
    const input = makeStandardInput();
    mutate(input);
    expectInvalidActive(input);
  });

  it.each([
    ["wrong Project", (item: ContextItem) => {
      item.projectId = "prj_other" as ContextItem["projectId"];
    }],
    ["wrong Big Task", (item: ContextItem) => {
      if ("bigTaskId" in item) {
        item.bigTaskId = "bt_other" as typeof item.bigTaskId;
      }
    }],
    ["Subtask scope", () => undefined],
    ["non-ACTIVE", (item: ContextItem) => {
      item.status = "PROPOSED";
    }],
  ] as const)("rejects Big Task bucket item with %s", (label, mutate) => {
    const input = makeStandardInput();
    const item = makeContextItem(
      `ctx_big_${label.replaceAll(" ", "_").toLowerCase()}`,
      label === "Subtask scope" ? "SUBTASK" : "BIG_TASK",
    );
    mutate(item);
    input.activeContext.bigTask = [item];
    expectInvalidActive(input);
  });

  it.each([
    ["wrong Project", (item: ContextItem) => {
      item.projectId = "prj_other" as ContextItem["projectId"];
    }],
    ["wrong Big Task", (item: ContextItem) => {
      if ("bigTaskId" in item) {
        item.bigTaskId = "bt_other" as typeof item.bigTaskId;
      }
    }],
    ["wrong Subtask", (item: ContextItem) => {
      if ("subtaskId" in item) {
        item.subtaskId = "st_other" as typeof item.subtaskId;
      }
    }],
    ["non-ACTIVE", (item: ContextItem) => {
      item.status = "PROPOSED";
    }],
  ] as const)("rejects Subtask bucket item with %s", (label, mutate) => {
    const input = makeStandardInput();
    const item = makeContextItem(
      `ctx_sub_${label.replaceAll(" ", "_").toLowerCase()}`,
      "SUBTASK",
    );
    mutate(item);
    input.activeContext.subtask = [item];
    expectInvalidActive(input);
  });

  it("rejects duplicate Context Item IDs within or across buckets", () => {
    const within = makeStandardInput();
    const duplicate = makeContextItem("ctx_duplicate", "PROJECT");
    within.activeContext.project = [duplicate, structuredClone(duplicate)];
    expectInvalidActive(within);

    const across = makeStandardInput();
    across.activeContext.project = [makeContextItem("ctx_duplicate", "PROJECT")];
    across.activeContext.bigTask = [makeContextItem("ctx_duplicate", "BIG_TASK")];
    expectInvalidActive(across);
  });

  it("preserves exact supplied order and contradictory content without resolution", () => {
    const input = makeStandardInput();
    input.activeContext.project = [
      makeContextItem("ctx_z", "PROJECT", "Use strategy A."),
      makeContextItem("ctx_a", "PROJECT", "Do not use strategy A."),
      makeContextItem("ctx_m", "PROJECT", "Use strategy C."),
    ];
    const packet = requireStandardPacket(input);
    expect(packet.sections[7].items.map(({ id }) => id)).toEqual([
      "ctx_z",
      "ctx_a",
      "ctx_m",
    ]);
    expect(packet.sections[7].items.map(({ body }) => body)).toEqual([
      "Use strategy A.",
      "Do not use strategy A.",
      "Use strategy C.",
    ]);
  });
});

describe("QA retest targets and generated inclusion reasons", () => {
  it("allows zero or factual targets for Fresh QA and requires one for Focused Re-QA", () => {
    expect(requireFreshQaPacket(makeFreshQaInput()).sections[8].targets).toEqual([]);
    const freshWithTarget = makeFreshQaInput();
    freshWithTarget.boundedRetestTargets = [retestTarget()];
    expect(requireFreshQaPacket(freshWithTarget).sections[8].targets).toEqual([
      retestTarget(),
    ]);
    expect(
      compileJitContextPacket({
        ...makeFocusedReQaInput(),
        boundedRetestTargets: [],
      }),
    ).toEqual({ compiled: false, reason: "INVALID_CONTEXT_PACKET_INPUT" });
  });

  it.each(["repairReasoning", "reproductionStrategy", "priorPassJudgment", "rawChat"])(
    "rejects extra retest target field %s",
    (field) => {
      const input = makeFocusedReQaInput();
      input.boundedRetestTargets = [
        {
          ...retestTarget(),
          retestTarget: { ...retestTarget().retestTarget, [field]: "forbidden" },
        },
      ] as FocusedReQaInput["boundedRetestTargets"];
      expect(compileJitContextPacket(input)).toEqual({
        compiled: false,
        reason: "INVALID_CONTEXT_PACKET_INPUT",
      });
    },
  );

  it("generates every reason from section type and ignores no caller override", () => {
    const first = requirePacket(makeStandardInput());
    const changedText = makeStandardInput();
    changedText.canonicalProjectRules[0]!.body = "Completely different caller text.";
    const second = requirePacket(changedText);
    expect(first.sections.map(({ reasonIncluded }) => reasonIncluded)).toEqual(
      second.sections.map(({ reasonIncluded }) => reasonIncluded),
    );
    expect(first.sections.every(({ reasonIncluded }) => reasonIncluded.length > 0)).toBe(true);
  });
});

describe("determinism, detachment, immutability, and non-operational output", () => {
  it("returns the same exact packet for the same stable canonical input", () => {
    const input = makeStandardInput();
    expect(requirePacket(input)).toEqual(requirePacket(structuredClone(input)));
  });

  it("detaches every standard caller category and deeply freezes the packet", () => {
    const input = makeStandardInput();
    const packet = requirePacket(input);
    const snapshot = structuredClone(packet);

    input.project.name = "Mutated Project";
    input.bigTask.title = "Mutated Big Task";
    input.bigTask.acceptanceCriteria[0] = "Mutated Big criterion";
    input.subtask.title = "Mutated Subtask";
    input.subtask.acceptanceCriteria[0] = "Mutated Subtask criterion";
    input.canonicalProjectRules[0]!.body = "Mutated Project rule";
    input.repositoryRuntimeEvidence[0]!.body = "Mutated evidence";
    input.activeContext.project[0]!.body = "Mutated Project Context Item";
    input.activeContext.bigTask[0]!.body = "Mutated Big Task Context Item";
    input.activeContext.subtask[0]!.body = "Mutated Subtask Context Item";

    expect(packet).toEqual(snapshot);
    expectDeeplyFrozen(packet);
  });

  it("detaches every QA-only caller category", () => {
    const input = makeFocusedReQaInput();
    const packet = requirePacket(input);
    const snapshot = structuredClone(packet);
    input.lockedInvariants[0]!.body = "Mutated invariant";
    input.qaInstructions[0]!.body = "Mutated QA instruction";
    input.boundedRetestTargets[0]!.sourceReference = "finding://mutated";
    input.boundedRetestTargets[0]!.retestTarget.findingId = "MUTATED";
    expect(packet).toEqual(snapshot);
    expectDeeplyFrozen(packet);
  });

  it("contains no budget result, provider serialization, history, digest, or promoted payload", () => {
    const serialized = JSON.stringify(requirePacket(makeStandardInput()));
    expect(serialized).not.toMatch(
      /tokenCount|withinBudget|budgetSatisfied|prunedToFit|"messages"|codexRequest|rawHistory|threadHistory|rawChat|digest|promotedContext|acceptedPromotedContext|dependencyContext/,
    );
    expect(
      JitContextPacketSchema.safeParse({
        ...requirePacket(makeStandardInput()),
        tokenCount: 100,
      }).success,
    ).toBe(false);
  });
});

describe("hostile runtime input capture", () => {
  const expectInvalidRuntime = (input: unknown): void => {
    expect(
      compileJitContextPacket(input as JitContextPacketCompilationInput),
    ).toEqual({ compiled: false, reason: "INVALID_CONTEXT_PACKET_INPUT" });
  };

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const input = makeStandardInput() as unknown as Record<string, unknown>;
    Object.defineProperty(input, "digest", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "forbidden";
      },
    });
    expectInvalidRuntime(input);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbol keys, non-enumerable keys, and special __proto__ own keys", () => {
    const symbolInput = makeStandardInput() as unknown as Record<PropertyKey, unknown>;
    symbolInput[Symbol("hidden")] = "hidden";
    expectInvalidRuntime(symbolInput);

    const nonEnumerableInput = makeStandardInput();
    Object.defineProperty(nonEnumerableInput, "hidden", {
      value: "hidden",
      enumerable: false,
    });
    expectInvalidRuntime(nonEnumerableInput);

    const specialKeyInput = makeStandardInput();
    Object.defineProperty(specialKeyInput, "__proto__", {
      value: "hostile",
      enumerable: true,
      configurable: true,
    });
    expectInvalidRuntime(specialKeyInput);
  });

  it("rejects changing prototypes, own keys, and throwing descriptors", () => {
    let prototypeCalls = 0;
    expectInvalidRuntime(
      new Proxy(makeStandardInput(), {
        getPrototypeOf: () =>
          prototypeCalls++ % 2 === 0 ? Object.prototype : null,
      }),
    );

    let ownKeyCalls = 0;
    expectInvalidRuntime(
      new Proxy(makeStandardInput(), {
        ownKeys: (target) => {
          const keys = Reflect.ownKeys(target);
          return ownKeyCalls++ % 2 === 0 ? keys : keys.slice(0, -1);
        },
      }),
    );

    expectInvalidRuntime(
      new Proxy(makeStandardInput(), {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === "project") {
            throw new Error("hostile descriptor");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }),
    );
  });

  it("rejects changing nested arrays and nested objects", () => {
    const arrayInput = makeStandardInput();
    let arrayDescriptorCalls = 0;
    arrayInput.canonicalProjectRules = new Proxy(arrayInput.canonicalProjectRules, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "0" && descriptor !== undefined && "value" in descriptor) {
          return {
            ...descriptor,
            value:
              arrayDescriptorCalls++ % 2 === 0
                ? descriptor.value
                : block("project-rule://changed"),
          };
        }
        return descriptor;
      },
    });
    expectInvalidRuntime(arrayInput);

    const objectInput = makeStandardInput();
    const project = objectInput.project;
    let projectDescriptorCalls = 0;
    objectInput.project = new Proxy(project, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "name" && descriptor !== undefined && "value" in descriptor) {
          return {
            ...descriptor,
            value:
              projectDescriptorCalls++ % 2 === 0
                ? "Codex Task Console"
                : "Changing Project",
          };
        }
        return descriptor;
      },
    });
    expectInvalidRuntime(objectInput);
  });

  it("rejects a jointly changing hierarchy/context observation", () => {
    const input = makeStandardInput();
    let observedProject = "prj_console";
    input.project = new Proxy(input.project, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "id" && descriptor !== undefined && "value" in descriptor) {
          observedProject =
            observedProject === "prj_console" ? "prj_alternate" : "prj_console";
          return { ...descriptor, value: observedProject };
        }
        return descriptor;
      },
    });
    input.bigTask = new Proxy(input.bigTask, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "projectId" && descriptor !== undefined && "value" in descriptor
          ? { ...descriptor, value: observedProject }
          : descriptor;
      },
    });
    input.activeContext.project[0] = new Proxy(input.activeContext.project[0]!, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "projectId" && descriptor !== undefined && "value" in descriptor
          ? { ...descriptor, value: observedProject }
          : descriptor;
      },
    });
    expectInvalidRuntime(input);
  });
});
