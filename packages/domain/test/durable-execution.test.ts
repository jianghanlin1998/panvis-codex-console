import { describe, expect, it } from "vitest";

import {
  ChatThreadSchema,
  ExecutionRunSchema,
  NormalizedUsageSchema,
} from "../src/index.js";

const CREATED_AT = "2026-08-30T01:00:00.000Z";
const STARTED_AT = "2026-08-30T01:00:01.000Z";
const ENDED_AT = "2026-08-30T01:00:02.000Z";

const openThread = {
  id: "thr_console",
  subtaskId: "st_a",
  providerId: "codex-app-server",
  providerThread: null,
  status: "OPEN",
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  closedAt: null,
} as const;

const providerRun = {
  providerId: "codex-app-server",
  providerThreadId: "provider-thread-1",
  providerRunId: "provider-run-1",
} as const;

const createdRun = {
  id: "run_console",
  chatThreadId: "thr_console",
  status: "CREATED",
  providerRun: null,
  providerModel: null,
  normalizedUsage: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  startedAt: null,
  endedAt: null,
} as const;

describe("durable ChatThread contract", () => {
  it("accepts open, bound, and closed lifecycle states", () => {
    expect(ChatThreadSchema.parse(openThread)).toEqual(openThread);
    const bound = {
      ...openThread,
      providerThread: {
        providerId: "codex-app-server",
        providerThreadId: "provider-thread-1",
      },
      updatedAt: STARTED_AT,
    };
    expect(ChatThreadSchema.parse(bound)).toEqual(bound);
    expect(
      ChatThreadSchema.parse({
        ...bound,
        status: "CLOSED",
        updatedAt: ENDED_AT,
        closedAt: ENDED_AT,
      }),
    ).toMatchObject({ status: "CLOSED", closedAt: ENDED_AT });
  });

  it.each(["CREATED", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED"])(
    "rejects invalid thread status %s",
    (status) => {
      expect(ChatThreadSchema.safeParse({ ...openThread, status }).success).toBe(false);
    },
  );

  it("rejects lifecycle timestamps and provider mismatch", () => {
    expect(
      ChatThreadSchema.safeParse({ ...openThread, status: "CLOSED" }).success,
    ).toBe(false);
    expect(
      ChatThreadSchema.safeParse({ ...openThread, closedAt: ENDED_AT }).success,
    ).toBe(false);
    expect(
      ChatThreadSchema.safeParse({
        ...openThread,
        providerThread: {
          providerId: "other-provider",
          providerThreadId: "provider-thread-1",
        },
      }).success,
    ).toBe(false);
  });
});

describe("durable ExecutionRun contract", () => {
  it("accepts created, running, pre-start failed, and all started terminal states", () => {
    expect(ExecutionRunSchema.parse(createdRun)).toEqual(createdRun);
    const running = {
      ...createdRun,
      status: "RUNNING",
      providerRun,
      providerModel: {
        providerId: "codex-app-server",
        providerModelId: "provider-model-1",
      },
      updatedAt: STARTED_AT,
      startedAt: STARTED_AT,
    } as const;
    expect(ExecutionRunSchema.parse(running)).toEqual(running);
    expect(
      ExecutionRunSchema.parse({
        ...createdRun,
        status: "FAILED",
        updatedAt: ENDED_AT,
        endedAt: ENDED_AT,
      }),
    ).toMatchObject({ status: "FAILED", startedAt: null });
    for (const status of ["SUCCEEDED", "FAILED", "INTERRUPTED"] as const) {
      expect(
        ExecutionRunSchema.parse({
          ...running,
          status,
          normalizedUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          updatedAt: ENDED_AT,
          endedAt: ENDED_AT,
        }),
      ).toMatchObject({ status, endedAt: ENDED_AT });
    }
  });

  it.each(["OPEN", "CLOSED", "CANCELLED", "DONE"])(
    "rejects invalid run status %s",
    (status) => {
      expect(ExecutionRunSchema.safeParse({ ...createdRun, status }).success).toBe(false);
    },
  );

  it("rejects impossible lifecycle timestamp and null combinations", () => {
    expect(
      ExecutionRunSchema.safeParse({ ...createdRun, status: "SUCCEEDED" }).success,
    ).toBe(false);
    expect(
      ExecutionRunSchema.safeParse({
        ...createdRun,
        status: "RUNNING",
        providerRun,
        updatedAt: STARTED_AT,
        startedAt: null,
      }).success,
    ).toBe(false);
    expect(
      ExecutionRunSchema.safeParse({
        ...createdRun,
        status: "RUNNING",
        providerRun,
        updatedAt: CREATED_AT,
        startedAt: STARTED_AT,
      }).success,
    ).toBe(false);
  });

  it("rejects mismatched provider references", () => {
    expect(
      ExecutionRunSchema.safeParse({
        ...createdRun,
        status: "RUNNING",
        providerRun,
        providerModel: {
          providerId: "other-provider",
          providerModelId: "provider-model-1",
        },
        updatedAt: STARTED_AT,
        startedAt: STARTED_AT,
      }).success,
    ).toBe(false);
  });

  it("continues to enforce NormalizedUsage", () => {
    expect(
      NormalizedUsageSchema.safeParse({
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 6,
      }).success,
    ).toBe(false);
    expect(
      ExecutionRunSchema.safeParse({
        ...createdRun,
        status: "FAILED",
        normalizedUsage: { inputTokens: -1 },
        updatedAt: ENDED_AT,
        endedAt: ENDED_AT,
      }).success,
    ).toBe(false);
  });
});
