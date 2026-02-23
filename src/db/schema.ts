/**
 * @module db/schema
 *
 * Schema creation and migration for the DuckDB star schema.
 * Reads DDL from sql/schema.sql and sql/views.sql and applies them
 * to the database connection.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MigrationError } from "../errors.js";

/** Current schema version matching sql/schema.sql */
const CURRENT_VERSION = 1;

/**
 * Split a SQL file into individual statements.
 * Strips comments first (so semicolons inside comments don't cause
 * incorrect splits), then splits on semicolons and filters empty fragments.
 */
function splitStatements(sql: string): string[] {
  // Remove comments before splitting so semicolons within
  // comments (e.g. "-- rates above 80%; effective") don't split
  const stripped = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the path to the sql/ directory.
 * In CJS bundle (dist/cli.cjs), __dirname points to dist/, so sql/ is one level up.
 * In ESM source (src/db/schema.ts), navigate up 3 levels to project root.
 */
function getSqlDir(): string {
  // tsup bundles to dist/cli.cjs, so __dirname = dist/
  // sql/ is at project root, one level up from dist/
  const candidates = [
    path.resolve(__dirname, "..", "sql"),
    path.resolve(__dirname, "..", "..", "..", "sql"),
    path.resolve(process.cwd(), "sql"),
  ];

  // Return first candidate that looks valid (has schema.sql)
  // At build time we can't check, so return the most likely one
  for (const candidate of candidates) {
    try {
      // Sync check is fine during startup
      require("node:fs").accessSync(path.join(candidate, "schema.sql"));
      return candidate;
    } catch {
      continue;
    }
  }

  // Fallback: relative to cwd
  return path.resolve(process.cwd(), "sql");
}

/**
 * Manages schema initialization and migrations for the DuckDB database.
 */
export class SchemaManager {
  /**
   * Ensure all required tables, views, and indexes exist.
   * Runs the full DDL from sql/schema.sql and sql/views.sql.
   *
   * @param connection - Active DuckDB connection
   * @throws MigrationError if schema initialization fails
   */
  async initialize(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    const sqlDir = getSqlDir();

    try {
      // Read and execute schema.sql (tables, indexes, migrations record)
      const schemaPath = path.join(sqlDir, "schema.sql");
      const schemaSql = await fs.readFile(schemaPath, "utf-8");
      const schemaStatements = splitStatements(schemaSql);

      for (const stmt of schemaStatements) {
        await conn.run(stmt);
      }

      // Read and execute views.sql (analytical views)
      const viewsPath = path.join(sqlDir, "views.sql");
      const viewsSql = await fs.readFile(viewsPath, "utf-8");
      const viewStatements = splitStatements(viewsSql);

      for (const stmt of viewStatements) {
        await conn.run(stmt);
      }
    } catch (err) {
      if (err instanceof MigrationError) {
        throw err;
      }
      throw new MigrationError(CURRENT_VERSION, err as Error);
    }
  }

  /**
   * Run pending migrations from the current version to the latest.
   *
   * @param connection - Active DuckDB connection
   * @returns Number of migrations applied
   * @throws MigrationError if any migration fails (rolled back)
   */
  async migrate(connection: unknown): Promise<number> {
    const currentVersion = await this.getVersion(connection);

    if (currentVersion >= CURRENT_VERSION) {
      return 0;
    }

    // For v0.1.0, if version is 0 (no schema), run full initialization
    if (currentVersion === 0) {
      await this.initialize(connection);
      return 1;
    }

    // Future migrations would go here as:
    // if (currentVersion < 2) { applyMigration2(connection); }
    // if (currentVersion < 3) { applyMigration3(connection); }

    return 0;
  }

  /**
   * Get the current schema version number.
   * Returns 0 if no schema has been initialized.
   *
   * @param connection - Active DuckDB connection
   * @returns Current schema version
   */
  async getVersion(connection: unknown): Promise<number> {
    const conn = connection as {
      runAndReadAll(sql: string): Promise<{
        getRowObjectsJS(): Record<string, unknown>[];
        currentRowCount: number;
      }>;
    };

    try {
      const reader = await conn.runAndReadAll(
        "SELECT MAX(version) AS version FROM schema_migrations",
      );

      if (reader.currentRowCount === 0) {
        return 0;
      }

      const rows = reader.getRowObjectsJS();
      const version = rows[0]?.version;

      // MAX() returns null if the table is empty
      if (version === null || version === undefined) {
        return 0;
      }

      return Number(version);
    } catch {
      // Table doesn't exist yet — schema not initialized
      return 0;
    }
  }
}
