#!/usr/bin/env node

import { LocalDaemonError, startLocalControlDaemon } from "./daemon.js";

const writeCliError = (code: string): void => {
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
};

const main = async (): Promise<void> => {
  if (process.argv.length !== 2) {
    writeCliError("INVALID_COMMAND");
    process.exitCode = 2;
    return;
  }
  try {
    const daemon = await startLocalControlDaemon();
    let stopping = false;
    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      void daemon.stop().catch((error: unknown) => {
        writeCliError(
          error instanceof LocalDaemonError ? error.code : "SHUTDOWN_FAILED",
        );
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    writeCliError(
      error instanceof LocalDaemonError ? error.code : "DAEMON_START_FAILED",
    );
    process.exitCode = 1;
  }
};

void main();
