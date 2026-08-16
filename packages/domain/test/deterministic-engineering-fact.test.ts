import { describe, expect, it } from "vitest";

import * as domainExports from "../src/index.js";
import {
  ContextKindSchema,
  DeterministicEngineeringFactDataSchema,
  PromotedContextCandidateSchema,
  PromotedContextRouteTopologySchema,
  RepositoryCommitShaSchema,
  RepositoryReferenceSchema,
  evaluatePromotedContextAcceptanceRequirement,
  renderDeterministicEngineeringFact,
} from "../src/index.js";
import type {
  ContextKind,
  DeterministicEngineeringFactData,
  PromotedContextCandidate,
} from "../src/index.js";
import { acceptPromotedContextFromTrustedHumanAction } from "../src/accepted-promoted-context.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const repository = { kind: "PATH", path: "/workspace/project" } as const;

const validFacts = [
  {
    factType: "REPOSITORY_COMMIT",
    repository,
    observedRef: "refs/heads/main",
    commitSha: SHA_A,
  },
  {
    factType: "TEST_RUN",
    repository,
    commitSha: SHA_A,
    command: "pnpm test",
    exitCode: 0,
    testFileCount: 2,
    testCount: 12,
    passedTestCount: 11,
    failedTestCount: 1,
  },
  {
    factType: "DIFF_FILE_SET",
    repository,
    baseCommitSha: SHA_A,
    headCommitSha: SHA_B,
    changedFiles: ["README.md", "packages/domain/src/index.ts"],
  },
  {
    factType: "RUNTIME_TOOLCHAIN",
    repository,
    commitSha: SHA_A,
    components: [
      { name: "Node", version: "v24.19.0" },
      { name: "pnpm", version: "11.19.0" },
    ],
  },
] as const;

const expectRendererClosed = (input: unknown): void => {
  let output: ReturnType<typeof renderDeterministicEngineeringFact> | undefined;
  expect(() => {
    output = renderDeterministicEngineeringFact(
      input as DeterministicEngineeringFactData,
    );
  }).not.toThrow();
  expect(output).toBeNull();
};

describe("S2D6a typed deterministic engineering fact DATA contract", () => {
  it("accepts exactly the four canonical V1 fact variants", () => {
    expect(
      validFacts.map(
        (fact) => DeterministicEngineeringFactDataSchema.parse(fact).factType,
      ),
    ).toEqual([
      "REPOSITORY_COMMIT",
      "TEST_RUN",
      "DIFF_FILE_SET",
      "RUNTIME_TOOLCHAIN",
    ]);

    for (const fact of validFacts) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...fact,
          extra: "not allowed",
        }).success,
      ).toBe(false);
      for (const missingKey of Object.keys(fact)) {
        const withoutRequiredField = Object.fromEntries(
          Object.entries(fact).filter(([key]) => key !== missingKey),
        );
        expect(
          DeterministicEngineeringFactDataSchema.safeParse(withoutRequiredField)
            .success,
        ).toBe(false);
      }
    }

    for (const factType of ["CUSTOM", "OTHER", "FREEFORM", "CLAIM", "PAYLOAD"]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          factType,
          repository,
          claim: "main is current",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects missing, wrong, and extra fields for every variant", () => {
    const invalidFacts = [
      { ...validFacts[0], observedRef: undefined },
      { ...validFacts[0], commitSha: 42 },
      { ...validFacts[1], command: undefined },
      { ...validFacts[1], exitCode: "0" },
      { ...validFacts[2], changedFiles: undefined },
      { ...validFacts[2], headCommitSha: true },
      { ...validFacts[3], components: undefined },
      { ...validFacts[3], commitSha: null },
    ];
    for (const fact of invalidFacts) {
      expect(DeterministicEngineeringFactDataSchema.safeParse(fact).success).toBe(
        false,
      );
    }
  });

  it("has no natural-language claim or generic semantic escape hatch", () => {
    for (const field of [
      "claim",
      "conclusion",
      "assertion",
      "statement",
      "summary",
      "body",
      "description",
      "reasoning",
      "confidence",
      "explanation",
      "semanticMeaning",
      "metadata",
      "payload",
    ]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...validFacts[0],
          [field]: "caller-controlled prose",
        }).success,
      ).toBe(false);
    }
  });

  it("reuses canonical repository-reference and commit-SHA contracts", () => {
    const parsed = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[0],
      repository: { kind: "REFERENCE", reference: "  repo:console  " },
    });
    expect(parsed.repository).toEqual(
      RepositoryReferenceSchema.parse({
        kind: "REFERENCE",
        reference: "  repo:console  ",
      }),
    );
    expect(parsed.factType).toBe("REPOSITORY_COMMIT");
    if (parsed.factType !== "REPOSITORY_COMMIT") {
      throw new Error("Expected a repository-commit fact.");
    }
    expect(RepositoryCommitShaSchema.parse(parsed.commitSha)).toBe(SHA_A);

    for (const commitSha of [
      "A".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
      ` ${SHA_A}`,
      `${SHA_A} `,
      `g${"a".repeat(39)}`,
    ]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...validFacts[0],
          commitSha,
        }).success,
      ).toBe(false);
    }
  });

  it("trims and bounds the observation ref and test command", () => {
    const commitFact = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[0],
      observedRef: "  refs/heads/main  ",
    });
    expect(commitFact.factType).toBe("REPOSITORY_COMMIT");
    if (commitFact.factType !== "REPOSITORY_COMMIT") {
      throw new Error("Expected a repository-commit fact.");
    }
    expect(commitFact.observedRef).toBe("refs/heads/main");

    const testFact = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[1],
      command: "  pnpm test  ",
    });
    expect(testFact.factType).toBe("TEST_RUN");
    if (testFact.factType !== "TEST_RUN") {
      throw new Error("Expected a test-run fact.");
    }
    expect(testFact.command).toBe("pnpm test");

    for (const fact of [
      { ...validFacts[0], observedRef: "x".repeat(513) },
      { ...validFacts[0], observedRef: "   " },
      { ...validFacts[1], command: "x".repeat(4_001) },
      { ...validFacts[1], command: "   " },
    ]) {
      expect(DeterministicEngineeringFactDataSchema.safeParse(fact).success).toBe(
        false,
      );
    }
  });

  it("enforces safe coherent TEST_RUN counts without inferring quality", () => {
    for (const override of [
      { testFileCount: -1 },
      { testCount: -1 },
      { passedTestCount: -1 },
      { failedTestCount: -1 },
      { testCount: Number.MAX_SAFE_INTEGER + 1 },
      { passedTestCount: Number.MAX_SAFE_INTEGER + 1 },
      { passedTestCount: 11, failedTestCount: 2, testCount: 12 },
      { exitCode: 0.5 },
      { exitCode: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...validFacts[1],
          ...override,
        }).success,
      ).toBe(false);
    }

    const exitZeroWithFailure = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[1],
      exitCode: 0,
      failedTestCount: 1,
    });
    const rendered = renderDeterministicEngineeringFact(exitZeroWithFailure);
    expect(rendered?.body).toContain("exit code 0");
    expect(rendered?.body).toContain("1 failed");
    expect(JSON.stringify(rendered)).not.toMatch(
      /accepted|approved|correct|quality|safe|secure/i,
    );
  });

  it("accepts only canonical sorted unique DIFF_FILE_SET paths", () => {
    for (const changedFiles of [
      ["packages/z.ts", "packages/a.ts"],
      ["README.md", "README.md"],
      ["/absolute.ts"],
      ["../escape.ts"],
      ["packages/./file.ts"],
      ["packages//file.ts"],
      ["packages\\file.ts"],
      [" packages/file.ts"],
      ["packages/file.ts "],
      ["x".repeat(1_025)],
      Array.from({ length: 257 }, (_, index) => `file-${String(index).padStart(3, "0")}`),
    ]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...validFacts[2],
          changedFiles,
        }).success,
      ).toBe(false);
    }

    const empty = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[2],
      changedFiles: [],
    });
    expect(empty.factType).toBe("DIFF_FILE_SET");
    if (empty.factType !== "DIFF_FILE_SET") {
      throw new Error("Expected a diff-file-set fact.");
    }
    expect(empty.changedFiles).toEqual([]);
    expect(Object.isFrozen(empty.changedFiles)).toBe(true);
    expect(renderDeterministicEngineeringFact(empty)?.body).toContain(
      "reported 0 changed files.",
    );
  });

  it("accepts only canonical unique RUNTIME_TOOLCHAIN component names", () => {
    for (const components of [
      [
        { name: "pnpm", version: "11" },
        { name: "Node", version: "24" },
      ],
      [
        { name: "Node", version: "24" },
        { name: "Node", version: "25" },
      ],
      [{ name: "", version: "24" }],
      [{ name: "Node", version: "" }],
      [{ name: "Node", version: "not interpreted", extra: true }],
      Array.from({ length: 65 }, (_, index) => ({
        name: `tool-${String(index).padStart(2, "0")}`,
        version: "1",
      })),
    ]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...validFacts[3],
          components,
        }).success,
      ).toBe(false);
    }

    const parsed = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[3],
      components: [{ name: "  Node  ", version: "  release candidate  " }],
    });
    expect(parsed.factType).toBe("RUNTIME_TOOLCHAIN");
    if (parsed.factType !== "RUNTIME_TOOLCHAIN") {
      throw new Error("Expected a runtime-toolchain fact.");
    }
    expect(parsed.components).toEqual([
      { name: "Node", version: "release candidate" },
    ]);
    expect(Object.isFrozen(parsed.components)).toBe(true);
    expect(renderDeterministicEngineeringFact(parsed)?.body).toContain(
      '"Node" "release candidate"',
    );

    const empty = DeterministicEngineeringFactDataSchema.parse({
      ...validFacts[3],
      components: [],
    });
    expect(renderDeterministicEngineeringFact(empty)?.body).toContain(
      "reported no runtime/toolchain components.",
    );
  });
});

describe("S2D6a deterministic renderer", () => {
  it("renders all four variants with fixed observation-only templates", () => {
    const rendered = validFacts.map((fact) =>
      renderDeterministicEngineeringFact(
        DeterministicEngineeringFactDataSchema.parse(fact),
      ),
    );
    expect(rendered).toEqual([
      {
        title: "Repository commit observation",
        body: `For repository PATH "/workspace/project", verification observed ref "refs/heads/main" at commit ${SHA_A}.`,
      },
      {
        title: "Deterministic test-run observation",
        body: `For repository PATH "/workspace/project" at commit ${SHA_A}, command "pnpm test" completed with exit code 0; 2 test files / 12 tests / 11 passed / 1 failed.`,
      },
      {
        title: "Deterministic diff file-set observation",
        body: `For repository PATH "/workspace/project", between commits ${SHA_A} and ${SHA_B}, the deterministic diff reported 2 changed files: "README.md", "packages/domain/src/index.ts".`,
      },
      {
        title: "Runtime toolchain observation",
        body: `For repository PATH "/workspace/project" at commit ${SHA_A}, the runtime probe reported: "Node" "v24.19.0", "pnpm" "11.19.0".`,
      },
    ]);
    expect(rendered[0]?.body).not.toContain("current main");
    for (const conclusion of rendered) {
      expect(Object.keys(conclusion ?? {})).toEqual(["title", "body"]);
      expect(Object.isFrozen(conclusion)).toBe(true);
    }
  });

  it("returns the same immutable title/body for the same DATA", () => {
    const fact = DeterministicEngineeringFactDataSchema.parse(validFacts[3]);
    const first = renderDeterministicEngineeringFact(fact);
    const second = renderDeterministicEngineeringFact(fact);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("accepts a stable transparent Proxy but closes changing or throwing reflection", () => {
    const ordinary = { ...validFacts[1] };
    expect(
      renderDeterministicEngineeringFact(
        new Proxy(ordinary, {}) as DeterministicEngineeringFactData,
      ),
    ).toEqual(
      renderDeterministicEngineeringFact(
        DeterministicEngineeringFactDataSchema.parse(ordinary),
      ),
    );

    let prototypeCalls = 0;
    expectRendererClosed(
      new Proxy({ ...validFacts[0] }, {
        getPrototypeOf: () =>
          prototypeCalls++ % 2 === 0 ? Object.prototype : null,
      }),
    );

    let ownKeyCalls = 0;
    const keyTarget = { ...validFacts[1] };
    expectRendererClosed(
      new Proxy(keyTarget, {
        ownKeys: (target) => {
          const keys = Reflect.ownKeys(target);
          ownKeyCalls += 1;
          return ownKeyCalls % 2 === 0
            ? keys.filter((key) => key !== "command")
            : keys;
        },
      }),
    );

    expectRendererClosed(
      new Proxy({ ...validFacts[0] }, {
        getOwnPropertyDescriptor: () => {
          throw new Error("hostile descriptor trap");
        },
      }),
    );
  });

  it("closes changing nested arrays and records without exception leakage", () => {
    let arrayDescriptorCalls = 0;
    const changedFiles = new Proxy(["README.md"], {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "0" || descriptor === undefined) {
          return descriptor;
        }
        arrayDescriptorCalls += 1;
        return {
          ...descriptor,
          value: arrayDescriptorCalls % 2 === 0 ? "README.md" : "package.json",
        };
      },
    });
    expectRendererClosed({ ...validFacts[2], changedFiles });

    let recordDescriptorCalls = 0;
    const component = new Proxy(
      { name: "Node", version: "24" },
      {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key !== "name" || descriptor === undefined) {
            return descriptor;
          }
          recordDescriptorCalls += 1;
          return {
            ...descriptor,
            value: recordDescriptorCalls % 2 === 0 ? "Node" : "pnpm",
          };
        },
      },
    );
    expectRendererClosed({ ...validFacts[3], components: [component] });
  });

  it("rejects accessors, symbol keys, and the special __proto__ own key", () => {
    let getterCalls = 0;
    const accessorFact = { ...validFacts[1] } as Record<string, unknown>;
    Object.defineProperty(accessorFact, "command", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "pnpm test";
      },
    });
    expectRendererClosed(accessorFact);
    expect(getterCalls).toBe(0);

    const symbolFact = { ...validFacts[0], [Symbol("extra")]: "forbidden" };
    expectRendererClosed(symbolFact);

    const protoFact = { ...validFacts[0] } as Record<string, unknown>;
    Object.defineProperty(protoFact, "__proto__", {
      value: "forbidden",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expectRendererClosed(protoFact);
  });
});

describe("S2D6a authority and human-fallback regressions", () => {
  const topology = PromotedContextRouteTopologySchema.parse({
    projects: [{ id: "prj_one" }],
    bigTasks: [{ id: "bt_one", projectId: "prj_one" }],
    subtasks: [{ id: "st_one", bigTaskId: "bt_one" }],
    dependencies: [],
  });

  const candidate = (kind: ContextKind): PromotedContextCandidate =>
    PromotedContextCandidateSchema.parse({
      route: {
        sourceSubtaskId: "st_one",
        audienceKind: "PARENT_BIG_TASK",
        targetBigTaskId: "bt_one",
      },
      kind,
      title: "Typed conclusion",
      body: "A compact conclusion selected for possible promotion.",
      provenance: {
        sourceType: "REPO",
        sourceReference: "repo:caller-supplied",
        evidenceReferences: ["evidence:caller-supplied"],
      },
    });

  it("keeps all five non-engineering kinds human-required and ENGINEERING_FACT dual-path", () => {
    for (const kind of ContextKindSchema.options) {
      const evaluation = evaluatePromotedContextAcceptanceRequirement(
        topology,
        candidate(kind),
      );
      expect(evaluation.acceptanceEligible).toBe(true);
      if (!evaluation.acceptanceEligible) {
        continue;
      }
      expect(evaluation.requirement).toBe(
        kind === "ENGINEERING_FACT"
          ? "DETERMINISTIC_EVIDENCE_OR_HUMAN"
          : "HUMAN_CONFIRMATION_REQUIRED",
      );
    }
  });

  it("keeps ENGINEERING_FACT human acceptance unchanged", () => {
    const result = acceptPromotedContextFromTrustedHumanAction(
      topology,
      candidate("ENGINEERING_FACT"),
      {
        evidenceType: "HUMAN_CONFIRMATION",
        sourceReference: "local-action:human",
        occurredAt: "2026-08-16T12:00:00+08:00",
      },
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.snapshot.acceptance.method).toBe("HUMAN_CONFIRMATION");
      expect(result.snapshot).not.toHaveProperty(
        "deterministicEngineeringFactData",
      );
    }
  });

  it("treats schema parsing as shape only and exports no verifier or accept bridge", () => {
    const handConstructed = DeterministicEngineeringFactDataSchema.parse(
      validFacts[0],
    );
    expect(handConstructed.factType).toBe("REPOSITORY_COMMIT");
    expect(handConstructed).not.toHaveProperty("verified");
    expect(handConstructed).not.toHaveProperty("trusted");
    expect(handConstructed).not.toHaveProperty("accepted");
    expect(
      Object.keys(domainExports).filter(
        (name) =>
          /DeterministicEngineeringFact/i.test(name) &&
          /(verify|trust|accept|approve|probe)/i.test(name),
      ),
    ).toEqual([]);
  });
});
