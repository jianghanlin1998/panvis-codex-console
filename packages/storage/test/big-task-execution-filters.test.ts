import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { executionGit } from "../src/big-task-execution.js";

describe("coordinator repository filter boundary", () => {
  it.each(["local", "included", "worktree", "info-attributes"])("refuses %s filter configuration before running its script", kind => {
    const f = makeExecutionFixture();
    try {
      const marker = join(f.root, "filter-ran");
      const script = join(f.root, "filter.sh");
      writeFileSync(script, `#!/bin/sh\n/usr/bin/touch '${marker}'\n/bin/cat\n`, "utf8"); chmodSync(script, 0o700);
      if (kind === "included") {
        const file = join(f.root, "included-config");
        writeFileSync(file, `[filter "fixture"]\nclean = ${script}\nrequired = true\n`, "utf8");
        f.git(["config", "include.path", file]);
      } else {
        if (kind === "worktree") f.git(["config", "extensions.worktreeConfig", "true"]);
        const scope = kind === "worktree" ? ["--worktree"] : [];
        f.git(["config", ...scope, "filter.fixture.clean", script]);
        f.git(["config", ...scope, "filter.fixture.required", "true"]);
      }
      writeFileSync(join(f.repository, kind === "info-attributes" ? ".git/info/attributes" : ".gitattributes"), "AGENTS.md filter=fixture\n", "utf8");
      writeFileSync(join(f.repository, "AGENTS.md"), "Xespect the approved task boundary.\n", "utf8");
      expect(() => executionGit(f.repository, ["status", "--porcelain=v2", "--untracked-files=all", "-z"])).toThrow();
      expect(() => f.execution.review(f.approval.bigTaskId)).toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally { f.close(); }
  });
});
