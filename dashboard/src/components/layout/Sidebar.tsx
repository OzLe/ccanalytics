import { NavLink } from "react-router-dom";
import { useState, useEffect, useCallback, type MutableRefObject } from "react";
import { cn } from "@/lib/utils";
import { pages } from "@/lib/pages";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Settings,
  X,
} from "lucide-react";

/* ── Constants ────────────────────────────────────────────── */
const STORAGE_KEY = "cc-sidebar-collapsed";
const SIDEBAR_WIDTH_EXPANDED = "w-[248px]";
const SIDEBAR_WIDTH_COLLAPSED = "w-[68px]";

/* ── Section definitions ──────────────────────────────────── */
const mainNav = pages.slice(0, 3); // Overview, Cost, Sessions
const insightsNav = pages.slice(3); // Prompts, Tools, Cache, Activity

/* ── Helpers ──────────────────────────────────────────────── */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* noop */
  }
}

/* ── Component ────────────────────────────────────────────── */
interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** Mutable ref that Layout can use to trigger sidebar collapse toggle */
  onToggleRef?: MutableRefObject<(() => void) | null>;
}

export default function Sidebar({ mobileOpen, onMobileClose, onToggleRef }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);

  /* Expose toggle to parent via ref */
  useEffect(() => {
    if (onToggleRef) {
      onToggleRef.current = toggleCollapse;
    }
  }, [onToggleRef, toggleCollapse]);

  /* Sync on storage change from other tabs */
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setCollapsed(e.newValue === "true");
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /* Close mobile sidebar on Escape */
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onMobileClose?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onMobileClose]);

  return (
    <>
      {/* Mobile scrim overlay */}
      <div
        className={cn(
          "fixed inset-0 z-[var(--z-overlay)] bg-[var(--bg-scrim)] lg:hidden",
          "transition-opacity duration-[var(--duration-normal)]",
          mobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        )}
        onClick={onMobileClose}
        aria-hidden="true"
      />

      <aside
        className={cn(
          /* Positioning & sizing */
          "fixed z-[var(--z-sidebar)] flex h-full flex-col lg:relative lg:z-auto",
          /* Background & border */
          "bg-[var(--bg-raised)] border-r border-[var(--border)]",
          /* Smooth width transition */
          "transition-all duration-[var(--duration-slow)] ease-[var(--ease-out)]",
          /* Mobile slide */
          mobileOpen
            ? "translate-x-0"
            : "-translate-x-full lg:translate-x-0",
          /* Width */
          collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED
        )}
      >
        {/* ── Logo area ─────────────────────────────────────── */}
        <div
          className={cn(
            "flex items-center border-b border-[var(--border)]",
            "h-[60px] shrink-0",
            collapsed ? "justify-center px-[var(--space-3)]" : "gap-[var(--space-3)] px-[var(--space-5)]"
          )}
        >
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center",
              "rounded-[var(--radius-md)] bg-[var(--accent)]"
            )}
          >
            <BarChart3 size={16} className="text-[var(--text-primary)]" />
          </div>
          {!collapsed && (
            <div className="flex flex-col overflow-hidden">
              <span className="truncate text-[var(--font-body-size)] font-semibold tracking-tight text-[var(--text-primary)]">
                CC Analytics
              </span>
              <span className="text-[length:var(--font-overline-size)] text-[var(--text-tertiary)]">
                v0.1.0
              </span>
            </div>
          )}
          {/* Mobile close button */}
          {mobileOpen && (
            <button
              onClick={onMobileClose}
              className={cn(
                "ml-auto flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] lg:hidden",
                "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
                "transition-colors duration-[var(--duration-fast)]"
              )}
              aria-label="Close sidebar"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* ── Navigation ────────────────────────────────────── */}
        <nav
          className={cn(
            "flex flex-1 flex-col gap-[var(--space-1)] overflow-y-auto overflow-x-hidden py-[var(--space-4)]",
            collapsed ? "px-[var(--space-2)]" : "px-[var(--space-3)]"
          )}
        >
          {/* Main section */}
          <NavSection
            items={mainNav}
            collapsed={collapsed}
            onMobileClose={onMobileClose}
          />

          {/* Divider */}
          <div
            className={cn(
              "mx-auto my-[var(--space-2)] h-px bg-[var(--border-subtle)]",
              collapsed ? "w-6" : "w-full"
            )}
          />

          {/* Section label */}
          {!collapsed && (
            <span className="mb-[var(--space-1)] px-[var(--space-3)] text-overline text-[var(--text-tertiary)]">
              Insights
            </span>
          )}

          {/* Insights section */}
          <NavSection
            items={insightsNav}
            collapsed={collapsed}
            onMobileClose={onMobileClose}
          />
        </nav>

        {/* ── Bottom area ───────────────────────────────────── */}
        <div
          className={cn(
            "flex shrink-0 flex-col gap-[var(--space-1)] border-t border-[var(--border)]",
            collapsed ? "px-[var(--space-2)]" : "px-[var(--space-3)]",
            "py-[var(--space-3)]"
          )}
        >
          {/* Settings link — routed to /settings */}
          <NavLink
            to="/settings"
            onClick={onMobileClose}
            className={cn(
              "flex items-center rounded-[var(--radius-md)]",
              "text-[var(--font-small-size)] font-medium text-[var(--text-tertiary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
              "transition-colors duration-[var(--duration-fast)]",
              collapsed
                ? "justify-center px-[var(--space-2)] py-[var(--space-2)]"
                : "gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)]"
            )}
            title={collapsed ? "Settings" : undefined}
          >
            <Settings size={18} className="shrink-0" />
            {!collapsed && <span>Settings</span>}
          </NavLink>

          {/* Collapse toggle (desktop only) */}
          <button
            onClick={toggleCollapse}
            className={cn(
              "hidden items-center rounded-[var(--radius-md)] lg:flex",
              "text-[var(--font-small-size)] font-medium text-[var(--text-tertiary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
              "transition-colors duration-[var(--duration-fast)]",
              collapsed
                ? "justify-center px-[var(--space-2)] py-[var(--space-2)]"
                : "gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)]"
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronsRight size={18} className="shrink-0" />
            ) : (
              <>
                <ChevronsLeft size={18} className="shrink-0" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  );
}

/* ── Nav section sub-component ────────────────────────────── */
function NavSection({
  items,
  collapsed,
  onMobileClose,
}: {
  items: typeof pages;
  collapsed: boolean;
  onMobileClose?: () => void;
}) {
  return (
    <>
      {items.map((page) => {
        const Icon = page.icon;
        return (
          <NavLink
            key={page.path}
            to={page.path}
            end={page.path === "/"}
            onClick={onMobileClose}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center rounded-[var(--radius-md)]",
                "text-[var(--font-small-size)] font-medium",
                "transition-all duration-[var(--duration-normal)]",
                collapsed
                  ? "justify-center px-[var(--space-2)] py-[var(--space-2)]"
                  : "gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)]",
                isActive
                  ? cn(
                      "bg-[var(--bg-elevated)] text-[var(--text-primary)]",
                      !collapsed && "border-l-[3px] border-l-[var(--accent)]"
                    )
                  : cn(
                      "text-[var(--text-secondary)]",
                      "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                      !collapsed && "border-l-[3px] border-l-transparent"
                    ),
                /* Collapsed active state */
                isActive && collapsed && "bg-[var(--accent-muted)] text-[var(--accent-hover)]"
              )
            }
            title={collapsed ? page.label : undefined}
          >
            <Icon size={18} className="shrink-0" />
            {!collapsed && (
              <span className="truncate">{page.label}</span>
            )}
          </NavLink>
        );
      })}
    </>
  );
}
