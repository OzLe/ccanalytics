import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

/* ── Skeleton variant system ─────────────────────────────── */
const skeletonVariants = cva(
  "animate-shimmer rounded-[var(--radius-md)]",
  {
    variants: {
      shape: {
        text: "h-3.5 w-full",
        card: "h-32 w-full rounded-[var(--radius-lg)]",
        chart: "h-48 w-full rounded-[var(--radius-lg)]",
        "table-row": "h-10 w-full rounded-[var(--radius-sm)]",
        circle: "rounded-full",
        custom: "",
      },
    },
    defaultVariants: {
      shape: "text",
    },
  }
);

interface SkeletonProps extends VariantProps<typeof skeletonVariants> {
  className?: string;
  width?: string;
  height?: string;
}

export default function Skeleton({
  className,
  shape = "text",
  width,
  height,
}: SkeletonProps) {
  return (
    <div
      className={cn(skeletonVariants({ shape }), className)}
      style={{
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      }}
    />
  );
}

/* ── Preset composites ───────────────────────────────────── */

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          shape="text"
          className={cn(i === lines - 1 && "w-3/5")}
        />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] p-[var(--space-6)]">
      <Skeleton shape="text" className="h-3 w-2/5" />
      <Skeleton shape="text" className="h-8 w-3/5" />
      <Skeleton shape="text" className="h-3 w-1/4" />
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="flex flex-col gap-[var(--space-3)]">
      <Skeleton shape="text" className="h-4 w-4/5" />
      <Skeleton shape="chart" />
      <div className="flex gap-[var(--space-4)]">
        <Skeleton shape="text" className="h-3 w-1/4" />
        <Skeleton shape="text" className="h-3 w-1/4" />
        <Skeleton shape="text" className="h-3 w-1/4" />
      </div>
    </div>
  );
}

export function SkeletonTableRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} shape="table-row" />
      ))}
    </div>
  );
}
