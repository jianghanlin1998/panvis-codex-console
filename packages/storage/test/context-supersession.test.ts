import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ContextItemIdSchema, ContextScopeSchema } from "@codex-task-console/domain";
import type {
  ContextItem,
  ContextScope,
  ContextStatus,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeBigTask,
  makeContextItem,
  makeProject,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const projectScope = (projectId = "prj_console"): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "PROJECT", projectId });

const bigTaskScope = (
  projectId = "prj_console",
  bigTaskId = "bt_v1",
): ContextScope => ContextScopeSchema.parse({ scopeType: "BIG_TASK", projectId, bigTaskId });

const subtaskScope = (
  projectId = "prj_console",
  bigTaskId = "bt_v1",
  subtaskId = "st_a",
): ContextScope =>
  ContextScopeSchema.parse({ scopeType: "SUBTASK", projectId, bigTaskId, subtaskId });

const expectMalformedStoredData = (operation: () => unknown): void => {
  expect(captureTaskStorageError(operation)).toMatchObject({
    code: "MALFORMED_STORED_DATA",
    message: "Stored task data is malformed.",
  });
};

const snapshotContextRows = (databasePath: string): readonly unknown[] => {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite.prepare("SELECT * FROM context_items ORDER BY id").all();
  } finally {
    sqlite.close();
  }
};

const createScopeHierarchy = (storage: TaskStorage, scope: ContextScope): void => {
  storage.createProject(
    makeProject(scope.projectId, scope.projectId.replaceAll("_", "-")),
  );
  if (scope.scopeType === "PROJECT") {
    return;
  }
  storage.createBigTask(makeBigTask(scope.bigTaskId, scope.projectId));
  if (scope.scopeType === "SUBTASK") {
    storage.createSubtask(makeSubtask(scope.subtaskId, scope.bigTaskId));
  }
};

const createContextChain = (
  storage: TaskStorage,
  idPrefix: string,
  scope: ContextScope,
  length: number,
): readonly ContextItem[] => {
  const created: ContextItem[] = [];
  let current = makeContextItem(`${idPrefix}_0`, scope, {
    effectiveAt: "2026-08-09T00:00:00.000Z",
  });
  storage.createContextItem(current);
  created.push(current);

  for (let index = 1; index < length; index += 1) {
    current = makeContextItem(`${idPrefix}_${index}`, scope, {
      effectiveAt: `2026-08-09T00:${String(index).padStart(2, "0")}:00.000Z`,
      supersedesContextItemId: current.id,
    });
    storage.supersedeContextItem(current);
    created.push(current);
  }

  return created.map((item, index) =>
    index === created.length - 1 ? item : { ...item, status: "SUPERSEDED" },
  );
};

describe("atomic Context Item supersession", () => {
  it("supersedes one ACTIVE item while preserving its historical evidence", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior", bigTaskScope(), {
        title: "Original title",
        body: "Original body",
      });
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
        title: "Replacement title",
      });

      expect(storage.supersedeContextItem(replacement)).toEqual(replacement);
      expect(storage.getContextItemById(replacement.id)).toEqual(replacement);
      expect(storage.getContextItemById(prior.id)).toEqual({
        ...prior,
        status: "SUPERSEDED",
      });
      expect(storage.getContextItemById(prior.id)).toMatchObject({
        title: "Original title",
        body: "Original body",
        authority: prior.authority,
        provenance: prior.provenance,
      });
    });
  });

  it("updates only the prior status and updated_at timestamp", () => {
    withTemporaryDatabasePath((databasePath) => {
      let currentTime = "2026-08-09T00:00:00.000Z";
      const storage = openTaskDatabase({
        databasePath,
        clock: () => new Date(currentTime),
      });
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      currentTime = "2026-08-09T01:00:00.000Z";
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });
      storage.supersedeContextItem(replacement);
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const priorRow = sqlite
          .prepare(
            "SELECT status, title, body, source_reference, effective_at, created_at, updated_at FROM context_items WHERE id = ?",
          )
          .get(prior.id);
        expect(priorRow).toEqual({
          status: "SUPERSEDED",
          title: prior.title,
          body: prior.body,
          source_reference: prior.provenance.sourceReference,
          effective_at: prior.provenance.effectiveAt,
          created_at: "2026-08-09T00:00:00.000Z",
          updated_at: "2026-08-09T01:00:00.000Z",
        });
      } finally {
        sqlite.close();
      }
    });
  });

  it("requires an ACTIVE replacement with an explicit prior pointer", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const proposedReplacement = makeContextItem("ctx_proposed", bigTaskScope(), {
        status: "PROPOSED",
        supersedesContextItemId: prior.id,
      });
      const missingPointer = makeContextItem("ctx_missing_pointer");

      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(proposedReplacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(missingPointer)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(prior.id)?.status).toBe("ACTIVE");
    });
  });

  it("rejects a missing prior item", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: ContextItemIdSchema.parse("ctx_missing"),
      });
      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
      ).toMatchObject({ code: "PARENT_NOT_FOUND" });
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it("rejects self-supersession", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const replacement = makeContextItem("ctx_self", bigTaskScope(), {
        supersedesContextItemId: ContextItemIdSchema.parse("ctx_self"),
      });
      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it.each([
    ["Project", projectScope("prj_a"), projectScope("prj_b")],
    ["Big Task", bigTaskScope("prj_a", "bt_a"), bigTaskScope("prj_a", "bt_other")],
    [
      "Subtask",
      subtaskScope("prj_a", "bt_a", "st_a"),
      subtaskScope("prj_a", "bt_other", "st_other"),
    ],
  ] as const)("rejects cross-%s supersession", (_label, priorScope, replacementScope) => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "project-a"));
      storage.createProject(makeProject("prj_b", "project-b"));
      storage.createBigTask(makeBigTask("bt_a", "prj_a"));
      storage.createBigTask(makeBigTask("bt_other", "prj_a"));
      storage.createSubtask(makeSubtask("st_a", "bt_a"));
      storage.createSubtask(makeSubtask("st_other", "bt_other"));
      const prior = makeContextItem("ctx_prior", priorScope);
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", replacementScope, {
        supersedesContextItemId: prior.id,
      });

      expect(
        captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getContextItemById(prior.id)?.status).toBe("ACTIVE");
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it.each(["PROPOSED", "REJECTED", "RESOLVED", "SUPERSEDED"] as const)(
    "does not supersede a %s prior item",
    (status: ContextStatus) => {
      withMemoryStorage((storage) => {
        createHierarchy(storage);
        const prior = makeContextItem("ctx_prior", bigTaskScope(), { status });
        storage.createContextItem(prior);
        const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
          supersedesContextItemId: prior.id,
        });

        expect(
          captureTaskStorageError(() => storage.supersedeContextItem(replacement)),
        ).toMatchObject({ code: "CONFLICT" });
        expect(storage.getContextItemById(prior.id)?.status).toBe(status);
        expect(storage.getContextItemById(replacement.id)).toBeNull();
      });
    },
  );

  it("prevents a prior item from branching to two replacements", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });
      storage.supersedeContextItem(replacement);
      const branch = makeContextItem("ctx_branch", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });

      expect(captureTaskStorageError(() => storage.supersedeContextItem(branch))).toMatchObject({
        code: "CONFLICT",
      });
      expect(storage.getContextItemById(branch.id)).toBeNull();
      expect(storage.listContextItemsByScope(bigTaskScope()).map(({ id }) => id)).toEqual([
        "ctx_prior",
        "ctx_replacement",
      ]);
    });
  });

  it("rolls back both supersession mutations when the transaction fails", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const prior = makeContextItem("ctx_prior");
      storage.createContextItem(prior);
      const replacement = makeContextItem("ctx_replacement", bigTaskScope(), {
        supersedesContextItemId: prior.id,
      });

      expect(
        captureTaskStorageError(() =>
          storage.runInTransaction((transaction) => {
            transaction.supersedeContextItem(replacement);
            throw new Error("private transaction failure");
          }),
        ),
      ).toMatchObject({ code: "TRANSACTION_FAILED" });
      expect(storage.getContextItemById(prior.id)).toEqual(prior);
      expect(storage.getContextItemById(replacement.id)).toBeNull();
    });
  });

  it("preserves an A to B to C supersession chain", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const a = makeContextItem("ctx_a");
      storage.createContextItem(a);
      const b = makeContextItem("ctx_b", bigTaskScope(), {
        supersedesContextItemId: a.id,
      });
      storage.supersedeContextItem(b);
      const c = makeContextItem("ctx_c", bigTaskScope(), {
        supersedesContextItemId: b.id,
      });
      storage.supersedeContextItem(c);

      expect(storage.getContextItemById(a.id)).toEqual({ ...a, status: "SUPERSEDED" });
      expect(storage.getContextItemById(b.id)).toEqual({ ...b, status: "SUPERSEDED" });
      expect(storage.getContextItemById(c.id)).toEqual(c);
    });
  });
});

describe("stored Context Item supersession read integrity", () => {
  it("fails closed on a historical cross-scope pointer without poisoning the foreign scope", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scopeA = bigTaskScope("prj_edge_a", "bt_edge_a");
      const scopeB = bigTaskScope("prj_edge_b", "bt_edge_b");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, scopeA);
      createScopeHierarchy(storage, scopeB);
      const [prior, replacement] = createContextChain(
        storage,
        "ctx_edge_a",
        scopeA,
        2,
      );
      const foreignPrior = makeContextItem("ctx_edge_b_foreign", scopeB, {
        status: "SUPERSEDED",
      });
      const unrelated = makeContextItem("ctx_edge_b_unrelated", scopeB);
      storage.createContextItem(foreignPrior);
      storage.createContextItem(unrelated);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
        )
        .run(foreignPrior.id, replacement!.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        const byIdError = captureTaskStorageError(() =>
          reopened.getContextItemById(replacement!.id),
        );
        expect(byIdError).toMatchObject({
          code: "MALFORMED_STORED_DATA",
          message: "Stored task data is malformed.",
        });
        expect(byIdError.message).not.toMatch(
          /ctx_edge|prj_edge|bt_edge|SQLite|SQL|context_items|supersedes_context_item_id|\/Users\//i,
        );
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scopeA));
        expectMalformedStoredData(() =>
          reopened.getContextItemById(foreignPrior.id),
        );
        expect(reopened.getContextItemById(unrelated.id)).toEqual(unrelated);
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scopeB));
        expect(prior!.status).toBe("SUPERSEDED");
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });

  it("fails closed when a replacement predecessor is missing after reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("prj_missing_edge", "bt_missing_edge", "st_missing_edge");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, scope);
      const [prior, replacement] = createContextChain(
        storage,
        "ctx_missing_edge",
        scope,
        2,
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.prepare("DELETE FROM context_items WHERE id = ?").run(prior!.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformedStoredData(() =>
          reopened.getContextItemById(replacement!.id),
        );
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });

  it("fails closed when only the predecessor hierarchy is corrupted", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("prj_hierarchy", "bt_hierarchy_a", "st_hierarchy_a");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      storage.createProject(makeProject(scope.projectId, "project-hierarchy-edge"));
      storage.createBigTask(makeBigTask("bt_hierarchy_a", scope.projectId));
      storage.createBigTask(makeBigTask("bt_hierarchy_b", scope.projectId));
      storage.createSubtask(makeSubtask("st_hierarchy_a", "bt_hierarchy_a"));
      storage.createSubtask(makeSubtask("st_hierarchy_b", "bt_hierarchy_b"));
      const [prior, replacement] = createContextChain(
        storage,
        "ctx_hierarchy_edge",
        scope,
        2,
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET subtask_id = ? WHERE id = ?")
        .run("st_hierarchy_b", prior!.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformedStoredData(() =>
          reopened.getContextItemById(replacement!.id),
        );
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });

  it.each(["ACTIVE", "PROPOSED", "REJECTED", "RESOLVED"] as const)(
    "fails both predecessor and successor reads when the prior status is %s",
    (status) => {
      withTemporaryDatabasePath((databasePath) => {
        const scope = bigTaskScope(
          `prj_prior_${status.toLowerCase()}`,
          `bt_prior_${status.toLowerCase()}`,
        );
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        createScopeHierarchy(storage, scope);
        const [prior, replacement] = createContextChain(
          storage,
          `ctx_prior_${status.toLowerCase()}`,
          scope,
          2,
        );
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite
          .prepare("UPDATE context_items SET status = ? WHERE id = ?")
          .run(status, prior!.id);
        sqlite.close();
        const corruptedRows = snapshotContextRows(databasePath);

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformedStoredData(() =>
            reopened.getContextItemById(prior!.id),
          );
          expectMalformedStoredData(() =>
            reopened.getContextItemById(replacement!.id),
          );
          expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
        } finally {
          reopened.close();
        }
        expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
      });
    },
  );

  it.each(["PROPOSED", "REJECTED", "RESOLVED"] as const)(
    "fails both sides of an edge when the pointer-bearing status is %s",
    (status) => {
      withTemporaryDatabasePath((databasePath) => {
        const scope = projectScope(`prj_current_${status.toLowerCase()}`);
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        createScopeHierarchy(storage, scope);
        const [prior, replacement] = createContextChain(
          storage,
          `ctx_current_${status.toLowerCase()}`,
          scope,
          2,
        );
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite
          .prepare("UPDATE context_items SET status = ? WHERE id = ?")
          .run(status, replacement!.id);
        sqlite.close();
        const corruptedRows = snapshotContextRows(databasePath);

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformedStoredData(() =>
            reopened.getContextItemById(replacement!.id),
          );
          expectMalformedStoredData(() =>
            reopened.getContextItemById(prior!.id),
          );
          expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
        } finally {
          reopened.close();
        }
        expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
      });
    },
  );

  it.each([
    ["predecessor", 0, 1],
    ["successor", 1, 0],
  ] as const)(
    "fails closed when the %s is structurally malformed",
    (_label, corruptIndex, readIndex) => {
      withTemporaryDatabasePath((databasePath) => {
        const scope = projectScope(`prj_structural_${corruptIndex}`);
        const storage = openTaskDatabase({ databasePath, clock: fixedClock });
        createScopeHierarchy(storage, scope);
        const chain = createContextChain(
          storage,
          `ctx_structural_${corruptIndex}`,
          scope,
          2,
        );
        storage.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite
          .prepare("UPDATE context_items SET effective_at = ? WHERE id = ?")
          .run("private-invalid-effective-time", chain[corruptIndex]!.id);
        sqlite.close();
        const corruptedRows = snapshotContextRows(databasePath);

        const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
        try {
          expectMalformedStoredData(() =>
            reopened.getContextItemById(chain[readIndex]!.id),
          );
          expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
        } finally {
          reopened.close();
        }
        expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
      });
    },
  );

  it("detects a two-node cycle from every public read path", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = bigTaskScope("prj_cycle_two", "bt_cycle_two");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, scope);
      const a = makeContextItem("ctx_cycle_two_a", scope, { status: "SUPERSEDED" });
      const b = makeContextItem("ctx_cycle_two_b", scope, { status: "SUPERSEDED" });
      storage.createContextItem(b);
      storage.createContextItem(a);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      const setPointer = sqlite.prepare(
        "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
      );
      setPointer.run(b.id, a.id);
      setPointer.run(a.id, b.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformedStoredData(() => reopened.getContextItemById(a.id));
        expectMalformedStoredData(() => reopened.getContextItemById(b.id));
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });

  it("detects a three-node cycle from every node and the exact-scope list", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = subtaskScope("prj_cycle_three", "bt_cycle_three", "st_cycle_three");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, scope);
      const nodes = ["c", "a", "b"].map((suffix) =>
        makeContextItem(`ctx_cycle_three_${suffix}`, scope, {
          status: "SUPERSEDED",
        }),
      );
      nodes.forEach((node) => storage.createContextItem(node));
      storage.close();

      const bySuffix = new Map(
        nodes.map((node) => [node.id.at(-1), node] as const),
      );
      const sqlite = new DatabaseSync(databasePath);
      const setPointer = sqlite.prepare(
        "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
      );
      setPointer.run(bySuffix.get("b")!.id, bySuffix.get("a")!.id);
      setPointer.run(bySuffix.get("c")!.id, bySuffix.get("b")!.id);
      setPointer.run(bySuffix.get("a")!.id, bySuffix.get("c")!.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        nodes.forEach((node) => {
          expectMalformedStoredData(() => reopened.getContextItemById(node.id));
        });
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scope));
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });

  it("fails a dependent tip when a middle predecessor crosses exact scopes", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scopeA = projectScope("prj_middle_a");
      const scopeB = projectScope("prj_middle_b");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, scopeA);
      createScopeHierarchy(storage, scopeB);
      const chain = createContextChain(storage, "ctx_middle_a", scopeA, 3);
      const foreignPrior = makeContextItem("ctx_middle_b", scopeB, {
        status: "SUPERSEDED",
      });
      storage.createContextItem(foreignPrior);
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare(
          "UPDATE context_items SET supersedes_context_item_id = ? WHERE id = ?",
        )
        .run(foreignPrior.id, chain[1]!.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectMalformedStoredData(() =>
          reopened.getContextItemById(chain[2]!.id),
        );
        expectMalformedStoredData(() =>
          reopened.getContextItemById(chain[1]!.id),
        );
        expectMalformedStoredData(() => reopened.listContextItemsByScope(scopeA));
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });

  it("preserves valid chain lengths 1, 2, 3, and 10 at every exact scope after reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const cases: readonly {
        readonly scope: ContextScope;
        readonly length: number;
        readonly prefix: string;
      }[] = ["PROJECT", "BIG_TASK", "SUBTASK"].flatMap((scopeType) =>
        [1, 2, 3, 10].map((length) => {
          const suffix = `${scopeType.toLowerCase()}_${length}`;
          const projectId = `prj_chain_${suffix}`;
          const scope =
            scopeType === "PROJECT"
              ? projectScope(projectId)
              : scopeType === "BIG_TASK"
                ? bigTaskScope(projectId, `bt_chain_${suffix}`)
                : subtaskScope(
                    projectId,
                    `bt_chain_${suffix}`,
                    `st_chain_${suffix}`,
                  );
          return { scope, length, prefix: `ctx_chain_${suffix}` };
        }),
      );
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const expected = cases.map(({ scope, length, prefix }) => {
        createScopeHierarchy(storage, scope);
        return {
          scope,
          items: createContextChain(storage, prefix, scope, length),
        };
      });
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expected.forEach(({ scope, items }) => {
          expect(reopened.listContextItemsByScope(scope)).toEqual(items);
          items.forEach((item) => {
            expect(reopened.getContextItemById(item.id)).toEqual(item);
          });
        });
      } finally {
        reopened.close();
      }
    });
  });

  it("keeps every standalone status valid without requiring a successor", () => {
    withTemporaryDatabasePath((databasePath) => {
      const scope = projectScope("prj_standalone_statuses");
      const statuses = [
        "PROPOSED",
        "ACTIVE",
        "SUPERSEDED",
        "REJECTED",
        "RESOLVED",
      ] as const;
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, scope);
      const standalone = statuses.map((status, index) =>
        makeContextItem(`ctx_standalone_${status.toLowerCase()}`, scope, {
          status,
          effectiveAt: `2026-08-09T01:0${index}:00.000Z`,
        }),
      );
      standalone.forEach((item) => storage.createContextItem(item));
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.listContextItemsByScope(scope)).toEqual(standalone);
        standalone.forEach((item) => {
          expect(reopened.getContextItemById(item.id)).toEqual(item);
        });
      } finally {
        reopened.close();
      }
    });
  });

  it("isolates a valid exact scope from a separate corrupt supersession chain", () => {
    withTemporaryDatabasePath((databasePath) => {
      const validScope = projectScope("prj_isolated_valid");
      const corruptScope = bigTaskScope("prj_isolated_bad", "bt_isolated_bad");
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createScopeHierarchy(storage, validScope);
      createScopeHierarchy(storage, corruptScope);
      const valid = makeContextItem("ctx_isolated_valid", validScope, {
        status: "SUPERSEDED",
      });
      storage.createContextItem(valid);
      const [corruptPrior] = createContextChain(
        storage,
        "ctx_isolated_bad",
        corruptScope,
        2,
      );
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite
        .prepare("UPDATE context_items SET status = ? WHERE id = ?")
        .run("ACTIVE", corruptPrior!.id);
      sqlite.close();
      const corruptedRows = snapshotContextRows(databasePath);

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getContextItemById(valid.id)).toEqual(valid);
        expect(reopened.listContextItemsByScope(validScope)).toEqual([valid]);
        expectMalformedStoredData(() =>
          reopened.listContextItemsByScope(corruptScope),
        );
      } finally {
        reopened.close();
      }
      expect(snapshotContextRows(databasePath)).toEqual(corruptedRows);
    });
  });
});
