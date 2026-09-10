import { describe, expect, it } from "vitest";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { CONSOLE_DISCUSSION_OUTPUT_SCHEMA } from "@codex-task-console/domain";
import { ConsoleWorkspaceStore } from "../../storage/src/console-workspace.js";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { planningProviderFixture } from "./planning-provider-fixture.js";
import { executeConsoleDiscussionCodexForTest } from "../src/live-execution.js";
import { consoleResearch } from "../src/console-research.js";
import type { JsonValue } from "../src/protocol.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
describe("Console read-only investigation and real image inputs", () => {
  it("reads the retained Git version even after the working file changes", () => {
    const f = makePlanningFixture();
    try {
      const revision = f.git(["rev-parse", "HEAD"]).toString().trim();
      writeFileSync(join(f.repository, "AGENTS.md"), "NEW_WORKING_RULES", "utf8");
      const read = consoleResearch(f.storage, f.intake.bigTask.projectId, { kind: "PROJECT", id: f.intake.bigTask.projectId });
      expect(read({ kind: "file", path: "AGENTS.md", revision })).toMatchObject({ revision, text: "Respect the approved task boundary.\n" });
      expect(read({ kind: "files", revision })).toMatchObject({ files: ["AGENTS.md"] });
      expect(read({ kind: "file", path: "AGENTS.md" })).toMatchObject({ text: "NEW_WORKING_RULES" });
      for (const path of ["../outside", ".git/config", ".env"]) expect(read({ kind: "file", path, revision })).toMatchObject({ error: "READ_UNAVAILABLE" });
    } finally { f.close(); }
  });
  it("supports shell reads, web search/page reads and image views without interrupting the reply", async () => {
    const f = makePlanningFixture();
    try {
      const store = new ConsoleWorkspaceStore(f.storage);
      const claim = store.claimDiscussion({ requestId: "research-tools", scope: { kind: "PROJECT", id: f.intake.bigTask.projectId }, message: "Investigate" });
      const peer = planningProviderFixture(() => ({ reply: "Investigated", proposal: null, contextSummary: "Checked project" }), { researchTools: true });
      const result = await executeConsoleDiscussionCodexForTest(f.storage, claim.inputText, CONSOLE_DISCUSSION_OUTPUT_SCHEMA as JsonValue, () => 300000, peer.dependencies);
      expect(result).toMatchObject({ success: true, failureCode: null });
      expect(peer.requests.find(request => request.method === "thread/start")?.params).toMatchObject({ sandbox: "read-only", config: { features: { shell_tool: true, unified_exec: true }, web_search: "live" } });
      expect(f.git(["status", "--short"]).toString()).toBe("");
    } finally { f.close(); }
  });
  it("roundtrips a dynamic read through JSONL and sends the saved screenshot as an image input", async () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage), scope = { kind: "PROJECT", id: f.intake.bigTask.projectId } as const;
      const asset = ui.entries.saveAsset(scope.id, scope, "layout.png", png);
      const claim = ui.claimDiscussion({ requestId: "image-discussion", scope, message: "Read project rules and inspect the screenshot", attachments: [asset] });
      let researchResult: unknown;
      const peer = planningProviderFixture(() => ({ reply: "Read the project", proposal: null, contextSummary: "The user is discussing layout." }), { researchCall: { kind: "file", path: "AGENTS.md", scope: null, offset: 0, query: null }, onResearchResult: result => { researchResult = result; } });
      const result = await executeConsoleDiscussionCodexForTest(f.storage, claim.inputText, CONSOLE_DISCUSSION_OUTPUT_SCHEMA as JsonValue, () => 300000, peer.dependencies);
      expect(result).toMatchObject({ success: true, failureCode: null });
      expect(JSON.stringify(researchResult)).toContain("Respect the approved task boundary.");
      expect(peer.requests.find(request => request.method === "initialize")?.params.capabilities).toMatchObject({ experimentalApi: true });
      expect(peer.requests.find(request => request.method === "thread/start")?.params.dynamicTools).toEqual([expect.objectContaining({ type: "function", name: "console_read" })]);
      expect(peer.requests.find(request => request.method === "turn/start")?.params.input).toEqual([expect.objectContaining({ type: "text" }), { type: "image", url: png }]);
      expect(f.storage.listBigTasksByProject(scope.id)).toHaveLength(0);
    } finally { f.close(); }
  });
  it("rejects outside files and configured Git filters without executing them", () => {
    const f = makePlanningFixture();
    try {
      const read = consoleResearch(f.storage, f.intake.bigTask.projectId, { kind: "PROJECT", id: f.intake.bigTask.projectId });
      const outside = join(f.root, "outside.txt"); writeFileSync(outside, "OUTSIDE_SENTINEL", "utf8");
      symlinkSync(outside, join(f.repository, "outside-link.txt"));
      for (const path of ["../outside.txt", outside, "outside-link.txt", ".git/config", ".env"]) expect(read({ kind: "file", path })).toMatchObject({ error: "READ_UNAVAILABLE" });
      expect(read({ kind: "file", path: "AGENTS.md" })).toMatchObject({ text: "Respect the approved task boundary.\n" });
      f.git(["config", "filter.fixture.clean", "false"]);
      expect(read({ kind: "repository" })).toMatchObject({ error: "READ_UNAVAILABLE" });
      expect(read({ kind: "task", scope: { kind: "PROJECT", id: "prj_unknown" } })).toMatchObject({ error: "READ_UNAVAILABLE" });
    } finally { f.close(); }
  });
  it("rejects malformed command events even when discussion supports research commands", async () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      const claim = ui.claimDiscussion({ requestId: "no-shell", scope: { kind: "PROJECT", id: f.intake.bigTask.projectId }, message: "Inspect" });
      const peer = planningProviderFixture(() => null, { toolAttempt: true });
      const result = await executeConsoleDiscussionCodexForTest(f.storage, claim.inputText, CONSOLE_DISCUSSION_OUTPUT_SCHEMA as JsonValue, () => 300000, peer.dependencies);
      expect(result.success).toBe(false);
      expect(result.failureCode).toBe("APP_SERVER_PROTOCOL_ERROR");
    } finally { f.close(); }
  });
});
