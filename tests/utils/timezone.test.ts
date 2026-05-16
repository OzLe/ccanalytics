/**
 * @module tests/utils/timezone
 *
 * Tests for the IANA timezone validation + projection helpers (ACT-001 /
 * SEM2-293). The DuckDB-side projection invariant is exercised in
 * `tests/queries/time-series.test.ts` and the per-route integration tests;
 * this file only covers the pure-JS helpers.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
  wrapTimestampForTz,
} from "../../src/utils/timezone.js";

describe("timezone utils", () => {
  describe("DEFAULT_TIMEZONE", () => {
    it("should be UTC", () => {
      expect(DEFAULT_TIMEZONE).toBe("UTC");
    });
  });

  describe("isValidTimezone", () => {
    it.each([
      "UTC",
      "GMT",
      "Asia/Jerusalem",
      "Asia/Tokyo",
      "America/New_York",
      "America/Los_Angeles",
      "America/Argentina/Buenos_Aires",
      "Europe/London",
      "Europe/Paris",
      "Pacific/Auckland",
      "Australia/Sydney",
    ])("accepts well-known IANA zone %s", (tz) => {
      expect(isValidTimezone(tz)).toBe(true);
    });

    it.each([
      "",
      "  ",
      "Bogus/NotReal",
      "America/Atlantis",
      "Asia/Wonderland",
      // Reject SQL injection / quoting attempts.
      "'; DROP TABLE conversation_turns; --",
      "UTC; DELETE FROM users",
      "UTC OR 1=1",
      "../../../etc/passwd",
    ])("rejects invalid zone %s", (tz) => {
      expect(isValidTimezone(tz)).toBe(false);
    });

    it.each([null, undefined, 42, true, false, {}, []])(
      "rejects non-string input %s",
      (tz) => {
        expect(isValidTimezone(tz)).toBe(false);
      },
    );
  });

  describe("resolveTimezone", () => {
    it("returns the input when it's a valid IANA zone", () => {
      expect(resolveTimezone("Asia/Jerusalem")).toBe("Asia/Jerusalem");
      expect(resolveTimezone("UTC")).toBe("UTC");
    });

    it("falls back to UTC for invalid input", () => {
      expect(resolveTimezone("Bogus/NotReal")).toBe("UTC");
      expect(resolveTimezone("")).toBe("UTC");
      expect(resolveTimezone(undefined)).toBe("UTC");
      expect(resolveTimezone(null)).toBe("UTC");
      expect(resolveTimezone(42)).toBe("UTC");
    });
  });

  describe("wrapTimestampForTz", () => {
    it("wraps a column with the double-AT-TIME-ZONE projection", () => {
      expect(wrapTimestampForTz("ct.timestamp", "$3")).toBe(
        "((ct.timestamp AT TIME ZONE 'UTC') AT TIME ZONE $3)",
      );
    });

    it("works with bare column names", () => {
      expect(wrapTimestampForTz("timestamp", "$3")).toBe(
        "((timestamp AT TIME ZONE 'UTC') AT TIME ZONE $3)",
      );
    });

    it("accepts arbitrary bind references / literals", () => {
      expect(wrapTimestampForTz("ct.timestamp", "'Asia/Jerusalem'")).toBe(
        "((ct.timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem')",
      );
    });
  });
});
