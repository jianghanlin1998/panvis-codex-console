import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-sqlite/migrator";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export const runMigrations = (
  database: NodeSQLiteDatabase,
  migrationsFolder: string,
): void => {
  const result = migrate(database, { migrationsFolder });
  if (result !== undefined) {
    throw new Error("Migration initialization failed.");
  }
};
