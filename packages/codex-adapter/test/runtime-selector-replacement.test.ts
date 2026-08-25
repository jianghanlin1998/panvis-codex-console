import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as FileSystem from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectorReadControl = vi.hoisted(() => ({
  afterRead: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    readSync(
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number {
      const bytesRead = actual.readSync(
        descriptor,
        buffer,
        offset,
        length,
        position,
      );
      selectorReadControl.afterRead?.();
      return bytesRead;
    },
  };
});

import {
  readOwnedCodexRuntimeSelector,
  type CodexRuntimeOwnershipOptions,
} from "../src/index.js";

const SELECTOR_A = {
  active: {
    target: "aarch64-apple-darwin",
    version: "0.148.0-alpha.9",
  },
  previous: null,
  schemaVersion: 1,
} as const;

const SELECTOR_B = {
  active: {
    target: "aarch64-apple-darwin",
    version: "0.148.0-alpha.10",
  },
  previous: null,
  schemaVersion: 1,
} as const;

let runtimeRoot: string;
let options: CodexRuntimeOwnershipOptions;
let originalNodeEnvironment: string | undefined;

beforeEach(() => {
  runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), "ctc-selector-replace-")));
  options = { trustedRuntimeRoot: runtimeRoot };
  originalNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  selectorReadControl.afterRead = undefined;
});

afterEach(() => {
  selectorReadControl.afterRead = undefined;
  restoreEnvironmentVariable("NODE_ENV", originalNodeEnvironment);
  chmodSync(runtimeRoot, 0o700);
  rmSync(runtimeRoot, { force: true, recursive: true });
});

describe("owned Codex selector stable read", () => {
  it("fails closed when active.json is replaced after its descriptor is read", () => {
    const selectorPath = join(runtimeRoot, "active.json");
    const replacementPath = join(runtimeRoot, "replacement.json");
    writeSelector(selectorPath, SELECTOR_A);
    writeSelector(replacementPath, SELECTOR_B);
    let replacementPerformed = false;
    selectorReadControl.afterRead = () => {
      selectorReadControl.afterRead = undefined;
      renameSync(replacementPath, selectorPath);
      replacementPerformed = true;
    };

    expect(() => readOwnedCodexRuntimeSelector(options)).toThrowError(
      expect.objectContaining({ code: "INVALID_SELECTOR" }),
    );
    expect(replacementPerformed).toBe(true);
    expect(JSON.parse(readFileSync(selectorPath, "utf8"))).toEqual(SELECTOR_B);
  });
});

function writeSelector(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
