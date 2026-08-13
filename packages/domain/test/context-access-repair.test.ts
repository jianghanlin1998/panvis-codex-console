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
} from "../src/index.js";

const project = ProjectSchema.parse({
  recordType: "PROJECT",
  id: "prj_repair",
  name: "Repair Project",
  slug: "repair-project",
  repository: { kind: "PATH", path: "/workspace/repair" },
  defaultBranch: "main",
  maxActiveCodingSubtasks: 2,
});
const bigTask = BigTaskSchema.parse({
  recordType: "BIG_TASK",
  id: "bt_repair",
  projectId: project.id,
  title: "Repair ACL validation",
  goal: "Fail closed for unstable runtime evidence.",
  rationale: "ACL decisions require stable structural evidence.",
  scopeIn: ["Stable capture"],
  scopeOut: ["Retrieval"],
  acceptanceCriteria: ["No false allow"],
  status: "IN_PROGRESS",
});
const subtask = SubtaskSchema.parse({
  recordType: "SUBTASK",
  id: "st_repair",
  bigTaskId: bigTask.id,
  title: "Repair hostile evidence handling",
  goal: "Capture one stable representation.",
  scopeIn: ["Builder", "Evaluator"],
  scopeOut: ["Storage"],
  acceptanceCriteria: ["State changes fail closed"],
  untouchedAreas: ["Context retrieval"],
  status: "QA_DEBUG",
  maturity: "HARDENED",
  startPolicy: "MANUAL",
  delegationPolicy: "NONE",
  recommendedReasoningLevel: "XHIGH",
  promptSeed: "Repair only the structural validation boundary.",
});

const buildSet = (): AllowedContextSet => {
  const result = buildAllowedContextSet(project, bigTask, subtask);
  if (!result.valid) {
    throw new Error("Fixture hierarchy must be valid.");
  }
  return result.allowedContextSet;
};

const baseSet = buildSet();
const projectCandidate = ContextScopeSchema.parse({
  scopeType: "PROJECT",
  projectId: project.id,
});

const alternatingOwnKeys = <T extends object>(value: T): T => {
  let callCount = 0;
  return new Proxy(value, {
    ownKeys: (target) => {
      const keys = Reflect.ownKeys(target);
      callCount += 1;
      return callCount % 2 === 0 ? [...keys].reverse() : keys;
    },
  });
};

const changingPrototype = <T extends object>(value: T): T => {
  let callCount = 0;
  return new Proxy(value, {
    getPrototypeOf: () => {
      callCount += 1;
      return callCount % 2 === 0 ? null : Object.prototype;
    },
  });
};

const delayedDescriptorSwap = <T extends object>(
  value: T,
  key: PropertyKey,
  replacement: unknown,
): T => {
  let descriptorCount = 0;
  return new Proxy(value, {
    getOwnPropertyDescriptor: (target, observedKey) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, observedKey);
      if (observedKey !== key || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      descriptorCount += 1;
      return { ...descriptor, value: descriptorCount >= 3 ? replacement : descriptor.value };
    },
  });
};

describe("CTC-S2A-FQA-001 array descriptor repair", () => {
  it("rejects a non-enumerable allowedRawScopes tuple element", () => {
    const rawScopes = [...baseSet.allowedRawScopes];
    Object.defineProperty(rawScopes, "1", {
      value: rawScopes[1],
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const malformed = { target: { ...baseSet.target }, allowedRawScopes: rawScopes };

    expect(evaluateContextScopeAccess(malformed as unknown as AllowedContextSet, projectCandidate)).toEqual({
      allowed: false,
      reason: "INVALID_ALLOWED_CONTEXT_SET",
    });
  });

  it("rejects a non-enumerable Big Task text-array element", () => {
    const scopeIn = [...bigTask.scopeIn];
    Object.defineProperty(scopeIn, "0", {
      value: scopeIn[0],
      writable: true,
      configurable: true,
      enumerable: false,
    });

    expect(buildAllowedContextSet(project, { ...bigTask, scopeIn } as BigTask, subtask)).toEqual({
      valid: false,
      errorCodes: ["INVALID_TARGET_SHAPE"],
    });
  });

  it.each([
    ["literal", ["Stable capture"]],
    ["JSON", JSON.parse('["Stable capture"]') as string[]],
    ["structuredClone", structuredClone(["Stable capture"])],
    ["frozen", Object.freeze(["Stable capture"])],
  ] as const)("accepts a canonical %s text array", (_label, scopeIn) => {
    expect(buildAllowedContextSet(project, { ...bigTask, scopeIn } as BigTask, subtask).valid)
      .toBe(true);
  });

  it.each([
    ["accessor index", () => Object.defineProperty(["Stable capture"], "0", {
      get: () => "Stable capture",
      configurable: true,
      enumerable: true,
    })],
    ["hole", () => new Array(1)],
    ["extra Symbol", () => Object.assign(["Stable capture"], { [Symbol("extra")]: true })],
    ["extra string key", () => Object.assign(["Stable capture"], { extra: true })],
    ["Array subclass", () => new (class extends Array<string> {})("Stable capture")],
  ] as const)("rejects a text array with %s", (_label, makeScopeIn) => {
    expect(
      buildAllowedContextSet(project, { ...bigTask, scopeIn: makeScopeIn() } as BigTask, subtask),
    ).toEqual({ valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] });
  });

  it("accepts the standard non-enumerable array length descriptor", () => {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(bigTask.scopeIn, "length");
    expect(lengthDescriptor).toMatchObject({ enumerable: false, configurable: false });
    expect(buildAllowedContextSet(project, bigTask, subtask).valid).toBe(true);
  });
});

describe("CTC-S2A-FQA-002 stable structural capture repair", () => {
  it("rejects changing ownKeys observations in builder evidence", () => {
    expect(buildAllowedContextSet(alternatingOwnKeys({ ...project }), bigTask, subtask)).toEqual({
      valid: false,
      errorCodes: ["INVALID_TARGET_SHAPE"],
    });
  });

  it.each([
    ["Project", alternatingOwnKeys({ ...project }), bigTask, subtask],
    ["Big Task", project, alternatingOwnKeys({ ...bigTask }), subtask],
    ["Subtask", project, bigTask, alternatingOwnKeys({ ...subtask })],
    [
      "repository",
      { ...project, repository: alternatingOwnKeys({ ...project.repository }) },
      bigTask,
      subtask,
    ],
    [
      "scope array",
      project,
      { ...bigTask, scopeIn: alternatingOwnKeys([...bigTask.scopeIn]) },
      subtask,
    ],
  ] as const)("rejects state-changing builder %s evidence", (_label, projectInput, bigTaskInput, subtaskInput) => {
    expect(
      buildAllowedContextSet(
        projectInput as typeof project,
        bigTaskInput as BigTask,
        subtaskInput as typeof subtask,
      ),
    ).toEqual({ valid: false, errorCodes: ["INVALID_TARGET_SHAPE"] });
  });

  it("rejects changing ownKeys observations in an AllowedContextSet", () => {
    expect(
      evaluateContextScopeAccess(
        alternatingOwnKeys(structuredClone(baseSet)) as AllowedContextSet,
        projectCandidate,
      ),
    ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });
  });

  it("rejects changing target identity descriptors", () => {
    const alternateTarget = { ...baseSet.target, projectId: "prj_alternate" };
    const descriptorValues = [baseSet.target, baseSet.target, alternateTarget];
    let targetDescriptorCount = 0;
    const changingTarget = new Proxy(structuredClone(baseSet), {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "target" || descriptor === undefined || !("value" in descriptor)) {
          return descriptor;
        }
        const value = descriptorValues[Math.min(targetDescriptorCount, 2)];
        targetDescriptorCount += 1;
        return { ...descriptor, value };
      },
    });

    expect(evaluateContextScopeAccess(changingTarget, projectCandidate)).toEqual({
      allowed: false,
      reason: "INVALID_ALLOWED_CONTEXT_SET",
    });
  });

  it("rejects a target that swaps only after earlier builder inputs are captured", () => {
    const swappingBigTask = delayedDescriptorSwap(
      { ...bigTask },
      "projectId",
      "prj_alternate",
    );
    expect(buildAllowedContextSet(project, swappingBigTask, subtask)).toEqual({
      valid: false,
      errorCodes: ["INVALID_TARGET_SHAPE"],
    });
  });

  it("rejects changing candidate identity descriptors", () => {
    const descriptorValues = [project.id, project.id, "prj_alternate"];
    let projectIdDescriptorCount = 0;
    const changingCandidate = new Proxy({ ...projectCandidate }, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "projectId" || descriptor === undefined || !("value" in descriptor)) {
          return descriptor;
        }
        const value = descriptorValues[Math.min(projectIdDescriptorCount, 2)];
        projectIdDescriptorCount += 1;
        return { ...descriptor, value };
      },
    });

    expect(evaluateContextScopeAccess(baseSet, changingCandidate as ContextScope)).toEqual({
      allowed: false,
      reason: "INVALID_CONTEXT_SCOPE",
    });
  });

  it("rejects a candidate that swaps only after set capture", () => {
    const changingCandidate = delayedDescriptorSwap(
      { ...projectCandidate },
      "projectId",
      "prj_alternate",
    );
    expect(evaluateContextScopeAccess(baseSet, changingCandidate as ContextScope)).toEqual({
      allowed: false,
      reason: "INVALID_CONTEXT_SCOPE",
    });
  });

  it("rejects changing descriptor attributes", () => {
    let descriptorCount = 0;
    const changingDescriptor = new Proxy(structuredClone(baseSet), {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "target" || descriptor === undefined) {
          return descriptor;
        }
        descriptorCount += 1;
        return { ...descriptor, enumerable: descriptorCount % 2 === 1 };
      },
    });

    expect(evaluateContextScopeAccess(changingDescriptor, projectCandidate)).toEqual({
      allowed: false,
      reason: "INVALID_ALLOWED_CONTEXT_SET",
    });
  });

  it("rejects changing prototype observations in set and candidate evidence", () => {
    expect(
      evaluateContextScopeAccess(
        changingPrototype(structuredClone(baseSet)) as AllowedContextSet,
        projectCandidate,
      ),
    ).toEqual({ allowed: false, reason: "INVALID_ALLOWED_CONTEXT_SET" });
    expect(
      evaluateContextScopeAccess(baseSet, changingPrototype({ ...projectCandidate }) as ContextScope),
    ).toEqual({ allowed: false, reason: "INVALID_CONTEXT_SCOPE" });
  });

  it.each([
    ["top level", alternatingOwnKeys(structuredClone(baseSet))],
    [
      "target",
      { ...structuredClone(baseSet), target: alternatingOwnKeys({ ...baseSet.target }) },
    ],
    [
      "allowedRawScopes",
      { ...structuredClone(baseSet), allowedRawScopes: alternatingOwnKeys([...baseSet.allowedRawScopes]) },
    ],
    [
      "nested scope",
      {
        ...structuredClone(baseSet),
        allowedRawScopes: [
          alternatingOwnKeys({ ...baseSet.allowedRawScopes[0] }),
          { ...baseSet.allowedRawScopes[1] },
          { ...baseSet.allowedRawScopes[2] },
        ],
      },
    ],
  ] as const)("rejects state-changing AllowedContextSet %s evidence", (_label, set) => {
    expect(evaluateContextScopeAccess(set as AllowedContextSet, projectCandidate)).toEqual({
      allowed: false,
      reason: "INVALID_ALLOWED_CONTEXT_SET",
    });
  });

  it.each(["scopeType", "projectId"] as const)(
    "rejects state-changing candidate %s evidence",
    (changingKey) => {
      const candidate = { ...projectCandidate };
      let callCount = 0;
      const changing = new Proxy(candidate, {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key !== changingKey || descriptor === undefined || !("value" in descriptor)) {
            return descriptor;
          }
          callCount += 1;
          return {
            ...descriptor,
            value: callCount % 2 === 0
              ? changingKey === "scopeType" ? "BIG_TASK" : "prj_alternate"
              : descriptor.value,
          };
        },
      });
      expect(evaluateContextScopeAccess(baseSet, changing as ContextScope)).toEqual({
        allowed: false,
        reason: "INVALID_CONTEXT_SCOPE",
      });
    },
  );

  it("preserves stable canonical structural controls", () => {
    const manual = {
      target: { ...baseSet.target },
      allowedRawScopes: baseSet.allowedRawScopes.map((scope) => ({ ...scope })),
    } as unknown as AllowedContextSet;
    const deepPlainCopy = {
      target: { ...manual.target },
      allowedRawScopes: manual.allowedRawScopes.map((scope) => ({ ...scope })),
    } as unknown as AllowedContextSet;
    const controls = [
      baseSet,
      manual,
      structuredClone(baseSet),
      JSON.parse(JSON.stringify(baseSet)) as AllowedContextSet,
      deepPlainCopy,
      new Proxy(structuredClone(baseSet), {}),
    ];
    for (const control of controls) {
      expect(evaluateContextScopeAccess(control, projectCandidate)).toEqual({
        allowed: true,
        reason: "TARGET_PROJECT_SCOPE",
      });
    }
  });
});
