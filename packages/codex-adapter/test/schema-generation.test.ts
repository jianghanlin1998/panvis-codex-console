import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSchemaGenerationCommands,
  isAllowedSchemaOutputPath,
  runSchemaGenerators,
  type CommandRunner,
} from "../src/index.js";
import { REPOSITORY_ROOT } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryOutput(): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-s0c-schema-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "generated");
}

describe("schema generation helper", () => {
  it("builds the two installed-CLI generator commands", () => {
    const outputDirectory = temporaryOutput();
    expect(
      buildSchemaGenerationCommands({ outputDirectory, repositoryRoot: REPOSITORY_ROOT }),
    ).toEqual([
      {
        arguments: [
          "app-server",
          "generate-ts",
          "--out",
          join(outputDirectory, "typescript"),
        ],
        command: "codex",
        kind: "typescript",
      },
      {
        arguments: [
          "app-server",
          "generate-json-schema",
          "--out",
          join(outputDirectory, "json-schema"),
        ],
        command: "codex",
        kind: "json-schema",
      },
    ]);
  });

  it("does not enable experimental schema output", () => {
    const commands = buildSchemaGenerationCommands({
      outputDirectory: temporaryOutput(),
      repositoryRoot: REPOSITORY_ROOT,
    });
    expect(commands.flatMap((command) => command.arguments)).not.toContain("--experimental");
  });

  it("allows temporary and repository-ignored output", () => {
    expect(isAllowedSchemaOutputPath(temporaryOutput(), REPOSITORY_ROOT)).toBe(true);
    expect(
      isAllowedSchemaOutputPath(resolve(REPOSITORY_ROOT, ".codex-schema"), REPOSITORY_ROOT),
    ).toBe(true);
  });

  it("rejects implicit, relative, and tracked-source output paths", () => {
    expect(isAllowedSchemaOutputPath("generated", REPOSITORY_ROOT)).toBe(false);
    expect(
      isAllowedSchemaOutputPath(resolve(REPOSITORY_ROOT, "packages/generated"), REPOSITORY_ROOT),
    ).toBe(false);
    expect(() =>
      buildSchemaGenerationCommands({
        outputDirectory: resolve(REPOSITORY_ROOT, "packages/generated"),
        repositoryRoot: REPOSITORY_ROOT,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_SCHEMA_OUTPUT_PATH" }),
    );
  });

  it("returns a sanitized typed error when the Codex CLI is missing", () => {
    const runner: CommandRunner = () => ({ errorCode: "ENOENT", status: null });
    expect(() =>
      runSchemaGenerators(
        { outputDirectory: temporaryOutput(), repositoryRoot: REPOSITORY_ROOT },
        runner,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CODEX_CLI_NOT_FOUND",
        message: "Codex CLI is unavailable; schema generation was not run.",
      }),
    );
  });

  it("returns a sanitized typed error when a generator fails", () => {
    const runner: CommandRunner = () => ({ errorCode: "RAW_PRIVATE_DETAIL", status: 1 });
    try {
      runSchemaGenerators(
        { outputDirectory: temporaryOutput(), repositoryRoot: REPOSITORY_ROOT },
        runner,
      );
      throw new Error("Expected schema generation to fail.");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "SCHEMA_GENERATION_FAILED",
        message: "Codex protocol schema generation failed.",
      });
      expect(String(error)).not.toContain("RAW_PRIVATE_DETAIL");
    }
  });

  it("keeps the repository schema directory ignored and absent", () => {
    const ignore = readFileSync(resolve(REPOSITORY_ROOT, ".gitignore"), "utf8");
    expect(ignore).toContain(".codex-schema/");
    expect(existsSync(resolve(REPOSITORY_ROOT, ".codex-schema"))).toBe(false);
  });
});
