/**
 * @module tests/helpers/damaged-db
 *
 * Builds the broken databases the open-failure tests need, the way they break
 * for real: a WAL left behind by a process that exited without a checkpoint,
 * then damaged; a file that is not a DuckDB database; a lock held by another
 * process. DuckDB runs in child processes so its file locks behave as they do
 * between the dashboard and the CLI.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Rows of table `t` that survive a checkpoint; the WAL holds 1,000 more. */
export const CHECKPOINTED_ROWS = 3;

// One DuckDB thread per fixture process: the default of one per core
// saturates the machine and starves time-sensitive tests running alongside,
// such as the chokidar watcher test.
const MAKE_DB_WITH_WAL = `
import { DuckDBInstance } from "@duckdb/node-api";
const inst = await DuckDBInstance.create(process.argv[1], { threads: "1" });
const conn = await inst.connect();
await conn.run("CREATE TABLE t (x INTEGER)");
await conn.run("INSERT INTO t VALUES (1), (2), (3)");
await conn.run("CHECKPOINT");
await conn.run("PRAGMA disable_checkpoint_on_shutdown");
await conn.run("SET checkpoint_threshold = '10GB'");
for (let k = 0; k < 5; k++) {
  await conn.run("INSERT INTO t SELECT range FROM range(" + k * 200 + ", " + (k + 1) * 200 + ")");
}
process.exit(0);
`;

const HOLD_OPEN = `
import { DuckDBInstance } from "@duckdb/node-api";
const inst = await DuckDBInstance.create(process.argv[1], { threads: "1" });
await inst.connect();
console.log("holding");
setInterval(() => {}, 1000);
`;

function runInline(code: string, arg: string): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, arg], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`fixture script failed: ${result.stderr}`);
  }
}

/** A database with checkpointed rows in table `t` and more rows only in its WAL. */
export function makeDbWithWal(dbPath: string): void {
  runInline(MAKE_DB_WITH_WAL, dbPath);
  if (!fs.existsSync(`${dbPath}.wal`)) {
    throw new Error("fixture script left no WAL behind");
  }
}

/** Flip 64 bytes in the middle of the WAL so its checksum fails on replay. */
export function corruptWal(dbPath: string): void {
  const walPath = `${dbPath}.wal`;
  const bytes = fs.readFileSync(walPath);
  const at = Math.floor(bytes.length / 2);
  for (let k = at; k < at + 64; k++) bytes[k] = bytes[k]! ^ 0xff;
  fs.writeFileSync(walPath, bytes);
}

/** A file that exists but is not a DuckDB database. */
export function writeGarbageDb(dbPath: string): void {
  fs.writeFileSync(dbPath, Buffer.alloc(4096, 0xde));
}

/** Hold the database open from another process until the child is killed. */
export async function holdOpen(dbPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", HOLD_OPEN, dbPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("holding")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return child;
}

/** Stop a child started by {@link holdOpen} and wait for it to exit. */
export async function release(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

/** SHA-256 of every file in `dir`, to prove a failure changed nothing. */
export function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) {
      out[name] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  return out;
}

/** SHA-256 of one file. */
export function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
