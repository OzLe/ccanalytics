import { Outlet, useLocation } from "react-router-dom";
import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { RotateCcw, PanelLeft } from "lucide-react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import CommandPalette from "../ui/CommandPalette";
import type { CommandAction } from "../ui/CommandPalette";

export default function Layout() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const sidebarToggleRef = useRef<(() => void) | null>(null);

  const handleResetFilters = useCallback(() => {
    document.dispatchEvent(new CustomEvent("reset-filters"));
  }, []);

  const handleToggleSidebar = useCallback(() => {
    sidebarToggleRef.current?.();
  }, []);

  /* ── Cmd+B / Ctrl+B sidebar toggle shortcut ─────────── */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        handleToggleSidebar();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleToggleSidebar]);

  const actions: CommandAction[] = [
    {
      id: "reset-filters",
      label: "Reset All Filters",
      icon: RotateCcw,
      onSelect: handleResetFilters,
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      icon: PanelLeft,
      onSelect: handleToggleSidebar,
    },
  ];

  return (
    <div className={cn("flex h-screen w-full overflow-hidden", "bg-[var(--bg-base)]")}>
      {/* Command Palette (manages its own open/close state via Cmd+K) */}
      <CommandPalette actions={actions} />

      {/* Sidebar */}
      <Sidebar
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
        onToggleRef={sidebarToggleRef}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar onMenuClick={() => setMobileMenuOpen(true)} />

        <main
          key={location.pathname}
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-auto",
            "bg-[var(--bg-base)]",
            "px-[var(--space-5)] py-[var(--space-6)] sm:px-[var(--space-6)] sm:py-[var(--space-8)] lg:px-[var(--space-8)] lg:py-[var(--space-8)] xl:px-[var(--space-10)]",
            "animate-fade-in"
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
