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
  .max(Number.MAX_SAFE_INTEGER);

const safeInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

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
export const DeterministicEngineeringFactDataSchema = z.discriminatedUnion(
  "factType",
  [
    RepositoryCommitFactSchema,
    TestRunFactSchema,
    DiffFileSetFactSchema,
    RuntimeToolchainFactSchema,
  ],
);

export type DeterministicEngineeringFactData = z.infer<
  typeof DeterministicEngineeringFactDataSchema
>;

export type DeterministicEngineeringFactConclusion = Readonly<{
  title: string;
  body: string;
}>;

const quote = (value: string): string => JSON.stringify(value);

const renderRepository = (repository: RepositoryReference): string =>
  repository.kind === "PATH"
    ? `PATH ${quote(repository.path)}`
    : `REFERENCE ${quote(repository.reference)}`;

const renderChangedFileCount = (count: number): string =>
  `${count} changed ${count === 1 ? "file" : "files"}`;

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

    const repository = renderRepository(fact.repository);
    switch (fact.factType) {
      case "REPOSITORY_COMMIT":
        return Object.freeze({
          title: "Repository commit observation",
          body: `For repository ${repository}, verification observed ref ${quote(fact.observedRef)} at commit ${fact.commitSha}.`,
        });
      case "TEST_RUN":
        return Object.freeze({
          title: "Deterministic test-run observation",
          body: `For repository ${repository} at commit ${fact.commitSha}, command ${quote(fact.command)} completed with exit code ${fact.exitCode}; ${fact.testFileCount} test files / ${fact.testCount} tests / ${fact.passedTestCount} passed / ${fact.failedTestCount} failed.`,
        });
      case "DIFF_FILE_SET": {
        const fileCount = renderChangedFileCount(fact.changedFiles.length);
        const fileList = fact.changedFiles.map(quote).join(", ");
        return Object.freeze({
          title: "Deterministic diff file-set observation",
          body: `For repository ${repository}, between commits ${fact.baseCommitSha} and ${fact.headCommitSha}, the deterministic diff reported ${fileCount}${fileList === "" ? "." : `: ${fileList}.`}`,
        });
      }
      case "RUNTIME_TOOLCHAIN": {
        const components = fact.components
          .map(({ name, version }) => `${quote(name)} ${quote(version)}`)
          .join(", ");
        return Object.freeze({
          title: "Runtime toolchain observation",
          body: `For repository ${repository} at commit ${fact.commitSha}, the runtime probe reported${components === "" ? " no runtime/toolchain components." : `: ${components}.`}`,
        });
      }
    }
  } catch {
    return null;
  }
};
