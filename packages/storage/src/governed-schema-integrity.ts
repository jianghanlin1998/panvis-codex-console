import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TaskStorageError } from "./errors.js";
import { governedSchemaManifest } from "./governed-schema-manifest.js";

const versions = new WeakMap<DatabaseSync, number>();
export function assertGovernedSchemaIntegrity(sqlite: DatabaseSync): void {
  const version = (sqlite.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
  if (versions.get(sqlite) === version) return;
  const rows = sqlite.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name GLOB 'governed_*' AND sql IS NOT NULL ORDER BY name`).all();
  if (rows.length !== Object.keys(governedSchemaManifest).length || rows.some(row =>
    governedSchemaManifest[String(row.name)] !== createHash("sha256").update(JSON.stringify(row)).digest("hex"),
  )) {
    throw new TaskStorageError("MALFORMED_STORED_DATA", "Stored governed execution authority is malformed.");
  }
  versions.set(sqlite, version);
}
