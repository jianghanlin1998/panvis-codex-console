import { z } from "zod";

import { RepositoryCommitShaSchema } from "./implementation-checkpoint.js";
import { captureJointlyStableStructuralDataList } from "./structural-capture.js";
import { RepositoryReferenceSchema } from "./tasks.js";
import type { RepositoryReference } from "./tasks.js";

const compactText = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength);

const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0), {
    message: "Negative zero is not a canonical non-negative integer",
  });

const safeInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0), {
    message: "Negative zero is not a canonical integer",
  });

const RepositoryCommitFactSchema = z
  .object({
    factType: z.literal("REPOSITORY_COMMIT"),
    repository: RepositoryReferenceSchema,
    observedRef: compactText(512),
    commitSha: RepositoryCommitShaSchema,
  })
  .strict()
  .readonly();

const TestRunFactSchema = z
  .object({
    factType: z.literal("TEST_RUN"),
    repository: RepositoryReferenceSchema,
    commitSha: RepositoryCommitShaSchema,
    command: compactText(4_000),
    exitCode: safeInteger,
    testFileCount: nonNegativeSafeInteger,
    testCount: nonNegativeSafeInteger,
    passedTestCount: nonNegativeSafeInteger,
    failedTestCount: nonNegativeSafeInteger,
  })
  .strict()
  .superRefine((fact, context) => {
    if (fact.passedTestCount + fact.failedTestCount > fact.testCount) {
      context.addIssue({
        code: "custom",
        message: "Passed and failed test counts must not exceed the total test count",
        path: ["failedTestCount"],
      });
    }
  })
  .readonly();

const repositoryRelativePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.trim() === value, {
    message: "Repository-relative paths must have no surrounding whitespace",
  })
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    {
      message: "Repository-relative paths must use canonical slash-separated segments",
    },
  );

const canonicalChangedFiles = z
  .array(repositoryRelativePath)
  .max(256)
  .superRefine((changedFiles, context) => {
    for (let index = 1; index < changedFiles.length; index += 1) {
      const previous = changedFiles[index - 1];
      const current = changedFiles[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: "custom",
          message: "Changed files must be unique and use canonical ascending order",
          path: [index],
        });
        break;
      }
    }
  })
  .readonly();

const DiffFileSetFactSchema = z
  .object({
    factType: z.literal("DIFF_FILE_SET"),
    repository: RepositoryReferenceSchema,
    baseCommitSha: RepositoryCommitShaSchema,
    headCommitSha: RepositoryCommitShaSchema,
    changedFiles: canonicalChangedFiles,
  })
  .strict()
  .readonly();

const RuntimeToolchainComponentSchema = z
  .object({
    name: compactText(128),
    version: compactText(512),
  })
  .strict()
  .readonly();

const canonicalRuntimeComponents = z
  .array(RuntimeToolchainComponentSchema)
  .max(64)
  .superRefine((components, context) => {
    for (let index = 1; index < components.length; index += 1) {
      const previous = components[index - 1];
      const current = components[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.name >= current.name
      ) {
        context.addIssue({
          code: "custom",
          message: "Runtime component names must be unique and use canonical ascending order",
          path: [index, "name"],
        });
        break;
      }
    }
  })
  .readonly();

const RuntimeToolchainFactSchema = z
  .object({
    factType: z.literal("RUNTIME_TOOLCHAIN"),
    repository: RepositoryReferenceSchema,
    commitSha: RepositoryCommitShaSchema,
    components: canonicalRuntimeComponents,
  })
  .strict()
  .readonly();

/**
 * Serialized DATA shape only. A successful parse establishes typed structural
 * validity; it does not establish that a trusted deterministic probe observed
 * the represented fact.
 */
const DeterministicEngineeringFactBaseDataSchema = z.discriminatedUnion(
  "factType",
  [
    RepositoryCommitFactSchema,
    TestRunFactSchema,
    DiffFileSetFactSchema,
    RuntimeToolchainFactSchema,
  ],
);

type DeterministicEngineeringFactBaseData = z.infer<
  typeof DeterministicEngineeringFactBaseDataSchema
>;

export type DeterministicEngineeringFactConclusion = Readonly<{
  title: string;
  body: string;
}>;

const PROMOTED_CONTEXT_TITLE_MAX_LENGTH = 256;
const PROMOTED_CONTEXT_BODY_MAX_LENGTH = 4_000;

const TITLES = Object.freeze({
  REPOSITORY_COMMIT: "Repository commit observation",
  TEST_RUN: "Test-run observation",
  DIFF_FILE_SET: "Diff file-set observation",
  RUNTIME_TOOLCHAIN: "Runtime toolchain observation",
} satisfies Readonly<Record<DeterministicEngineeringFactBaseData["factType"], string>>);

const quote = (value: string): string => JSON.stringify(value);

const renderRepository = (repository: RepositoryReference): string =>
  repository.kind === "PATH"
    ? `PATH ${quote(repository.path)}`
    : `REFERENCE ${quote(repository.reference)}`;

const renderChangedFileCount = (count: number): string =>
  `${count} changed ${count === 1 ? "file" : "files"}`;

const renderCanonicalFact = (
  fact: DeterministicEngineeringFactBaseData,
): DeterministicEngineeringFactConclusion => {
  const repository = renderRepository(fact.repository);
  switch (fact.factType) {
    case "REPOSITORY_COMMIT":
      return Object.freeze({
        title: TITLES.REPOSITORY_COMMIT,
        body: `For repository ${repository}, the supplied observation records ref ${quote(fact.observedRef)} at commit ${fact.commitSha}.`,
      });
    case "TEST_RUN":
      return Object.freeze({
        title: TITLES.TEST_RUN,
        body: `For repository ${repository} at commit ${fact.commitSha}, the supplied observation records command ${quote(fact.command)} with exit code ${fact.exitCode}; ${fact.testFileCount} test files / ${fact.testCount} tests / ${fact.passedTestCount} passed / ${fact.failedTestCount} failed.`,
      });
    case "DIFF_FILE_SET": {
      const fileCount = renderChangedFileCount(fact.changedFiles.length);
      const fileList = fact.changedFiles.map(quote).join(", ");
      return Object.freeze({
        title: TITLES.DIFF_FILE_SET,
        body: `For repository ${repository}, between commits ${fact.baseCommitSha} and ${fact.headCommitSha}, the supplied observation records ${fileCount}${fileList === "" ? "." : `: ${fileList}.`}`,
      });
    }
    case "RUNTIME_TOOLCHAIN": {
      const components = fact.components
        .map(({ name, version }) => `${quote(name)} ${quote(version)}`)
        .join(", ");
      return Object.freeze({
        title: TITLES.RUNTIME_TOOLCHAIN,
        body: `For repository ${repository} at commit ${fact.commitSha}, the supplied observation records${components === "" ? " no runtime/toolchain components." : ` runtime/toolchain components: ${components}.`}`,
      });
    }
  }
};

/**
 * Serialized DATA shape only. Aggregate rendering limits preserve lossless
 * composability with the accepted S2D2 title/body contract; they establish no
 * observation authenticity or verification authority.
 */
export const DeterministicEngineeringFactDataSchema =
  DeterministicEngineeringFactBaseDataSchema.superRefine((fact, context) => {
    const conclusion = renderCanonicalFact(fact);
    if (conclusion.title.length > PROMOTED_CONTEXT_TITLE_MAX_LENGTH) {
      context.addIssue({
        code: "custom",
        message: "The canonical fact title exceeds the Promoted Context limit",
      });
    }
    if (conclusion.body.length > PROMOTED_CONTEXT_BODY_MAX_LENGTH) {
      context.addIssue({
        code: "custom",
        message: "The canonical fact body exceeds the Promoted Context limit",
      });
    }
  });

export type DeterministicEngineeringFactData = z.infer<
  typeof DeterministicEngineeringFactDataSchema
>;

const parseCapturedFact = (
  input: unknown,
): DeterministicEngineeringFactData | null => {
  try {
    const parsed = DeterministicEngineeringFactDataSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Renders structurally valid typed DATA with fixed observation-only templates.
 * Invalid or unstable runtime inputs fail closed with `null`. Rendering does
 * not verify evidence, establish authority, route context, or accept it.
 */
export const renderDeterministicEngineeringFact = (
  input: DeterministicEngineeringFactData,
): DeterministicEngineeringFactConclusion | null => {
  try {
    const captured = captureJointlyStableStructuralDataList([input]);
    if (!captured.stable[0] || !captured.jointlyConsistent) {
      return null;
    }

    const fact = parseCapturedFact(captured.data[0]);
    if (fact === null) {
      return null;
    }

    return renderCanonicalFact(fact);
  } catch {
    return null;
  }
};
