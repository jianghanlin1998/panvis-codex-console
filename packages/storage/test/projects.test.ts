import { describe, expect, it } from "vitest";

import type { Project } from "@codex-task-console/domain";
import { TaskStorageError } from "../src/index.js";
import { captureTaskStorageError, makeProject, withMemoryStorage } from "./fixtures.js";

describe("Project storage", () => {
  it("creates and round-trips a valid Project", () => {
    withMemoryStorage((storage) => {
      const project = makeProject();
      expect(storage.createProject(project)).toEqual(project);
      expect(storage.getProjectById(project.id)).toEqual(project);
    });
  });

  it("round-trips a repository reference representation", () => {
    withMemoryStorage((storage) => {
      const project = {
        ...makeProject(),
        repository: { kind: "REFERENCE" as const, reference: "li7danyu/example" },
      };
      expect(storage.createProject(project)).toEqual(project);
      expect(storage.getProjectById(project.id)).toEqual(project);
    });
  });

  it("looks up a Project by slug", () => {
    withMemoryStorage((storage) => {
      const project = makeProject();
      storage.createProject(project);
      expect(storage.getProjectBySlug(project.slug)).toEqual(project);
      expect(storage.getProjectBySlug("missing-project")).toBeNull();
    });
  });

  it("lists Projects deterministically by timestamp and ID", () => {
    withMemoryStorage((storage) => {
      const second = makeProject("prj_b", "project-b");
      const first = makeProject("prj_a", "project-a");
      storage.createProject(second);
      storage.createProject(first);
      expect(storage.listProjects().map(({ id }) => id)).toEqual(["prj_a", "prj_b"]);
    });
  });

  it("rejects a duplicate Project slug with a stable typed error", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject("prj_a", "same-slug"));
      expect(() => storage.createProject(makeProject("prj_b", "same-slug"))).toThrow(
        TaskStorageError,
      );
      expect(
        captureTaskStorageError(() => storage.createProject(makeProject("prj_b", "same-slug")))
          .code,
      ).toBe("CONFLICT");
    });
  });

  it("rejects invalid Project input before writing", () => {
    withMemoryStorage((storage) => {
      const invalid = { ...makeProject(), slug: "INVALID SLUG" } as Project;
      expect(captureTaskStorageError(() => storage.createProject(invalid)).code).toBe(
        "INVALID_INPUT",
      );
      expect(storage.listProjects()).toEqual([]);
    });
  });

  it("does not mutate caller-owned Project data", () => {
    withMemoryStorage((storage) => {
      const repository = Object.freeze({ kind: "PATH" as const, path: "/repositories/console" });
      const project = Object.freeze({ ...makeProject(), repository });
      const snapshot = JSON.stringify(project);
      storage.createProject(project);
      expect(JSON.stringify(project)).toBe(snapshot);
      expect(project.repository).toBe(repository);
    });
  });

  it("does not leak raw SQLite conflict errors", () => {
    withMemoryStorage((storage) => {
      storage.createProject(makeProject());
      let thrown: unknown;
      try {
        storage.createProject(makeProject());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TaskStorageError);
      expect((thrown as Error).message).not.toMatch(/SQLITE|UNIQUE constraint|projects\.slug/i);
    });
  });
});
