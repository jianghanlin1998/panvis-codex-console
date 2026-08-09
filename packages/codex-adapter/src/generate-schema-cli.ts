import { resolve } from "node:path";

import { CodexAdapterError } from "./errors.js";
import { runSchemaGenerators } from "./schema-generation.js";

const outputDirectory = process.argv.slice(2).find((argument) => argument !== "--");

if (outputDirectory === undefined) {
  process.stderr.write(
    "Usage: pnpm codex:schema:generate -- <absolute temporary or .codex-schema path>\n",
  );
  process.exitCode = 1;
} else {
  try {
    const commands = runSchemaGenerators({
      outputDirectory,
      repositoryRoot: resolve(import.meta.dirname, "../../.."),
    });
    process.stdout.write(
      `Generated ${String(commands.length)} version-specific schema bundles.\n`,
    );
  } catch (error: unknown) {
    const message =
      error instanceof CodexAdapterError
        ? error.message
        : "Codex protocol schema generation failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
