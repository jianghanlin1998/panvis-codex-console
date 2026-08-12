import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ContextScopeSchema,
  ProjectSchema,
  SubtaskDependencySchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
} from "../src/index.js";
import type {
  AllowedContextSet,
  BigTask,
  ContextScope,
  Project,
  Subtask,
  SubtaskMaturity,
  SubtaskStatus,
} from "../src/index.js";

const project = (id: string): Project =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id,
    name: `Project ${id}`,
    slug: id.replace("prj_", ""),
    repository: { kind: "PATH", path: `/workspace/${id}` },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });

const bigTask = (id: string, projectId: string): BigTask =>
  BigTaskSchema.parse({
    recordType: "BIG_TASK",
    id,
    projectId,
    title: `Big Task ${id}`,
    goal: "Prove the context access boundary.",
    rationale: "Raw context access must be deterministic.",
    scopeIn: ["Context access"],
    scopeOut: ["Retrieval"],
    acceptanceCriteria: ["Default deny"],
    status: "IN_PROGRESS",
  });

const subtask = (
  id: string,
  bigTaskId: string,
  status: SubtaskStatus = "TODO",
  maturity: SubtaskMaturity = "NOT_STARTED",
): Subtask =>
  SubtaskSchema.parse({
    recordType: "SUBTASK",
    id,
    bigTaskId,
    title: `Subtask ${id}`,
    goal: "Evaluate exact raw context scopes.",
    scopeIn: ["Domain ACL"],
    scopeOut: ["Storage"],
    acceptanceCriteria: ["Exact hierarchy only"],
    untouchedAreas: ["Context retrieval"],
    status,
    maturity,
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
    promptSeed: "Implement the bounded access contract.",
  });

const scope = (input: unknown): ContextScope => ContextScopeSchema.parse(input);

const p1 = project("prj_p1");
const b1 = bigTask("bt_b1", p1.id);
const s1 = subtask("st_s1", b1.id);
const s2 = subtask("st_s2", b1.id);
const b2 = bigTask("bt_b2", p1.id);
const s3 = subtask("st_s3", b2.id);
const p2 = project("prj_p2");
const b3 = bigTask("bt_b3", p2.id);
const s4 = subtask("st_s4", b3.id);

const builtSet = (
  targetProject: Project = p1,
  targetBigTask: BigTask = b1,
  targetSubtask: Subtask = s1,
): AllowedContextSet => {
  const result = buildAllowedContextSet(targetProject, targetBigTask, targetSubtask);
  if (!result.valid) {
    throw new Error(`Unexpected invalid target: ${result.errorCodes.join(",")}`);
  }
  return result.allowedContextSet;
};

const allowedSet = builtSet();

const projectScope = (projectId: string): ContextScope =>
  scope({ scopeType: "PROJECT", projectId });
const bigTaskScope = (projectId: string, bigTaskId: string): ContextScope =>
  scope({ scopeType: "BIG_TASK", projectId, bigTaskId });
const subtaskScope = (
  projectId: string,
  bigTaskId: string,
  subtaskId: string,
): ContextScope => scope({ scopeType: "SUBTASK", projectId, bigTaskId, subtaskId });

describe("AllowedContextSet independent access matrix", () => {
  it.each([
    ["target Project", projectScope(p1.id), true, "TARGET_PROJECT_SCOPE"],
    ["target parent Big Task", bigTaskScope(p1.id, b1.id), true, "TARGET_BIG_TASK_SCOPE"],
    ["target exact Subtask", subtaskScope(p1.id, b1.id, s1.id), true, "TARGET_SUBTASK_SCOPE"],
    ["sibling Subtask", subtaskScope(p1.id, b1.id, s2.id), false, "SIBLING_SUBTASK_EXCLUDED"],
    ["same-Project unrelated Big Task", bigTaskScope(p1.id, b2.id), false, "UNRELATED_BIG_TASK_EXCLUDED"],
    ["Subtask under unrelated Big Task", subtaskScope(p1.id, b2.id, s3.id), false, "UNRELATED_BIG_TASK_EXCLUDED"],
    ["other Project", projectScope(p2.id), false, "OTHER_PROJECT_EXCLUDED"],
    ["other-Project Big Task", bigTaskScope(p2.id, b3.id), false, "OTHER_PROJECT_EXCLUDED"],
    ["other-Project Subtask", subtaskScope(p2.id, b3.id, s4.id), false, "OTHER_PROJECT_EXCLUDED"],
  ] as const)("evaluates %s", (_label, candidate, allowed, reason) => {
    expect(evaluateContextScopeAccess(allowedSet, candidate)).toEqual({ allowed, reason });
  });
});

describe("AllowedContextSet target hierarchy validation", () => {
  it("builds the one canonical ordered raw-scope tuple", () => {
    expect(buildAllowedContextSet(p1, b1, s1)).toEqual({
      valid: true,
      allowedContextSet: {
        target: { projectId: p1.id, bigTaskId: b1.id, subtaskId: s1.id },
        allowedRawScopes: [
          { scopeType: "PROJECT", projectId: p1.id },
          { scopeType: "BIG_TASK", projectId: p1.id, bigTaskId: b1.id },
          {
            scopeType: "SUBTASK",
            projectId: p1.id,
            bigTaskId: b1.id,
            subtaskId: s1.id,
          },
        ],
      },
      errorCodes: [],
    });
  });

  it("rejects a Big Task owned by another Project", () => {
    expect(buildAllowedContextSet(p1, bigTask(b1.id, p2.id), s1)).toEqual({
      valid: false,
      errorCodes: ["BIG_TASK_PROJECT_MISMATCH"],
    });
  });

  it("rejects a Subtask owned by another Big Task", () => {
    expect(buildAllowedContextSet(p1, b1, s3)).toEqual({
      valid: false,
      errorCodes: ["SUBTASK_BIG_TASK_MISMATCH"],
    });
  });

  it("reports both target ownership mismatches in stable order", () => {
    expect(buildAllowedContextSet(p1, b3, s3)).toEqual({
      valid: false,
      errorCodes: ["BIG_TASK_PROJECT_MISMATCH", "SUBTASK_BIG_TASK_MISMATCH"],
    });
  });

  it.each([
    ["null Project", null, b1, s1],
    ["null Big Task", p1, null, s1],
    ["null Subtask", p1, b1, null],
    ["missing Project ID", { ...p1, id: undefined }, b1, s1],
    ["extra Big Task field", p1, { ...b1, hidden: true }, s1],
    ["missing Subtask owner", p1, b1, { ...s1, bigTaskId: undefined }],
    ["padded Project ID", { ...p1, id: ` ${p1.id}` }, b1, s1],
    ["padded Big Task owner", p1, { ...b1, projectId: `${p1.id} ` }, s1],
    ["padded Subtask owner", p1, b1, { ...s1, bigTaskId: ` ${b1.id}` }],
  ] as const)("fails closed for %s", (_label, projectInput, bigTaskInput, subtaskInput) => {
    expect(
      buildAllowedContextSet(
        projectInput as unknown as Project,
        bigTaskInput as unknown as BigTask,
        subtaskInput as unknown as Subtask,
      ),
    ).toEqual({ valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] });
  });
});

describe("candidate ContextScope fail-closed behavior", () => {
  it.each([
    ["null", null],
    ["missing scope type", { projectId: p1.id }],
    ["unknown scope type", { scopeType: "GLOBAL", projectId: p1.id }],
    ["null Project ID", { scopeType: "PROJECT", projectId: null }],
    ["missing Project ID", { scopeType: "PROJECT" }],
    ["unknown field", { scopeType: "PROJECT", projectId: p1.id, hidden: true }],
    ["missing Big Task ID", { scopeType: "BIG_TASK", projectId: p1.id }],
    ["missing Subtask ID", { scopeType: "SUBTASK", projectId: p1.id, bigTaskId: b1.id }],
    ["padded Project ID", { scopeType: "PROJECT", projectId: ` ${p1.id}` }],
    ["padded Big Task ID", { scopeType: "BIG_TASK", projectId: p1.id, bigTaskId: `${b1.id} ` }],
    ["padded Subtask ID", { scopeType: "SUBTASK", projectId: p1.id, bigTaskId: b1.id, subtaskId: ` ${s1.id}` }],
    ["Project scope with child ID", { scopeType: "PROJECT", projectId: p1.id, bigTaskId: b1.id }],
  ] as const)("denies malformed %s input", (_label, candidate) => {
    expect(
      evaluateContextScopeAccess(allowedSet, candidate as unknown as ContextScope),
    ).toEqual({ allowed: false, reason: "INVALID_CONTEXT_SCOPE" });
  });

  it("compares the complete hierarchy rather than a coincidentally equal child ID", () => {
    expect(
      evaluateContextScopeAccess(
        allowedSet,
        subtaskScope(p2.id, b3.id, s1.id),
      ),
    ).toEqual({ allowed: false, reason: "OTHER_PROJECT_EXCLUDED" });
    expect(
      evaluateContextScopeAccess(
        allowedSet,
        bigTaskScope(p2.id, b1.id),
      ),
    ).toEqual({ allowed: false, reason: "OTHER_PROJECT_EXCLUDED" });
  });
});

describe("dependency isolation", () => {
  const dependencies = [
    SubtaskDependencySchema.parse({
      upstreamSubtaskId: s2.id,
      downstreamSubtaskId: s1.id,
      dependencyType: "BLOCKING",
      requiredGate: "HARDENED",
      reason: "Hardened upstream evidence is required.",
    }),
    SubtaskDependencySchema.parse({
      upstreamSubtaskId: s2.id,
      downstreamSubtaskId: s1.id,
      dependencyType: "BLOCKING",
      requiredGate: "ACCEPTED",
      reason: "Accepted upstream evidence is required.",
    }),
    SubtaskDependencySchema.parse({
      upstreamSubtaskId: s2.id,
      downstreamSubtaskId: s1.id,
      dependencyType: "INFORMATIONAL",
      requiredGate: "NONE",
      reason: "The relationship is informational.",
    }),
  ] as const;

  it.each(dependencies)(
    "does not grant raw upstream Subtask scope for $dependencyType + $requiredGate",
    (dependency) => {
      expect(dependency.downstreamSubtaskId).toBe(s1.id);
      expect(
        evaluateContextScopeAccess(allowedSet, subtaskScope(p1.id, b1.id, s2.id)),
      ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
      expect(evaluateContextScopeAccess(allowedSet, bigTaskScope(p1.id, b1.id))).toEqual({
        allowed: true,
        reason: "TARGET_BIG_TASK_SCOPE",
      });
    },
  );

  it("does not expand ACL for reverse or unrelated dependency evidence", () => {
    const reverse = SubtaskDependencySchema.parse({
      upstreamSubtaskId: s1.id,
      downstreamSubtaskId: s2.id,
      dependencyType: "BLOCKING",
      requiredGate: "HARDENED",
      reason: "Reverse evidence.",
    });
    const unrelated = SubtaskDependencySchema.parse({
      upstreamSubtaskId: s3.id,
      downstreamSubtaskId: s4.id,
      dependencyType: "INFORMATIONAL",
      requiredGate: "NONE",
      reason: "Unrelated evidence.",
    });

    expect(reverse.upstreamSubtaskId).toBe(s1.id);
    expect(unrelated.downstreamSubtaskId).toBe(s4.id);
    expect(
      evaluateContextScopeAccess(allowedSet, subtaskScope(p1.id, b1.id, s2.id)),
    ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
    expect(
      evaluateContextScopeAccess(allowedSet, subtaskScope(p1.id, b2.id, s3.id)),
    ).toEqual({ allowed: false, reason: "UNRELATED_BIG_TASK_EXCLUDED" });
  });
});

describe("AllowedContextSet determinism and mutation resistance", () => {
  it("is identical across insertion order, copies, frozen inputs, and repeated builds", () => {
    const reorderedProject = Object.freeze({
      maxActiveCodingSubtasks: p1.maxActiveCodingSubtasks,
      defaultBranch: p1.defaultBranch,
      repository: p1.repository,
      slug: p1.slug,
      name: p1.name,
      id: p1.id,
      recordType: p1.recordType,
    });
    const reorderedBigTask = Object.freeze({
      status: b1.status,
      acceptanceCriteria: b1.acceptanceCriteria,
      scopeOut: b1.scopeOut,
      scopeIn: b1.scopeIn,
      rationale: b1.rationale,
      goal: b1.goal,
      title: b1.title,
      projectId: b1.projectId,
      id: b1.id,
      recordType: b1.recordType,
    });
    const copiedSubtask = Object.freeze({ ...s1 });

    expect(builtSet(reorderedProject, reorderedBigTask, copiedSubtask)).toEqual(allowedSet);
    for (let index = 0; index < 20; index += 1) {
      expect(builtSet({ ...p1 }, { ...b1 }, { ...s1 })).toEqual(allowedSet);
      expect(
        evaluateContextScopeAccess(
          { allowedRawScopes: [...allowedSet.allowedRawScopes], target: { ...allowedSet.target } },
          { subtaskId: s1.id, bigTaskId: b1.id, projectId: p1.id, scopeType: "SUBTASK" },
        ),
      ).toEqual({ allowed: true, reason: "TARGET_SUBTASK_SCOPE" });
    }
  });

  it("deep-freezes the canonical output and each decision", () => {
    expect(Object.isFrozen(allowedSet)).toBe(true);
    expect(Object.isFrozen(allowedSet.target)).toBe(true);
    expect(Object.isFrozen(allowedSet.allowedRawScopes)).toBe(true);
    allowedSet.allowedRawScopes.forEach((value) => expect(Object.isFrozen(value)).toBe(true));
    expect(
      Object.isFrozen(evaluateContextScopeAccess(allowedSet, projectScope(p1.id))),
    ).toBe(true);
    expect(() => {
      (allowedSet.allowedRawScopes as unknown as ContextScope[]).push(projectScope(p2.id));
    }).toThrow();
    expect(() => {
      (allowedSet.target as unknown as { projectId: string }).projectId = p2.id;
    }).toThrow();
  });

  it("copies the target hierarchy so later entity mutation cannot change access", () => {
    const mutableProject = { ...p1 };
    const mutableBigTask = { ...b1 };
    const mutableSubtask = { ...s1 };
    const result = buildAllowedContextSet(mutableProject, mutableBigTask, mutableSubtask);
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    (mutableProject as { id: string }).id = p2.id;
    (mutableBigTask as { id: string }).id = b2.id;
    (mutableSubtask as { id: string }).id = s2.id;

    expect(result.allowedContextSet).toEqual(allowedSet);
    expect(
      evaluateContextScopeAccess(
        result.allowedContextSet,
        subtaskScope(p1.id, b1.id, s1.id),
      ),
    ).toEqual({ allowed: true, reason: "TARGET_SUBTASK_SCOPE" });
  });

  it.each([
    ["unrelated Big Task in allowed tuple", {
      ...allowedSet,
      allowedRawScopes: [
        allowedSet.allowedRawScopes[0],
        bigTaskScope(p1.id, b2.id),
        allowedSet.allowedRawScopes[2],
      ],
    }],
    ["sibling Subtask in allowed tuple", {
      ...allowedSet,
      allowedRawScopes: [
        allowedSet.allowedRawScopes[0],
        allowedSet.allowedRawScopes[1],
        subtaskScope(p1.id, b1.id, s2.id),
      ],
    }],
    ["input-dependent scope order", {
      ...allowedSet,
      allowedRawScopes: [...allowedSet.allowedRawScopes].reverse(),
    }],
    ["extra raw scope", {
      ...allowedSet,
      allowedRawScopes: [...allowedSet.allowedRawScopes, projectScope(p2.id)],
    }],
    ["missing raw scope", {
      ...allowedSet,
      allowedRawScopes: allowedSet.allowedRawScopes.slice(0, 2),
    }],
    ["padded target ID", {
      ...allowedSet,
      target: { ...allowedSet.target, projectId: `${allowedSet.target.projectId} ` },
    }],
    ["unknown key", { ...allowedSet, hidden: true }],
    ["null set", null],
  ] as const)("denies a forged or corrupt AllowedContextSet with %s", (_label, forged) => {
    expect(
      evaluateContextScopeAccess(
        forged as unknown as AllowedContextSet,
        projectScope(p1.id),
      ),
    ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });
  });

  it.each([
    ["TODO / NOT_STARTED", "TODO", "NOT_STARTED"],
    ["IN_PROGRESS / IMPLEMENTED", "IN_PROGRESS", "IMPLEMENTED"],
    ["QA_DEBUG / HARDENED", "QA_DEBUG", "HARDENED"],
    ["DONE / ACCEPTED", "DONE", "ACCEPTED"],
    ["DROPPED / NOT_STARTED", "DROPPED", "NOT_STARTED"],
    ["ARCHIVED / ACCEPTED", "ARCHIVED", "ACCEPTED"],
  ] as const)("does not couple ACL to %s", (_label, status, maturity) => {
    expect(builtSet(p1, b1, subtask(s1.id, b1.id, status, maturity))).toEqual(allowedSet);
  });
});

describe("Task Contract mutation audit", () => {
  const expectDenied = (candidate: ContextScope): void => {
    expect(evaluateContextScopeAccess(allowedSet, candidate).allowed).toBe(false);
  };

  const mutationChecks: readonly [string, () => void][] = [
    ["01 allow all same-Project scopes", () => expectDenied(bigTaskScope(p1.id, b2.id))],
    ["02 allow all same-Big-Task Subtasks", () => expectDenied(subtaskScope(p1.id, b1.id, s2.id))],
    ["03 blocking dependency grants upstream raw scope", () => expectDenied(subtaskScope(p1.id, b1.id, s2.id))],
    ["04 informational dependency grants raw scope", () => expectDenied(subtaskScope(p1.id, b1.id, s2.id))],
    ["05 other Project scope allowed", () => expectDenied(projectScope(p2.id))],
    ["06 same-Project unrelated Big Task allowed", () => expectDenied(bigTaskScope(p1.id, b2.id))],
    ["07 child of unrelated Big Task allowed", () => expectDenied(subtaskScope(p1.id, b2.id, s3.id))],
    ["08 malformed target accepted", () => {
      expect(buildAllowedContextSet(null as unknown as Project, b1, s1).valid).toBe(false);
    }],
    ["09 mismatched Big Task to Project accepted", () => {
      expect(buildAllowedContextSet(p1, b3, s4).valid).toBe(false);
    }],
    ["10 mismatched Subtask to Big Task accepted", () => {
      expect(buildAllowedContextSet(p1, b1, s3).valid).toBe(false);
    }],
    ["11 candidate Subtask compared only by ID", () => expectDenied(subtaskScope(p2.id, b3.id, s1.id))],
    ["12 candidate Big Task compared only by ID", () => expectDenied(bigTaskScope(p2.id, b1.id))],
    ["13 candidate Project ID ignored", () => expectDenied(subtaskScope(p2.id, b1.id, s1.id))],
    ["14 sibling raw scope treated as parent scope", () => expectDenied(subtaskScope(p1.id, b1.id, s2.id))],
    ["15 parser normalization changes raw meaning", () => {
      expect(
        evaluateContextScopeAccess(
          allowedSet,
          { scopeType: "PROJECT", projectId: ` ${p1.id}` } as unknown as ContextScope,
        ).allowed,
      ).toBe(false);
    }],
    ["16 malformed candidate defaults allow", () => {
      expect(evaluateContextScopeAccess(allowedSet, null as unknown as ContextScope).allowed)
        .toBe(false);
    }],
    ["17 unknown candidate type defaults allow", () => {
      expect(
        evaluateContextScopeAccess(
          allowedSet,
          { scopeType: "GLOBAL", projectId: p1.id } as unknown as ContextScope,
        ).allowed,
      ).toBe(false);
    }],
    ["18 dependency direction expands ACL", () => expectDenied(subtaskScope(p1.id, b1.id, s2.id))],
    ["19 output ordering depends on input", () => {
      expect(builtSet({ ...p1 }, { ...b1 }, { ...s1 }).allowedRawScopes)
        .toEqual(allowedSet.allowedRawScopes);
    }],
    ["20 mutable output changes future decision", () => {
      expect(Object.isFrozen(allowedSet.allowedRawScopes)).toBe(true);
    }],
    ["21 source target mutation changes decisions", () => {
      expect(evaluateContextScopeAccess(allowedSet, projectScope(p1.id)).allowed).toBe(true);
    }],
    ["22 unknown branch becomes allow", () => {
      expect(
        evaluateContextScopeAccess(
          allowedSet,
          { scopeType: "UNKNOWN", projectId: p1.id } as unknown as ContextScope,
        ).allowed,
      ).toBe(false);
    }],
    ["23 raw-history special case grants sibling", () => expectDenied(subtaskScope(p1.id, b1.id, s2.id))],
    ["24 maturity affects ACL", () => {
      expect(builtSet(p1, b1, subtask(s1.id, b1.id, "TODO", "ACCEPTED"))).toEqual(allowedSet);
    }],
    ["25 board status affects ACL", () => {
      expect(builtSet(p1, b1, subtask(s1.id, b1.id, "ARCHIVED"))).toEqual(allowedSet);
    }],
    ["26 forged allowed set adds an unrelated scope", () => {
      const forged = {
        ...allowedSet,
        allowedRawScopes: [
          allowedSet.allowedRawScopes[0],
          bigTaskScope(p1.id, b2.id),
          allowedSet.allowedRawScopes[2],
        ],
      } as unknown as AllowedContextSet;
      expect(evaluateContextScopeAccess(forged, bigTaskScope(p1.id, b2.id)).allowed)
        .toBe(false);
    }],
    ["27 other-Project reuse of target hierarchy IDs", () => expectDenied(subtaskScope(p2.id, b1.id, s1.id))],
  ];

  it.each(mutationChecks)("kills mutation %s", (_label, verify) => {
    verify();
  });
});
