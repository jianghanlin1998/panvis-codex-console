#!/usr/bin/env node

import {
  LocalOperatorError,
  parseOperatorCommand,
  runOperatorCommand,
} from "./operator.js";

const writeError = (code: string): void => {
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
};

const main = async (): Promise<void> => {
  try {
    const command = parseOperatorCommand(process.argv.slice(2));
    const result = await runOperatorCommand(command);
    process.stdout.write(`${JSON.stringify(result.body)}\n`);
    if (!result.succeeded) {
      process.exitCode = 1;
    }
  } catch (error) {
    writeError(
      error instanceof LocalOperatorError ? error.code : "OPERATOR_UNAVAILABLE",
    );
    process.exitCode = error instanceof LocalOperatorError && error.code === "INVALID_COMMAND" ? 2 : 1;
  }
};

void main();
