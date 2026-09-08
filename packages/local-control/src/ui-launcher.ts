import type { LocalSessionDescriptor } from "./state.js";

export interface UiLauncherDependencies<T> {
  readSession(): LocalSessionDescriptor;
  recoverStopped(): boolean;
  start(): Promise<T>;
  wait(): Promise<void>;
}
/** Concurrent desktop clicks converge on one daemon; all waits are bounded and injectable. */
export async function connectUiDaemon<T>(dependencies: UiLauncherDependencies<T>): Promise<{ session: LocalSessionDescriptor; owned: T | null }> {
  let owned: T | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    dependencies.recoverStopped();
    try { return { session: dependencies.readSession(), owned }; }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "SESSION_UNAVAILABLE") throw error; }
    try { owned = await dependencies.start(); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "DAEMON_ALREADY_RUNNING") throw error; }
    if (owned !== null) return { session: dependencies.readSession(), owned };
    await dependencies.wait();
  }
  throw new Error("SESSION_UNAVAILABLE");
}
