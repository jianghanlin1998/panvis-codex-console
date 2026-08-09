import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./helpers.js";

const transcriptDirectory = resolve(
  REPOSITORY_ROOT,
  "fixtures/mock-app-server/transcripts",
);

describe("protocol transcript fixtures", () => {
  it("stores the representative supported scenarios", () => {
    expect(readdirSync(transcriptDirectory).sort()).toEqual([
      "command-approval.jsonl",
      "failure.jsonl",
      "file-approval.jsonl",
      "interrupt.jsonl",
      "stream.jsonl",
    ]);
  });

  it("contains one valid JSON object per non-empty line", () => {
    for (const name of readdirSync(transcriptDirectory)) {
      const lines = readFileSync(resolve(transcriptDirectory, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(JSON.parse(line)).toEqual(expect.any(Object));
      }
    }
  });

  it("uses only the fake fixture workspace", () => {
    const transcripts = readdirSync(transcriptDirectory)
      .map((name) => readFileSync(resolve(transcriptDirectory, name), "utf8"))
      .join("\n");
    expect(transcripts).not.toContain("/Users/");
    expect(transcripts).not.toContain("/home/");
    expect(transcripts).toContain("/fixture/workspace");
  });

  it("contains no secrets, accounts, raw errors, or reasoning", () => {
    const transcripts = readdirSync(transcriptDirectory)
      .map((name) => readFileSync(resolve(transcriptDirectory, name), "utf8"))
      .join("\n");
    expect(transcripts).not.toMatch(
      /(?:api[_-]?key|authorization|bearer|account[_-]?id|private[_-]?key|provider error|reasoning content)/iu,
    );
  });
});
