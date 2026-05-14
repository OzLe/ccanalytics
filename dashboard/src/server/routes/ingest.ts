/**
 * @module server/routes/ingest
 *
 * Ingest API endpoint — POST /api/ingest.
 *
 * Triggers an incremental ingestion pass from the dashboard UI. It runs the
 * SHARED `runIngestion()` orchestration (`src/ingestion/run-ingestion.ts`) —
 * the exact same code path the `ccanalytics ingest` CLI command uses — so the
 * button and the CLI can never drift apart.
 *
 * Why in-process, not a subprocess:
 *   DuckDB is single-writer. The API server already holds a read-write
 *   connection to `analytics.duckdb`. Spawning the `ccanalytics ingest` CLI
 *   would open a SECOND connection and deadlock on the file lock. Instead this
 *   route reuses the server's own connection (`getIngestConnection()`), so the
 *   pipeline writes through the connection the server already owns.
 *
 * Why a runtime-resolved dynamic import:
 *   The dashboard server runs under `tsx`, which resolves the parent-package
 *   module fine at runtime. Resolving the path at runtime (rather than a static
 *   import) keeps the dashboard's `tsc -b` from pulling the entire parent
 *   ingestion project — which has its own, separate tsconfig — into this
 *   project's typecheck. The typed boundary below is the contract.
 */

import { Router } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envelope } from "../helpers/parseFilters.js";
import { getIngestConnection } from "../helpers/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Summary of one ingestion pass.
 * Mirrors `IngestionResult` in the parent package (`src/types/index.ts`).
 */
interface IngestionResult {
  filesDiscovered: number;
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  failedFiles: Array<{ path: string; error: string }>;
  entriesIngested: number;
  duplicatesRemoved: number;
  parseErrors: number;
  durationMs: number;
}

/**
 * Typed boundary for the parent package's shared `runIngestion()`
 * orchestration. This is the contract the dynamic import is cast to.
 */
type RunIngestion = (options: {
  db: { getConnection(): unknown };
  source?: "all" | "claude-code" | "claude-desktop";
  force?: boolean;
}) => Promise<{ result: IngestionResult; config: unknown }>;

/**
 * Dynamically load `runIngestion` from the parent package. The module path is
 * resolved at runtime (not a static string literal) on purpose — see the
 * module header for why.
 */
async function loadRunIngestion(): Promise<RunIngestion> {
  const modulePath = path.resolve(
    __dirname,
    "../../../../src/ingestion/run-ingestion.ts",
  );
  const mod = (await import(modulePath)) as { runIngestion: RunIngestion };
  return mod.runIngestion;
}

const router = Router();

/**
 * Module-level guard: only one ingestion may run at a time. Ingestion writes
 * through the server's single DuckDB connection, so overlapping runs are both
 * unsafe and pointless — a second request gets 409 while one is in flight.
 */
let isIngesting = false;

/**
 * POST /api/ingest
 *
 * Runs an incremental ingestion pass (all sources) and returns the
 * `IngestionResult` summary. Returns 409 if an ingestion is already running.
 */
router.post("/", async (_req, res, next) => {
  if (isIngesting) {
    return res.status(409).json({
      error: "Conflict",
      message:
        "An ingestion is already running. Please wait for it to finish.",
    });
  }

  isIngesting = true;
  try {
    const runIngestion = await loadRunIngestion();
    const db = await getIngestConnection();
    const { result } = await runIngestion({ db, source: "all" });
    res.json(envelope(result, "all"));
  } catch (err) {
    next(err);
  } finally {
    isIngesting = false;
  }
});

export default router;
