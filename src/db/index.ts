/**
 * @module db
 *
 * Barrel export for the database module.
 * Provides DuckDB connection management, schema initialization, and query execution.
 */

export { ConnectionManager } from "./connection.js";
export { SchemaManager } from "./schema.js";
export { QueryExecutor } from "./executor.js";
