/**
 * @module utils/format
 *
 * Output formatting utilities for rendering query results as
 * terminal tables, JSON, or CSV. Uses cli-table3 for table rendering
 * and picocolors for terminal color output.
 */

import Table from "cli-table3";
import type { OutputFormat } from "../types/index.js";

/** Column definition for table and CSV output. */
export interface TableColumn {
  /** Column header text. */
  header: string;
  /** Key in the row object. */
  key: string;
  /** Column alignment. Default: "left" */
  align?: "left" | "center" | "right";
  /** Custom value formatter. */
  format?: (value: unknown) => string;
  /** Maximum column width in characters. */
  maxWidth?: number;
}

/**
 * OutputFormatter class providing table, JSON, and CSV formatting.
 *
 * All formatting methods return strings suitable for writing to stdout.
 */
export class OutputFormatter {
  /**
   * Format data as a terminal table using cli-table3.
   * @param rows - Array of row objects
   * @param columns - Column definitions controlling headers and formatting
   * @returns Formatted table string
   */
  formatTable<T extends Record<string, unknown>>(
    rows: T[],
    columns: TableColumn[],
  ): string {
    const table = new Table({
      head: columns.map((col) => col.header),
      colAligns: columns.map((col) => col.align ?? "left"),
      style: {
        head: [],
        border: [],
      },
    });

    for (const row of rows) {
      const cells = columns.map((col) => {
        const rawValue = row[col.key];
        let formatted: string;

        if (col.format) {
          formatted = col.format(rawValue);
        } else if (rawValue === null || rawValue === undefined) {
          formatted = "";
        } else {
          formatted = String(rawValue);
        }

        // Apply maxWidth truncation
        if (col.maxWidth && formatted.length > col.maxWidth) {
          formatted = formatted.slice(0, col.maxWidth - 1) + "\u2026";
        }

        return formatted;
      });

      table.push(cells);
    }

    return table.toString();
  }

  /**
   * Format data as pretty-printed JSON.
   * @param data - Any serializable data
   * @returns JSON string with 2-space indentation
   */
  formatJson(data: unknown): string {
    return JSON.stringify(data, null, 2);
  }

  /**
   * Format data as CSV with a header row.
   * Values containing commas, quotes, or newlines are escaped per RFC 4180.
   * @param rows - Array of row objects
   * @param columns - Column definitions controlling headers
   * @returns CSV string with header row
   */
  formatCsv<T extends Record<string, unknown>>(
    rows: T[],
    columns: TableColumn[],
  ): string {
    const escapeCsvValue = (value: unknown): string => {
      if (value === null || value === undefined) {
        return "";
      }
      const str = String(value);
      // RFC 4180: if value contains comma, double quote, or newline, wrap in quotes
      if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
        // Double any internal double quotes
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    // Header row
    const headerRow = columns.map((col) => escapeCsvValue(col.header)).join(",");

    // Data rows
    const dataRows = rows.map((row) => {
      return columns
        .map((col) => {
          const rawValue = row[col.key];
          return escapeCsvValue(rawValue);
        })
        .join(",");
    });

    return [headerRow, ...dataRows].join("\n");
  }

  /**
   * Auto-format based on the configured output format.
   * Delegates to formatTable(), formatJson(), or formatCsv().
   */
  auto<T extends Record<string, unknown>>(
    rows: T[],
    columns: TableColumn[],
    format: OutputFormat,
  ): string {
    switch (format) {
      case "table":
        return this.formatTable(rows, columns);
      case "json":
        return this.formatJson(rows);
      case "csv":
        return this.formatCsv(rows, columns);
      default:
        throw new TypeError(
          `Unknown output format: ${format}. Valid options: table, json, csv`,
        );
    }
  }

  /**
   * Format a single key-value summary (for dashboard panels).
   * @param entries - Array of label-value pairs
   * @returns Formatted summary string
   */
  formatSummary(
    entries: Array<{ label: string; value: string | number }>,
  ): string {
    if (entries.length === 0) {
      return "";
    }

    // Calculate max label width for alignment
    const maxLabelWidth = Math.max(...entries.map((e) => e.label.length));

    return entries
      .map((entry) => {
        const paddedLabel = entry.label.padEnd(maxLabelWidth);
        return `  ${paddedLabel}  ${entry.value}`;
      })
      .join("\n");
  }

  /**
   * Format a cost value with currency symbol and appropriate precision.
   * @param usd - Cost in USD
   * @returns Formatted string, e.g. "$6.30"
   */
  formatCost(usd: number): string {
    return `$${usd.toFixed(2)}`;
  }

  /**
   * Format a token count with thousands separators.
   * @param count - Token count
   * @returns Formatted string, e.g. "1,234,567"
   */
  formatTokens(count: number): string {
    return count.toLocaleString("en-US");
  }

  /**
   * Format a percentage with one decimal place.
   * @param ratio - Ratio between 0 and 1
   * @returns Formatted string, e.g. "82.4%"
   */
  formatPercent(ratio: number): string {
    return `${(ratio * 100).toFixed(1)}%`;
  }

  /**
   * Format a duration in milliseconds to human-readable string.
   * @param ms - Duration in milliseconds
   * @returns Formatted string, e.g. "34m 12s", "1h 4m"
   */
  formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
  }
}
