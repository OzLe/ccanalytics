/**
 * @module tests/ingestion/skill-listing-parser
 *
 * Unit tests for parseSkillListing() (P-04) — the pure continuation-line
 * parser for the `skill_listing` attachment's `content` field.
 *
 * Covers the four cases called out in the Chunk A test plan:
 *   1. single-line skills
 *   2. plugin-namespaced colon names (babysitter:babysit, ...)
 *   3. multi-line TRIGGER/SKIP continuation lines
 *   4. parsed.length === attachment.skillCount integrity assertion
 * plus the mismatch path (parser never throws; caller logs the warning).
 */

import { describe, it, expect } from "vitest";
import { parseSkillListing } from "../../src/ingestion/skill-listing-parser.js";

describe("parseSkillListing", () => {
  it("parses single-line skills (name + description)", () => {
    const content =
      "- update-config: Configure the Claude Code harness via settings.json.\n" +
      "- simplify: Review changed code for reuse, quality, and efficiency.";

    const parsed = parseSkillListing(content);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      name: "update-config",
      description: "Configure the Claude Code harness via settings.json.",
    });
    expect(parsed[1]).toEqual({
      name: "simplify",
      description: "Review changed code for reuse, quality, and efficiency.",
    });
  });

  it("parses plugin-namespaced skill names with colons", () => {
    // The namespace colon has no trailing space, so `[^:]+(?::[^:]+)*` keeps
    // it as part of the name and only the ": " before the description splits.
    const content =
      "- babysitter:babysit: Orchestrate via @babysitter.\n" +
      "- chrome-devtools-mcp:chrome-devtools: Uses Chrome DevTools via MCP.\n" +
      "- llm-application-dev:rag-implementation: Build RAG systems.";

    const parsed = parseSkillListing(content);

    expect(parsed).toHaveLength(3);
    expect(parsed.map((s) => s.name)).toEqual([
      "babysitter:babysit",
      "chrome-devtools-mcp:chrome-devtools",
      "llm-application-dev:rag-implementation",
    ]);
    expect(parsed[0].description).toBe("Orchestrate via @babysitter.");
    expect(parsed[1].description).toBe("Uses Chrome DevTools via MCP.");
  });

  it("appends multi-line TRIGGER/SKIP continuation lines to the previous skill", () => {
    const content =
      "- claude-api: Build, debug, and optimize Claude API apps.\n" +
      "TRIGGER when: code imports `anthropic`; user adds a Claude feature.\n" +
      "SKIP: file imports `openai`/other-provider SDK, provider-neutral code.\n" +
      "- init: Initialize a new CLAUDE.md file.";

    const parsed = parseSkillListing(content);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("claude-api");
    expect(parsed[0].description).toBe(
      "Build, debug, and optimize Claude API apps. " +
        "TRIGGER when: code imports `anthropic`; user adds a Claude feature. " +
        "SKIP: file imports `openai`/other-provider SDK, provider-neutral code.",
    );
    // The continuation lines did NOT start a new skill.
    expect(parsed[1]).toEqual({
      name: "init",
      description: "Initialize a new CLAUDE.md file.",
    });
  });

  it("integrity: parsed.length === attachment.skillCount for clean input", () => {
    // A skill_listing-shaped payload: N skill lines + some continuation lines,
    // skillCount counts only the skill lines.
    const attachment = {
      type: "skill_listing" as const,
      isInitial: true,
      skillCount: 3,
      content:
        "- alpha: First skill.\n" +
        "- beta: Second skill.\n" +
        "continuation of beta's description.\n" +
        "- gamma: Third skill.",
    };

    const parsed = parseSkillListing(attachment.content);

    expect(parsed).toHaveLength(attachment.skillCount);
    expect(parsed.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(parsed[1].description).toBe(
      "Second skill. continuation of beta's description.",
    );
  });

  it("does not throw on a skillCount mismatch — the caller owns the integrity check", () => {
    // A description whose continuation line itself looks like a "- name: desc"
    // skill line is miscounted as an extra skill (the documented R-LOW drift
    // case). The parser must still return cleanly so the adapter can log a
    // warning and trust attachment.skillCount rather than failing the batch.
    const attachment = {
      skillCount: 1,
      content:
        "- only: a skill whose description continues with an example\n" +
        "- usage: run it like this",
    };

    let parsed: ReturnType<typeof parseSkillListing> | undefined;
    expect(() => {
      parsed = parseSkillListing(attachment.content);
    }).not.toThrow();

    expect(parsed).toBeDefined();
    // Parser found 2 skill-shaped lines; this DIFFERS from skillCount=1 — the
    // caller is responsible for noticing and warning, not the parser.
    expect(parsed!.length).toBe(2);
    expect(parsed!.length).not.toBe(attachment.skillCount);
  });

  it("handles a skill with an empty description", () => {
    const parsed = parseSkillListing("- bare:\n- next: has one");
    expect(parsed).toEqual([
      { name: "bare", description: "" },
      { name: "next", description: "has one" },
    ]);
  });

  it("returns [] for empty / whitespace-only content", () => {
    expect(parseSkillListing("")).toEqual([]);
    expect(parseSkillListing("\n\n  \n")).toEqual([]);
  });

  it("ignores a continuation line that appears before any skill line", () => {
    // Malformed input — a leading non-"- " line has no skill to attach to.
    const parsed = parseSkillListing("stray leading line\n- real: a skill");
    expect(parsed).toEqual([{ name: "real", description: "a skill" }]);
  });

  it("trims surrounding whitespace from names and descriptions", () => {
    const parsed = parseSkillListing("-  spaced :   padded description  ");
    expect(parsed).toEqual([{ name: "spaced", description: "padded description" }]);
  });
});
