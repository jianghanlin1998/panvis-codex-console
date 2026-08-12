import { describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ContextScopeSchema,
  ProjectSchema,
  SubtaskSchema,
  buildAllowedContextSet,
  evaluateContextScopeAccess,
} from "../src/index.js";
import type {
  AllowedContextSet,
  BigTask,
  ContextScope,
  ContextScopeAccessDecision,
  Project,
  Subtask,
  SubtaskMaturity,
  SubtaskStatus,
} from "../src/index.js";

const makeProject = (id: string, index = 0): Project =>
  ProjectSchema.parse({
    recordType: "PROJECT",
    id,
    name: `ACL Project ${index}`,
    slug: `acl-project-${index}`,
    repository: { kind: "PATH", path: `/workspace/acl-project-${index}` },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });

const makeBigTask = (
  id: string,
  projectId: string,
  index = 0,
  status: "IN_PROGRESS" | "DONE" = "IN_PROGRESS",
): BigTask =>
  BigTaskSchema.parse({
    recordType: "BIG_TASK",
    id,
    projectId,
    title: `ACL Big Task ${index}`,
    goal: "Prove exact raw-scope isolation.",
    rationale: "Raw discussion state must remain isolated.",
    scopeIn: ["Pure ACL"],
    scopeOut: ["Retrieval"],
    acceptanceCriteria: ["Default deny"],
    status,
  });

const makeSubtask = (
  id: string,
  bigTaskId: string,
  index = 0,
  status: SubtaskStatus = "TODO",
  maturity: SubtaskMaturity = "NOT_STARTED",
): Subtask =>
  SubtaskSchema.parse({
    recordType: "SUBTASK",
    id,
    bigTaskId,
    title: `ACL Subtask ${index}`,
    goal: "Evaluate an exact hierarchy.",
    scopeIn: ["Access decision"],
    scopeOut: ["Context selection"],
    acceptanceCriteria: ["Only three raw scopes are allowed"],
    untouchedAreas: ["Storage"],
    status,
    maturity,
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "HIGH",
    promptSeed: "Harden the exact access boundary.",
  });

const projectScope = (projectId: string): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId });

const bigTaskScope = (projectId: string, bigTaskId: string): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId });

const subtaskScope = (
  projectId: string,
  bigTaskId: string,
  subtaskId: string,
): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "SUBTASK", projectId, bigTaskId, subtaskId });

const buildSet = (project: Project, bigTask: BigTask, subtask: Subtask): AllowedContextSet => {
  const result = buildAllowedContextSet(project, bigTask, subtask);
  if (!result.valid) {
    throw new Error(`Unexpected invalid hierarchy: ${result.errorCodes.join(",")}`);
  }
  return result.allowedContextSet;
};

const expectedAccess = (
  target: Readonly<{ projectId: string; bigTaskId: string; subtaskId: string }>,
  candidate: ContextScope,
): ContextScopeAccessDecision => {
  if (candidate.projectId !== target.projectId) {
    return { allowed: false, reason: "OTHER_PROJECT_EXCLUDED" };
  }
  if (candidate.scopeType === "PROJECT") {
    return { allowed: true, reason: "TARGET_PROJECT_SCOPE" };
  }
  if (candidate.bigTaskId !== target.bigTaskId) {
    return { allowed: false, reason: "UNRELATED_BIG_TASK_EXCLUDED" };
  }
  if (candidate.scopeType === "BIG_TASK") {
    return { allowed: true, reason: "TARGET_BIG_TASK_SCOPE" };
  }
  return candidate.subtaskId === target.subtaskId
    ? { allowed: true, reason: "TARGET_SUBTASK_SCOPE" }
    : { allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" };
};

const baseProject = makeProject("prj_hardened_p1", 1);
const baseBigTask = makeBigTask("bt_hardened_b1", baseProject.id, 1);
const baseSubtask = makeSubtask("st_hardened_s1", baseBigTask.id, 1);
const siblingSubtask = makeSubtask("st_hardened_s2", baseBigTask.id, 2);
const otherBigTask = makeBigTask("bt_hardened_b2", baseProject.id, 2);
const otherBigTaskSubtask = makeSubtask("st_hardened_s3", otherBigTask.id, 3);
const otherProject = makeProject("prj_hardened_p2", 2);
const otherProjectBigTask = makeBigTask("bt_hardened_b3", otherProject.id, 3);
const otherProjectSubtask = makeSubtask("st_hardened_s4", otherProjectBigTask.id, 4);
const baseSet = buildSet(baseProject, baseBigTask, baseSubtask);

const representativeScopes = [
  projectScope(baseProject.id),
  bigTaskScope(baseProject.id, baseBigTask.id),
  subtaskScope(baseProject.id, baseBigTask.id, baseSubtask.id),
  subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id),
  bigTaskScope(baseProject.id, otherBigTask.id),
  subtaskScope(baseProject.id, otherBigTask.id, otherBigTaskSubtask.id),
  projectScope(otherProject.id),
  bigTaskScope(otherProject.id, otherProjectBigTask.id),
  subtaskScope(otherProject.id, otherProjectBigTask.id, otherProjectSubtask.id),
] as const;

describe("S2A independent ACL oracle and hierarchy matrix", () => {
  it("matches an independently derived oracle for every target in a 4x4x6 topology", () => {
    const projects = Array.from({ length: 4 }, (_, projectIndex) =>
      makeProject(`prj_oracle_${projectIndex}`, 100 + projectIndex),
    );
    const bigTasks = projects.flatMap((project, projectIndex) =>
      Array.from({ length: 4 }, (_, bigTaskIndex) => ({
        entity: makeBigTask(
          `bt_oracle_${projectIndex}_${bigTaskIndex}`,
          project.id,
          projectIndex * 4 + bigTaskIndex,
        ),
        project,
      })),
    );
    const subtasks = bigTasks.flatMap(({ entity: bigTask, project }, bigTaskIndex) =>
      Array.from({ length: 6 }, (_, subtaskIndex) => ({
        bigTask,
        entity: makeSubtask(
          `st_oracle_${bigTaskIndex}_${subtaskIndex}`,
          bigTask.id,
          bigTaskIndex * 6 + subtaskIndex,
        ),
        project,
      })),
    );
    const candidates = [
      ...projects.map(({ id }) => projectScope(id)),
      ...bigTasks.map(({ entity, project }) => bigTaskScope(project.id, entity.id)),
      ...subtasks.map(({ bigTask, entity, project }) =>
        subtaskScope(project.id, bigTask.id, entity.id),
      ),
    ];

    let decisionCount = 0;
    for (const { bigTask, entity: subtask, project } of subtasks) {
      const allowedContextSet = buildSet(project, bigTask, subtask);
      for (const candidate of candidates) {
        const target = {
          projectId: project.id,
          bigTaskId: bigTask.id,
          subtaskId: subtask.id,
        };
        expect(evaluateContextScopeAccess(allowedContextSet, candidate)).toEqual(
          expectedAccess(target, candidate),
        );
        decisionCount += 1;
      }
    }

    expect(projects).toHaveLength(4);
    expect(bigTasks).toHaveLength(16);
    expect(subtasks).toHaveLength(96);
    expect(candidates).toHaveLength(116);
    expect(decisionCount).toBe(11_136);
  });

  it.each([
    [projectScope(baseProject.id), true, "TARGET_PROJECT_SCOPE"],
    [projectScope(otherProject.id), false, "OTHER_PROJECT_EXCLUDED"],
    [bigTaskScope(baseProject.id, baseBigTask.id), true, "TARGET_BIG_TASK_SCOPE"],
    [bigTaskScope(baseProject.id, otherBigTask.id), false, "UNRELATED_BIG_TASK_EXCLUDED"],
    [bigTaskScope(otherProject.id, baseBigTask.id), false, "OTHER_PROJECT_EXCLUDED"],
    [bigTaskScope(otherProject.id, otherProjectBigTask.id), false, "OTHER_PROJECT_EXCLUDED"],
    [subtaskScope(baseProject.id, baseBigTask.id, baseSubtask.id), true, "TARGET_SUBTASK_SCOPE"],
    [subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id), false, "SIBLING_SUBTASK_EXCLUDED"],
    [subtaskScope(baseProject.id, otherBigTask.id, baseSubtask.id), false, "UNRELATED_BIG_TASK_EXCLUDED"],
    [subtaskScope(otherProject.id, baseBigTask.id, baseSubtask.id), false, "OTHER_PROJECT_EXCLUDED"],
    [subtaskScope(otherProject.id, otherProjectBigTask.id, otherProjectSubtask.id), false, "OTHER_PROJECT_EXCLUDED"],
  ] as const)("uses the complete hierarchy for candidate %#", (candidate, allowed, reason) => {
    expect(evaluateContextScopeAccess(baseSet, candidate)).toEqual({ allowed, reason });
  });
});

describe("S2A target hierarchy and canonical evidence", () => {
  it("returns the exact three-level target for valid evidence", () => {
    expect(buildAllowedContextSet(baseProject, baseBigTask, baseSubtask)).toEqual({
      valid: true,
      allowedContextSet: baseSet,
      errorCodes: [],
    });
  });

  it.each([
    [
      "Big Task Project mismatch",
      baseProject,
      { ...baseBigTask, projectId: otherProject.id },
      baseSubtask,
      ["BIG_TASK_PROJECT_MISMATCH"],
    ],
    [
      "Subtask Big Task mismatch",
      baseProject,
      baseBigTask,
      { ...baseSubtask, bigTaskId: otherBigTask.id },
      ["SUBTASK_BIG_TASK_MISMATCH"],
    ],
    [
      "both ownership mismatches",
      baseProject,
      { ...baseBigTask, projectId: otherProject.id },
      { ...baseSubtask, bigTaskId: otherBigTask.id },
      ["BIG_TASK_PROJECT_MISMATCH", "SUBTASK_BIG_TASK_MISMATCH"],
    ],
    [
      "coincident child IDs under wrong owners",
      otherProject,
      { ...baseBigTask, projectId: baseProject.id },
      { ...baseSubtask, bigTaskId: otherBigTask.id },
      ["BIG_TASK_PROJECT_MISMATCH", "SUBTASK_BIG_TASK_MISMATCH"],
    ],
  ] as const)("rejects %s in stable order", (_label, project, bigTask, subtask, errorCodes) => {
    expect(
      buildAllowedContextSet(
        project as Project,
        bigTask as unknown as BigTask,
        subtask as unknown as Subtask,
      ),
    ).toEqual({ valid: false, errorCodes });
  });

  it.each([
    ["null", null, baseBigTask, baseSubtask],
    ["array", [], baseBigTask, baseSubtask],
    ["primitive", "project", baseBigTask, baseSubtask],
    ["missing field", { ...baseProject, id: undefined }, baseBigTask, baseSubtask],
    ["unknown field", { ...baseProject, unknown: true }, baseBigTask, baseSubtask],
    ["wrong recordType", { ...baseProject, recordType: "BIG_TASK" }, baseBigTask, baseSubtask],
    ["invalid enum", baseProject, { ...baseBigTask, status: "TODO" }, baseSubtask],
    [
      "malformed repository",
      { ...baseProject, repository: { kind: "PATH", reference: "wrong member" } },
      baseBigTask,
      baseSubtask,
    ],
    ["malformed structured array", baseProject, { ...baseBigTask, scopeIn: [null] }, baseSubtask],
    ["sparse structured array", baseProject, { ...baseBigTask, scopeIn: new Array(1) }, baseSubtask],
    [
      "inherited Project fields",
      Object.create(baseProject) as unknown,
      baseBigTask,
      baseSubtask,
    ],
    [
      "inherited repository fields",
      { ...baseProject, repository: Object.create(baseProject.repository) },
      baseBigTask,
      baseSubtask,
    ],
    [
      "accessor Project field",
      Object.defineProperty({ ...baseProject }, "id", { get: () => baseProject.id, enumerable: true }),
      baseBigTask,
      baseSubtask,
    ],
  ] as const)("fails closed for malformed target shape: %s", (_label, project, bigTask, subtask) => {
    expect(
      buildAllowedContextSet(
        project as unknown as Project,
        bigTask as unknown as BigTask,
        subtask as unknown as Subtask,
      ),
    ).toEqual({ valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] });
  });

  it.each([
    ["Project ID", { ...baseProject, id: `\u00a0${baseProject.id}\u00a0` }, baseBigTask, baseSubtask],
    ["Big Task ID", baseProject, { ...baseBigTask, id: `\t${baseBigTask.id}\t` }, baseSubtask],
    ["Big Task owner", baseProject, { ...baseBigTask, projectId: `\u3000${baseProject.id}` }, baseSubtask],
    ["Subtask ID", baseProject, baseBigTask, { ...baseSubtask, id: `${baseSubtask.id}\ufeff` }],
    ["Subtask owner", baseProject, baseBigTask, { ...baseSubtask, bigTaskId: `\u202f${baseBigTask.id}` }],
  ] as const)("requires canonical identity/ownership evidence for %s", (_label, project, bigTask, subtask) => {
    expect(
      buildAllowedContextSet(
        project as unknown as Project,
        bigTask as unknown as BigTask,
        subtask as unknown as Subtask,
      ),
    ).toEqual({ valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] });
  });

  it("accepts parser-normalizable non-access text because ACL uses only identity and ownership", () => {
    const paddedProject = {
      ...baseProject,
      name: `\u2000${baseProject.name}\u2000`,
      slug: ` ${baseProject.slug} `,
      repository: { kind: "PATH" as const, path: `\u3000${baseProject.repository.kind === "PATH" ? baseProject.repository.path : ""}\u3000` },
      defaultBranch: `\ufeff${baseProject.defaultBranch}\ufeff`,
    };
    const paddedBigTask = {
      ...baseBigTask,
      title: ` ${baseBigTask.title} `,
      goal: `\t${baseBigTask.goal}\t`,
      rationale: `\u00a0${baseBigTask.rationale}\u00a0`,
      scopeIn: [` ${baseBigTask.scopeIn[0]} `],
      scopeOut: [`\u1680${baseBigTask.scopeOut[0]}\u1680`],
      acceptanceCriteria: [`\u205f${baseBigTask.acceptanceCriteria[0]}\u205f`],
    };
    const paddedSubtask = {
      ...baseSubtask,
      title: ` ${baseSubtask.title} `,
      goal: `\t${baseSubtask.goal}\t`,
      scopeIn: [`\u00a0${baseSubtask.scopeIn[0]}\u00a0`],
      scopeOut: [`\u2000${baseSubtask.scopeOut[0]}\u2000`],
      acceptanceCriteria: [`\u202f${baseSubtask.acceptanceCriteria[0]}\u202f`],
      untouchedAreas: [`\u3000${baseSubtask.untouchedAreas[0]}\u3000`],
      promptSeed: `\ufeff${baseSubtask.promptSeed}\ufeff`,
    };

    expect(
      buildAllowedContextSet(
        paddedProject as Project,
        paddedBigTask as BigTask,
        paddedSubtask as Subtask,
      ),
    ).toEqual({ valid: true, allowedContextSet: baseSet, errorCodes: [] });
  });
});

describe("S2A candidate canonicalization and reason accuracy", () => {
  const trimmableWhitespace = [
    " ",
    "\t",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
  ] as const;

  it("proves ECMAScript-trim behavior and denies every normalized ID position", () => {
    let assertionCount = 0;
    for (const whitespace of trimmableWhitespace) {
      const candidates = [
        { scopeType: "PROJECT", projectId: `${whitespace}${baseProject.id}${whitespace}` },
        {
          scopeType: "BIG_TASK",
          projectId: baseProject.id,
          bigTaskId: `${whitespace}${baseBigTask.id}${whitespace}`,
        },
        {
          scopeType: "SUBTASK",
          projectId: baseProject.id,
          bigTaskId: baseBigTask.id,
          subtaskId: `${whitespace}${baseSubtask.id}${whitespace}`,
        },
      ] as const;
      for (const candidate of candidates) {
        const parsed = ContextScopeSchema.safeParse(candidate);
        expect(parsed.success).toBe(true);
        expect(
          evaluateContextScopeAccess(baseSet, candidate as unknown as ContextScope),
        ).toEqual({ allowed: false, reason: "INVALID_CONTEXT_SCOPE" });
        assertionCount += 2;
      }
    }
    expect(assertionCount).toBe(54);
  });

  it.each([
    ["interior space", "prj_acl interior", "bt_acl interior", "st_acl interior"],
    ["zero-width code point", "prj_acl\u200bproject", "bt_acl\u200bbig", "st_acl\u200bsub"],
    ["unusual Unicode", "prj_雪", "bt_仕事", "st_境界"],
  ] as const)("allows canonical unusual identifiers: %s", (_label, projectId, bigTaskId, subtaskId) => {
    const project = makeProject(projectId, 800);
    const bigTask = makeBigTask(bigTaskId, project.id, 800);
    const subtask = makeSubtask(subtaskId, bigTask.id, 800);
    const allowedContextSet = buildSet(project, bigTask, subtask);

    expect(evaluateContextScopeAccess(allowedContextSet, projectScope(project.id))).toEqual({
      allowed: true,
      reason: "TARGET_PROJECT_SCOPE",
    });
    expect(evaluateContextScopeAccess(allowedContextSet, bigTaskScope(project.id, bigTask.id))).toEqual({
      allowed: true,
      reason: "TARGET_BIG_TASK_SCOPE",
    });
    expect(
      evaluateContextScopeAccess(
        allowedContextSet,
        subtaskScope(project.id, bigTask.id, subtask.id),
      ),
    ).toEqual({ allowed: true, reason: "TARGET_SUBTASK_SCOPE" });
  });

  it("rejects malformed candidates before hierarchy reason selection", () => {
    const inheritedTargetProject = Object.create({
      scopeType: "PROJECT",
      projectId: baseProject.id,
    });
    const accessorTargetProject = Object.defineProperties({}, {
      scopeType: { get: () => "PROJECT", enumerable: true },
      projectId: { get: () => baseProject.id, enumerable: true },
    });

    for (const candidate of [
      null,
      undefined,
      1,
      [],
      {},
      { scopeType: "GLOBAL", projectId: baseProject.id },
      { scopeType: "PROJECT", projectId: baseProject.id, extra: true },
      inheritedTargetProject,
      accessorTargetProject,
    ]) {
      expect(
        evaluateContextScopeAccess(baseSet, candidate as unknown as ContextScope),
      ).toEqual({ allowed: false, reason: "INVALID_CONTEXT_SCOPE" });
    }
  });
});

describe("S2A forged AllowedContextSet and copy boundary", () => {
  const corruptSets: readonly unknown[] = [
    null,
    undefined,
    1,
    "set",
    [],
    {},
    { allowedRawScopes: baseSet.allowedRawScopes },
    { target: baseSet.target },
    { ...baseSet, extra: true },
    { ...baseSet, target: { ...baseSet.target, projectId: ` ${baseProject.id}` } },
    { ...baseSet, target: { ...baseSet.target, bigTaskId: `${baseBigTask.id}\u00a0` } },
    { ...baseSet, target: { ...baseSet.target, subtaskId: `\u3000${baseSubtask.id}` } },
    { ...baseSet, allowedRawScopes: [] },
    { ...baseSet, allowedRawScopes: [baseSet.allowedRawScopes[0]] },
    { ...baseSet, allowedRawScopes: baseSet.allowedRawScopes.slice(0, 2) },
    { ...baseSet, allowedRawScopes: [...baseSet.allowedRawScopes, projectScope(otherProject.id)] },
    { ...baseSet, allowedRawScopes: [...baseSet.allowedRawScopes].reverse() },
    {
      ...baseSet,
      allowedRawScopes: [
        baseSet.allowedRawScopes[0],
        baseSet.allowedRawScopes[0],
        baseSet.allowedRawScopes[2],
      ],
    },
    {
      ...baseSet,
      allowedRawScopes: [
        baseSet.allowedRawScopes[0],
        baseSet.allowedRawScopes[1],
        baseSet.allowedRawScopes[1],
      ],
    },
    {
      ...baseSet,
      allowedRawScopes: [
        { ...baseSet.allowedRawScopes[0], scopeType: "BIG_TASK" },
        baseSet.allowedRawScopes[1],
        baseSet.allowedRawScopes[2],
      ],
    },
    {
      ...baseSet,
      allowedRawScopes: [
        projectScope(otherProject.id),
        bigTaskScope(otherProject.id, otherProjectBigTask.id),
        subtaskScope(otherProject.id, otherProjectBigTask.id, otherProjectSubtask.id),
      ],
    },
    {
      ...baseSet,
      allowedRawScopes: [
        baseSet.allowedRawScopes[0],
        bigTaskScope(baseProject.id, otherBigTask.id),
        baseSet.allowedRawScopes[2],
      ],
    },
    {
      ...baseSet,
      allowedRawScopes: [
        baseSet.allowedRawScopes[0],
        baseSet.allowedRawScopes[1],
        subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id),
      ],
    },
    {
      ...baseSet,
      allowedRawScopes: [
        { ...baseSet.allowedRawScopes[0], projectId: `\ufeff${baseProject.id}` },
        baseSet.allowedRawScopes[1],
        baseSet.allowedRawScopes[2],
      ],
    },
    {
      ...baseSet,
      target: Object.create(baseSet.target),
    },
    Object.create(baseSet),
  ];

  it("denies every candidate when the supplied set is malformed or corrupt", () => {
    let decisionCount = 0;
    for (const corruptSet of corruptSets) {
      for (const candidate of representativeScopes) {
        expect(
          evaluateContextScopeAccess(corruptSet as AllowedContextSet, candidate),
        ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });
        decisionCount += 1;
      }
    }
    expect(corruptSets).toHaveLength(26);
    expect(decisionCount).toBe(234);
  });

  it("accepts canonical structural copies and rejects altered copies", () => {
    const copies = [
      structuredClone(baseSet),
      JSON.parse(JSON.stringify(baseSet)) as AllowedContextSet,
      {
        target: { ...baseSet.target },
        allowedRawScopes: baseSet.allowedRawScopes.map((candidate) => ({ ...candidate })),
      } as unknown as AllowedContextSet,
    ];
    for (const copy of copies) {
      expect(evaluateContextScopeAccess(copy, projectScope(baseProject.id))).toEqual({
        allowed: true,
        reason: "TARGET_PROJECT_SCOPE",
      });
      expect(
        evaluateContextScopeAccess(
          copy,
          subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id),
        ),
      ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
    }

    const reordered = structuredClone(baseSet) as unknown as {
      allowedRawScopes: ContextScope[];
    };
    reordered.allowedRawScopes.reverse();
    expect(
      evaluateContextScopeAccess(reordered as unknown as AllowedContextSet, projectScope(baseProject.id)),
    ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });
  });

  it("treats a self-consistent forged set as a pure evaluator input, not authenticated provenance", () => {
    const selfConsistent = {
      target: {
        projectId: otherProject.id,
        bigTaskId: otherProjectBigTask.id,
        subtaskId: otherProjectSubtask.id,
      },
      allowedRawScopes: [
        projectScope(otherProject.id),
        bigTaskScope(otherProject.id, otherProjectBigTask.id),
        subtaskScope(otherProject.id, otherProjectBigTask.id, otherProjectSubtask.id),
      ],
    } as AllowedContextSet;

    expect(evaluateContextScopeAccess(selfConsistent, projectScope(otherProject.id))).toEqual({
      allowed: true,
      reason: "TARGET_PROJECT_SCOPE",
    });
    expect(evaluateContextScopeAccess(selfConsistent, projectScope(baseProject.id))).toEqual({
      allowed: false,
      reason: "OTHER_PROJECT_EXCLUDED",
    });
    expect(
      evaluateContextScopeAccess(
        selfConsistent,
        subtaskScope(otherProject.id, otherProjectBigTask.id, siblingSubtask.id),
      ),
    ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
  });
});

describe("S2A status, maturity, field, dependency, and Context Item independence", () => {
  const statuses: readonly SubtaskStatus[] = [
    "TODO",
    "IN_PROGRESS",
    "QA_DEBUG",
    "DONE",
    "DROPPED",
    "ARCHIVED",
  ];
  const maturities: readonly SubtaskMaturity[] = [
    "NOT_STARTED",
    "IMPLEMENTED",
    "HARDENED",
    "ACCEPTED",
  ];

  it("preserves identical ACL semantics across all 24 status and maturity combinations", () => {
    let combinationCount = 0;
    for (const status of statuses) {
      for (const maturity of maturities) {
        const allowedContextSet = buildSet(
          baseProject,
          baseBigTask,
          makeSubtask(baseSubtask.id, baseBigTask.id, 1, status, maturity),
        );
        expect(allowedContextSet).toEqual(baseSet);
        for (const candidate of representativeScopes) {
          expect(evaluateContextScopeAccess(allowedContextSet, candidate)).toEqual(
            expectedAccess(baseSet.target, candidate),
          );
        }
        combinationCount += 1;
      }
    }
    expect(combinationCount).toBe(24);
  });

  it.each(["IN_PROGRESS", "DONE"] as const)(
    "does not depend on Big Task status %s",
    (status) => {
      const bigTask = makeBigTask(baseBigTask.id, baseProject.id, 1, status);
      expect(buildSet(baseProject, bigTask, baseSubtask)).toEqual(baseSet);
    },
  );

  it("depends only on canonical target identity and ownership, not other entity fields", () => {
    const changedProject = ProjectSchema.parse({
      ...baseProject,
      name: "A materially different Project name",
      slug: "materially-different-project",
      repository: { kind: "REFERENCE", reference: "repository:materially-different" },
      defaultBranch: "release/hardening",
      maxActiveCodingSubtasks: 1,
    });
    const changedBigTask = BigTaskSchema.parse({
      ...baseBigTask,
      title: "Different title",
      goal: "Different goal",
      rationale: "Different rationale",
      scopeIn: ["Different scope"],
      scopeOut: ["Different exclusion"],
      acceptanceCriteria: ["Different criterion"],
      status: "DONE",
    });
    const changedSubtask = SubtaskSchema.parse({
      ...baseSubtask,
      title: "Different Subtask title",
      goal: "Different Subtask goal",
      scopeIn: ["Different included work"],
      scopeOut: ["Different deferred work"],
      acceptanceCriteria: ["Different outcome"],
      untouchedAreas: ["Different untouched area"],
      status: "QA_DEBUG",
      maturity: "HARDENED",
      startPolicy: "WHEN_READY",
      delegationPolicy: "REVIEW_ONLY",
      recommendedReasoningLevel: "XHIGH",
      promptSeed: "Different stable intent.",
    });

    expect(buildSet(changedProject, changedBigTask, changedSubtask)).toEqual(baseSet);
  });

  it("never expands raw scope for dependency direction, gate, topology, or malformed external edges", () => {
    const dependencyFixtures = [
      {
        label: "BLOCKING + HARDENED upstream",
        edges: [{ upstream: siblingSubtask.id, downstream: baseSubtask.id, type: "BLOCKING", gate: "HARDENED" }],
      },
      {
        label: "BLOCKING + ACCEPTED upstream",
        edges: [{ upstream: siblingSubtask.id, downstream: baseSubtask.id, type: "BLOCKING", gate: "ACCEPTED" }],
      },
      {
        label: "INFORMATIONAL + NONE upstream",
        edges: [{ upstream: siblingSubtask.id, downstream: baseSubtask.id, type: "INFORMATIONAL", gate: "NONE" }],
      },
      {
        label: "reverse",
        edges: [{ upstream: baseSubtask.id, downstream: siblingSubtask.id, type: "BLOCKING", gate: "HARDENED" }],
      },
      {
        label: "other Big Task",
        edges: [{ upstream: otherBigTaskSubtask.id, downstream: baseSubtask.id, type: "BLOCKING", gate: "ACCEPTED" }],
      },
      {
        label: "cross-Project malformed external edge",
        edges: [{ upstream: otherProjectSubtask.id, downstream: baseSubtask.id, type: "BLOCKING", gate: "ACCEPTED" }],
      },
      {
        label: "long chain",
        edges: [
          { upstream: "st_chain_a", downstream: "st_chain_b" },
          { upstream: "st_chain_b", downstream: "st_chain_c" },
          { upstream: "st_chain_c", downstream: baseSubtask.id },
        ],
      },
      {
        label: "fan-in",
        edges: [
          { upstream: "st_fan_in_a", downstream: baseSubtask.id },
          { upstream: "st_fan_in_b", downstream: baseSubtask.id },
        ],
      },
      {
        label: "fan-out",
        edges: [
          { upstream: baseSubtask.id, downstream: "st_fan_out_a" },
          { upstream: baseSubtask.id, downstream: "st_fan_out_b" },
        ],
      },
      {
        label: "cycle",
        edges: [
          { upstream: "st_cycle_a", downstream: "st_cycle_b" },
          { upstream: "st_cycle_b", downstream: "st_cycle_c" },
          { upstream: "st_cycle_c", downstream: "st_cycle_a" },
        ],
      },
    ] as const;

    for (const dependencyFixture of dependencyFixtures) {
      expect(dependencyFixture.label).not.toBe("");
      expect(dependencyFixture.edges.length).toBeGreaterThan(0);
      expect(
        evaluateContextScopeAccess(
          baseSet,
          subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id),
        ),
      ).toEqual({ allowed: false, reason: "SIBLING_SUBTASK_EXCLUDED" });
      expect(
        evaluateContextScopeAccess(
          baseSet,
          subtaskScope(baseProject.id, otherBigTask.id, otherBigTaskSubtask.id),
        ),
      ).toEqual({ allowed: false, reason: "UNRELATED_BIG_TASK_EXCLUDED" });
    }
    expect(dependencyFixtures).toHaveLength(10);
  });

  it("has no Context Item metadata input and remains stable across all metadata variants", () => {
    const contextStatuses = ["ACTIVE", "SUPERSEDED", "REJECTED", "RESOLVED", "PROPOSED"];
    const contextKinds = [
      "DECISION",
      "REQUIREMENT",
      "CONSTRAINT",
      "ENGINEERING_FACT",
      "OPEN_QUESTION",
      "RISK",
    ];
    const authorities = ["HUMAN", "REPO_EVIDENCE", "CODEX_CANDIDATE", "SYSTEM"];
    const sourceTypes = ["CHAT_MESSAGE", "REPO", "HANDOFF", "IMPORT", "MANUAL", "SYSTEM"];
    let variantCount = 0;

    expect(buildAllowedContextSet).toHaveLength(3);
    expect(evaluateContextScopeAccess).toHaveLength(2);
    for (const status of contextStatuses) {
      for (const kind of contextKinds) {
        for (const authority of authorities) {
          for (const sourceType of sourceTypes) {
            expect({ status, kind, authority, sourceType }).toBeDefined();
            expect(
              evaluateContextScopeAccess(baseSet, projectScope(baseProject.id)),
            ).toEqual({ allowed: true, reason: "TARGET_PROJECT_SCOPE" });
            variantCount += 1;
          }
        }
      }
    }
    expect(variantCount).toBe(720);
  });
});

describe("S2A deep immutability", () => {
  it("blocks assignment, deletion, replacement, and array mutators at every exposed layer", () => {
    expect(Object.isFrozen(baseSet)).toBe(true);
    expect(Object.isFrozen(baseSet.target)).toBe(true);
    expect(Object.isFrozen(baseSet.allowedRawScopes)).toBe(true);
    baseSet.allowedRawScopes.forEach((candidate) => expect(Object.isFrozen(candidate)).toBe(true));

    expect(Reflect.set(baseSet as object, "target", { ...baseSet.target })).toBe(false);
    expect(Reflect.deleteProperty(baseSet as object, "target")).toBe(false);
    expect(Reflect.set(baseSet.target as object, "projectId", otherProject.id)).toBe(false);
    expect(Reflect.deleteProperty(baseSet.target as object, "projectId")).toBe(false);
    expect(Reflect.set(baseSet.allowedRawScopes[0] as object, "projectId", otherProject.id)).toBe(false);
    expect(Reflect.deleteProperty(baseSet.allowedRawScopes[2] as object, "subtaskId")).toBe(false);
    expect(() => Object.assign(baseSet.target, { projectId: otherProject.id })).toThrow(TypeError);
    expect(() =>
      (baseSet.allowedRawScopes as unknown as ContextScope[]).push(projectScope(otherProject.id)),
    ).toThrow(TypeError);
    expect(() => (baseSet.allowedRawScopes as unknown as ContextScope[]).pop()).toThrow(TypeError);
    expect(() =>
      (baseSet.allowedRawScopes as unknown as ContextScope[]).splice(0, 1),
    ).toThrow(TypeError);

    expect(evaluateContextScopeAccess(baseSet, projectScope(baseProject.id))).toEqual({
      allowed: true,
      reason: "TARGET_PROJECT_SCOPE",
    });
  });

  it("copies target identity and remains unchanged after every original input layer mutates", () => {
    const project = structuredClone(baseProject) as Project;
    const bigTask = structuredClone(baseBigTask) as BigTask;
    const subtask = structuredClone(baseSubtask) as Subtask;
    const allowedContextSet = buildSet(project, bigTask, subtask);

    (project as unknown as { id: string }).id = otherProject.id;
    (project.repository as unknown as { path: string }).path = "/mutated";
    (bigTask as unknown as { id: string }).id = otherBigTask.id;
    (bigTask.scopeIn as unknown as string[]).push("mutated");
    (subtask as unknown as { id: string }).id = siblingSubtask.id;
    (subtask.acceptanceCriteria as unknown as string[]).splice(0, 1, "mutated");

    expect(allowedContextSet).toEqual(baseSet);
    expect(
      evaluateContextScopeAccess(
        allowedContextSet,
        subtaskScope(baseProject.id, baseBigTask.id, baseSubtask.id),
      ),
    ).toEqual({ allowed: true, reason: "TARGET_SUBTASK_SCOPE" });
  });

  it("freezes all access decisions", () => {
    for (const candidate of representativeScopes) {
      const decision = evaluateContextScopeAccess(baseSet, candidate);
      expect(Object.isFrozen(decision)).toBe(true);
      expect(Reflect.set(decision as object, "allowed", !decision.allowed)).toBe(false);
      expect(Reflect.deleteProperty(decision as object, "reason")).toBe(false);
    }
  });
});

describe("S2A hostile runtime object handling", () => {
  it("returns deterministic invalid-set decisions without leaking hostile exceptions", () => {
    const throwingGetter = Object.defineProperty({}, "target", {
      get: () => {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });
    const changingGetter = Object.defineProperties({}, {
      target: {
        get: () => ({ ...baseSet.target }),
        enumerable: true,
      },
      allowedRawScopes: {
        get: () => [...baseSet.allowedRawScopes],
        enumerable: true,
      },
    });
    const throwingProxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    });
    const inherited = Object.create(baseSet);
    const pollutedPrototype = Object.create({ polluted: true }) as Record<string, unknown>;
    Object.assign(pollutedPrototype, structuredClone(baseSet));

    const hostileValues = [
      throwingGetter,
      changingGetter,
      throwingProxy,
      inherited,
      pollutedPrototype,
      new Date(),
      new Map(),
      new Set(),
      () => baseSet,
      new String("set"),
      Object.create(null),
    ];
    for (const hostile of hostileValues) {
      expect(() =>
        evaluateContextScopeAccess(hostile as AllowedContextSet, projectScope(baseProject.id)),
      ).not.toThrow();
      expect(
        evaluateContextScopeAccess(hostile as AllowedContextSet, projectScope(baseProject.id)),
      ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });
    }
  });

  it("returns deterministic invalid-scope decisions without leaking hostile exceptions", () => {
    const throwingGetter = Object.defineProperty({}, "scopeType", {
      get: () => {
        throw new Error("hostile getter");
      },
      enumerable: true,
    });
    const changingGetter = Object.defineProperties({}, {
      scopeType: { get: () => "PROJECT", enumerable: true },
      projectId: { get: () => baseProject.id, enumerable: true },
    });
    const throwingProxy = new Proxy({}, {
      get: () => {
        throw new Error("hostile proxy");
      },
    });
    const inherited = Object.create({ scopeType: "PROJECT", projectId: baseProject.id });
    const pollutedPrototype = Object.assign(
      Object.create({ polluted: true }) as Record<string, unknown>,
      projectScope(baseProject.id),
    );

    for (const hostile of [
      throwingGetter,
      changingGetter,
      throwingProxy,
      inherited,
      pollutedPrototype,
      new Date(),
      new Map(),
      new Set(),
      () => projectScope(baseProject.id),
      new String("scope"),
      Object.create(null),
    ]) {
      expect(() => evaluateContextScopeAccess(baseSet, hostile as ContextScope)).not.toThrow();
      expect(evaluateContextScopeAccess(baseSet, hostile as ContextScope)).toEqual({
        allowed: false,
        reason: "INVALID_CONTEXT_SCOPE",
      });
    }
  });

  it("accepts only exact canonical null-prototype data and transparent structural proxies", () => {
    const nullPrototypeCandidate = Object.assign(Object.create(null) as object, {
      scopeType: "PROJECT",
      projectId: baseProject.id,
    }) as ContextScope;
    const transparentProxy = new Proxy(structuredClone(baseSet), {});

    expect(evaluateContextScopeAccess(baseSet, nullPrototypeCandidate)).toEqual({
      allowed: true,
      reason: "TARGET_PROJECT_SCOPE",
    });
    expect(evaluateContextScopeAccess(transparentProxy, projectScope(baseProject.id))).toEqual({
      allowed: true,
      reason: "TARGET_PROJECT_SCOPE",
    });
  });

  it("fails closed for hostile builder evidence", () => {
    const getterProject = Object.defineProperty({ ...baseProject }, "id", {
      get: () => {
        throw new Error("hostile target getter");
      },
      enumerable: true,
    });
    const proxyProject = new Proxy(baseProject, {
      getPrototypeOf: () => {
        throw new Error("hostile target proxy");
      },
    });

    for (const project of [getterProject, proxyProject]) {
      expect(() =>
        buildAllowedContextSet(project as unknown as Project, baseBigTask, baseSubtask),
      ).not.toThrow();
      expect(
        buildAllowedContextSet(project as unknown as Project, baseBigTask, baseSubtask),
      ).toEqual({ valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] });
    }
  });
});

const seededIdentifier = (
  prefix: "prj" | "bt" | "st",
  seed: number,
  coordinates: string,
): string => {
  const base =
    seed % 10 === 0
      ? `${prefix}_種_${seed}_${coordinates}`
      : `${prefix}_seed_${seed}_${coordinates}`;
  if (seed % 10 !== 1) {
    return base;
  }
  return base.padEnd(128, "x").slice(0, 128);
};

describe("S2A deterministic property and scale campaigns", () => {
  it("matches the independent oracle across 40 fixed-seed multi-Project fixtures", () => {
    let decisionCount = 0;
    let projectCount = 0;
    let bigTaskCount = 0;
    let subtaskCount = 0;

    for (let seed = 0; seed < 40; seed += 1) {
      const projects = Array.from({ length: 5 }, (_, projectIndex) =>
        makeProject(seededIdentifier("prj", seed, String(projectIndex)), seed * 10 + projectIndex),
      );
      const bigTasks = projects.flatMap((project, projectIndex) =>
        Array.from({ length: 4 }, (_, bigTaskIndex) => ({
          entity: makeBigTask(
            seededIdentifier("bt", seed, `${projectIndex}_${bigTaskIndex}`),
            project.id,
            seed * 100 + projectIndex * 4 + bigTaskIndex,
          ),
          project,
        })),
      );
      const subtasks = bigTasks.flatMap(({ entity: bigTask, project }, bigTaskIndex) =>
        Array.from({ length: 7 }, (_, subtaskIndex) => ({
          bigTask,
          entity: makeSubtask(
            seededIdentifier("st", seed, `${bigTaskIndex}_${subtaskIndex}`),
            bigTask.id,
            seed * 1_000 + bigTaskIndex * 7 + subtaskIndex,
          ),
          project,
        })),
      );
      const baseCandidates = [
        ...projects.map(({ id }) => projectScope(id)),
        ...bigTasks.map(({ entity, project }) => bigTaskScope(project.id, entity.id)),
        ...subtasks.map(({ bigTask, entity, project }) =>
          subtaskScope(project.id, bigTask.id, entity.id),
        ),
      ];
      const selectedTargets = [subtasks[0], subtasks[subtasks.length - 1]];
      for (const targetEntry of selectedTargets) {
        if (targetEntry === undefined) {
          throw new Error("The fixed property topology must contain target Subtasks.");
        }
        const foreignProject = projects.find(({ id }) => id !== targetEntry.project.id);
        const foreignBigTask = bigTasks.find(
          ({ entity, project }) =>
            project.id === targetEntry.project.id && entity.id !== targetEntry.bigTask.id,
        );
        if (foreignProject === undefined || foreignBigTask === undefined) {
          throw new Error("The fixed property topology must contain foreign hierarchy members.");
        }
        const coincidentalCandidates = [
          bigTaskScope(foreignProject.id, targetEntry.bigTask.id),
          subtaskScope(foreignProject.id, targetEntry.bigTask.id, targetEntry.entity.id),
          subtaskScope(
            targetEntry.project.id,
            foreignBigTask.entity.id,
            targetEntry.entity.id,
          ),
        ];
        const candidates = [...baseCandidates, ...coincidentalCandidates];
        const allowedContextSet = buildSet(
          targetEntry.project,
          targetEntry.bigTask,
          targetEntry.entity,
        );
        for (const candidate of candidates) {
          expect(evaluateContextScopeAccess(allowedContextSet, candidate)).toEqual(
            expectedAccess(allowedContextSet.target, candidate),
          );
          decisionCount += 1;
        }
      }

      projectCount += projects.length;
      bigTaskCount += bigTasks.length;
      subtaskCount += subtasks.length;
    }

    expect(projectCount).toBe(200);
    expect(bigTaskCount).toBe(800);
    expect(subtaskCount).toBe(5_600);
    expect(decisionCount).toBe(13_440);
  });

  it("matches the oracle over 100 Projects, 1,000 Big Tasks, and 10,000 Subtasks", () => {
    const projects = Array.from({ length: 100 }, (_, projectIndex) =>
      makeProject(`prj_scale_${projectIndex}`, 2_000 + projectIndex),
    );
    const bigTasks = projects.flatMap((project, projectIndex) =>
      Array.from({ length: 10 }, (_, bigTaskIndex) => ({
        entity: makeBigTask(
          `bt_scale_${projectIndex}_${bigTaskIndex}`,
          project.id,
          2_000 + projectIndex * 10 + bigTaskIndex,
        ),
        project,
      })),
    );
    const subtasks = bigTasks.flatMap(({ entity: bigTask, project }, bigTaskIndex) =>
      Array.from({ length: 10 }, (_, subtaskIndex) => ({
        bigTask,
        entity: makeSubtask(
          `st_scale_${bigTaskIndex}_${subtaskIndex}`,
          bigTask.id,
          2_000 + bigTaskIndex * 10 + subtaskIndex,
        ),
        project,
      })),
    );
    const candidates = [
      ...projects.map(({ id }) => projectScope(id)),
      ...bigTasks.map(({ entity, project }) => bigTaskScope(project.id, entity.id)),
      ...subtasks.map(({ bigTask, entity, project }) =>
        subtaskScope(project.id, bigTask.id, entity.id),
      ),
    ];
    const targetIndexes = [0, 4_999, 9_999] as const;
    let decisionCount = 0;

    for (const targetIndex of targetIndexes) {
      const targetEntry = subtasks[targetIndex];
      if (targetEntry === undefined) {
        throw new Error("The fixed scale topology must contain each target.");
      }
      const allowedContextSet = buildSet(
        targetEntry.project,
        targetEntry.bigTask,
        targetEntry.entity,
      );
      for (const candidate of candidates) {
        expect(evaluateContextScopeAccess(allowedContextSet, candidate)).toEqual(
          expectedAccess(allowedContextSet.target, candidate),
        );
        decisionCount += 1;
      }
    }

    expect(projects).toHaveLength(100);
    expect(bigTasks).toHaveLength(1_000);
    expect(subtasks).toHaveLength(10_000);
    expect(candidates).toHaveLength(11_100);
    expect(decisionCount).toBe(33_300);
  });
});

describe("S2A default-deny and exact-allow mutation resistance", () => {
  const invalidSet = {
    ...baseSet,
    allowedRawScopes: [
      baseSet.allowedRawScopes[0],
      bigTaskScope(baseProject.id, otherBigTask.id),
      baseSet.allowedRawScopes[2],
    ],
  } as unknown as AllowedContextSet;

  const falseAllowHypotheses: readonly [string, () => boolean][] = [
    ["other Project allowed", () => evaluateContextScopeAccess(baseSet, projectScope(otherProject.id)).allowed],
    ["same-Project unrelated Big Task allowed", () => evaluateContextScopeAccess(baseSet, bigTaskScope(baseProject.id, otherBigTask.id)).allowed],
    ["sibling allowed", () => evaluateContextScopeAccess(baseSet, subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id)).allowed],
    ["malformed candidate parser failure allowed", () => evaluateContextScopeAccess(baseSet, null as unknown as ContextScope).allowed],
    ["invalid set allowed", () => evaluateContextScopeAccess(invalidSet, projectScope(baseProject.id)).allowed],
    ["Project comparison removed", () => evaluateContextScopeAccess(baseSet, subtaskScope(otherProject.id, baseBigTask.id, baseSubtask.id)).allowed],
    ["Big Task comparison removed", () => evaluateContextScopeAccess(baseSet, subtaskScope(baseProject.id, otherBigTask.id, baseSubtask.id)).allowed],
    ["Subtask comparison removed", () => evaluateContextScopeAccess(baseSet, subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id)).allowed],
    ["child ID only comparison", () => evaluateContextScopeAccess(baseSet, subtaskScope(otherProject.id, otherBigTask.id, baseSubtask.id)).allowed],
    ["unknown type fallthrough", () => evaluateContextScopeAccess(baseSet, { scopeType: "GLOBAL", projectId: baseProject.id } as unknown as ContextScope).allowed],
    ["reordered tuple accepted", () => evaluateContextScopeAccess({ ...baseSet, allowedRawScopes: [...baseSet.allowedRawScopes].reverse() } as unknown as AllowedContextSet, projectScope(baseProject.id)).allowed],
    ["broadened tuple accepted", () => evaluateContextScopeAccess(invalidSet, bigTaskScope(baseProject.id, otherBigTask.id)).allowed],
    ["dependency sibling allowed", () => evaluateContextScopeAccess(baseSet, subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id)).allowed],
    ["status conditional grant", () => evaluateContextScopeAccess(buildSet(baseProject, baseBigTask, makeSubtask(baseSubtask.id, baseBigTask.id, 1, "DONE", "ACCEPTED")), subtaskScope(baseProject.id, baseBigTask.id, siblingSubtask.id)).allowed],
    ["noncanonical candidate normalized to allow", () => evaluateContextScopeAccess(baseSet, { scopeType: "PROJECT", projectId: ` ${baseProject.id}` } as unknown as ContextScope).allowed],
    ["forged widened raw scopes accepted", () => evaluateContextScopeAccess(invalidSet, projectScope(baseProject.id)).allowed],
    ["copied corrupt set accepted", () => evaluateContextScopeAccess(structuredClone(invalidSet), projectScope(baseProject.id)).allowed],
    ["inherited candidate accepted", () => evaluateContextScopeAccess(baseSet, Object.create(projectScope(baseProject.id)) as ContextScope).allowed],
    ["inherited set accepted", () => evaluateContextScopeAccess(Object.create(baseSet) as AllowedContextSet, projectScope(baseProject.id)).allowed],
    ["invalid target emits usable set", () => buildAllowedContextSet(baseProject, { ...baseBigTask, projectId: otherProject.id }, baseSubtask).valid],
    ["ownership mismatch ignored", () => buildAllowedContextSet(baseProject, baseBigTask, { ...baseSubtask, bigTaskId: otherBigTask.id }).valid],
    ["mutated built tuple broadens access", () => Reflect.set(baseSet.allowedRawScopes[1] as object, "bigTaskId", otherBigTask.id)],
  ];

  const falseDenyHypotheses: readonly [string, () => boolean][] = [
    ["target Project denied", () => !evaluateContextScopeAccess(baseSet, projectScope(baseProject.id)).allowed],
    ["target Big Task denied", () => !evaluateContextScopeAccess(baseSet, bigTaskScope(baseProject.id, baseBigTask.id)).allowed],
    ["target Subtask denied", () => !evaluateContextScopeAccess(baseSet, subtaskScope(baseProject.id, baseBigTask.id, baseSubtask.id)).allowed],
    ["status changes ACL", () => !evaluateContextScopeAccess(buildSet(baseProject, baseBigTask, makeSubtask(baseSubtask.id, baseBigTask.id, 1, "ARCHIVED", "ACCEPTED")), projectScope(baseProject.id)).allowed],
    ["maturity changes ACL", () => !evaluateContextScopeAccess(buildSet(baseProject, baseBigTask, makeSubtask(baseSubtask.id, baseBigTask.id, 1, "TODO", "HARDENED")), bigTaskScope(baseProject.id, baseBigTask.id)).allowed],
    ["dependency evidence shrinks ACL", () => !evaluateContextScopeAccess(baseSet, bigTaskScope(baseProject.id, baseBigTask.id)).allowed],
    ["Context Item status shrinks ACL", () => !evaluateContextScopeAccess(baseSet, projectScope(baseProject.id)).allowed],
    ["business text shrinks ACL", () => !evaluateContextScopeAccess(buildSet(ProjectSchema.parse({ ...baseProject, name: "Changed" }), baseBigTask, baseSubtask), subtaskScope(baseProject.id, baseBigTask.id, baseSubtask.id)).allowed],
  ];

  it.each(falseAllowHypotheses)("kills false-ALLOW hypothesis: %s", (_label, survived) => {
    expect(survived()).toBe(false);
  });

  it.each(falseDenyHypotheses)("kills false-DENY hypothesis: %s", (_label, survived) => {
    expect(survived()).toBe(false);
  });

  it("accounts for every declared mutation hypothesis", () => {
    expect(falseAllowHypotheses).toHaveLength(22);
    expect(falseDenyHypotheses).toHaveLength(8);
  });
});
