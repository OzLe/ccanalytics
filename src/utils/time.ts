/**
 * @module utils/time
 *
 * Shared time/period utilities used across commands.
 */

import type { TimeRange } from "../types/index.js";

/**
 * Parse a period string into a TimeRange (inclusive start, exclusive end).
 *
 * Supported values: "today", "7d", "30d", "90d", "all".
 * Unknown values fall back to "7d".
 *
 * @param period - Period identifier
 * @returns TimeRange with start and end dates
 */
export function parsePeriod(period: string): TimeRange {
  const now = new Date();
  const end = now;
  let start: Date;

  switch (period) {
    case "today": {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    }
    case "7d": {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case "30d": {
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
    case "90d": {
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    }
    case "all": {
      start = new Date("2020-01-01");
      break;
    }
    default: {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
  }

  return { start, end };
}
