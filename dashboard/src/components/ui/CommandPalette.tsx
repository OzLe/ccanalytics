import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "cmdk";
import { cn } from "@/lib/utils";
import { pages } from "@/lib/pages";
import { Search, ArrowRight, SlidersHorizontal, type LucideIcon } from "lucide-react";

/* ── Action definitions ──────────────────────────────────── */
interface CommandAction {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  onSelect: () => void;
  keywords?: string[];
}

interface CommandPaletteProps {
  /** Additional actions (e.g. toggle filters) to show in the palette */
  actions?: CommandAction[];
}

export default function CommandPalette({ actions = [] }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  /* ── Keyboard shortcut: Cmd+K / Ctrl+K ─────────────── */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    },
    []
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  /* ── Navigation handler ────────────────────────────── */
  const handlePageSelect = useCallback(
    (path: string) => {
      navigate(path);
      setOpen(false);
    },
    [navigate]
  );

  if (!open) return null;

  return (
    <>
      {/* Scrim overlay */}
      <div
        className="fixed inset-0 z-[var(--z-command-palette)] bg-[var(--bg-scrim)] animate-fade-in"
        onClick={() => setOpen(false)}
      />

      {/* Command palette container */}
      <div className="fixed inset-0 z-[calc(var(--z-command-palette)+1)] flex items-start justify-center pt-[20vh]">
        <Command
          label="Command palette"
          loop
          className={cn(
            "w-full max-w-lg overflow-hidden rounded-[var(--radius-xl)]",
            "glass shadow-[var(--shadow-xl)]",
            "border border-[rgba(255,255,255,0.08)]",
            "animate-scale-in"
          )}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        >
          {/* ── Search input ───────────────────────────── */}
          <div className="flex items-center gap-[var(--space-3)] border-b border-[var(--border-subtle)] px-[var(--space-4)]">
            <Search
              size={18}
              className="shrink-0 text-[var(--text-tertiary)]"
            />
            <CommandInput
              placeholder="Search pages, actions..."
              className={cn(
                "flex-1 bg-transparent py-[var(--space-3)]",
                "text-[var(--font-body-size)] text-[var(--text-primary)]",
                "placeholder:text-[var(--text-tertiary)]",
                "outline-none border-none"
              )}
            />
            <kbd
              className={cn(
                "hidden shrink-0 select-none rounded-[var(--radius-sm)] sm:inline-flex",
                "border border-[var(--border)] bg-[var(--bg-surface)]",
                "px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)]"
              )}
            >
              ESC
            </kbd>
          </div>

          {/* ── Results list ───────────────────────────── */}
          <CommandList
            className={cn(
              "max-h-72 overflow-y-auto overscroll-contain",
              "p-[var(--space-2)]"
            )}
          >
            <CommandEmpty className="flex items-center justify-center py-[var(--space-8)] text-[var(--font-small-size)] text-[var(--text-tertiary)]">
              No results found.
            </CommandEmpty>

            {/* Pages group */}
            <CommandGroup
              heading="Pages"
              className="[&_[cmdk-group-heading]]:text-overline [&_[cmdk-group-heading]]:px-[var(--space-2)] [&_[cmdk-group-heading]]:py-[var(--space-2)] [&_[cmdk-group-heading]]:text-[var(--text-tertiary)]"
            >
              {pages.map((page) => {
                const Icon = page.icon;
                return (
                  <CommandItem
                    key={page.path}
                    value={page.label}
                    keywords={page.keywords}
                    onSelect={() => handlePageSelect(page.path)}
                    className={cn(
                      "flex items-center gap-[var(--space-3)] rounded-[var(--radius-md)]",
                      "px-[var(--space-3)] py-[var(--space-2)]",
                      "text-[var(--font-body-size)] text-[var(--text-secondary)]",
                      "cursor-pointer select-none",
                      "transition-colors duration-[var(--duration-fast)]",
                      "aria-selected:bg-[var(--accent-subtle)] aria-selected:text-[var(--text-primary)]"
                    )}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="flex-1">{page.label}</span>
                    <ArrowRight
                      size={14}
                      className="shrink-0 opacity-0 transition-opacity duration-[var(--duration-fast)] [[aria-selected=true]_&]:opacity-100"
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>

            {/* Actions group */}
            {actions.length > 0 && (
              <>
                <CommandSeparator className="my-[var(--space-1)] h-px bg-[var(--border-subtle)]" />
                <CommandGroup
                  heading="Actions"
                  className="[&_[cmdk-group-heading]]:text-overline [&_[cmdk-group-heading]]:px-[var(--space-2)] [&_[cmdk-group-heading]]:py-[var(--space-2)] [&_[cmdk-group-heading]]:text-[var(--text-tertiary)]"
                >
                  {actions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <CommandItem
                        key={action.id}
                        value={action.label}
                        keywords={action.keywords}
                        onSelect={() => {
                          action.onSelect();
                          setOpen(false);
                        }}
                        className={cn(
                          "flex items-center gap-[var(--space-3)] rounded-[var(--radius-md)]",
                          "px-[var(--space-3)] py-[var(--space-2)]",
                          "text-[var(--font-body-size)] text-[var(--text-secondary)]",
                          "cursor-pointer select-none",
                          "transition-colors duration-[var(--duration-fast)]",
                          "aria-selected:bg-[var(--accent-subtle)] aria-selected:text-[var(--text-primary)]"
                        )}
                      >
                        <Icon size={16} className="shrink-0" />
                        <span className="flex-1">{action.label}</span>
                        {action.shortcut && (
                          <kbd
                            className={cn(
                              "shrink-0 select-none rounded-[var(--radius-sm)]",
                              "border border-[var(--border)] bg-[var(--bg-surface)]",
                              "px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)]"
                            )}
                          >
                            {action.shortcut}
                          </kbd>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>

          {/* ── Footer hint ────────────────────────────── */}
          <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-[var(--space-4)] py-[var(--space-2)]">
            <div className="flex items-center gap-[var(--space-2)]">
              <SlidersHorizontal size={12} className="text-[var(--text-tertiary)]" />
              <span className="text-[11px] text-[var(--text-tertiary)]">
                Navigate with arrow keys
              </span>
            </div>
            <div className="flex items-center gap-[var(--space-1)]">
              <kbd className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-surface)] px-1 py-px text-[10px] text-[var(--text-tertiary)]">
                &crarr;
              </kbd>
              <span className="text-[11px] text-[var(--text-tertiary)]">to select</span>
            </div>
          </div>
        </Command>
      </div>
    </>
  );
}

export type { CommandAction };
