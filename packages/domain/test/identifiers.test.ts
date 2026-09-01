import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  AuditEventIdSchema,
  BigTaskIdSchema,
  ChatThreadIdSchema,
  ContextDigestIdSchema,
  ContextItemIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProjectIdSchema,
  ProviderModelIdSchema,
  ProviderRunIdSchema,
  ProviderThreadIdSchema,
  RepositoryCommitShaSchema,
  SubtaskIdSchema,
  SubtaskImplementationCheckpointIdSchema,
  WorktreeOwnershipIdSchema,
} from "../src/index.js";

interface PrefixedIdentifierCase {
  readonly name: string;
  readonly prefix: string;
  readonly schema: ZodType<string>;
}

const prefixedIdentifierCases: readonly PrefixedIdentifierCase[] = [
  { name: "ProjectId", prefix: "prj", schema: ProjectIdSchema },
  { name: "BigTaskId", prefix: "bt", schema: BigTaskIdSchema },
  { name: "SubtaskId", prefix: "st", schema: SubtaskIdSchema },
  { name: "ChatThreadId", prefix: "thr", schema: ChatThreadIdSchema },
  { name: "ExecutionRunId", prefix: "run", schema: ExecutionRunIdSchema },
  { name: "ContextItemId", prefix: "ctx", schema: ContextItemIdSchema },
  { name: "ContextDigestId", prefix: "dgt", schema: ContextDigestIdSchema },
  { name: "AuditEventId", prefix: "aud", schema: AuditEventIdSchema },
  {
    name: "SubtaskImplementationCheckpointId",
    prefix: "icp",
    schema: SubtaskImplementationCheckpointIdSchema,
  },
];

const providerIdentifierCases = [
  { name: "ProviderThreadId", schema: ProviderThreadIdSchema },
  { name: "ProviderRunId", schema: ProviderRunIdSchema },
  { name: "ProviderModelId", schema: ProviderModelIdSchema },
] as const;

const malformedSuffixes = [
  "\ud800",
  "\udc00",
  "\ud800x",
  "x\udc00",
  "before\ud800after",
  `paired\ud83d\ude00\ud800`,
] as const;

const validSuffixes = [
  "hello",
  "中文任务",
  "日本語",
  "café",
  "cafe\u0301",
  "alpha%2Fbeta",
  "\ud83d\ude00",
] as const;

describe.each(prefixedIdentifierCases)("$name well-formed Unicode contract", ({ prefix, schema }) => {
  it.each(malformedSuffixes)("rejects malformed UTF-16 %#", (suffix) => {
    expect(schema.safeParse(`${prefix}_${suffix}`).success).toBe(false);
  });

  it.each(validSuffixes)("accepts valid Unicode %# without normalization", (suffix) => {
    const value = `${prefix}_${suffix}`;
    expect(schema.parse(value)).toBe(value);
  });

  it("preserves prefix, trim, and UTF-16 code-unit length semantics", () => {
    const maximum = `${prefix}_${"x".repeat(128 - prefix.length - 1)}`;
    expect(schema.parse(maximum)).toBe(maximum);
    expect(maximum).toHaveLength(128);
    expect(schema.safeParse(`${maximum}x`).success).toBe(false);
    expect(schema.parse(` ${prefix}_trimmed `)).toBe(`${prefix}_trimmed`);
    expect(schema.safeParse(`${prefix}_`).success).toBe(false);
    expect(schema.safeParse(`wrong_value`).success).toBe(false);
  });
});

describe.each(providerIdentifierCases)("$name well-formed Unicode contract", ({ schema }) => {
  it.each(malformedSuffixes)("rejects malformed UTF-16 %#", (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each(validSuffixes)("accepts valid Unicode %# without normalization", (value) => {
    expect(schema.parse(value)).toBe(value);
  });

  it("preserves exact trim and UTF-16 code-unit length semantics", () => {
    expect(schema.parse("x")).toBe("x");
    expect(schema.parse("x".repeat(512))).toHaveLength(512);
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("x".repeat(513)).success).toBe(false);
    expect(schema.safeParse(" surrounded ").success).toBe(false);
    expect(schema.safeParse("\ud83d\ude00".repeat(256)).success).toBe(true);
    expect(schema.safeParse(`${"\ud83d\ude00".repeat(256)}x`).success).toBe(false);
  });
});

describe("canonical identifier sequence identity", () => {
  it("keeps composed and decomposed valid Unicode identifiers distinct", () => {
    const composed = SubtaskIdSchema.parse("st_café");
    const decomposed = SubtaskIdSchema.parse("st_cafe\u0301");

    expect(composed).toBe("st_café");
    expect(decomposed).toBe("st_cafe\u0301");
    expect(composed).not.toBe(decomposed);
  });

  it("leaves narrower ASCII-safe identifier grammars unchanged", () => {
    expect(ExecutionProviderIdSchema.parse("provider-alpha")).toBe("provider-alpha");
    expect(WorktreeOwnershipIdSchema.parse(`wt_${"a".repeat(32)}`)).toBe(
      `wt_${"a".repeat(32)}`,
    );
    expect(RepositoryCommitShaSchema.parse("b".repeat(40))).toBe("b".repeat(40));

    expect(ExecutionProviderIdSchema.safeParse("provider-😀").success).toBe(false);
    expect(WorktreeOwnershipIdSchema.safeParse(`wt_${"😀".repeat(16)}`).success).toBe(
      false,
    );
    expect(RepositoryCommitShaSchema.safeParse("😀".repeat(20)).success).toBe(false);
  });
});
