import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { CodexAdapterError } from "./errors.js";

export interface SchemaGenerationOptions {
  readonly codexBinary?: string;
  readonly outputDirectory: string;
  readonly repositoryRoot: string;
}

export interface SchemaGenerationCommand {
  readonly arguments: readonly string[];
  readonly command: string;
  readonly kind: "json-schema" | "typescript";
}

export interface CommandResult {
  readonly errorCode?: string;
  readonly status: number | null;
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
) => CommandResult;

export function isAllowedSchemaOutputPath(
  outputDirectory: string,
  repositoryRoot: string,
): boolean {
  if (!isAbsolute(outputDirectory) || !isAbsolute(repositoryRoot)) {
    return false;
  }

  const output = resolve(outputDirectory);
  const ignoredRoot = resolve(repositoryRoot, ".codex-schema");
  const temporaryRoot = resolve(tmpdir());

  return output === ignoredRoot || isStrictDescendant(output, ignoredRoot) || isStrictDescendant(output, temporaryRoot);
}

export function buildSchemaGenerationCommands(
  options: SchemaGenerationOptions,
): readonly SchemaGenerationCommand[] {
  if (!isAllowedSchemaOutputPath(options.outputDirectory, options.repositoryRoot)) {
    throw new CodexAdapterError("INVALID_SCHEMA_OUTPUT_PATH");
  }

  const codexBinary = options.codexBinary ?? "codex";
  const output = resolve(options.outputDirectory);

  return [
    {
      arguments: ["app-server", "generate-ts", "--out", join(output, "typescript")],
      command: codexBinary,
      kind: "typescript",
    },
    {
      arguments: [
        "app-server",
        "generate-json-schema",
        "--out",
        join(output, "json-schema"),
      ],
      command: codexBinary,
      kind: "json-schema",
    },
  ];
}

export function runSchemaGenerators(
  options: SchemaGenerationOptions,
  runner: CommandRunner = defaultRunner,
): readonly SchemaGenerationCommand[] {
  const commands = buildSchemaGenerationCommands(options);
  mkdirSync(resolve(options.outputDirectory), { recursive: true });

  for (const command of commands) {
    const result = runner(command.command, command.arguments);
    if (result.errorCode === "ENOENT") {
      throw new CodexAdapterError("CODEX_CLI_NOT_FOUND");
    }
    if (result.errorCode !== undefined || result.status !== 0) {
      throw new CodexAdapterError("SCHEMA_GENERATION_FAILED");
    }
  }

  return commands;
}

function defaultRunner(command: string, arguments_: readonly string[]): CommandResult {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    shell: false,
    stdio: "pipe",
  });

  return {
    ...(result.error === undefined
      ? {}
      : { errorCode: (result.error as NodeJS.ErrnoException).code ?? "UNKNOWN" }),
    status: result.status,
  };
}

function isStrictDescendant(candidate: string, parent: string): boolean {
  const childPath = relative(parent, candidate);
  return childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath);
}
