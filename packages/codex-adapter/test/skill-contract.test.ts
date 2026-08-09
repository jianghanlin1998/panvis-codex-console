import { realpathSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./helpers.js";

const skillDirectory = resolve(REPOSITORY_ROOT, ".agents/skills/task-execution");
const skillPath = resolve(skillDirectory, "SKILL.md");
const metadataPath = resolve(skillDirectory, "agents/openai.yaml");
const skill = readFileSync(skillPath, "utf8");
const metadata = readFileSync(metadataPath, "utf8");
const frontmatter = skill.match(/^---\n(?<value>[\s\S]*?)\n---/u)?.groups?.value ?? "";
const description = frontmatter.match(/^description:\s*(?<value>.+)$/mu)?.groups?.value ?? "";

describe("repository task-execution Skill", () => {
  it("exists at the repository-scoped path", () => {
    expect(realpathSync(skillPath)).toBe(skillPath);
    expect(relative(REPOSITORY_ROOT, skillPath)).toBe(
      ".agents/skills/task-execution/SKILL.md",
    );
  });

  it("declares the required name and description", () => {
    expect(frontmatter).toContain("name: task-execution");
    expect(description).toContain("Task Contract");
  });

  it("uses a bounded and specific trigger description", () => {
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThan(320);
    expect(description).toContain("Use when explicitly invoked");
    expect(description).toContain("do not use");
  });

  it("disables implicit invocation in supported metadata", () => {
    expect(metadata).toContain("policy:\n  allow_implicit_invocation: false");
    expect(metadata).toContain('default_prompt: "Use $task-execution');
  });

  it("contains the required execution boundaries", () => {
    for (const requiredText of [
      "Read the supplied Task Contract",
      "current repository truth",
      "untouched areas",
      "smallest safe change",
      "do not invent product or architecture decisions",
      "Stop only for a real product",
      "deterministic tests",
      "Never weaken",
      "Summarize successful logs",
      "git diff --check",
      "Reconcile current main",
      "structured Handoff",
      "Never expose secrets",
    ]) {
      expect(skill).toContain(requiredText);
    }
  });

  it("does not freeze the current S0C task scope into the reusable Skill", () => {
    expect(skill).not.toMatch(/S0C|App Server|mock protocol|Codex Task Console/iu);
  });

  it("contains no secret-like fixture value or raw sensitive error", () => {
    expect(skill).not.toMatch(
      /(?:api[_-]?key|authorization:\s*bearer|private[_-]?key|raw provider error|account[_-]?id)/iu,
    );
  });

  it("is instruction-only and cannot call a live model", () => {
    expect(readdirSync(skillDirectory).sort()).toEqual(["SKILL.md", "agents"]);
    expect(skill).not.toMatch(/live model|model request|curl|fetch\(/iu);
  });
});
