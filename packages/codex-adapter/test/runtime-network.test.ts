import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeHttpsProxy } from "../src/runtime-network.js";
import { buildLiveCodexChildEnvironmentForTest } from "../src/live-execution.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctc-network-settings-"));
  const path = join(root, "Library", "Application Support", "Codex Task Console", "codex-runtime", "network.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return { root, path, save: (value: unknown) => writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("persistent Console runtime network settings", () => {
  it("uses the saved connection on consecutive Finder-style launches without inheriting ambient proxies or credentials", () => {
    const f = fixture();
    try {
      f.save({ schemaVersion: 1, httpsProxy: "http://127.0.0.1:10808" });
      for (let launch = 0; launch < 2; launch += 1) {
        const env = buildLiveCodexChildEnvironmentForTest({ HTTPS_PROXY: "https://private-canary.invalid", OPENAI_API_KEY: "private-canary" }, f.root, "/tmp/workspace");
        expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:10808");
        expect(JSON.stringify(env)).not.toContain("private-canary");
      }
    } finally { f.close(); }
  });
  it("keeps direct mode when settings are absent or explicitly null and supports environment override", () => {
    const f = fixture();
    try {
      expect(resolveRuntimeHttpsProxy(undefined, f.path)).toBeUndefined();
      f.save({ schemaVersion: 1, httpsProxy: null });
      expect(resolveRuntimeHttpsProxy(undefined, f.path)).toBeUndefined();
      expect(resolveRuntimeHttpsProxy("http://[::1]:65535", f.path)).toBe("http://[::1]:65535");
      f.save({ schemaVersion: 1, httpsProxy: "http://127.0.0.1:10808" });
      expect(() => resolveRuntimeHttpsProxy("invalid", f.path)).toThrow("INVALID_RUNTIME_NETWORK_SETTINGS");
    } finally { f.close(); }
  });
  it.each([
    { schemaVersion: 1, httpsProxy: "http://user:private-canary@127.0.0.1:10808" },
    { schemaVersion: 1, httpsProxy: "http://example.com:10808" },
    { schemaVersion: 1, httpsProxy: "http://127.0.0.1:65536" },
    { schemaVersion: 1, httpsProxy: "http://127.0.0.1:10808/path" },
    { schemaVersion: 1, httpsProxy: "http://127.0.0.1:10808\n" },
    { schemaVersion: 2, httpsProxy: null },
    { schemaVersion: 1, httpsProxy: null, private: "private-canary" },
    null,
  ])("rejects invalid saved settings without exposing their content", (value) => {
    const f = fixture();
    try {
      f.save(value);
      expect(() => resolveRuntimeHttpsProxy(undefined, f.path)).toThrow(/^INVALID_RUNTIME_NETWORK_SETTINGS$/);
    } finally { f.close(); }
  });
  it("rejects malformed, oversized, shared, and symbolic-link settings", () => {
    const f = fixture();
    try {
      for (const content of ["private-canary", " ".repeat(4097)]) {
        writeFileSync(f.path, content, { encoding: "utf8", mode: 0o600 });
        expect(() => resolveRuntimeHttpsProxy(undefined, f.path)).toThrow(/^INVALID_RUNTIME_NETWORK_SETTINGS$/);
      }
      f.save({ schemaVersion: 1, httpsProxy: null }); chmodSync(f.path, 0o644);
      expect(() => resolveRuntimeHttpsProxy(undefined, f.path)).toThrow(/^INVALID_RUNTIME_NETWORK_SETTINGS$/);
      rmSync(f.path); const target = join(f.root, "target.json");
      writeFileSync(target, '{"schemaVersion":1,"httpsProxy":null}', { encoding: "utf8", mode: 0o600 });
      symlinkSync(target, f.path);
      expect(() => resolveRuntimeHttpsProxy(undefined, f.path)).toThrow(/^INVALID_RUNTIME_NETWORK_SETTINGS$/);
    } finally { f.close(); }
  });
});
