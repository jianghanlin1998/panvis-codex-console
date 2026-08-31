import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  validateOwnedWorktreeHardlinkSafety,
  WorktreeFilesystemSafetyError,
} from "../src/worktree-filesystem-safety.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("owned-worktree hardlink safety", () => {
  it("accepts unique regular files and does not follow symbolic links", () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    mkdirSync(join(root, "nested space", "Unicode-目录"), { recursive: true });
    writeFileSync(join(root, "tracked.txt"), "tracked\n", "utf8");
    writeFileSync(
      join(root, "nested space", "Unicode-目录", "value.txt"),
      "value\n",
      "utf8",
    );
    writeFileSync(join(outside, "sentinel.txt"), "outside\n", "utf8");
    symlinkSync(join(outside, "sentinel.txt"), join(root, "outside-link"));

    expect(() => validateOwnedWorktreeHardlinkSafety(root)).not.toThrow();
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe(
      "outside\n",
    );
  });

  it("rejects an external hardlink without modifying either alias", () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "original\n", "utf8");
    linkSync(sentinel, join(root, "alias.txt"));

    expect(() => validateOwnedWorktreeHardlinkSafety(root)).toThrow(
      WorktreeFilesystemSafetyError,
    );
    expect(readFileSync(sentinel, "utf8")).toBe("original\n");
    expect(readFileSync(join(root, "alias.txt"), "utf8")).toBe("original\n");
  });

  it("conservatively rejects multiple hardlinks entirely inside the worktree", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "first.txt"), "inside\n", "utf8");
    linkSync(join(root, "first.txt"), join(root, "second.txt"));

    expect(() => validateOwnedWorktreeHardlinkSafety(root)).toThrow(
      WorktreeFilesystemSafetyError,
    );
  });
});

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ctc-hardlink-safety-")));
  roots.push(root);
  return root;
}
