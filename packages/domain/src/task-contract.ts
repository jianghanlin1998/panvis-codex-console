import { z } from "zod";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
} from "./identifiers.js";
import type { BigTaskId, ProjectId, SubtaskId } from "./identifiers.js";
import {
  ReasoningLevelSchema,
  SubtaskDelegationPolicySchema,
  SubtaskStartPolicySchema,
} from "./tasks.js";
import type {
  ReasoningLevel,
  SubtaskDelegationPolicy,
  SubtaskStartPolicy,
} from "./tasks.js";
import { isWellFormedUnicode } from "./well-formed-unicode.js";

const hasNoDurableControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return false;
    }
  }
  return true;
};

const durableText = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: "Durable Task Contract text must already be trimmed",
  })
  .refine(isWellFormedUnicode, {
    message: "Durable Task Contract text must be well-formed Unicode",
  })
  .refine(hasNoDurableControlCharacters, {
    message: "Durable Task Contract text must not contain control characters",
  });

const exactProjectId = z.custom<ProjectId>((value) => {
  const result = ProjectIdSchema.safeParse(value);
  return result.success && result.data === value;
});
const exactBigTaskId = z.custom<BigTaskId>((value) => {
  const result = BigTaskIdSchema.safeParse(value);
  return result.success && result.data === value;
});
const exactSubtaskId = z.custom<SubtaskId>((value) => {
  const result = SubtaskIdSchema.safeParse(value);
  return result.success && result.data === value;
});

const taskContractRef = durableText.max(1_000);
const nonEmptyTextList = z.array(durableText).min(1);
const textList = z.array(durableText);

export interface TaskContractV0 {
  readonly taskContractRef: string;
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly subtaskId: SubtaskId;
  readonly title: string;
  readonly goal: string;
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly untouchedAreas: readonly string[];
  readonly promptSeed: string;
  readonly startPolicy: SubtaskStartPolicy;
  readonly delegationPolicy: SubtaskDelegationPolicy;
  readonly recommendedReasoningLevel: ReasoningLevel;
}

const TaskContractV0ShapeSchema = z
  .object({
    taskContractRef,
    projectId: exactProjectId,
    bigTaskId: exactBigTaskId,
    subtaskId: exactSubtaskId,
    title: durableText,
    goal: durableText,
    scopeIn: nonEmptyTextList,
    scopeOut: textList,
    acceptanceCriteria: nonEmptyTextList,
    untouchedAreas: textList,
    promptSeed: durableText,
    startPolicy: SubtaskStartPolicySchema,
    delegationPolicy: SubtaskDelegationPolicySchema,
    recommendedReasoningLevel: ReasoningLevelSchema,
  })
  .strict();

export const TaskContractV0Schema = TaskContractV0ShapeSchema.transform(
  (contract): TaskContractV0 =>
    Object.freeze({
      ...contract,
      scopeIn: Object.freeze([...contract.scopeIn]),
      scopeOut: Object.freeze([...contract.scopeOut]),
      acceptanceCriteria: Object.freeze([...contract.acceptanceCriteria]),
      untouchedAreas: Object.freeze([...contract.untouchedAreas]),
    }),
);
