import { z } from "zod";

import { ContextItemSchema } from "./context.js";
import {
  BoundedRetestTargetSchema,
  QaContextProfileKindSchema,
} from "./context-profile.js";
import { captureJointlyStableStructuralDataList } from "./structural-capture.js";
import {
  BigTaskSchema,
  ProjectSchema,
  SubtaskSchema,
} from "./tasks.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

const PacketTextBlockSchema = z
  .object({
    sourceReference: compactText(2_048),
    title: compactText(256),
    body: compactText(4_000),
  })
  .strict();

const PacketBoundedRetestTargetSchema = z
  .object({
    sourceReference: compactText(2_048),
    retestTarget: BoundedRetestTargetSchema,
  })
  .strict();

export const JitContextPacketProfileKindSchema = z.enum([
  "STANDARD_SUBTASK_EXECUTION",
  ...QaContextProfileKindSchema.options,
]);

const CommonCompilationInputShape = {
  project: ProjectSchema,
  bigTask: BigTaskSchema,
  subtask: SubtaskSchema,
  canonicalProjectRules: z.array(PacketTextBlockSchema),
  repositoryRuntimeEvidence: z.array(PacketTextBlockSchema),
} as const;

const ActiveContextInputSchema = z
  .object({
    project: z.array(ContextItemSchema),
    bigTask: z.array(ContextItemSchema),
    subtask: z.array(ContextItemSchema),
  })
  .strict();

const QaCompilationInputShape = {
  ...CommonCompilationInputShape,
  lockedInvariants: z.array(PacketTextBlockSchema),
  qaInstructions: z.array(PacketTextBlockSchema),
} as const;

const StandardSubtaskExecutionCompilationInputSchema = z
  .object({
    profile: z.literal("STANDARD_SUBTASK_EXECUTION"),
    ...CommonCompilationInputShape,
    activeContext: ActiveContextInputSchema,
  })
  .strict();

const FreshIndependentQaCompilationInputSchema = z
  .object({
    profile: z.literal("FRESH_INDEPENDENT_QA"),
    ...QaCompilationInputShape,
    boundedRetestTargets: z.array(PacketBoundedRetestTargetSchema),
  })
  .strict();

const FocusedReQaCompilationInputSchema = z
  .object({
    profile: z.literal("FOCUSED_RE_QA"),
    ...QaCompilationInputShape,
    boundedRetestTargets: z.array(PacketBoundedRetestTargetSchema).min(1),
  })
  .strict();

export const JitContextPacketCompilationInputSchema = z.discriminatedUnion(
  "profile",
  [
    StandardSubtaskExecutionCompilationInputSchema,
    FreshIndependentQaCompilationInputSchema,
    FocusedReQaCompilationInputSchema,
  ],
);

const ProjectCoreSchema = ProjectSchema.pick({
  id: true,
  name: true,
  slug: true,
  repository: true,
  defaultBranch: true,
});

const BigTaskContractSchema = BigTaskSchema.pick({
  id: true,
  projectId: true,
  title: true,
  goal: true,
  rationale: true,
  scopeIn: true,
  scopeOut: true,
});

const SubtaskContractSchema = SubtaskSchema.pick({
  id: true,
  bigTaskId: true,
  title: true,
  goal: true,
  scopeIn: true,
  scopeOut: true,
  untouchedAreas: true,
});

const AcceptanceCriteriaSchema = z
  .object({
    bigTask: z
      .object({
        bigTaskId: BigTaskSchema.shape.id,
        criteria: BigTaskSchema.shape.acceptanceCriteria,
      })
      .strict(),
    subtask: z
      .object({
        subtaskId: SubtaskSchema.shape.id,
        criteria: SubtaskSchema.shape.acceptanceCriteria,
      })
      .strict(),
  })
  .strict();

const ExecutionIntentSchema = SubtaskSchema.pick({
  recommendedReasoningLevel: true,
  promptSeed: true,
});

const CanonicalProjectRulesSectionSchema = z
  .object({
    sectionType: z.literal("CANONICAL_PROJECT_RULES"),
    reasonIncluded: z.literal("CANONICAL_PROJECT_RULES"),
    blocks: z.array(PacketTextBlockSchema),
  })
  .strict();

const RepositoryRuntimeEvidenceSectionSchema = z
  .object({
    sectionType: z.literal("REPOSITORY_RUNTIME_EVIDENCE"),
    reasonIncluded: z.literal("REPOSITORY_RUNTIME_EVIDENCE"),
    blocks: z.array(PacketTextBlockSchema),
  })
  .strict();

const ProjectCoreSectionSchema = z
  .object({
    sectionType: z.literal("PROJECT_CORE"),
    reasonIncluded: z.literal("CURRENT_PROJECT_CORE"),
    project: ProjectCoreSchema,
  })
  .strict();

const BigTaskContractSectionSchema = z
  .object({
    sectionType: z.literal("BIG_TASK_CONTRACT"),
    reasonIncluded: z.literal("CURRENT_BIG_TASK_CONTRACT"),
    bigTask: BigTaskContractSchema,
  })
  .strict();

const SubtaskContractSectionSchema = z
  .object({
    sectionType: z.literal("SUBTASK_CONTRACT"),
    reasonIncluded: z.literal("CURRENT_SUBTASK_CONTRACT"),
    subtask: SubtaskContractSchema,
  })
  .strict();

const AcceptanceCriteriaSectionSchema = z
  .object({
    sectionType: z.literal("ACCEPTANCE_CRITERIA"),
    reasonIncluded: z.literal("CURRENT_ACCEPTANCE_CRITERIA"),
    acceptanceCriteria: AcceptanceCriteriaSchema,
  })
  .strict();

const ExecutionIntentSectionSchema = z
  .object({
    sectionType: z.literal("EXECUTION_INTENT"),
    reasonIncluded: z.literal("STANDARD_EXECUTION_INTENT"),
    executionIntent: ExecutionIntentSchema,
  })
  .strict();

const ActiveProjectContextSectionSchema = z
  .object({
    sectionType: z.literal("ACTIVE_PROJECT_CONTEXT"),
    reasonIncluded: z.literal("ALREADY_SELECTED_ACTIVE_PROJECT_CONTEXT"),
    items: z.array(ContextItemSchema),
  })
  .strict();

const ActiveBigTaskContextSectionSchema = z
  .object({
    sectionType: z.literal("ACTIVE_BIG_TASK_CONTEXT"),
    reasonIncluded: z.literal("ALREADY_SELECTED_ACTIVE_BIG_TASK_CONTEXT"),
    items: z.array(ContextItemSchema),
  })
  .strict();

const ActiveSubtaskContextSectionSchema = z
  .object({
    sectionType: z.literal("ACTIVE_SUBTASK_CONTEXT"),
    reasonIncluded: z.literal("ALREADY_SELECTED_ACTIVE_SUBTASK_CONTEXT"),
    items: z.array(ContextItemSchema),
  })
  .strict();

const LockedInvariantsSectionSchema = z
  .object({
    sectionType: z.literal("LOCKED_INVARIANTS"),
    reasonIncluded: z.literal("LOCKED_QA_INVARIANTS"),
    blocks: z.array(PacketTextBlockSchema),
  })
  .strict();

const QaInstructionsSectionSchema = z
  .object({
    sectionType: z.literal("QA_INSTRUCTIONS"),
    reasonIncluded: z.literal("QA_INSTRUCTIONS"),
    blocks: z.array(PacketTextBlockSchema),
  })
  .strict();

const BoundedRetestTargetsSectionSchema = z
  .object({
    sectionType: z.literal("BOUNDED_RETEST_TARGETS"),
    reasonIncluded: z.literal("BOUNDED_RETEST_TARGETS"),
    targets: z.array(PacketBoundedRetestTargetSchema),
  })
  .strict();

const RequiredBoundedRetestTargetsSectionSchema = z
  .object({
    sectionType: z.literal("BOUNDED_RETEST_TARGETS"),
    reasonIncluded: z.literal("BOUNDED_RETEST_TARGETS"),
    targets: z.array(PacketBoundedRetestTargetSchema).min(1),
  })
  .strict();

const StandardPacketSectionsSchema = z.tuple([
  CanonicalProjectRulesSectionSchema,
  RepositoryRuntimeEvidenceSectionSchema,
  ProjectCoreSectionSchema,
  BigTaskContractSectionSchema,
  SubtaskContractSectionSchema,
  AcceptanceCriteriaSectionSchema,
  ExecutionIntentSectionSchema,
  ActiveProjectContextSectionSchema,
  ActiveBigTaskContextSectionSchema,
  ActiveSubtaskContextSectionSchema,
]);

const FreshQaPacketSectionsSchema = z.tuple([
  CanonicalProjectRulesSectionSchema,
  RepositoryRuntimeEvidenceSectionSchema,
  ProjectCoreSectionSchema,
  BigTaskContractSectionSchema,
  SubtaskContractSectionSchema,
  AcceptanceCriteriaSectionSchema,
  LockedInvariantsSectionSchema,
  QaInstructionsSectionSchema,
  BoundedRetestTargetsSectionSchema,
]);

const FocusedReQaPacketSectionsSchema = z.tuple([
  CanonicalProjectRulesSectionSchema,
  RepositoryRuntimeEvidenceSectionSchema,
  ProjectCoreSectionSchema,
  BigTaskContractSectionSchema,
  SubtaskContractSectionSchema,
  AcceptanceCriteriaSectionSchema,
  LockedInvariantsSectionSchema,
  QaInstructionsSectionSchema,
  RequiredBoundedRetestTargetsSectionSchema,
]);

export const JitContextPacketSchema = z.discriminatedUnion("profile", [
  z
    .object({
      profile: z.literal("STANDARD_SUBTASK_EXECUTION"),
      sections: StandardPacketSectionsSchema,
    })
    .strict(),
  z
    .object({
      profile: z.literal("FRESH_INDEPENDENT_QA"),
      sections: FreshQaPacketSectionsSchema,
    })
    .strict(),
  z
    .object({
      profile: z.literal("FOCUSED_RE_QA"),
      sections: FocusedReQaPacketSectionsSchema,
    })
    .strict(),
]);

export const JitContextPacketCompilationReasonSchema = z.enum([
  "INVALID_CONTEXT_PACKET_INPUT",
  "INCONSISTENT_TASK_HIERARCHY",
  "INVALID_ACTIVE_CONTEXT",
]);

export type JitContextPacketProfileKind = z.infer<
  typeof JitContextPacketProfileKindSchema
>;
export type JitContextPacketCompilationInput = z.infer<
  typeof JitContextPacketCompilationInputSchema
>;
export type JitContextPacket = z.infer<typeof JitContextPacketSchema>;
export type JitContextPacketCompilationReason = z.infer<
  typeof JitContextPacketCompilationReasonSchema
>;
export type JitContextPacketCompilationResult =
  | Readonly<{
      compiled: true;
      packet: JitContextPacket;
    }>
  | Readonly<{
      compiled: false;
      reason: JitContextPacketCompilationReason;
    }>;

type StandardCompilationInput = z.infer<
  typeof StandardSubtaskExecutionCompilationInputSchema
>;
type QaCompilationInput =
  | z.infer<typeof FreshIndependentQaCompilationInputSchema>
  | z.infer<typeof FocusedReQaCompilationInputSchema>;

const failure = (
  reason: JitContextPacketCompilationReason,
): JitContextPacketCompilationResult => Object.freeze({ compiled: false, reason });

interface TopLevelReferenceCapture {
  readonly prototype: typeof Object.prototype | null;
  readonly keys: readonly string[];
  readonly values: readonly unknown[];
}

const captureTopLevelReferences = (
  input: unknown,
): TopLevelReferenceCapture | null => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.some(
        (key) => typeof key !== "string" || key === "__proto__",
      )
    ) {
      return null;
    }
    const keys = ownKeys as string[];
    const values: unknown[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return null;
      }
      values.push(descriptor.value);
    }
    return { prototype, keys, values };
  } catch {
    return null;
  }
};

const capturedDataEqual = (left: unknown, right: unknown): boolean => {
  if (typeof left !== "object" || left === null) {
    return Object.is(left, right);
  }
  if (typeof right !== "object" || right === null) {
    return false;
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
    return false;
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    return (
      leftDescriptor !== undefined &&
      rightDescriptor !== undefined &&
      "value" in leftDescriptor &&
      "value" in rightDescriptor &&
      capturedDataEqual(leftDescriptor.value, rightDescriptor.value)
    );
  });
};

const captureCompilationInput = (input: unknown): unknown | null => {
  const topLevel = captureTopLevelReferences(input);
  if (topLevel === null) {
    return null;
  }
  const captured = captureJointlyStableStructuralDataList([
    input,
    ...topLevel.values,
  ]);
  if (
    !captured.jointlyConsistent ||
    captured.stable.some((stable) => !stable)
  ) {
    return null;
  }
  const capturedRoot = captured.data[0];
  if (
    typeof capturedRoot !== "object" ||
    capturedRoot === null ||
    Array.isArray(capturedRoot) ||
    Object.getPrototypeOf(capturedRoot) !== topLevel.prototype
  ) {
    return null;
  }
  const capturedKeys = Reflect.ownKeys(capturedRoot);
  if (
    capturedKeys.length !== topLevel.keys.length ||
    capturedKeys.some((key, index) => key !== topLevel.keys[index])
  ) {
    return null;
  }
  for (let index = 0; index < topLevel.keys.length; index += 1) {
    const key = topLevel.keys[index];
    if (key === undefined) {
      return null;
    }
    const rootDescriptor = Object.getOwnPropertyDescriptor(capturedRoot, key);
    if (
      rootDescriptor === undefined ||
      !("value" in rootDescriptor) ||
      !capturedDataEqual(rootDescriptor.value, captured.data[index + 1])
    ) {
      return null;
    }
  }
  return capturedRoot;
};

const deeplyFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deeplyFreeze(descriptor.value);
    }
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

const invalidActiveContext = (input: StandardCompilationInput): boolean => {
  const seenIds = new Set<string>();
  const buckets = [
    ["PROJECT", input.activeContext.project],
    ["BIG_TASK", input.activeContext.bigTask],
    ["SUBTASK", input.activeContext.subtask],
  ] as const;

  for (const [bucket, items] of buckets) {
    for (const item of items) {
      if (item.status !== "ACTIVE" || seenIds.has(item.id)) {
        return true;
      }
      seenIds.add(item.id);
      if (item.projectId !== input.project.id) {
        return true;
      }
      if (bucket === "PROJECT" && "bigTaskId" in item) {
        return true;
      }
      if (
        bucket === "BIG_TASK" &&
        (!("bigTaskId" in item) ||
          "subtaskId" in item ||
          item.bigTaskId !== input.bigTask.id)
      ) {
        return true;
      }
      if (
        bucket === "SUBTASK" &&
        (!("subtaskId" in item) ||
          item.bigTaskId !== input.bigTask.id ||
          item.subtaskId !== input.subtask.id)
      ) {
        return true;
      }
    }
  }
  return false;
};

const projectCoreSection = (input: JitContextPacketCompilationInput) => ({
  sectionType: "PROJECT_CORE" as const,
  reasonIncluded: "CURRENT_PROJECT_CORE" as const,
  project: {
    id: input.project.id,
    name: input.project.name,
    slug: input.project.slug,
    repository: input.project.repository,
    defaultBranch: input.project.defaultBranch,
  },
});

const bigTaskContractSection = (input: JitContextPacketCompilationInput) => ({
  sectionType: "BIG_TASK_CONTRACT" as const,
  reasonIncluded: "CURRENT_BIG_TASK_CONTRACT" as const,
  bigTask: {
    id: input.bigTask.id,
    projectId: input.bigTask.projectId,
    title: input.bigTask.title,
    goal: input.bigTask.goal,
    rationale: input.bigTask.rationale,
    scopeIn: input.bigTask.scopeIn,
    scopeOut: input.bigTask.scopeOut,
  },
});

const subtaskContractSection = (input: JitContextPacketCompilationInput) => ({
  sectionType: "SUBTASK_CONTRACT" as const,
  reasonIncluded: "CURRENT_SUBTASK_CONTRACT" as const,
  subtask: {
    id: input.subtask.id,
    bigTaskId: input.subtask.bigTaskId,
    title: input.subtask.title,
    goal: input.subtask.goal,
    scopeIn: input.subtask.scopeIn,
    scopeOut: input.subtask.scopeOut,
    untouchedAreas: input.subtask.untouchedAreas,
  },
});

const acceptanceCriteriaSection = (input: JitContextPacketCompilationInput) => ({
  sectionType: "ACCEPTANCE_CRITERIA" as const,
  reasonIncluded: "CURRENT_ACCEPTANCE_CRITERIA" as const,
  acceptanceCriteria: {
    bigTask: {
      bigTaskId: input.bigTask.id,
      criteria: input.bigTask.acceptanceCriteria,
    },
    subtask: {
      subtaskId: input.subtask.id,
      criteria: input.subtask.acceptanceCriteria,
    },
  },
});

const sharedSections = (input: JitContextPacketCompilationInput) =>
  [
    {
      sectionType: "CANONICAL_PROJECT_RULES" as const,
      reasonIncluded: "CANONICAL_PROJECT_RULES" as const,
      blocks: input.canonicalProjectRules,
    },
    {
      sectionType: "REPOSITORY_RUNTIME_EVIDENCE" as const,
      reasonIncluded: "REPOSITORY_RUNTIME_EVIDENCE" as const,
      blocks: input.repositoryRuntimeEvidence,
    },
    projectCoreSection(input),
    bigTaskContractSection(input),
    subtaskContractSection(input),
    acceptanceCriteriaSection(input),
  ] as const;

const compileStandardPacket = (
  input: StandardCompilationInput,
): JitContextPacket => {
  const packet = {
    profile: input.profile,
    sections: [
      ...sharedSections(input),
      {
        sectionType: "EXECUTION_INTENT" as const,
        reasonIncluded: "STANDARD_EXECUTION_INTENT" as const,
        executionIntent: {
          recommendedReasoningLevel: input.subtask.recommendedReasoningLevel,
          promptSeed: input.subtask.promptSeed,
        },
      },
      {
        sectionType: "ACTIVE_PROJECT_CONTEXT" as const,
        reasonIncluded: "ALREADY_SELECTED_ACTIVE_PROJECT_CONTEXT" as const,
        items: input.activeContext.project,
      },
      {
        sectionType: "ACTIVE_BIG_TASK_CONTEXT" as const,
        reasonIncluded: "ALREADY_SELECTED_ACTIVE_BIG_TASK_CONTEXT" as const,
        items: input.activeContext.bigTask,
      },
      {
        sectionType: "ACTIVE_SUBTASK_CONTEXT" as const,
        reasonIncluded: "ALREADY_SELECTED_ACTIVE_SUBTASK_CONTEXT" as const,
        items: input.activeContext.subtask,
      },
    ],
  };
  return JitContextPacketSchema.parse(packet);
};

const compileQaPacket = (input: QaCompilationInput): JitContextPacket => {
  const packet = {
    profile: input.profile,
    sections: [
      ...sharedSections(input),
      {
        sectionType: "LOCKED_INVARIANTS" as const,
        reasonIncluded: "LOCKED_QA_INVARIANTS" as const,
        blocks: input.lockedInvariants,
      },
      {
        sectionType: "QA_INSTRUCTIONS" as const,
        reasonIncluded: "QA_INSTRUCTIONS" as const,
        blocks: input.qaInstructions,
      },
      {
        sectionType: "BOUNDED_RETEST_TARGETS" as const,
        reasonIncluded: "BOUNDED_RETEST_TARGETS" as const,
        targets: input.boundedRetestTargets,
      },
    ],
  };
  return JitContextPacketSchema.parse(packet);
};

/**
 * Compiles already-authorized and already-classified canonical DATA. This pure
 * boundary does not establish ACL access, provenance authenticity, acceptance,
 * trust, verification, token-budget compliance, or provider execution input.
 */
export const compileJitContextPacket = (
  input: JitContextPacketCompilationInput,
): JitContextPacketCompilationResult => {
  try {
    const capturedInput = captureCompilationInput(input);
    if (capturedInput === null) {
      return failure("INVALID_CONTEXT_PACKET_INPUT");
    }

    const parsed = JitContextPacketCompilationInputSchema.safeParse(capturedInput);
    if (!parsed.success) {
      const capturedProfile =
        typeof capturedInput === "object" && capturedInput !== null
          ? (capturedInput as Readonly<Record<string, unknown>>).profile
          : undefined;
      const onlyActiveContextIssues = parsed.error.issues.every(
        (issue) => issue.path[0] === "activeContext",
      );
      return failure(
        capturedProfile === "STANDARD_SUBTASK_EXECUTION" && onlyActiveContextIssues
          ? "INVALID_ACTIVE_CONTEXT"
          : "INVALID_CONTEXT_PACKET_INPUT",
      );
    }

    if (
      parsed.data.bigTask.projectId !== parsed.data.project.id ||
      parsed.data.subtask.bigTaskId !== parsed.data.bigTask.id
    ) {
      return failure("INCONSISTENT_TASK_HIERARCHY");
    }

    if (
      parsed.data.profile === "STANDARD_SUBTASK_EXECUTION" &&
      invalidActiveContext(parsed.data)
    ) {
      return failure("INVALID_ACTIVE_CONTEXT");
    }

    const packet =
      parsed.data.profile === "STANDARD_SUBTASK_EXECUTION"
        ? compileStandardPacket(parsed.data)
        : compileQaPacket(parsed.data);
    return Object.freeze({ compiled: true, packet: deeplyFreeze(packet) });
  } catch {
    return failure("INVALID_CONTEXT_PACKET_INPUT");
  }
};
