import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

function validProxy(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(value);
  return match !== null && match[0] === value && Number(match[1]) <= 65_535;
}

/** Saved Console-only transport survives Finder launches, which have no shell environment. */
export function resolveRuntimeHttpsProxy(explicit: string | undefined, settingsPath: string): string | undefined {
  if (explicit !== undefined) {
    if (!validProxy(explicit)) throw new Error("INVALID_RUNTIME_NETWORK_SETTINGS");
    return explicit;
  }
  let descriptor: number;
  try {
    descriptor = openSync(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("INVALID_RUNTIME_NETWORK_SETTINGS");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error();
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.schemaVersion !== 1 ||
      (record.httpsProxy !== null && !validProxy(record.httpsProxy))) throw new Error();
    return record.httpsProxy === null ? undefined : record.httpsProxy as string;
  } catch {
    // No file content, paths, credentials or parser errors escape this boundary.
    throw new Error("INVALID_RUNTIME_NETWORK_SETTINGS");
  } finally {
    closeSync(descriptor);
  }
}
