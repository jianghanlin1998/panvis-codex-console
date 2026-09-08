import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectUiDaemon } from "../src/ui-launcher.js";
import { acquireDaemonLock, ensureProductionStateDirectories, LocalStateError, localControlPathsForTesting, recoverStoppedDaemonAuthority, writeSessionDescriptor } from "../src/state.js";
const session = { schemaVersion: 1 as const, instanceId: `inst_${"1".repeat(32)}`, pid: 4321, port: 54321, startedAt: "2026-09-08T00:00:00.000Z", sessionToken: "2".repeat(64) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("desktop launcher lifetime", () => {
  it("reuses the running daemon without starting another", async () => {
    const start = vi.fn(); const recoverStopped = vi.fn(() => false);
    expect(await connectUiDaemon({ readSession: () => session, recoverStopped, start, wait: async () => undefined })).toEqual({ session, owned: null });
    expect(start).not.toHaveBeenCalled(); expect(recoverStopped).toHaveBeenCalledOnce();
  });
  it("starts a cold daemon once and tolerates a simultaneous launcher winning the lock", async () => {
    let ready = false; const daemon = {};
    const readSession = () => { if (!ready) throw new LocalStateError("SESSION_UNAVAILABLE"); return session; };
    const start = vi.fn(async () => { ready = true; return daemon; });
    expect((await connectUiDaemon({ readSession, recoverStopped: () => false, start, wait: async () => undefined })).owned).toBe(daemon);
    expect(start).toHaveBeenCalledOnce(); ready = false;
    const losingStart = vi.fn(async () => { throw new LocalStateError("DAEMON_ALREADY_RUNNING"); });
    const wait = vi.fn(async () => { ready = true; });
    expect((await connectUiDaemon({ readSession, recoverStopped: () => false, start: losingStart, wait })).owned).toBeNull();
    expect(losingStart).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce();
  });
  it("bounds startup waits and does not conceal malformed authority", async () => {
    const wait = vi.fn(async () => undefined);
    await expect(connectUiDaemon({ readSession: () => { throw new LocalStateError("SESSION_UNAVAILABLE"); }, recoverStopped: () => false,
      start: async () => { throw new LocalStateError("DAEMON_ALREADY_RUNNING"); }, wait })).rejects.toThrow("SESSION_UNAVAILABLE");
    expect(wait).toHaveBeenCalledTimes(30);
    const start = vi.fn();
    await expect(connectUiDaemon({ readSession: () => { throw new LocalStateError("SESSION_MALFORMED"); }, recoverStopped: () => false, start, wait })).rejects.toThrow("SESSION_MALFORMED");
    expect(start).not.toHaveBeenCalled();
  });
  it.each([true, false])("only reclaims a matching stopped authority pair (alive=%s)", alive => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ctc-launcher-"))); roots.push(root);
    const paths = localControlPathsForTesting(root); ensureProductionStateDirectories(paths);
    acquireDaemonLock(paths, session.instanceId, session.pid, session.startedAt); writeSessionDescriptor(paths, session);
    const probe = vi.fn(() => alive);
    expect(recoverStoppedDaemonAuthority(paths, probe)).toBe(!alive);
    expect(probe).toHaveBeenCalledWith(session.pid);
    expect(existsSync(paths.lockPath)).toBe(alive); expect(existsSync(paths.sessionPath)).toBe(alive);
  });
  it("retains a mismatched session even when the lock owner is stopped", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ctc-launcher-"))); roots.push(root);
    const paths = localControlPathsForTesting(root); ensureProductionStateDirectories(paths);
    acquireDaemonLock(paths, session.instanceId, session.pid, session.startedAt); writeSessionDescriptor(paths, { ...session, pid: session.pid + 1 });
    expect(() => recoverStoppedDaemonAuthority(paths, () => false)).toThrow("SESSION_MALFORMED");
    expect(existsSync(paths.lockPath)).toBe(true); expect(existsSync(paths.sessionPath)).toBe(true);
  });
});
