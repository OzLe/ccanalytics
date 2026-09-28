/**
 * @module tests/ingestion/adapters/usage
 *
 * Transcript usage parsing and pricing, including the 5-minute / 1-hour
 * cache-write split and the defaults for transcripts that lack it.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeUsage,
  oneHourCacheWrites,
  usageCost,
} from "../../../src/ingestion/adapters/usage.js";
import { calculateCost } from "../../../src/utils/pricing.js";

const RECORDED = {
  input_tokens: 2,
  output_tokens: 1_075,
  cache_creation_input_tokens: 581,
  cache_read_input_tokens: 506_675,
  cache_creation: { ephemeral_1h_input_tokens: 581, ephemeral_5m_input_tokens: 0 },
};

const UNRECORDED = {
  input_tokens: 2,
  output_tokens: 1_075,
  cache_creation_input_tokens: 581,
  cache_read_input_tokens: 506_675,
};

describe("normalizeUsage", () => {
  it("keeps the 1-hour share when the transcript records the split", () => {
    expect(normalizeUsage(RECORDED)).toEqual({
      input_tokens: 2,
      output_tokens: 1_075,
      cache_creation_input_tokens: 581,
      cache_read_input_tokens: 506_675,
      cache_creation_1h_input_tokens: 581,
    });
  });

  it("reads a recorded split without 1-hour writes as 0", () => {
    const u = normalizeUsage({ ...UNRECORDED, cache_creation: { ephemeral_5m_input_tokens: 581 } });
    expect(u.cache_creation_1h_input_tokens).toBe(0);
  });

  it("marks an unrecorded split as null", () => {
    expect(normalizeUsage(UNRECORDED).cache_creation_1h_input_tokens).toBeNull();
  });

  it("treats missing usage as zero tokens", () => {
    expect(normalizeUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_1h_input_tokens: null,
    });
  });
});

describe("oneHourCacheWrites / usageCost", () => {
  it("uses the recorded split whatever the default", () => {
    const u = normalizeUsage({ ...UNRECORDED, cache_creation: { ephemeral_1h_input_tokens: 100 } });
    expect(oneHourCacheWrites(u, "1h")).toBe(100);
    expect(oneHourCacheWrites(u, "5m")).toBe(100);
  });

  it("applies the default when the split is unrecorded", () => {
    const u = normalizeUsage(UNRECORDED);
    expect(oneHourCacheWrites(u, "1h")).toBe(581);
    expect(oneHourCacheWrites(u, "5m")).toBe(0);
  });

  it("prices a main-thread turn's unrecorded writes as 1-hour writes", () => {
    expect(usageCost("claude-opus-5-5", normalizeUsage(UNRECORDED), "1h")).toBeCloseTo(
      calculateCost("claude-opus-5-5", 2, 1_075, 581, 506_675, 581),
      12,
    );
    expect(usageCost("claude-opus-5-5", normalizeUsage(UNRECORDED), "5m")).toBeCloseTo(
      calculateCost("claude-opus-5-5", 2, 1_075, 581, 506_675, 0),
      12,
    );
  });
});
