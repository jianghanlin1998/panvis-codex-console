import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  commandCwdIsWithinForTest,
  fileChangePathIsWithinForTest,
} from "../src/live-execution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("provider-reported path safety", () => {
  it("accepts only filesystem-real command directories inside the worktree", () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const nested = join(root, "nested space", "Unicode-目录");
    mkdirSync(nested, { recursive: true });
    const link = join(root, "outside-link");
    symlinkSync(outside, link);

    expect(commandCwdIsWithinForTest(root, root)).toBe(true);
    expect(commandCwdIsWithinForTest(nested, root)).toBe(true);
    expect(commandCwdIsWithinForTest(outside, root)).toBe(false);
    expect(commandCwdIsWithinForTest(join(root, ".."), root)).toBe(false);
    expect(commandCwdIsWithinForTest(link, root)).toBe(false);
    expect(commandCwdIsWithinForTest(join(root, "missing"), root)).toBe(false);

    rmSync(nested, { recursive: true });
    symlinkSync(outside, nested);
    expect(commandCwdIsWithinForTest(nested, root)).toBe(false);
  });

  it("accepts relative file changes only through real in-worktree ancestors", () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    mkdirSync(join(root, "nested space", "Unicode-目录"), { recursive: true });
    writeFileSync(join(root, "existing.txt"), "value\n", "utf8");
    symlinkSync(outside, join(root, "outside-link"));

    expect(fileChangePathIsWithinForTest("existing.txt", root)).toBe(true);
    expect(
      fileChangePathIsWithinForTest(
        "nested space/Unicode-目录/new file.txt",
        root,
      ),
    ).toBe(true);
    expect(fileChangePathIsWithinForTest("/absolute.txt", root)).toBe(false);
    expect(fileChangePathIsWithinForTest("../outside.txt", root)).toBe(false);
    expect(fileChangePathIsWithinForTest("nested space/./value.txt", root)).toBe(
      false,
    );
    expect(fileChangePathIsWithinForTest("outside-link/value.txt", root)).toBe(
      false,
    );

    rmSync(join(root, "nested space"), { recursive: true });
    symlinkSync(outside, join(root, "nested space"));
    expect(
      fileChangePathIsWithinForTest("nested space/recreated.txt", root),
    ).toBe(false);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ctc-provider-path-"));
  roots.push(root);
  return root;
}
