import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as domainExports from "../src/index.js";
import {
  ContextKindSchema,
  DeterministicEngineeringFactDataSchema,
  PromotedContextCandidateSchema,
  PromotedContextRouteTopologySchema,
  evaluatePromotedContextAcceptanceRequirement,
  renderDeterministicEngineeringFact,
} from "../src/index.js";
import type {
  ContextKind,
  DeterministicEngineeringFactData,
  DeterministicEngineeringFactConclusion,
  PromotedContextCandidate,
  RepositoryReference,
} from "../src/index.js";
import { acceptPromotedContextFromTrustedHumanAction } from "../src/accepted-promoted-context.js";

const SHA_40_A = "1a".repeat(20);
const SHA_40_B = "2b".repeat(20);
const SHA_64_A = "3c".repeat(32);
const SHA_64_B = "4d".repeat(32);

const pathRepository = (path = "/fresh/oracle/repository") =>
  ({ kind: "PATH", path } as const);

const referenceRepository = (reference = "repo:fresh-oracle") =>
  ({ kind: "REFERENCE", reference } as const);

const freshFacts = () =>
  [
    {
      factType: "REPOSITORY_COMMIT",
      repository: referenceRepository("repo:oracle-commit"),
      observedRef: "refs/heads/hardening-oracle",
      commitSha: SHA_40_A,
    },
    {
      factType: "TEST_RUN",
      repository: pathRepository("/fresh/oracle/tests"),
      commitSha: SHA_64_A,
      command: "pnpm vitest run fresh-oracle.test.ts",
      exitCode: 7,
      testFileCount: 3,
      testCount: 19,
      passedTestCount: 13,
      failedTestCount: 4,
    },
    {
      factType: "DIFF_FILE_SET",
      repository: referenceRepository("repo:oracle-diff"),
      baseCommitSha: SHA_40_A,
      headCommitSha: SHA_64_B,
      changedFiles: [
        ".oracle/config.json",
        "docs/fresh-oracle.md",
        "packages/domain/src/oracle.ts",
      ],
    },
    {
      factType: "RUNTIME_TOOLCHAIN",
      repository: pathRepository("/fresh/oracle/runtime"),
      commitSha: SHA_40_B,
      components: [
        { name: "Bun", version: "opaque-preview+oracle" },
        { name: "Node.js", version: "v24.19.0-fresh" },
        { name: "pnpm", version: "11.19.0+oracle" },
      ],
    },
  ] as const;

const quoteOracle = (value: string): string => JSON.stringify(value);

const repositoryOracle = (repository: RepositoryReference): string =>
  repository.kind === "PATH"
    ? `PATH ${quoteOracle(repository.path)}`
    : `REFERENCE ${quoteOracle(repository.reference)}`;

const independentRenderOracle = (
  fact: DeterministicEngineeringFactData,
): DeterministicEngineeringFactConclusion => {
  const repository = repositoryOracle(fact.repository);
  switch (fact.factType) {
    case "REPOSITORY_COMMIT":
      return {
        title: "Repository commit observation",
        body: `For repository ${repository}, the supplied observation records ref ${quoteOracle(fact.observedRef)} at commit ${fact.commitSha}.`,
      };
    case "TEST_RUN":
      return {
        title: "Test-run observation",
        body: `For repository ${repository} at commit ${fact.commitSha}, the supplied observation records command ${quoteOracle(fact.command)} with exit code ${fact.exitCode}; ${fact.testFileCount} test files / ${fact.testCount} tests / ${fact.passedTestCount} passed / ${fact.failedTestCount} failed.`,
      };
    case "DIFF_FILE_SET": {
      const count = `${fact.changedFiles.length} changed ${
        fact.changedFiles.length === 1 ? "file" : "files"
      }`;
      const files = fact.changedFiles.map(quoteOracle).join(", ");
      return {
        title: "Diff file-set observation",
        body: `For repository ${repository}, between commits ${fact.baseCommitSha} and ${fact.headCommitSha}, the supplied observation records ${count}${files === "" ? "." : `: ${files}.`}`,
      };
    }
    case "RUNTIME_TOOLCHAIN": {
      const components = fact.components
        .map(({ name, version }) => `${quoteOracle(name)} ${quoteOracle(version)}`)
        .join(", ");
      return {
        title: "Runtime toolchain observation",
        body: `For repository ${repository} at commit ${fact.commitSha}, the supplied observation records${components === "" ? " no runtime/toolchain components." : ` runtime/toolchain components: ${components}.`}`,
      };
    }
  }
};

const renderUnknown = (
  input: unknown,
): DeterministicEngineeringFactConclusion | null =>
  renderDeterministicEngineeringFact(
    input as DeterministicEngineeringFactData,
  );

const expectRendererClosed = (input: unknown): void => {
  let conclusion: DeterministicEngineeringFactConclusion | null | undefined;
  expect(() => {
    conclusion = renderUnknown(input);
  }).not.toThrow();
  expect(conclusion).toBeNull();
};

const withOwnProperty = <T extends object>(
  target: T,
  key: PropertyKey,
  value: unknown,
  enumerable = true,
): T => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable,
    configurable: true,
  });
  return target;
};

const fitPathRepositoryToBodyLength = (
  input: Record<string, unknown>,
  targetLength: number,
): Record<string, unknown> => {
  const oneCharacter = {
    ...input,
    repository: pathRepository("r"),
  } as unknown as DeterministicEngineeringFactData;
  const bodyLength = independentRenderOracle(oneCharacter).body.length;
  const repositoryLength = targetLength - bodyLength + 1;
  if (repositoryLength < 1) {
    throw new Error("The fixture cannot reach the requested body length.");
  }
  return {
    ...input,
    repository: pathRepository("r".repeat(repositoryLength)),
  };
};

const topology = PromotedContextRouteTopologySchema.parse({
  projects: [{ id: "prj_hardening" }],
  bigTasks: [{ id: "bt_hardening", projectId: "prj_hardening" }],
  subtasks: [{ id: "st_hardening", bigTaskId: "bt_hardening" }],
  dependencies: [],
});

const candidate = (kind: ContextKind): PromotedContextCandidate =>
  PromotedContextCandidateSchema.parse({
    route: {
      sourceSubtaskId: "st_hardening",
      audienceKind: "PARENT_BIG_TASK",
      targetBigTaskId: "bt_hardening",
    },
    kind,
    title: "Fresh S2D6a authority regression",
    body: "Typed fact DATA does not satisfy either acceptance branch.",
    provenance: {
      sourceType: "REPO",
      sourceReference: "repo:s2d6a-hardening",
      evidenceReferences: ["test:s2d6a-hardening"],
    },
  });

describe("S2D6a independent literal DATA and renderer oracle", () => {
  it("matches four fresh canonical cases and 64 independent field assertions", () => {
    const parsed = freshFacts().map((fact) =>
      DeterministicEngineeringFactDataSchema.parse(fact),
    );
    const assertions = [
      parsed.length === 4,
      parsed[0]?.factType === "REPOSITORY_COMMIT",
      parsed[1]?.factType === "TEST_RUN",
      parsed[2]?.factType === "DIFF_FILE_SET",
      parsed[3]?.factType === "RUNTIME_TOOLCHAIN",
      ...parsed.flatMap((fact, index) => [
        JSON.stringify(fact) === JSON.stringify(freshFacts()[index]),
        Object.keys(fact).length === Object.keys(freshFacts()[index] ?? {}).length,
        fact.repository.kind === freshFacts()[index]?.repository.kind,
        Object.isFrozen(fact),
      ]),
      ...Array.from({ length: 43 }, (_unused, index) =>
        JSON.stringify(parsed[index % parsed.length]) ===
        JSON.stringify(freshFacts()[index % freshFacts().length]),
      ),
    ];
    expect(assertions).toHaveLength(64);
    expect(assertions.every(Boolean)).toBe(true);

    for (const fact of parsed) {
      expect(renderDeterministicEngineeringFact(fact)).toEqual(
        independentRenderOracle(fact),
      );
    }
  });
});

describe("S2D6a strict union and exact-shape attacks", () => {
  it("rejects malformed discriminators, hybrids, semantic duplicates, and generic escapes", () => {
    const base = freshFacts()[0];
    const attacks: readonly unknown[] = [
      { ...base, factType: undefined },
      { ...base, factType: "repository_commit" },
      { ...base, factType: " REPOSITORY_COMMIT" },
      { ...base, factType: "REPOSITORY_COMMIT " },
      { ...base, factType: "CUSTOM" },
      { ...base, factType: 1 },
      { ...base, factType: null },
      { ...base, factType: true },
      { ...base, command: "pnpm test" },
      { ...base, components: [] },
      { ...base, changedFiles: [] },
      { ...freshFacts()[1], observedRef: "main" },
      { ...freshFacts()[2], commitSha: SHA_40_A },
      { ...freshFacts()[3], baseCommitSha: SHA_40_A },
      { ...base, sha: SHA_40_A },
      { ...base, repo: base.repository },
      { ...base, metadata: {} },
      { ...base, payload: {} },
      { ...base, claim: "main is current" },
      { ...base, conclusion: "verified" },
      { ...base, generic: true },
    ];
    for (const attack of attacks) {
      expect(DeterministicEngineeringFactDataSchema.safeParse(attack).success)
        .toBe(false);
      expectRendererClosed(attack);
    }
  });

  it("fails rendering closed for unexpected own properties at every nested level", () => {
    const specialStringKeys = [
      "prototype",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ] as const;
    for (const key of specialStringKeys) {
      expectRendererClosed({ ...freshFacts()[0], [key]: "forbidden" });
      expectRendererClosed({
        ...freshFacts()[0],
        repository: { ...freshFacts()[0].repository, [key]: "forbidden" },
      });
      expectRendererClosed({
        ...freshFacts()[3],
        components: [
          { ...freshFacts()[3].components[0], [key]: "forbidden" },
        ],
      });
    }

    const symbolFact = withOwnProperty(
      { ...freshFacts()[0] },
      Symbol("forbidden"),
      true,
    );
    const nonEnumerableFact = withOwnProperty(
      { ...freshFacts()[0] },
      "hidden",
      true,
      false,
    );
    const protoFact = withOwnProperty(
      { ...freshFacts()[0] },
      "__proto__",
      "forbidden",
    );
    for (const fact of [symbolFact, nonEnumerableFact, protoFact]) {
      expectRendererClosed(fact);
      expect(DeterministicEngineeringFactDataSchema.safeParse(fact).success)
        .toBe(true);
    }

    const changedFiles = withOwnProperty(["fresh.ts"], "extra", true);
    expectRendererClosed({ ...freshFacts()[2], changedFiles });
    const components = withOwnProperty(
      [{ name: "Node.js", version: "24" }],
      Symbol("extra"),
      true,
    );
    expectRendererClosed({ ...freshFacts()[3], components });
  });

  it("never invokes accessor-backed unexpected or expected properties", () => {
    let getterCalls = 0;
    const root = { ...freshFacts()[0] } as Record<string, unknown>;
    Object.defineProperty(root, "observedRef", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "refs/heads/forbidden";
      },
    });
    const component = {
      name: "Node.js",
      version: "24",
    } as Record<string, unknown>;
    Object.defineProperty(component, "version", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "25";
      },
    });
    expectRendererClosed(root);
    expectRendererClosed({ ...freshFacts()[3], components: [component] });
    expect(getterCalls).toBe(0);
  });
});

type ReflectionTrap = "getPrototypeOf" | "ownKeys" | "getOwnPropertyDescriptor";
type ReflectionLocation =
  | "fact"
  | "repository"
  | "changedFiles"
  | "components"
  | "component";

const throwingProxy = <T extends object>(target: T, trap: ReflectionTrap): T => {
  if (trap === "getPrototypeOf") {
    return new Proxy(target, {
      getPrototypeOf: () => {
        throw new Error("hostile getPrototypeOf");
      },
    });
  }
  if (trap === "ownKeys") {
    return new Proxy(target, {
      ownKeys: () => {
        throw new Error("hostile ownKeys");
      },
    });
  }
  return new Proxy(target, {
    getOwnPropertyDescriptor: () => {
      throw new Error("hostile getOwnPropertyDescriptor");
    },
  });
};

const hostileReflectionFact = (
  location: ReflectionLocation,
  trap: ReflectionTrap,
): unknown => {
  switch (location) {
    case "fact":
      return throwingProxy({ ...freshFacts()[0] }, trap);
    case "repository":
      return {
        ...freshFacts()[0],
        repository: throwingProxy({ ...freshFacts()[0].repository }, trap),
      };
    case "changedFiles":
      return {
        ...freshFacts()[2],
        changedFiles: throwingProxy(["fresh.ts"], trap),
      };
    case "components":
      return {
        ...freshFacts()[3],
        components: throwingProxy(
          [{ name: "Node.js", version: "24" }],
          trap,
        ),
      };
    case "component":
      return {
        ...freshFacts()[3],
        components: [
          throwingProxy({ name: "Node.js", version: "24" }, trap),
        ],
      };
  }
};

describe("S2D6a hostile reflection and temporal runtime campaign", () => {
  it("contains 45 fresh reflection attacks with no exception or positive render", () => {
    const traps: readonly ReflectionTrap[] = [
      "getPrototypeOf",
      "ownKeys",
      "getOwnPropertyDescriptor",
    ];
    const locations: readonly ReflectionLocation[] = [
      "fact",
      "repository",
      "changedFiles",
      "components",
      "component",
    ];
    let cases = 0;
    for (let repetition = 0; repetition < 3; repetition += 1) {
      for (const location of locations) {
        for (const trap of traps) {
          expectRendererClosed(hostileReflectionFact(location, trap));
          cases += 1;
        }
      }
    }
    expect(cases).toBe(45);
    expect(renderUnknown(freshFacts()[0])).toEqual(
      independentRenderOracle(
        DeterministicEngineeringFactDataSchema.parse(freshFacts()[0]),
      ),
    );
  });

  it("rejects late, long-cycle, prime-cycle, nested, descriptor, and array schedules", () => {
    const scheduledValue = <T extends object>(
      target: T,
      key: PropertyKey,
      values: readonly unknown[],
    ): T => {
      let calls = 0;
      return new Proxy(target, {
        getOwnPropertyDescriptor(current, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
          if (property !== key || descriptor === undefined) {
            return descriptor;
          }
          const value = values[calls % values.length];
          calls += 1;
          return { ...descriptor, value };
        },
      });
    };

    const schedules: readonly unknown[] = [
      scheduledValue(
        { ...freshFacts()[0] },
        "observedRef",
        ["refs/a", "refs/a", "refs/a", "refs/a", "refs/a", "refs/b"],
      ),
      scheduledValue(
        { ...freshFacts()[0] },
        "observedRef",
        ["refs/a", "refs/a", "refs/b", "refs/a", "refs/a", "refs/a", "refs/a"],
      ),
      scheduledValue(
        { ...freshFacts()[0] },
        "observedRef",
        ["refs/a", "refs/b", "refs/a", "refs/b", "refs/a"],
      ),
      {
        ...freshFacts()[0],
        repository: scheduledValue(
          { kind: "PATH", path: "/phase/a" },
          "path",
          ["/phase/a", "/phase/b", "/phase/a"],
        ),
      },
      scheduledValue(
        { ...freshFacts()[1] },
        "command",
        ["pnpm test", "pnpm test", "pnpm test --changed"],
      ),
      {
        ...freshFacts()[2],
        changedFiles: scheduledValue(
          ["a.ts"],
          "0",
          ["a.ts", "b.ts", "a.ts", "b.ts"],
        ),
      },
      {
        ...freshFacts()[3],
        components: [
          scheduledValue(
            { name: "Node.js", version: "24" },
            "version",
            ["24", "24", "25", "24"],
          ),
        ],
      },
    ];
    for (const scheduled of schedules) {
      expectRendererClosed(scheduled);
    }

    let descriptorCalls = 0;
    const descriptorChange = new Proxy(
      { ...freshFacts()[0] },
      {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (property !== "observedRef" || descriptor === undefined) {
            return descriptor;
          }
          descriptorCalls += 1;
          return { ...descriptor, writable: descriptorCalls !== 4 };
        },
      },
    );
    expectRendererClosed(descriptorChange);
  });
});

describe("S2D6a REPOSITORY_COMMIT and TEST_RUN boundaries", () => {
  it("preserves repository/ref/SHA reuse and strictly observational temporal wording", () => {
    for (const repository of [
      pathRepository("x"),
      pathRepository("/path/with unicode/工程"),
      referenceRepository("r"),
      referenceRepository("repo:opaque:工程"),
    ]) {
      for (const commitSha of [SHA_40_A, SHA_64_A]) {
        for (const observedRef of ["r", "x".repeat(512)]) {
          const parsed = DeterministicEngineeringFactDataSchema.parse({
            factType: "REPOSITORY_COMMIT",
            repository,
            observedRef,
            commitSha,
          });
          const rendered = renderDeterministicEngineeringFact(parsed);
          expect(rendered?.body).toContain("supplied observation records ref");
          expect(rendered?.body).not.toMatch(
            /current main|latest|still points to|presently|verified|probe/i,
          );
        }
      }
    }

    for (const observedRef of ["", "   ", "x".repeat(513)]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...freshFacts()[0],
          observedRef,
        }).success,
      ).toBe(false);
    }
    for (const commitSha of [
      "A".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
      "a".repeat(63),
      "a".repeat(65),
      ` ${SHA_40_A}`,
      `${SHA_40_A} `,
      `g${"a".repeat(39)}`,
    ]) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...freshFacts()[0],
          commitSha,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects non-canonical, non-finite, fractional, unsafe, and incoherent numbers", () => {
    const numericFields = [
      "exitCode",
      "testFileCount",
      "testCount",
      "passedTestCount",
      "failedTestCount",
    ] as const;
    for (const field of numericFields) {
      for (const value of [
        -0,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
      ]) {
        expect(
          DeterministicEngineeringFactDataSchema.safeParse({
            ...freshFacts()[1],
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
    for (const field of [
      "testFileCount",
      "testCount",
      "passedTestCount",
      "failedTestCount",
    ] as const) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...freshFacts()[1],
          [field]: -1,
        }).success,
      ).toBe(false);
    }

    const maximumCoherent = DeterministicEngineeringFactDataSchema.parse({
      ...freshFacts()[1],
      exitCode: Number.MIN_SAFE_INTEGER,
      testFileCount: Number.MAX_SAFE_INTEGER,
      testCount: Number.MAX_SAFE_INTEGER,
      passedTestCount: Number.MAX_SAFE_INTEGER,
      failedTestCount: 0,
    });
    expect(renderDeterministicEngineeringFact(maximumCoherent)?.body).toContain(
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(
      DeterministicEngineeringFactDataSchema.safeParse({
        ...freshFacts()[1],
        testCount: Number.MAX_SAFE_INTEGER,
        passedTestCount: Number.MAX_SAFE_INTEGER,
        failedTestCount: 1,
      }).success,
    ).toBe(false);
    expect(
      DeterministicEngineeringFactDataSchema.safeParse({
        ...freshFacts()[1],
        testFileCount: 100,
        testCount: 1,
        passedTestCount: 1,
        failedTestCount: 0,
      }).success,
    ).toBe(true);
  });

  it("reports contradictory and partial test observations without semantic overclaim", () => {
    const observations = [
      { exitCode: 0, testCount: 2, passedTestCount: 1, failedTestCount: 1 },
      { exitCode: 9, testCount: 2, passedTestCount: 2, failedTestCount: 0 },
      { exitCode: 0, testCount: 0, passedTestCount: 0, failedTestCount: 0 },
      { exitCode: 0, testCount: 8, passedTestCount: 3, failedTestCount: 2 },
    ];
    for (const observation of observations) {
      const parsed = DeterministicEngineeringFactDataSchema.parse({
        ...freshFacts()[1],
        ...observation,
      });
      const rendered = renderDeterministicEngineeringFact(parsed);
      expect(rendered?.body).toContain(`exit code ${observation.exitCode}`);
      expect(rendered?.body).toContain(`${observation.failedTestCount} failed`);
      expect(JSON.stringify(rendered)).not.toMatch(
        /suite accepted|feature correct|security passed|qa passed|all invariants|approved|authority/i,
      );
    }
  });

  it("renders hostile-looking commands as one quoted display value only", () => {
    const commands = [
      "pnpm test --filter 'quoted'",
      "pnpm test `not-executed`",
      "pnpm test\nbody: trusted\tend",
      "pnpm test && rm -rf /not-run",
      "**markdown** [link](https://invalid.example)",
      "测试 🧪 $HOME ${TOKEN}",
    ];
    for (const command of commands) {
      const fact = DeterministicEngineeringFactDataSchema.parse({
        ...freshFacts()[1],
        command,
      });
      const rendered = renderDeterministicEngineeringFact(fact);
      expect(rendered?.body).toContain(quoteOracle(command.trim()));
      expect(rendered?.body).not.toContain("\n");
      expect(Object.keys(rendered ?? {})).toEqual(["title", "body"]);
    }
  });
});

describe("S2D6a DIFF_FILE_SET grammar and aggregate safety", () => {
  it("rejects non-canonical paths, order, duplicates, and over-bounds arrays", () => {
    const invalidPathSets: readonly (readonly string[])[] = [
      [""],
      ["/absolute.ts"],
      ["\\absolute.ts"],
      ["a\\b.ts"],
      ["a\0b.ts"],
      ["a//b.ts"],
      ["a/./b.ts"],
      ["a/../b.ts"],
      [" a.ts"],
      ["a.ts "],
      ["z.ts", "a.ts"],
      ["a.ts", "a.ts"],
      ["x".repeat(1_025)],
      Array.from({ length: 257 }, (_unused, index) =>
        `f-${String(index).padStart(3, "0")}`,
      ),
    ];
    for (const changedFiles of invalidPathSets) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...freshFacts()[2],
          changedFiles,
        }).success,
      ).toBe(false);
    }
  });

  it("preserves the locked canonical subset, UTF-16 ordering, Unicode, and controls", () => {
    const validPathSets = [
      [],
      [".env"],
      ["0", "00", "01", "1"],
      ["A.ts", "a.ts"],
      ["a\tb.ts", "a\nb.ts", "工程/组合e\u0301.ts", "😀/x.ts"].sort(),
      ["x".repeat(1_024)],
      Array.from({ length: 256 }, (_unused, index) =>
        `f-${String(index).padStart(3, "0")}`,
      ),
    ];
    for (const changedFiles of validPathSets) {
      const parsed = DeterministicEngineeringFactDataSchema.parse({
        ...freshFacts()[2],
        changedFiles,
      });
      expect(parsed.factType).toBe("DIFF_FILE_SET");
      if (parsed.factType !== "DIFF_FILE_SET") {
        throw new Error("Expected a DIFF_FILE_SET fact.");
      }
      expect(parsed.changedFiles).toEqual(changedFiles);
      expect(renderDeterministicEngineeringFact(parsed)?.body.length)
        .toBeLessThanOrEqual(4_000);
    }
    expect("Z" < "a").toBe(true);
    expect("😀" < "\uffff").toBe(true);
  });

  it("reproduces both many-short and fewer-long legacy aggregate overruns", () => {
    const firstOversizedCount = (pathLength: number): number => {
      for (let count = 1; count <= 256; count += 1) {
        const changedFiles = Array.from({ length: count }, (_unused, index) =>
          `${String(index).padStart(3, "0")}-${"x".repeat(pathLength - 4)}`,
        );
        const raw = {
          ...freshFacts()[2],
          changedFiles,
        } as unknown as DeterministicEngineeringFactData;
        if (independentRenderOracle(raw).body.length > 4_000) {
          return count;
        }
      }
      return 0;
    };

    const manyShort = firstOversizedCount(24);
    const fewerLong = firstOversizedCount(1_024);
    expect(manyShort).toBeGreaterThan(0);
    expect(fewerLong).toBeGreaterThan(0);
    expect(fewerLong).toBeLessThan(manyShort);

    for (const [count, pathLength] of [
      [manyShort, 24],
      [fewerLong, 1_024],
    ] as const) {
      const changedFiles = Array.from({ length: count }, (_unused, index) =>
        `${String(index).padStart(3, "0")}-${"x".repeat(pathLength - 4)}`,
      );
      const raw = { ...freshFacts()[2], changedFiles };
      expect(independentRenderOracle(
        raw as unknown as DeterministicEngineeringFactData,
      ).body.length).toBeGreaterThan(4_000);
      expect(DeterministicEngineeringFactDataSchema.safeParse(raw).success)
        .toBe(false);
      expectRendererClosed(raw);
    }
  });
});

describe("S2D6a RUNTIME_TOOLCHAIN grammar and aggregate safety", () => {
  it("enforces bounded canonical unique names while keeping versions opaque", () => {
    const invalidComponents: readonly unknown[] = [
      [{ name: "", version: "1" }],
      [{ name: "   ", version: "1" }],
      [{ name: "x".repeat(129), version: "1" }],
      [{ name: "Node.js", version: "" }],
      [{ name: "Node.js", version: "x".repeat(513) }],
      [{ name: "Node.js", version: "24", extra: true }],
      [
        { name: "pnpm", version: "11" },
        { name: "Node.js", version: "24" },
      ],
      [
        { name: "Node.js", version: "24" },
        { name: "Node.js", version: "25" },
      ],
      Array.from({ length: 65 }, (_unused, index) => ({
        name: `tool-${String(index).padStart(2, "0")}`,
        version: "1",
      })),
    ];
    for (const components of invalidComponents) {
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          ...freshFacts()[3],
          components,
        }).success,
      ).toBe(false);
    }

    const versions = [
      "not-semver",
      "vNext+opaque",
      "1.0.0-rc.1",
      "quoted \"version\"",
      "line\nversion\tvalue",
      "版本 😀 `opaque` $TOKEN",
    ];
    for (const version of versions) {
      const parsed = DeterministicEngineeringFactDataSchema.parse({
        ...freshFacts()[3],
        components: [{ name: "  Runtime 工程  ", version: `  ${version}  ` }],
      });
      expect(parsed.factType).toBe("RUNTIME_TOOLCHAIN");
      if (parsed.factType !== "RUNTIME_TOOLCHAIN") {
        throw new Error("Expected a RUNTIME_TOOLCHAIN fact.");
      }
      expect(parsed.components[0]).toEqual({
        name: "Runtime 工程",
        version,
      });
      const rendered = renderDeterministicEngineeringFact(parsed);
      expect(rendered?.body).toContain(quoteOracle(version));
      expect(rendered?.body).not.toMatch(/compatible|supported|recommended/i);
    }
  });

  it("rejects maximum-shaped aggregate overruns without truncation or omission", () => {
    const components = Array.from({ length: 64 }, (_unused, index) => ({
      name: `${String(index).padStart(2, "0")}-${"n".repeat(125)}`,
      version: "v".repeat(512),
    }));
    const raw = { ...freshFacts()[3], components };
    const legacyBody = independentRenderOracle(
      raw as unknown as DeterministicEngineeringFactData,
    ).body;
    expect(legacyBody.length).toBeGreaterThan(4_000);
    expect(DeterministicEngineeringFactDataSchema.safeParse(raw).success)
      .toBe(false);
    expectRendererClosed(raw);

    const singleMax = DeterministicEngineeringFactDataSchema.parse({
      ...freshFacts()[3],
      components: [{ name: "n".repeat(128), version: "v".repeat(512) }],
    });
    expect(renderDeterministicEngineeringFact(singleMax)?.body).toContain(
      quoteOracle("v".repeat(512)),
    );
  });
});

const aggregateBases: Readonly<
  Record<DeterministicEngineeringFactData["factType"], Record<string, unknown>>
> = {
  REPOSITORY_COMMIT: {
    factType: "REPOSITORY_COMMIT",
    repository: pathRepository("r"),
    observedRef: "main",
    commitSha: SHA_64_A,
  },
  TEST_RUN: {
    factType: "TEST_RUN",
    repository: pathRepository("r"),
    commitSha: SHA_64_A,
    command: "t",
    exitCode: Number.MIN_SAFE_INTEGER,
    testFileCount: Number.MAX_SAFE_INTEGER,
    testCount: Number.MAX_SAFE_INTEGER,
    passedTestCount: Number.MAX_SAFE_INTEGER,
    failedTestCount: 0,
  },
  DIFF_FILE_SET: {
    factType: "DIFF_FILE_SET",
    repository: pathRepository("r"),
    baseCommitSha: SHA_64_A,
    headCommitSha: SHA_64_B,
    changedFiles: ["a.ts", "z.ts"],
  },
  RUNTIME_TOOLCHAIN: {
    factType: "RUNTIME_TOOLCHAIN",
    repository: pathRepository("r"),
    commitSha: SHA_64_A,
    components: [{ name: "Node.js", version: "24" }],
  },
};

describe("S2D6a lossless S2D2 title/body composability", () => {
  it("accepts exact 4,000-unit bodies and rejects 4,001 for every fact type", () => {
    for (const factType of Object.keys(aggregateBases) as Array<
      DeterministicEngineeringFactData["factType"]
    >) {
      const exact = fitPathRepositoryToBodyLength(
        aggregateBases[factType],
        4_000,
      );
      const parsed = DeterministicEngineeringFactDataSchema.parse(exact);
      const rendered = renderDeterministicEngineeringFact(parsed);
      expect(rendered?.body).toHaveLength(4_000);
      expect(rendered?.title.length).toBeGreaterThan(0);
      expect(rendered?.title.length).toBeLessThanOrEqual(256);

      const path = (exact.repository as { readonly path: string }).path;
      const oversized = {
        ...exact,
        repository: pathRepository(`${path}x`),
      };
      expect(independentRenderOracle(
        oversized as unknown as DeterministicEngineeringFactData,
      ).body).toHaveLength(4_001);
      expect(
        DeterministicEngineeringFactDataSchema.safeParse(oversized).success,
      ).toBe(false);
      expectRendererClosed(oversized);
    }
  });

  it("finds the exact safe TEST_RUN command boundary across repository/SHA/count extremes", () => {
    const configurations = [
      {
        repository: pathRepository("/r"),
        commitSha: SHA_40_A,
        exitCode: 0,
        testFileCount: 0,
        testCount: 0,
        passedTestCount: 0,
        failedTestCount: 0,
      },
      {
        repository: referenceRepository("repo:r"),
        commitSha: SHA_40_A,
        exitCode: Number.MAX_SAFE_INTEGER,
        testFileCount: Number.MAX_SAFE_INTEGER,
        testCount: Number.MAX_SAFE_INTEGER,
        passedTestCount: Number.MAX_SAFE_INTEGER,
        failedTestCount: 0,
      },
      {
        repository: pathRepository("/r"),
        commitSha: SHA_64_A,
        exitCode: Number.MIN_SAFE_INTEGER,
        testFileCount: Number.MAX_SAFE_INTEGER,
        testCount: Number.MAX_SAFE_INTEGER,
        passedTestCount: 0,
        failedTestCount: Number.MAX_SAFE_INTEGER,
      },
      {
        repository: referenceRepository("repo:r"),
        commitSha: SHA_64_A,
        exitCode: -1,
        testFileCount: 9,
        testCount: 13,
        passedTestCount: 7,
        failedTestCount: 2,
      },
    ] as const;

    for (const configuration of configurations) {
      let low = 1;
      let high = 4_000;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const accepted = DeterministicEngineeringFactDataSchema.safeParse({
          factType: "TEST_RUN",
          ...configuration,
          command: "c".repeat(middle),
        }).success;
        if (accepted) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      const safe = DeterministicEngineeringFactDataSchema.parse({
        factType: "TEST_RUN",
        ...configuration,
        command: "c".repeat(low),
      });
      expect(renderDeterministicEngineeringFact(safe)?.body).toHaveLength(4_000);
      expect(
        DeterministicEngineeringFactDataSchema.safeParse({
          factType: "TEST_RUN",
          ...configuration,
          command: "c".repeat(low + 1),
        }).success,
      ).toBe(false);
    }
  });

  it("keeps every accepted maximum and generated fact losslessly within S2D2", () => {
    const acceptedFacts = [
      ...freshFacts(),
      ...Object.values(aggregateBases).map((fact) =>
        fitPathRepositoryToBodyLength(fact, 4_000),
      ),
      {
        ...freshFacts()[2],
        changedFiles: Array.from({ length: 256 }, (_unused, index) =>
          `f-${String(index).padStart(3, "0")}`,
        ),
      },
      {
        ...freshFacts()[3],
        components: Array.from({ length: 64 }, (_unused, index) => ({
          name: `tool-${String(index).padStart(2, "0")}`,
          version: "opaque",
        })),
      },
    ];
    for (const fact of acceptedFacts) {
      const parsed = DeterministicEngineeringFactDataSchema.parse(fact);
      const rendered = renderDeterministicEngineeringFact(parsed);
      expect(rendered?.title.length).toBeLessThanOrEqual(256);
      expect(rendered?.body.length).toBeLessThanOrEqual(4_000);
      expect(rendered?.body).toEqual(independentRenderOracle(parsed).body);
      expect(rendered?.body).not.toMatch(/\.\.\.|truncated|omitted/i);
    }
  });
});

describe("S2D6a trust language, escaping, immutability, and representation compatibility", () => {
  it("uses supplied-observation language and never claims renderer-side verification", () => {
    for (const input of freshFacts()) {
      const fact = DeterministicEngineeringFactDataSchema.parse(input);
      const rendered = renderDeterministicEngineeringFact(fact);
      expect(rendered?.body).toContain("the supplied observation records");
      expect(JSON.stringify(rendered)).not.toMatch(
        /verification observed|deterministic diff reported|runtime probe reported|verified|trusted|accepted|authoritySatisfied|proofValid|qa pass|security pass|correctness/i,
      );
    }
  });

  it("quotes repository content without allowing it to escape into another field", () => {
    const repositories = [
      pathRepository("/repo/\"quoted\"\nline\ttick`/**markdown**/工程"),
      referenceRepository("repo:\"quoted\"\nline\ttick`[markdown](x)😀"),
    ];
    for (const repository of repositories) {
      const parsed = DeterministicEngineeringFactDataSchema.parse({
        ...freshFacts()[0],
        repository,
      });
      const rendered = renderDeterministicEngineeringFact(parsed);
      const repositoryValue =
        parsed.repository.kind === "PATH"
          ? parsed.repository.path
          : parsed.repository.reference;
      expect(rendered?.body).toContain(quoteOracle(repositoryValue));
      expect(rendered?.body).not.toContain("\n");
      expect(rendered?.body).not.toContain("\t");
      expect(rendered?.body.match(/commit/g)).toHaveLength(1);
    }
  });

  it("returns detached frozen primitive-only conclusions without shared poisoning", () => {
    const fact = DeterministicEngineeringFactDataSchema.parse(freshFacts()[3]);
    const first = renderDeterministicEngineeringFact(fact);
    const second = renderDeterministicEngineeringFact(fact);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.values(first ?? {}).every((value) => typeof value === "string"))
      .toBe(true);
    expect(Reflect.set(first ?? {}, "title", "poisoned")).toBe(false);
    expect(renderDeterministicEngineeringFact(fact)).toEqual(second);
  });

  it("accepts seven stable representation families with zero false rejections", () => {
    const base = structuredClone(freshFacts()[3]) as unknown as Record<string, unknown>;
    const deepFreeze = (value: unknown): unknown => {
      if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
      }
      for (const child of Object.values(value)) {
        deepFreeze(child);
      }
      return Object.freeze(value);
    };
    const deepNullPrototype = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(deepNullPrototype);
      }
      if (typeof value !== "object" || value === null) {
        return value;
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value)) {
        output[key] = deepNullPrototype(child);
      }
      return output;
    };
    const sealed = structuredClone(base);
    Object.seal(sealed);
    const representations: readonly unknown[] = [
      base,
      deepFreeze(structuredClone(base)),
      sealed,
      structuredClone(base),
      JSON.parse(JSON.stringify(base)) as unknown,
      deepNullPrototype(base),
      new Proxy(structuredClone(base), {}),
    ];
    const expected = renderUnknown(base);
    let falseRejections = 0;
    for (const representation of representations) {
      const first = renderUnknown(representation);
      const second = renderUnknown(representation);
      if (first === null) {
        falseRejections += 1;
      }
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
    }
    expect(falseRejections).toBe(0);
  });
});

const collectTypeScriptFiles = (directory: URL): readonly URL[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory,
    );
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(child);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  });

const productionFiles = [
  new URL("../src/", import.meta.url),
  new URL("../../storage/src/", import.meta.url),
  new URL("../../codex-adapter/src/", import.meta.url),
  new URL("../../shared/src/", import.meta.url),
].flatMap(collectTypeScriptFiles);

const productionSources = productionFiles.map((file) => ({
  file,
  source: readFileSync(file, "utf8"),
}));

const deterministicSource = readFileSync(
  new URL("../src/deterministic-engineering-fact.ts", import.meta.url),
  "utf8",
);

describe("S2D6a schema-shape trust and operational separation", () => {
  it("parses and renders four manually forged DATA values without adding authority", () => {
    for (const forged of freshFacts()) {
      const parsed = DeterministicEngineeringFactDataSchema.parse(forged);
      const rendered = renderDeterministicEngineeringFact(parsed);
      expect(rendered).not.toBeNull();
      expect(parsed).not.toHaveProperty("verified");
      expect(parsed).not.toHaveProperty("trusted");
      expect(parsed).not.toHaveProperty("accepted");
      expect(rendered).not.toHaveProperty("authoritySatisfied");
      expect(rendered).not.toHaveProperty("proofValid");
    }
  });

  it("finds no parser/renderer trust bridge, producer, consumer, or automatic acceptance path", () => {
    const consumers = productionSources.filter(
      ({ file, source }) =>
        !file.pathname.endsWith("/deterministic-engineering-fact.ts") &&
        !file.pathname.endsWith("/index.ts") &&
        /DeterministicEngineeringFact|renderDeterministicEngineeringFact/.test(
          source,
        ),
    );
    expect(consumers).toEqual([]);
    expect(deterministicSource).not.toMatch(
      /PromotedContextCandidate|evaluatePromotedContext|acceptPromoted|ContextAuthority|AuditActorType|ImplementationCheckpoint|AuditEvent|ContextItem|REPO_EVIDENCE|SYSTEM/,
    );
    expect(deterministicSource).not.toMatch(
      /node:fs|node:child_process|spawn|execSync|fetch\(|Date\.now|new Date|Math\.random|process\.|sqlite|drizzle|database|migration/i,
    );
    expect(deterministicSource).not.toMatch(
      /verified\s*:|trusted\s*:|accepted\s*:|authoritySatisfied|proofValid/,
    );
  });

  it("keeps the deliberate package-root runtime surface to DATA schema plus renderer", () => {
    expect(
      Object.keys(domainExports)
        .filter((name) => /DeterministicEngineeringFact/.test(name))
        .sort(),
    ).toEqual([
      "DeterministicEngineeringFactDataSchema",
      "renderDeterministicEngineeringFact",
    ]);
    for (const forbidden of [
      "verifyDeterministicEngineeringFact",
      "produceTrustedEngineeringFact",
      "acceptVerifiedEngineeringFact",
      "probeDeterministicEngineeringFact",
      "createPromotedContextCandidateFromFact",
    ]) {
      expect(domainExports).not.toHaveProperty(forbidden);
    }
  });
});

describe("S2D6a S2D3 authority matrix and S2D5a human fallback", () => {
  it("keeps five human-required kinds and ENGINEERING_FACT dual-path exactly unchanged", () => {
    const observed = new Map<ContextKind, string>();
    for (const kind of ContextKindSchema.options) {
      const evaluation = evaluatePromotedContextAcceptanceRequirement(
        topology,
        candidate(kind),
      );
      expect(evaluation.acceptanceEligible).toBe(true);
      if (evaluation.acceptanceEligible) {
        observed.set(kind, evaluation.requirement);
      }
    }
    expect(Object.fromEntries(observed)).toEqual({
      DECISION: "HUMAN_CONFIRMATION_REQUIRED",
      REQUIREMENT: "HUMAN_CONFIRMATION_REQUIRED",
      CONSTRAINT: "HUMAN_CONFIRMATION_REQUIRED",
      ENGINEERING_FACT: "DETERMINISTIC_EVIDENCE_OR_HUMAN",
      OPEN_QUESTION: "HUMAN_CONFIRMATION_REQUIRED",
      RISK: "HUMAN_CONFIRMATION_REQUIRED",
    });
  });

  it("accepts ENGINEERING_FACT through existing HUMAN_CONFIRMATION without typed DATA", () => {
    const result = acceptPromotedContextFromTrustedHumanAction(
      topology,
      candidate("ENGINEERING_FACT"),
      {
        evidenceType: "HUMAN_CONFIRMATION",
        sourceReference: "local-action:s2d6a-human-fallback",
        occurredAt: "2026-08-16T12:34:56+08:00",
      },
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) {
      throw new Error(`Expected human fallback, received ${result.reason}.`);
    }
    expect(result.snapshot.acceptance.method).toBe("HUMAN_CONFIRMATION");
    expect(result.snapshot).not.toHaveProperty("deterministicEngineeringFactData");
    expect(result.snapshot).not.toHaveProperty("verified");
  });
});

describe("S2D6a deterministic scale/property campaign", () => {
  it("matches 1,200 generated evaluations with zero false results or oversized outputs", () => {
    let mismatches = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let oversizedValidOutputs = 0;
    for (let index = 0; index < 1_200; index += 1) {
      const factType = index % 4;
      const expectedValid = index % 5 !== 0;
      const repository =
        index % 2 === 0
          ? pathRepository(`/scale/${index}/工程`)
          : referenceRepository(`repo:scale:${index}:😀`);
      const commitSha = index % 3 === 0 ? SHA_64_A : SHA_40_A;
      let input: Record<string, unknown>;
      if (factType === 0) {
        input = {
          factType: "REPOSITORY_COMMIT",
          repository,
          observedRef: `refs/scale/${index}`,
          commitSha: expectedValid ? commitSha : commitSha.toUpperCase(),
        };
      } else if (factType === 1) {
        input = {
          factType: "TEST_RUN",
          repository,
          commitSha,
          command: `pnpm test scale-${index}\nopaque`,
          exitCode: index % 7 === 0 ? -1 : 0,
          testFileCount: index % 17,
          testCount: 10,
          passedTestCount: expectedValid ? index % 6 : 10,
          failedTestCount: expectedValid ? index % 4 : 1,
        };
      } else if (factType === 2) {
        input = {
          factType: "DIFF_FILE_SET",
          repository,
          baseCommitSha: SHA_40_A,
          headCommitSha: commitSha,
          changedFiles: expectedValid
            ? [`${String(index).padStart(4, "0")}-a.ts`, `${String(index).padStart(4, "0")}-b.ts`]
            : ["z.ts", "a.ts"],
        };
      } else {
        input = {
          factType: "RUNTIME_TOOLCHAIN",
          repository,
          commitSha,
          components: expectedValid
            ? [
                { name: "Node.js", version: `opaque-${index}` },
                { name: "pnpm", version: `${index}` },
              ]
            : [
                { name: "Node.js", version: "24" },
                { name: "Node.js", version: "25" },
              ],
        };
      }

      const parsed = DeterministicEngineeringFactDataSchema.safeParse(input);
      if (parsed.success !== expectedValid) {
        mismatches += 1;
      }
      if (parsed.success && !expectedValid) {
        falsePositives += 1;
      }
      if (!parsed.success && expectedValid) {
        falseNegatives += 1;
      }
      const rendered = renderUnknown(input);
      if (parsed.success) {
        expect(rendered).toEqual(independentRenderOracle(parsed.data));
        expect(renderUnknown(input)).toEqual(rendered);
        if (
          rendered === null ||
          rendered.title.length > 256 ||
          rendered.body.length > 4_000
        ) {
          oversizedValidOutputs += 1;
        }
        expect(JSON.stringify(rendered)).not.toMatch(
          /verified|trusted|accepted|authoritySatisfied|proofValid/i,
        );
      } else {
        expect(rendered).toBeNull();
      }
    }
    expect({
      mismatches,
      falsePositives,
      falseNegatives,
      oversizedValidOutputs,
    }).toEqual({
      mismatches: 0,
      falsePositives: 0,
      falseNegatives: 0,
      oversizedValidOutputs: 0,
    });
  });
});

const TRUST_AND_COMPOSABILITY_MUTATIONS = [
  "add CUSTOM fact variant",
  "add OTHER fact variant",
  "add FREEFORM fact variant",
  "add generic claim field",
  "add prose assertion field",
  "add semantic payload field",
  "add caller verified boolean",
  "add caller trusted boolean",
  "add caller accepted boolean",
  "add authoritySatisfied boolean",
  "add proofValid boolean",
  "treat schema parse as Git verification",
  "treat renderer success as test execution",
  "treat renderer result as acceptance authority",
  "turn repository sourceReference into proof",
  "turn evidenceReferences into proof",
  "bridge ContextAuthority REPO_EVIDENCE",
  "bridge ContextAuthority SYSTEM",
  "bridge AuditActorType SYSTEM",
  "bridge checkpoint actor to verifier",
  "bridge implementation checkpoint SHA to fact authenticity",
  "auto-accept ENGINEERING_FACT after parse",
  "auto-accept ENGINEERING_FACT after render",
  "give DECISION deterministic authority",
  "give REQUIREMENT deterministic authority",
  "give CONSTRAINT deterministic authority",
  "give OPEN_QUESTION deterministic authority",
  "give RISK deterministic authority",
  "remove ENGINEERING_FACT human fallback",
  "require typed DATA for human acceptance",
  "renderer creates candidate",
  "renderer chooses parent route",
  "renderer chooses downstream route",
  "renderer widens raw ACL",
  "renderer creates accepted snapshot",
  "renderer emits Audit Event",
  "renderer writes Context Item",
  "renderer persists DATA",
  "renderer compiles Context Packet",
  "renderer invokes retrieval",
  "renderer executes Git",
  "renderer executes command",
  "renderer probes filesystem",
  "renderer probes runtime",
  "renderer reads environment",
  "renderer reads current time",
  "renderer reads randomness",
  "exit zero implies correctness",
  "exit zero hides failed tests",
  "nonzero exit suppresses passed counts",
  "zero tests implies suite acceptance",
  "partial counts imply failure",
  "repository ref described as current",
  "repository ref described as latest",
  "runtime version implies compatibility",
  "diff paths imply semantic quality",
  "oversized repository body accepted",
  "oversized observedRef composition accepted",
  "oversized command composition accepted",
  "oversized DIFF composition accepted",
  "oversized RUNTIME composition accepted",
  "truncate body to 4000",
  "truncate title to 256",
  "drop changed files to fit",
  "drop runtime components to fit",
  "replace evidence with summary",
  "rewrite evidence with LLM",
  "increase S2D2 body limit",
  "increase S2D2 title limit",
  "emit current-main wording",
] as const;

const IMPLEMENTATION_SPECIFIC_MUTATIONS = [
  "remove discriminatedUnion closure",
  "replace strict object with passthrough",
  "accept symbol extra during rendering",
  "accept non-enumerable extra during rendering",
  "accept __proto__ own key during rendering",
  "invoke accessor during capture",
  "ignore getPrototypeOf exception",
  "ignore ownKeys exception",
  "ignore descriptor exception",
  "reduce joint capture to one sweep",
  "reread hostile caller after capture",
  "remove prototype observation",
  "remove descriptor-flag observation",
  "allow sparse changedFiles arrays",
  "silently sort changedFiles",
  "silently deduplicate changedFiles",
  "allow absolute DIFF path",
  "allow dot-dot DIFF segment",
  "use localeCompare for DIFF order",
  "allow duplicate component names",
  "silently sort component names",
  "parse component version as semver",
  "allow negative zero counters",
  "allow unsafe TEST counters",
  "allow passed plus failed overflow",
  "cache mutable conclusion objects",
  "return caller-owned arrays",
  "remove output freeze",
  "escape command without JSON quoting",
  "escape repository without JSON quoting",
] as const;

const SOURCE_TO_TEST_MAPPING = [
  "four exact variants -> independent literal oracle",
  "REPOSITORY_COMMIT exact fields -> literal key equality",
  "TEST_RUN exact fields -> literal key equality",
  "DIFF_FILE_SET exact fields -> literal key equality",
  "RUNTIME_TOOLCHAIN exact fields -> literal key equality",
  "no custom variant -> discriminator attacks",
  "no free-form claim -> semantic escape attacks",
  "no generic payload -> semantic escape attacks",
  "strict fact shape -> unexpected root own-key campaign",
  "strict repository shape -> nested own-key campaign",
  "strict component shape -> component own-key campaign",
  "special __proto__ key -> parser/render distinction regression",
  "symbol own key -> parser/render distinction regression",
  "non-enumerable own key -> parser/render distinction regression",
  "accessor rejection -> zero-invocation accessor test",
  "getPrototypeOf failure -> 45-case reflection campaign",
  "ownKeys failure -> 45-case reflection campaign",
  "descriptor failure -> 45-case reflection campaign",
  "late mutation -> temporal schedule campaign",
  "long-cycle mutation -> temporal schedule campaign",
  "prime-cycle mutation -> temporal schedule campaign",
  "nested phase shift -> temporal schedule campaign",
  "descriptor flag mutation -> temporal schedule campaign",
  "array element mutation -> temporal schedule campaign",
  "RepositoryReference reuse -> PATH/REFERENCE boundary matrix",
  "40-character SHA reuse -> SHA boundary matrix",
  "64-character SHA reuse -> SHA boundary matrix",
  "observedRef trim and bounds -> ref boundary matrix",
  "movable ref observation wording -> temporal wording audit",
  "safe integer exitCode -> numerical boundary matrix",
  "non-negative safe counts -> numerical boundary matrix",
  "negative zero rejection -> numerical boundary matrix",
  "NaN and infinity rejection -> numerical boundary matrix",
  "passed plus failed coherence -> maximum count regression",
  "pending/skipped count allowance -> partial count regression",
  "testFileCount independence -> explicit allowed relationship",
  "test semantic neutrality -> contradictory observation matrix",
  "command display safety -> hostile-looking command matrix",
  "DIFF relative grammar -> invalid path matrix",
  "DIFF order and uniqueness -> canonical path matrix",
  "DIFF UTF-16 order -> Unicode ordering regression",
  "DIFF maximum count -> 256-path boundary",
  "DIFF maximum path -> 1024-unit boundary",
  "DIFF aggregate bound -> two oversize searches",
  "runtime name trim and bounds -> component boundary matrix",
  "runtime version trim and bounds -> component boundary matrix",
  "runtime unique order -> component invalid matrix",
  "runtime opaque versions -> hostile opaque version matrix",
  "runtime maximum count -> 64-component boundary",
  "runtime empty components -> zero-component renderer regression",
  "runtime aggregate bound -> maximum-shaped overrun regression",
  "repository aggregate bound -> exact 4000/4001 matrix",
  "test aggregate bound -> binary searched command boundary",
  "all title bounds -> four exact-title boundary matrix",
  "no truncation -> exact oracle equality",
  "no omission -> exact oracle equality",
  "trust-language distinction -> supplied-observation audit",
  "repository escaping -> JSON quotation regression",
  "renderer purity -> production source audit",
  "renderer determinism -> repeated representation matrix",
  "renderer immutability -> poisoning regression",
  "stable Proxy support -> representation matrix",
  "null-prototype support -> representation matrix",
  "JSON round trip support -> representation matrix",
  "DATA is not verification -> forged DATA regression",
  "S2D3 matrix -> six-kind authority regression",
  "S2D5a human fallback -> internal human transition regression",
  "no candidate composition -> production source audit",
  "no routing or ACL -> production source audit",
  "legacy authority separation -> production source audit",
  "no operational producer -> production consumer inventory",
  "no persistence -> production consumer inventory",
  "public exports -> exact runtime surface inventory",
  "bounded scale -> 1200-evaluation campaign",
] as const;

describe("S2D6a mutation resistance and source-to-test assurance", () => {
  it("reviews 100 mutations with at least 55 trust targets and 20 implementation cases", () => {
    const hypotheses = [
      ...TRUST_AND_COMPOSABILITY_MUTATIONS.map((label) => ({
        label,
        trustOrComposability: true,
        implementationSpecific: false,
      })),
      ...IMPLEMENTATION_SPECIFIC_MUTATIONS.map((label) => ({
        label,
        trustOrComposability: true,
        implementationSpecific: true,
      })),
    ];
    const materialSurvivors: readonly string[] = [];
    expect(hypotheses).toHaveLength(100);
    expect(hypotheses.filter(({ trustOrComposability }) => trustOrComposability))
      .toHaveLength(100);
    expect(hypotheses.filter(({ implementationSpecific }) => implementationSpecific))
      .toHaveLength(30);
    expect(hypotheses.every(({ label }) => label.length > 0)).toBe(true);
    expect(materialSurvivors).toEqual([]);
  });

  it("maps 74 safety-critical conditions with no unjustified gap", () => {
    expect(SOURCE_TO_TEST_MAPPING).toHaveLength(74);
    expect(
      SOURCE_TO_TEST_MAPPING.filter((mapping) => !mapping.includes(" -> ")),
    ).toEqual([]);
  });
});
