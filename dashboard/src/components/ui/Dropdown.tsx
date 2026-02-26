import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Check } from "lucide-react";

/* ── Types ───────────────────────────────────────────────── */
interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  label: string;
  options: DropdownOption[];
  selected: string[];
  onToggle: (value: string) => void;
  className?: string;
  loading?: boolean;
}

/* ── Dropdown Component ──────────────────────────────────── */
export default function Dropdown({
  label,
  options,
  selected,
  onToggle,
  className,
  loading,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const isActive = selected.length > 0;

  /* All items: "All" sentinel + real options */
  const allItemCount = 1 + options.length;

  /* ── Click-outside to close ─────────────────────────── */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  /* ── Keyboard navigation ────────────────────────────── */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
          setFocusIndex(0);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusIndex((prev) => (prev + 1) % allItemCount);
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusIndex((prev) => (prev - 1 + allItemCount) % allItemCount);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (focusIndex === 0) {
            /* "All" option — clear selection */
            if (selected.length > 0) {
              selected.forEach((v) => onToggle(v));
            }
            setOpen(false);
          } else if (focusIndex > 0) {
            const opt = options[focusIndex - 1];
            if (opt) {
              onToggle(opt.value);
              setOpen(false);
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
          break;
      }
    },
    [open, focusIndex, allItemCount, options, selected, onToggle],
  );

  /* ── Scroll focused item into view ──────────────────── */
  useEffect(() => {
    if (!open || focusIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll("[role='option']");
    const item = items[focusIndex];
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex, open]);

  /* ── Reset focus on open ────────────────────────────── */
  useEffect(() => {
    if (!open) {
      setFocusIndex(-1);
    }
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "inline-flex items-center gap-[6px] rounded-[var(--radius-full)]",
          "px-[14px] py-[5px] min-h-[44px] sm:min-h-0",
          "text-[12px] font-medium leading-[1.25] whitespace-nowrap",
          "transition-all duration-[var(--duration-fast)]",
          "border cursor-pointer",
          isActive
            ? "border-[var(--border-pill-active)] bg-[var(--bg-pill-active-strong)] text-[var(--text-primary)]"
            : "border-[var(--border-pill)] bg-transparent text-[var(--text-secondary)]",
          !isActive &&
            "hover:bg-[var(--bg-pill-hover)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)]",
          isActive && "hover:bg-[var(--bg-pill-active-hover)]",
          open && "bg-[var(--bg-pill-hover)] border-[var(--border-pill-active)]",
        )}
      >
        {isActive && (
          <span className="h-[6px] w-[6px] shrink-0 rounded-[var(--radius-full)] bg-[var(--accent)]" />
        )}
        <span>{label}</span>
        {isActive && (
          <span className="max-w-[100px] truncate opacity-70">
            {selected[0]}
          </span>
        )}
        <ChevronDown
          size={10}
          className={cn(
            "shrink-0 transition-transform duration-[var(--duration-normal)]",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={cn(
            "absolute right-0 top-[calc(100%+6px)] z-[var(--z-dropdown)]",
            "min-w-[200px] max-h-[280px] overflow-y-auto",
            "bg-[var(--bg-elevated)] backdrop-blur-[20px]",
            "border border-[var(--border)] rounded-[var(--radius-lg)]",
            "shadow-[var(--shadow-dropdown)] p-[var(--space-1)]",
            "animate-scale-in",
          )}
        >
          {/* "All" option */}
          <button
            role="option"
            aria-selected={!isActive}
            onClick={() => {
              if (selected.length > 0) {
                selected.forEach((v) => onToggle(v));
              }
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-[var(--space-2)] rounded-[var(--radius-md)]",
              "px-[var(--space-3)] py-[var(--space-2)] text-left text-[12px] leading-[1.35]",
              "transition-all duration-[var(--duration-fast)] cursor-pointer border-none",
              focusIndex === 0 && "ring-2 ring-[var(--accent)] ring-inset",
              !isActive
                ? "bg-[var(--accent-subtle)] text-[var(--accent-hover)]"
                : "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            {!isActive && (
              <Check size={14} className="shrink-0 text-[var(--accent)]" />
            )}
            <span>All</span>
          </button>

          {/* Separator */}
          <div className="mx-[var(--space-2)] my-[var(--space-1)] h-px bg-[var(--border)]" />

          {loading ? (
            <div className="flex items-center gap-[var(--space-1)] px-[var(--space-3)] py-[var(--space-2)]">
              <span className="inline-block h-1 w-1 animate-pulse rounded-[var(--radius-full)] bg-[var(--text-tertiary)]" />
              <span className="inline-block h-1 w-1 animate-pulse rounded-[var(--radius-full)] bg-[var(--text-tertiary)] [animation-delay:150ms]" />
              <span className="inline-block h-1 w-1 animate-pulse rounded-[var(--radius-full)] bg-[var(--text-tertiary)] [animation-delay:300ms]" />
            </div>
          ) : (
            options.map((opt, idx) => {
              const isSelected = selected.includes(opt.value);
              const isFocused = focusIndex === idx + 1;
              return (
                <button
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onToggle(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-[var(--space-2)] rounded-[var(--radius-md)]",
                    "px-[var(--space-3)] py-[var(--space-2)] text-left text-[12px] leading-[1.35]",
                    "transition-all duration-[var(--duration-fast)] cursor-pointer border-none",
                    isFocused && "ring-2 ring-[var(--accent)] ring-inset",
                    isSelected
                      ? "bg-[var(--accent-subtle)] text-[var(--accent-hover)]"
                      : "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                  )}
                >
                  {isSelected && (
                    <Check size={14} className="shrink-0 text-[var(--accent)]" />
                  )}
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export type { DropdownOption, DropdownProps };
