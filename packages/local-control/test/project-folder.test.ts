import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { folderDialogCommand, inspectProjectFolder } from "../src/project-folder.js";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";

describe("project folder selection", () => {
  it("uses native folder dialogs with fixed arguments on Mac and Windows", () => {
    expect(folderDialogCommand("darwin")).toMatchObject({ executable: "/usr/bin/osascript", args: ["-e", expect.stringContaining("choose folder")] });
    expect(folderDialogCommand("win32")).toMatchObject({ executable: "powershell.exe", args: expect.arrayContaining(["-STA", expect.stringContaining("FolderBrowserDialog")]) });
    expect(folderDialogCommand("linux")).toBeNull();
  });
  it("finds the repository root and branch from a Unicode subfolder, and explains a nonrepository", async () => {
    const f = makePlanningFixture();
    try {
      const child = join(f.repository, "项目 folder"); mkdirSync(child);
      expect(await inspectProjectFolder(child)).toMatchObject({ ready: true, selected: child, repositoryPath: f.repository, defaultBranch: "main", name: "repository", slug: "repository" });
      const empty = join(f.root, "new folder"); mkdirSync(empty);
      expect(await inspectProjectFolder(empty)).toMatchObject({ ready: false, repositoryPath: empty, message: expect.stringContaining("Git") });
    } finally { f.close(); }
  });
});
