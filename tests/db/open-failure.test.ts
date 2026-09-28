/**
 * @module tests/db/open-failure
 *
 * Classification and wording of DuckDB open failures. The messages are the
 * ones DuckDB 1.4.5 produces for each case.
 */

import { describe, it, expect } from "vitest";
import { classifyOpenFailure, describeOpenFailure } from "../../src/db/open-failure.js";
import { DatabaseOpenError, formatError } from "../../src/errors.js";

const LOCKED =
  'IO Error: Could not set lock on file "/x/a.duckdb": Conflicting lock is held in /usr/bin/node (PID 7) by user u. See also https://duckdb.org/docs/stable/connect/concurrency';
const WAL_REPLAY =
  'IO Error: Failure while replaying WAL file "/x/a.duckdb.wal": Corrupt WAL file: entry at byte position 56 computed checksum 1 does not match stored checksum 2';
const VERSION =
  "IO Error: Trying to read a database file with version number 68, but we can only read versions between 64 and 67.\nThe database file was created with an newer version of DuckDB.";
const NOT_DUCKDB =
  'IO Error: The file "/x/a.duckdb" exists, but it is not a valid DuckDB database file!';
const SHORT_READ =
  'IO Error: Could not read enough bytes from file "/x/a.duckdb": attempted to read 262144 bytes from location 8192';

describe("classifyOpenFailure", () => {
  it.each([
    [LOCKED, "locked"],
    [WAL_REPLAY, "wal-replay"],
    [VERSION, "version"],
    [NOT_DUCKDB, "unreadable"],
    [SHORT_READ, "unreadable"],
    ["INTERNAL Error: Attempted to access index 3 within vector of size 3", "unreadable"],
  ])("classifies %s", (message, reason) => {
    expect(classifyOpenFailure(message)).toBe(reason);
  });
});

describe("describeOpenFailure", () => {
  it("points a damaged WAL at `db recover` and says nothing changed", () => {
    const err = describeOpenFailure("/x/a.duckdb", new Error(WAL_REPLAY));
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect(err.reason).toBe("wal-replay");
    expect(err.dbPath).toBe("/x/a.duckdb");
    expect(err.walPath).toBe("/x/a.duckdb.wal");
    expect(err.message).toBe(`Could not open the database /x/a.duckdb: ${WAL_REPLAY}`);
    expect(err.hint).toContain("ccanalytics db recover");
    expect(err.hint).toContain("nothing was changed");
  });

  it("points a damaged database file at `db recover`", () => {
    expect(describeOpenFailure("/x/a.duckdb", new Error(NOT_DUCKDB)).hint).toContain(
      "ccanalytics db recover",
    );
  });

  it("does not suggest recovery for a lock or a version mismatch", () => {
    for (const message of [LOCKED, VERSION]) {
      const err = describeOpenFailure("/x/a.duckdb", new Error(message));
      expect(err.hint).not.toContain("db recover");
      expect(err.hint.length).toBeGreaterThan(0);
    }
  });

  it("keeps only the first line of DuckDB's message", () => {
    const err = describeOpenFailure("/x/a.duckdb", new Error(VERSION));
    expect(err.message).not.toContain("\n");
    expect(err.cause?.message).toBe(VERSION);
  });

  it("gives an in-memory database no hint and no WAL", () => {
    const err = describeOpenFailure(":memory:", new Error("IO Error: out of memory"));
    expect(err.hint).toBe("");
    expect(err.walPresent).toBe(false);
  });

  it("formatError appends the hint", () => {
    const err = describeOpenFailure("/x/a.duckdb", new Error(NOT_DUCKDB));
    expect(formatError(err, false)).toBe(
      `Error: [DATABASE] ${err.message}\n  Hint: ${err.hint}`,
    );
  });
});
