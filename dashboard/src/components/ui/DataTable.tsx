import { cn } from "@/lib/utils";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import Skeleton from "./Skeleton";
import EmptyState from "./EmptyState";
import { Table } from "lucide-react";

/* ── Types ───────────────────────────────────────────────── */
interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  align?: "left" | "center" | "right";
  width?: string;
}

interface PaginationConfig {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  sortField?: string;
  sortOrder?: "asc" | "desc";
  onSort?: (field: string) => void;
  onRowClick?: (row: T) => void;
  rowAriaLabel?: string;
  loading?: boolean;
  emptyMessage?: string;
  pagination?: PaginationConfig;
  className?: string;
}

/* ── Alignment utility ───────────────────────────────────── */
const alignClass = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

/* ── Sort icon ───────────────────────────────────────────── */
function SortIcon({
  field,
  sortField,
  sortOrder,
}: {
  field: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
}) {
  if (sortField !== field) {
    return <ChevronsUpDown size={14} className="text-[var(--text-tertiary)] opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100" />;
  }
  return sortOrder === "asc" ? (
    <ChevronUp size={14} className="text-[var(--accent)]" />
  ) : (
    <ChevronDown size={14} className="text-[var(--accent)]" />
  );
}

/* ── Pagination ──────────────────────────────────────────── */
function Pagination({ page, pageSize, total, onPageChange }: PaginationConfig) {
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  if (total === 0) return null;

  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] px-[var(--space-4)] py-[var(--space-3)]">
      <span className="text-caption text-[var(--text-tertiary)]">
        {start.toLocaleString()}&ndash;{end.toLocaleString()} of{" "}
        {total.toLocaleString()}
      </span>

      <div className="flex items-center gap-[var(--space-1)]">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className={cn(
            "pagination-btn flex h-8 w-8 items-center justify-center",
            "rounded-[var(--radius-md)] border text-sm transition-all duration-[var(--duration-fast)]"
          )}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
        </button>

        <span className="text-caption px-[var(--space-2)] text-[var(--text-secondary)]">
          {page} / {totalPages}
        </span>

        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className={cn(
            "pagination-btn flex h-8 w-8 items-center justify-center",
            "rounded-[var(--radius-md)] border text-sm transition-all duration-[var(--duration-fast)]"
          )}
          aria-label="Next page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ── Loading skeleton rows ───────────────────────────────── */
function LoadingRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <tr key={rowIdx}>
          {Array.from({ length: columns }).map((_, colIdx) => (
            <td key={colIdx} className="px-[var(--space-4)] py-[var(--space-3)]">
              <Skeleton
                shape="text"
                className={cn("h-4", colIdx === 0 ? "w-3/5" : "w-2/5")}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/* ── Main DataTable Component ────────────────────────────── */
export default function DataTable<T>({
  columns,
  data,
  sortField,
  sortOrder,
  onSort,
  onRowClick,
  rowAriaLabel,
  loading = false,
  emptyMessage,
  pagination,
  className,
}: DataTableProps<T>) {
  const isEmpty = !loading && data.length === 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)]",
        "bg-[var(--bg-elevated)]",
        className
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] border-collapse">
          {/* ── Header ──────────────────────────────────────── */}
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-surface)]">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-[var(--space-4)] py-[var(--space-3)]",
                    "text-overline",
                    alignClass[col.align ?? "left"],
                    col.sortable && "table-header-sortable cursor-pointer select-none",
                    col.sortable && "group"
                  )}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={
                    col.sortable && onSort
                      ? () => onSort(col.key)
                      : undefined
                  }
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable && (
                      <SortIcon
                        field={col.key}
                        sortField={sortField}
                        sortOrder={sortOrder}
                      />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          {/* ── Body ────────────────────────────────────────── */}
          <tbody>
            {loading ? (
              <LoadingRows columns={columns.length} />
            ) : isEmpty ? null : (
              data.map((row, idx) => (
                <tr
                  key={idx}
                  className={cn(
                    "table-row-hover border-b border-[var(--border-subtle)] last:border-b-0",
                    onRowClick && "cursor-pointer"
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  {...(onRowClick ? {
                    tabIndex: 0,
                    role: "button" as const,
                    "aria-label": rowAriaLabel ?? "View details",
                    onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    },
                  } : {})}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-[var(--space-4)] py-[var(--space-3)]",
                        "text-body text-[var(--text-primary)]",
                        alignClass[col.align ?? "left"]
                      )}
                    >
                      {col.render
                        ? col.render(row)
                        : String((row as Record<string, unknown>)[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Empty state ──────────────────────────────────── */}
      {isEmpty && (
        <EmptyState
          icon={Table}
          title="No results"
          message={emptyMessage ?? "No data matches the current filters."}
          className="py-[var(--space-12)]"
        />
      )}

      {/* ── Pagination ───────────────────────────────────── */}
      {pagination && <Pagination {...pagination} />}
    </div>
  );
}

export type { Column, DataTableProps, PaginationConfig };
