import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateWriteTurnNotificationSequenceForTest } from "../src/live-execution.js";

const roots: string[] = [];
const correlation = { threadId: "thread-test", turnId: "turn-test" };

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("write-tool notification lifecycle", () => {
  it("accepts correlated command and file-change lifecycles", () => {
    const root = fixtureRoot();
    expect(() =>
      validateWriteTurnNotificationSequenceForTest(root, [
        started(commandItem(root, "command-1", "inProgress")),
        output("command-1", "item/commandExecution/outputDelta"),
        completed(commandItem(root, "command-1", "completed")),
        started(fileItem("file-1", "inProgress")),
        output("file-1", "item/fileChange/outputDelta"),
        patch("file-1", [{ path: "safe file.txt", diff: "value", kind: { type: "add" } }]),
        completed(fileItem("file-1", "completed")),
        terminal(),
      ]),
    ).not.toThrow();
  });

  it.each([
    ["completion without start", (root: string) => [completed(commandItem(root, "id", "completed"))]],
    ["output before start", () => [output("id", "item/commandExecution/outputDelta")]],
    ["patch before start", () => [patch("id", [])]],
    ["wrong type for item id", (root: string) => [started(commandItem(root, "id", "inProgress")), completed(fileItem("id", "completed"))]],
    ["duplicate start", (root: string) => [started(commandItem(root, "id", "inProgress")), started(commandItem(root, "id", "inProgress"))]],
    ["duplicate completion", (root: string) => [started(commandItem(root, "id", "inProgress")), completed(commandItem(root, "id", "completed")), completed(commandItem(root, "id", "completed"))]],
    ["output after completion", (root: string) => [started(commandItem(root, "id", "inProgress")), completed(commandItem(root, "id", "completed")), output("id", "item/commandExecution/outputDelta")]],
    ["terminal status at start", (root: string) => [started(commandItem(root, "id", "completed"))]],
    ["in-progress status at completion", (root: string) => [started(commandItem(root, "id", "inProgress")), completed(commandItem(root, "id", "inProgress"))]],
    ["terminal with active item", (root: string) => [started(commandItem(root, "id", "inProgress")), terminal()]],
    ["malformed command action", (root: string) => [started({ ...commandItem(root, "id", "inProgress"), commandActions: [{ type: "execute", command: "bad" }] })]],
    ["malformed file change", () => [started({ ...fileItem("id", "inProgress"), changes: [{ path: "../escape", diff: "bad", kind: { type: "add" } }] })]],
    ["mismatched thread", (root: string) => [{ ...started(commandItem(root, "id", "inProgress")), params: { ...started(commandItem(root, "id", "inProgress")).params, threadId: "other" } }]],
    ["mismatched turn", (root: string) => [{ ...started(commandItem(root, "id", "inProgress")), params: { ...started(commandItem(root, "id", "inProgress")).params, turnId: "other" } }]],
    ["tool after terminal", (root: string) => [terminal(), started(commandItem(root, "id", "inProgress"))]],
  ] as const)("rejects %s", (_name, build) => {
    const root = fixtureRoot();
    expect(() =>
      validateWriteTurnNotificationSequenceForTest(root, build(root)),
    ).toThrow("APP_SERVER_PROTOCOL_ERROR");
  });

  it("rejects unknown tool item types", () => {
    const root = fixtureRoot();
    expect(() =>
      validateWriteTurnNotificationSequenceForTest(root, [
        started({ type: "webSearch", id: "id", status: "inProgress" }),
      ]),
    ).toThrow("TOOL_ACTION_ATTEMPTED");
  });

  it("bounds distinct write-tool item identifiers", () => {
    const root = fixtureRoot();
    const notifications = Array.from({ length: 513 }, (_unused, index) =>
      started(commandItem(root, `command-${index}`, "inProgress")),
    );
    expect(() =>
      validateWriteTurnNotificationSequenceForTest(root, notifications),
    ).toThrow("APP_SERVER_PROTOCOL_ERROR");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ctc-tool-lifecycle-"));
  roots.push(root);
  return root;
}

function commandItem(root: string, id: string, status: string) {
  return {
    type: "commandExecution",
    id,
    command: "printf synthetic",
    commandActions: [],
    cwd: root,
    status,
  };
}

function fileItem(id: string, status: string) {
  return {
    type: "fileChange",
    id,
    changes: [{ path: "safe.txt", diff: "synthetic", kind: { type: "add" } }],
    status,
  };
}

function started(item: Record<string, unknown>) {
  return {
    method: "item/started",
    params: { ...correlation, startedAtMs: 1, item },
  };
}

function completed(item: Record<string, unknown>) {
  return {
    method: "item/completed",
    params: { ...correlation, completedAtMs: 2, item },
  };
}

function output(itemId: string, method: string) {
  return { method, params: { ...correlation, itemId, delta: "output" } };
}

function patch(itemId: string, changes: readonly unknown[]) {
  return {
    method: "item/fileChange/patchUpdated",
    params: { ...correlation, itemId, changes },
  };
}

function terminal() {
  return {
    method: "turn/completed",
    params: {
      threadId: correlation.threadId,
      turn: { id: correlation.turnId, status: "completed" },
    },
  };
}
