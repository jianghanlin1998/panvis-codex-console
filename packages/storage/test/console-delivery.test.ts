import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";

describe("Console delivered version inspection", () => {
  it("keeps exact delivered metadata available when a diff exceeds the bounded Git output", () => {
    const f = makeExecutionFixture();
    try {
      const approved = f.execution.approve(f.approval);
      writeFileSync(join(f.repository, "large.txt"), "A synthetic changed line.\n".repeat(240000), "utf8");
      f.git(["add", "large.txt"]); f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Large fixture result"]);
      const headSha = f.git(["rev-parse", "HEAD"]).toString().trim(); f.git(["update-ref", approved.resultRef, headSha]);
      // Supply a delivered projection only; the real repository/ref/approval binding and diff are exercised.
      vi.spyOn(f.execution, "inspect").mockReturnValue({ ...approved, phase: "AWAITING_ACCEPTANCE", resultRefCreated: true, resultHeadSha: headSha });
      const delivery = f.execution.readDelivery(f.approval.bigTaskId);
      expect(delivery.headSha).toBe(headSha); expect(delivery.resultRef).toBe(approved.resultRef);
      expect(delivery.stat).toContain("large.txt"); expect(delivery.diffUnavailable).toBe(true); expect(delivery.diff).toBe("");
    } finally { vi.restoreAllMocks(); f.close(); }
  });
});
